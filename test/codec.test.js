import test from "node:test";
import assert from "node:assert/strict";
import { compress, decompress, describe } from "../src/codec.js";

const cases = {
  ASCII: "https://example.com/plain/path?hello=world",
  Unicode: "https://例え.テスト/ümlaut/🚀?q=olá mundo",
  "query parameters": "https://example.com/search?q=URL+compression&utm_source=google&utm_medium=cpc",
  fragments: "https://example.com/docs/page#installation-section",
  ports: "http://example.com:8080/api/items",
  "long paths": `https://example.com/${"long-segment/".repeat(20)}end`,
  UUIDs: "https://api.example.com/users/550e8400-e29b-41d4-a716-446655440000",
  "numeric IDs": "https://example.com/products/000123456789/orders/9876543210",
  "percent-encoded values": "https://example.com/redirect?next=https%3A%2F%2Fother.example%2Fa%20b",
  timestamps: "https://example.com/events?at=2026-09-19T12:34:56Z",
  hashes: "https://github.com/org/repo/commit/deadbeef0123456789abcdef",
  "uppercase UUID remains exact": "https://example.com/550E8400-E29B-41D4-A716-446655440000",
  "no explicit scheme": "example.com/path"
};
for (const [name, url] of Object.entries(cases)) test(`round-trip ${name}`, () => { const expected = new URL(url.includes("://") ? url : `https://${url}`).href; assert.equal(decompress(compress(url)), expected); });

test("semantic features remain independently reversible", () => {
  const url = "https://example.com/550e8400-e29b-41d4-a716-446655440000/deadbeef01234567/000123?at=2026-09-19T12:34:56Z&utm_source=x";
  for (const feature of ["numbers", "uuids", "hex", "timestamps"]) { const features = { numbers: false, uuids: false, hex: false, timestamps: false, [feature]: true }; assert.equal(decompress(compress(url, { features })), new URL(url).href); }
});
test("format is versioned and malformed input is rejected", () => { assert.throws(() => decompress("AAAA"), /Unsupported payload version|Unexpected end of payload/); assert.throws(() => decompress("*bad*"), /Invalid base64url/); });
test("decoder remains compatible with version 1 bitstreams", () => {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_", url = "https://example.com/plain/path";
  const version2 = compress(url, { huffman: false, lz: false, arithmetic: false, structural: false }), first = alphabet.indexOf(version2[0]);
  const version1 = alphabet[(first & 0b000111) | 0b001000] + version2.slice(1);
  assert.equal(decompress(version1), new URL(url).href);
});
test("static Huffman is deterministic and never chosen when framing would make a segment larger", () => {
  const urls = ["https://example.com/x", "https://example.com/search?q=common-english-path-and-query", `https://example.com/${"documentation/".repeat(10)}`];
  for (const url of urls) { const first = compress(url, { huffman: true }), second = compress(url, { huffman: true }), raw = compress(url, { huffman: false }); assert.equal(first, second); assert.ok(first.length <= raw.length); assert.equal(decompress(first), new URL(url).href); }
});
test("literal blocks never split a multibyte UTF-8 character", () => { const url = `https://unlisted.test/${"a".repeat(31)}🚀${"é".repeat(20)}`; assert.equal(decompress(compress(url)), new URL(url).href); });
test("describe reports all size fields and round trip", () => { const input = "https://example.com/123456", payload = compress(input), result = describe(input, payload, "forge.test"); assert.equal(result.originalLength, input.length); assert.equal(result.payloadLength, payload.length); assert.equal(result.fullLinkLength, `https://forge.test/#${payload}`.length); assert.equal(result.compressionRatio, payload.length / input.length); assert.equal(result.roundTrip, true); });
