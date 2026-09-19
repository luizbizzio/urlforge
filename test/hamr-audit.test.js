import test from "node:test";
import assert from "node:assert/strict";
import { auditHamr, FAILURE_REASONS } from "../src/hamr-audit.js";
import { outputAlphabetASCII } from "../vendor/ha.mr/docs/alphabets.js";

const mapsCases = [
  "48.558080,-2.122352", "53.630181,-7.077499", "47.691240,-5.312812", "59.638646,18.693072", "52.200236,-5.155240",
  "41.902782,12.496366", "40.712776,-74.005974", "35.676200,139.650300", "-33.868820,151.209290", "51.507351,-0.127758"
].map((coordinates, index) => `https://maps.google.com/?q=${coordinates}&z=${10 + index}`);

const unicodeCases = [
  "https://例え.テスト/ação/0?q=mañana", "https://例え.テスト/東京/1?q=straße", "https://例え.テスト/münchen/2?q=olá mundo",
  "https://例え.テスト/café/3?q=日本語", "https://例え.テスト/🚀/4?q=ação", "https://例え.テスト/über/5?q=français",
  "https://例え.テスト/niño/6?q=Zürich", "https://例え.テスト/한국/7?q=서울", "https://例え.テスト/ελλάδα/8?q=δοκιμή", "https://例え.テスト/россия/9?q=москва"
];

const unsupportedCases = [
  "https://bad_host.example/path", "https://under_score.com/a", "https://a_b.org/value", "https://host_name.dev/search?q=x",
  "https://one_two_three.net/path", "https://invalid_label.io/a", "https://x_y_z.com/value", "https://with_under.example.org/path", "https://a__b.com/end"
];

for (const url of mapsCases) test(`ha.mr normalization audit: ${url}`, () => { const result = auditHamr(url, outputAlphabetASCII); assert.equal(result.valid, true); assert.equal(result.exact, false); assert.equal(result.reason, FAILURE_REASONS.NORMALIZATION); });
for (const url of unicodeCases) test(`ha.mr percent normalization audit: ${url}`, () => { const result = auditHamr(url, outputAlphabetASCII); assert.equal(result.valid, true); assert.equal(result.exact, false); assert.equal(result.reason, FAILURE_REASONS.NORMALIZATION); });
for (const url of unsupportedCases) test(`ha.mr unsupported hostname audit: ${url}`, () => { const result = auditHamr(url, outputAlphabetASCII); assert.equal(result.valid, false); assert.equal(result.reason, FAILURE_REASONS.UNSUPPORTED); });
