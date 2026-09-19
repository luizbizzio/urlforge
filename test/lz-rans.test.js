import test from "node:test";
import assert from "node:assert/strict";
import { compress, decompress, internals } from "../src/codec.js";
import { encodeRans, decodeRans } from "../experiments/rans.js";

const roundTrip = (url, options = {}) => assert.equal(decompress(compress(url, options)), new URL(url).href);

test("LZ compresses repeated path segments", () => {
  const url = `https://example.com/${"repeatable-segment/".repeat(30)}`;
  const withLz = compress(url, { huffman: false, lz: true }), withoutLz = compress(url, { huffman: false, lz: false });
  assert.ok(withLz.length < withoutLz.length); roundTrip(url);
});
test("LZ compresses repeated query data without reordering parameters", () => { const value = "same-query-value-".repeat(8), url = `https://example.com/search?a=${value}&b=${value}&c=${value}#done`; roundTrip(url); assert.ok(compress(url).length < compress(url, { lz: false }).length); });
test("LZ handles repeated long words", () => roundTrip(`https://example.com/${"antidisestablishmentarianism".repeat(12)}`));
test("LZ decoder supports overlapping references", () => { const url = `https://example.com/${"xyz".repeat(100)}`; roundTrip(url); assert.ok(compress(url, { huffman: false }).length < compress(url, { huffman: false, lz: false }).length / 4); });
test("LZ remains byte-safe for repeated Unicode", () => roundTrip(`https://例え.テスト/${"東京🚀café/".repeat(20)}?q=${"ação".repeat(20)}`));
test("short strings do not pay LZ metadata", () => { const url = "https://example.com/xy"; assert.equal(compress(url, { lz: true }), compress(url, { lz: false })); });
test("malformed LZ distance is rejected", () => assert.throws(() => decompress("fv8"), /Malformed LZ back-reference/));
test("two-digit semantic tokens are never emitted as undersized LZ references", () => roundTrip(`https://repeat.example/${"79oq03-segment/".repeat(14)}`));
test("mixed dictionary, semantic, Huffman, and LZ tokens round-trip", () => { const uuid = "550e8400-e29b-41d4-a716-446655440000", hash = "deadbeef0123456789abcdef"; roundTrip(`https://github.com/example/repo/${uuid}/${uuid}/commit/${hash}/${hash}?utm_source=google&value=${"repeat-me-".repeat(12)}#${"fragment-".repeat(10)}`); });
test("ports, trailing slash, percent escapes, and fragments survive LZ", () => roundTrip(`http://example.com:8443/${"a%20b/".repeat(15)}?x=${"%2Fvalue".repeat(8)}#${"frag".repeat(12)}`));
test("isolated experimental rANS core round-trips every byte value", () => { const input = Uint8Array.from({ length: 256 }, (_, index) => index); assert.deepEqual(decodeRans(encodeRans(input), input.length), input); });
test("version 5 arithmetic core round-trips deterministic binary data", () => { const input = Uint8Array.from({ length: 1024 }, (_, index) => index * 73 & 255); const arithmetic = internals.encodeArithmetic(input); assert.deepEqual(internals.decodeArithmetic(arithmetic, input.length), input); });
