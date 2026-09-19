import test from "node:test";
import assert from "node:assert/strict";
import { META_DATA_ALPHABET, META_FORGE_PREFIX, chooseMetaCandidate, compressMetaV7, decompressMetaV7, metaRoundTripEquivalent } from "../src/meta-codec.js";

const urls = [
  "https://x.com/",
  "https://example.com/a",
  "https://unknown.photography/random/R7mQ2vL9?x=q7Z3",
  `https://example.com/${"repeat/".repeat(20)}end`,
  "https://例え.テスト/東京/mañana?q=ação#résumé",
  "https://maps.google.com/?q=48.856613,2.352222&z=14",
  "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  `https://search.example/find?${Array.from({ length: 20 }, (_, index) => `p${index}=value-${index * 7919}`).join("&")}`,
  "https://github.com/org/repo/commit/deadbeef0123456789abcdef0123456789abcdef",
  "https://cdn.example/value/ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
];

test("meta-v7 is self-contained and never exceeds an eligible ha.mr payload", () => {
  for (const url of urls) {
    const result = compressMetaV7(url), hamr = result.trace.candidates.haMr;
    assert.equal(metaRoundTripEquivalent(url, decompressMetaV7(result.payload)), true);
    if (hamr.eligible) assert.ok(result.payload.length <= hamr.payloadCharacters);
    assert.equal(result.trace.finalWireBits, result.payload.length * 8);
    assert.equal(result.trace.finalLinkCharacters, 13 + result.payload.length);
  }
});

test("Forge family marker is safe, reserved, and included in every measured cost", () => {
  assert.equal(META_FORGE_PREFIX, ".");
  assert.equal(META_DATA_ALPHABET.includes(META_FORGE_PREFIX), false);
  const result = compressMetaV7(`https://example.com/${"same/".repeat(40)}`), forge = result.trace.candidates.combinedRetained;
  assert.equal(forge.identifierCharacters, 1);
  assert.equal(forge.identifierWireBits, 8);
  assert.equal(forge.payloadCharacters, forge.bodyCharacters + 1);
});

test("equal final character counts prefer Forge", () => {
  const forge = { name: "combinedRetained", family: "forge", eligible: true, payloadCharacters: 12 };
  const hamr = { name: "ha.mr", family: "ha.mr", eligible: true, payloadCharacters: 12 };
  assert.equal(chooseMetaCandidate({ combinedRetained: forge, haMr: hamr }), forge);
});

test("currentV6Planner is traced but never selectable", () => {
  const result = compressMetaV7("https://example.com/reference/path?q=value");
  assert.equal(result.trace.candidates.currentV6Planner.selectable, false);
  assert.notEqual(result.trace.selectedCandidate, "currentV6Planner");
});

test("unsupported ha.mr inputs retain an explicit discard reason", () => {
  const result = compressMetaV7("https://bad_host.example/path");
  assert.equal(result.trace.candidates.haMr.eligible, false);
  assert.ok(result.trace.candidates.haMr.discardReason?.reason);
  assert.equal(result.trace.selectedCandidate, "combinedRetained");
});

test("normalization differences are recorded instead of silently discarded", () => {
  const result = compressMetaV7("https://例え.テスト/ação?q=mañana");
  const hamr = result.trace.candidates.haMr;
  if (hamr.eligible && !hamr.normalization.exact) assert.ok(hamr.normalization.differenceReason);
  assert.equal(metaRoundTripEquivalent(result.trace.normalizedUrl, decompressMetaV7(result.payload)), true);
});

test("malformed family payloads are rejected", () => {
  assert.throws(() => decompressMetaV7("."), /Empty Forge body/);
  assert.throws(() => decompressMetaV7("bad%payload"), /Invalid meta-v7 ha\.mr payload alphabet/);
});

test("real URL fragments preserve reserved source data, Unicode, query, and original fragment", () => {
  const inputs = [
    "https://example.com/a%2Fb%20c?x=%23%25%26&empty=#original%20fragment",
    "https://例え.テスト/東京/🚀?q=ação&dup=&dup=value#résumé",
    "https://example.com/path?url=https%3A%2F%2Fother.example%2Fa%3Fx%3D1%23part#outer"
  ];
  for (const input of inputs) {
    const result = compressMetaV7(input), visible = `http://uf.mr#${result.payload}`, parsed = new URL(new URL(visible).href);
    assert.equal(parsed.hash.slice(1), result.payload);
    assert.equal(decodeURIComponent(parsed.hash.slice(1)), result.payload);
    assert.equal(decompressMetaV7(parsed.hash.slice(1)), result.trace.normalizedUrl);
  }
});
