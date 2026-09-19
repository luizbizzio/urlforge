import test from "node:test";
import assert from "node:assert/strict";
import { compress, decompress } from "../src/codec.js";

const cases = [
  `https://example.com/${"repeat/".repeat(60)}?a=${"same-value".repeat(25)}#done`,
  `https://unknown.photography/${"random-looking-A9_/".repeat(20)}?empty=&empty=&x=%2Fvalue`,
  `https://例え.テスト/${"東京🚀café/".repeat(20)}?q=${encodeURIComponent("ação 日本語 ".repeat(12))}`,
  "http://example.com:8080/550e8400-e29b-41d4-a716-446655440000/deadbeef0123456789abcdef?at=2026-09-19T12:34:56Z"
];

test("reduced deterministic planner is stable and reversible for every production candidate", () => {
  const candidates = [
    { huffman: true, lz: true, arithmetic: false },
    { huffman: false, lz: false, arithmetic: true },
    { huffman: true, lz: true, arithmetic: true }
  ];
  for (const url of cases) for (const options of candidates) {
    const first = compress(url, options), second = compress(url, options);
    assert.equal(first, second, "planner output must be deterministic");
    assert.equal(decompress(first), new URL(url).href);
  }
});

test("global arithmetic planner never exceeds its selectable non-arithmetic baseline", () => {
  for (const url of cases) {
    const baseline = compress(url, { huffman: true, lz: true, arithmetic: false });
    const global = compress(url, { huffman: true, lz: true, arithmetic: true });
    assert.ok(global.length <= baseline.length, `${global.length} should not exceed ${baseline.length}`);
  }
});
