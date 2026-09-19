import assert from "node:assert/strict";
import test from "node:test";

import { compress as compressForge } from "../src/codec.js";
import {
  META_DATA_ALPHABET,
  META_LIMITS,
  MetaCodecError,
  compress,
  decompress,
  inspect,
  tryDecompress
} from "../src/meta-codec.js";
import { decodeOutput, encodeOutput } from "../src/output-encoding.js";

const encoder = new TextEncoder();

function deterministicRandom(seed = 0x7f4a7c15) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
}

function assertStructured(result) {
  assert.equal(typeof result.ok, "boolean");
  if (result.ok) {
    assert.equal(result.error, null);
    assert.match(result.value, /^https?:\/\//);
    assert.ok(encoder.encode(result.value).length <= META_LIMITS.maxDecompressedUrlBytes);
  } else {
    assert.equal(result.value, null);
    assert.equal(typeof result.error.code, "string");
    assert.equal(typeof result.error.message, "string");
    assert.ok(!("stack" in result.error));
    assert.ok(!("cause" in result.error));
  }
}

function bitsToBytes(bits) {
  const bytes = new Uint8Array(Math.ceil(bits.length / 8));
  for (let index = 0; index < bits.length; index++) if (bits[index] === "1") bytes[index >> 3] |= 1 << (7 - (index & 7));
  return bytes;
}

function gamma(value) {
  const binary = (BigInt(value) + 1n).toString(2);
  return `${"0".repeat(binary.length - 1)}${binary}`;
}

test("public meta-v7 API is small, structured, and preserves valid URLs", () => {
  const input = "https://example.com/a%2Fb?empty=&dup=1&dup=2#parte%20final";
  const payload = compress(input);
  assert.equal(decompress(payload), new URL(input).href);
  assert.deepEqual(tryDecompress(payload), { ok: true, value: new URL(input).href, error: null });

  const detail = inspect(payload);
  assert.equal(detail.valid, true);
  assert.equal(detail.decodedUrl, new URL(input).href);
  assert.equal(detail.payloadCharacters, payload.length);
  assert.deepEqual(detail.limits, META_LIMITS);

  assert.throws(() => decompress("."), error => error instanceof MetaCodecError && error.code === "EMPTY_PAYLOAD");
  assert.doesNotThrow(() => tryDecompress(Symbol("hostile")));
  assert.equal(tryDecompress(Symbol("hostile")).error.code, "INVALID_INPUT");
  assert.equal(inspect(null).valid, false);
});

test("meta-v7 preserves literal-compatible codec versions 1 through 7", () => {
  const input = "https://unknown.example/path/value?x=1#frag";
  const base64 = compressForge(input, { huffman: false, lz: false, arithmetic: false, structural: false });
  for (let version = 1; version <= 7; version++) {
    const bytes = decodeOutput(base64, "base64url");
    bytes[0] = (bytes[0] & 0x1f) | (version << 5);
    const payload = `.${encodeOutput(bytes, "safe65")}`;
    assert.equal(decompress(payload), new URL(input).href, `version ${version}`);
  }
});

test("limits reject oversized input before expensive decoding", () => {
  const nearHamr = "A".repeat(META_LIMITS.maxPayloadCharacters);
  const nearForge = `.${"A".repeat(META_LIMITS.maxPayloadCharacters - 1)}`;
  assertStructured(tryDecompress(nearHamr));
  assertStructured(tryDecompress(nearForge));

  for (const payload of [
    "A".repeat(META_LIMITS.maxPayloadCharacters + 1),
    `.${"A".repeat(META_LIMITS.maxPayloadCharacters)}`,
    "A".repeat(META_LIMITS.maxPayloadCharacters * 16)
  ]) {
    const result = tryDecompress(payload);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "PAYLOAD_TOO_LARGE");
  }

  const tooLargeUrl = `https://example.com/${"a".repeat(META_LIMITS.maxDecompressedUrlBytes)}`;
  assert.throws(() => compress(tooLargeUrl), error => error instanceof MetaCodecError && error.code === "INPUT_URL_TOO_LARGE");
});

test("malformed LZ, unknown versions, and invalid ha.mr inputs are sanitized", () => {
  const badDistance = `.${encodeOutput(decodeOutput("fv8", "base64url"), "safe65")}`;
  assert.equal(tryDecompress(badDistance).error.code, "INVALID_BACK_REFERENCE");

  const rawA = `0${"00000"}01100001`;
  const overlongLz = `11101${gamma(0)}${gamma(META_LIMITS.maxBackReferenceLength - 2)}`;
  const badLength = `.${encodeOutput(bitsToBytes(`1011${rawA}${overlongLz}11111`), "safe65")}`;
  assert.equal(tryDecompress(badLength).error.code, "INVALID_BACK_REFERENCE");

  const unknownVersion = `.${encodeOutput(Uint8Array.from([0x0b, 0xf0]), "safe65")}`;
  assert.equal(tryDecompress(unknownVersion).error.code, "UNSUPPORTED_VERSION");

  for (const payload of ["~~~~", "~A~A~A"]) {
    const result = tryDecompress(payload);
    assert.equal(result.ok, false);
    assert.ok(["INVALID_HAMR_PAYLOAD", "INVALID_URL"].includes(result.error.code));
  }
});

test("deterministic fuzzing never throws, collides routing, or exceeds limits", t => {
  const random = deterministicRandom();
  const randomPayload = (length, alphabet = META_DATA_ALPHABET) => Array.from({ length }, () => alphabet[Math.floor(random() * alphabet.length)]).join("");
  let cases = 0;

  for (let index = 0; index < 2000; index++) {
    const result = tryDecompress(randomPayload(1 + Math.floor(random() * 192)));
    assertStructured(result); cases++;
  }
  for (let index = 0; index < 2000; index++) {
    const result = tryDecompress(`.${randomPayload(Math.floor(random() * 192))}`);
    assertStructured(result); cases++;
  }

  const validPayloads = [
    "https://example.com/short",
    "https://nested.unknown.photography/a/b/c?empty=&dup=1&dup=2#frag",
    "https://example.com/repeat/repeat/repeat?value=repeat-repeat-repeat",
    "https://例え.テスト/東京/🚀?q=ação#résumé",
    "https://example.com/download?signature=AbCdEf0123456789_-AbCdEf0123456789"
  ].map(compress);

  for (const payload of validPayloads) {
    assert.equal(tryDecompress(payload).ok, true);
    for (let length = 0; length < payload.length; length++) {
      assertStructured(tryDecompress(payload.slice(0, length))); cases++;
    }
  }

  const mutationAlphabet = `${META_DATA_ALPHABET}.`;
  for (let index = 0; index < 1000; index++) {
    const source = validPayloads[index % validPayloads.length];
    const position = Math.floor(random() * source.length);
    let replacement = mutationAlphabet[Math.floor(random() * mutationAlphabet.length)];
    if (replacement === source[position]) replacement = mutationAlphabet[(mutationAlphabet.indexOf(replacement) + 1) % mutationAlphabet.length];
    const mutated = `${source.slice(0, position)}${replacement}${source.slice(position + 1)}`;
    assertStructured(tryDecompress(mutated)); cases++;
  }

  for (const payload of ["", ".", "%", "bad%payload", "~~~~", "~A~A~A", "..", ".#", ".%"] ) {
    assertStructured(tryDecompress(payload)); cases++;
  }

  t.diagnostic(JSON.stringify({ fuzzCases: cases, seed: "0x7f4a7c15", randomSafe65: 2000, dotPrefixed: 2000, oneCharacterMutations: 1000 }));
  assert.ok(cases >= 5000);
});
