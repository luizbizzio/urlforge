import test from "node:test";
import assert from "node:assert/strict";
import { compress, compressDetailed, decompress, internals } from "../src/codec.js";

const urls = {
  "random query parameters": "https://unknown.cloud/search?A9b_C2d-E=FcYQuBE-28OsiUBxYmRk44&Z7y_X6w-V=TowcUiHXBSQils_ERFIDmU&K5j_H4g-F=sPYYKgGgmtz3LIlkiF6f6i",
  "random long path": `https://unlisted.technology/${Array.from({ length: 12 }, (_, i) => `section-${i}-A9b_C2d-E7f_G6h`).join("/")}`,
  "non-repeated path": `https://unlisted.ai/${Array.from({ length: 15 }, (_, i) => `unique-${i}-Q7w_E9r-T2y`).join("/")}`,
  "Base64 values": `https://unknown.auth/callback?state=${"Ab9_-Xy7".repeat(6)}&code=${"Qp3_-Mn8".repeat(12)}&nonce=${"Zk5_-Rt2".repeat(4)}`,
  "signed URL": "https://bucket.storage.cloud/object/file.bin?X-Signature=deadbeef0123456789abcdef0123456789abcdef0123456789abcdef01234567&X-Expires=1700000000&X-Credential=AbC_123-XyZ",
  "short URL": "https://s.travel/J",
  "unknown domain": "https://ciuna8rkh.cloud/j6JnDCMn?x=0",
  "nested subdomains": "https://alpha.beta.region-7.service.museum/v2/resource",
  "unusual TLD": "https://service-9.photography/catalog/AbC_123-XyZ",
  fragments: `https://unknown.example/path/${"shared-value".repeat(4)}?q=${"shared-value".repeat(4)}#${"shared-value".repeat(4)}`,
  "duplicates and empty values": "https://unknown.com/form?empty=&same=7&same=&flag&same=7#result",
  "ports and percent encoding": "http://unknown.example:8443/a%20b/%2Fvalue?next=a%2Fb&empty=#frag%20ment"
};

for (const [name, url] of Object.entries(urls)) test(`globalRawStream round-trip: ${name}`, () => {
  const expected = new URL(url).href, detail = compressDetailed(url, { globalRawStream: true });
  assert.equal(detail.plan.version, 6); assert.equal(decompress(detail.payload), expected);
  assert.ok(["localSegmented", "globalRawStream"].includes(detail.plan.selectedRepresentation));
  assert.ok(detail.plan.selectedBodyBits <= detail.plan.localSegmentedBodyBits);
});

test("globalRawStream shares LZ history across path, query, and fragment", () => {
  const repeated = "cross-boundary-value-".repeat(12), url = `https://unlisted.example/${repeated}?q=${repeated}#${repeated}`;
  const detail = compressDetailed(url, { huffman: true, lz: true, arithmetic: false, globalRawStream: true });
  assert.equal(detail.plan.selectedRepresentation, "globalRawStream");
  assert.ok(detail.plan.savedBodyBits > 0); assert.equal(decompress(detail.payload), new URL(url).href);
});

test("current codec remains v5 while the experimental candidate is v6", () => {
  const current = compressDetailed("https://example.com/path"), experimental = compressDetailed("https://example.com/path", { globalRawStream: true });
  assert.equal(current.plan.version, 5); assert.equal(experimental.plan.version, 6);
});

test("decoder accepts compatible literal streams marked v1 through v5", () => {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_", url = "https://unlisted.test/plain-path", payload = compress(url, { huffman: false, lz: false, arithmetic: false, structural: false });
  const first = alphabet.indexOf(payload[0]);
  for (let version = 1; version <= 5; version++) {
    const compatible = alphabet[(first & 0b000111) | version << 3] + payload.slice(1);
    assert.equal(decompress(compatible), new URL(url).href);
  }
  assert.deepEqual(internals.SUPPORTED_VERSIONS, [1, 2, 3, 4, 5, 6, 7, 8]);
});
