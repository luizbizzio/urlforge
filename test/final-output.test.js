import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { compressCombinedDetailed, compressDetailed, decompress, internals } from "../src/codec.js";
import { OUTPUT_ALPHABETS, auditOutputAlphabet, decodeOutput, encodeOutput } from "../src/output-encoding.js";

const cases = [
  "https://example.com/path",
  "https://s.travel/J",
  "https://unknown.photography/random/path/value",
  "https://例え.テスト/東京/mañana?q=ação#résumé",
  "https://cdn.example/value/ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_",
  "https://unknown.example/hash/deadbeef0123456789abcdef01234567",
  "https://api.example/signed?X-Signature=1w9F_8JdL0vP3gK7mN2qR6tY4uI5oA&Expires=1999999999",
  `https://example.com/${"repeat-path/".repeat(30)}`,
  "https://unknown.example/search?x=8zQp2Lm9&empty=&x=second&&encoded=a%2Fb%20c",
  "https://unknown.example/path#fragment-with-percent-%2F-and-value",
  "https://unknown.example/a%2Fb%20c?q=%E2%9C%93"
];

test("safe65 contains only unreserved fragment characters and never #", () => {
  assert.equal(OUTPUT_ALPHABETS.safe65.radix, 65);
  for (const name of ["base64url", "safe65"]) {
    const audit = auditOutputAlphabet(name);
    assert.equal(audit.excludesFragmentDelimiter, true);
    assert.equal(audit.browserRoundTrip, true);
    assert.equal(audit.browserAddsPercentEncoding, false);
    assert.equal(audit.copyPasteRoundTrip, true);
    assert.equal(audit.decodeURIComponentRoundTrip, true);
  }
});

test("transport profiles are reported independently", () => {
  const audit = auditOutputAlphabet("safe65");
  assert.equal(audit.windowsTerminalUnquotedSafe, true);
  assert.equal(audit.markdownAutolinkSafe, true);
  assert.equal(audit.chatTransportSafe, true);
  assert.equal(audit.qrByteModeSafe, true);
  assert.equal(audit.qrAlphanumericModeSafe, false);
});

test("safe65 survives Windows PowerShell and cmd output", { skip: process.platform !== "win32" }, () => {
  const sample = OUTPUT_ALPHABETS.safe65.alphabet;
  const powershell = spawnSync("powershell.exe", ["-NoProfile", "-Command", `Write-Output ${sample}`], { encoding: "utf8" });
  const commandPrompt = spawnSync("cmd.exe", ["/d", "/s", "/c", `echo ${sample}`], { encoding: "utf8" });
  assert.equal(powershell.status, 0); assert.equal(powershell.stdout.trim(), sample);
  assert.equal(commandPrompt.status, 0); assert.equal(commandPrompt.stdout.trim(), sample);
});

test("safe65 byte conversion is deterministic and reversible", () => {
  for (let length = 1; length <= 64; length++) {
    const bytes = Uint8Array.from({ length }, (_, index) => (index * 73 + length * 31) & 255);
    // Production payloads always start with a non-zero version header.
    bytes[0] ||= 32;
    const payload = encodeOutput(bytes, "safe65");
    assert.deepEqual(decodeOutput(payload, "safe65"), bytes);
    assert.equal(encodeOutput(bytes, "safe65"), payload);
  }
});

test("browser fragment parsing and copy/paste preserve every safe65 payload", () => {
  for (const url of cases) {
    const detail = compressDetailed(url, { globalRawStream: true, directBinaryValues: true, outputAlphabet: "safe65" });
    const visible = `http://uf.mr#${detail.payload}`, parsed = new URL(visible);
    assert.equal(parsed.hash.slice(1), detail.payload);
    assert.equal(decodeURIComponent(parsed.hash.slice(1)), detail.payload);
    assert.equal(decompress(parsed.hash.slice(1), { outputAlphabet: "safe65" }), new URL(url).href);
  }
});

test("compatibility Base64URL output remains the default", () => {
  for (const url of cases) {
    const defaultDetail = compressDetailed(url, { globalRawStream: true });
    const compatibility = compressDetailed(url, { globalRawStream: true, outputAlphabet: "base64url" });
    assert.equal(defaultDetail.payload, compatibility.payload);
    assert.equal(decompress(defaultDetail.payload), new URL(url).href);
  }
});

test("context arithmetic order zero and order one cores round-trip arbitrary bytes", () => {
  const bytes = Uint8Array.from({ length: 512 }, (_, index) => index * 151 & 255);
  for (const model of ["hostname", "path", "query", "fragment"]) for (const order of [0, 1]) {
    const bits = internals.encodeContextArithmetic(bytes, model, order);
    assert.deepEqual(internals.decodeContextArithmetic(bits, bytes.length, model, order), bytes);
  }
});

test("version 8 context blocks round-trip with their model identifier", () => {
  const url = `https://unknown.test/${"api/v1/users/profile/settings/preferences/".repeat(5)}`;
  const detail = compressDetailed(url, { globalRawStream: true, huffman: false, lz: false, arithmetic: false, contextArithmetic: true });
  assert.equal(detail.plan.version, 8);
  assert.ok((detail.plan.selectedFeatures.contextArithmeticOrder0 || 0) + (detail.plan.selectedFeatures.contextArithmeticOrder1 || 0) > 0);
  assert.equal(decompress(detail.payload), new URL(url).href);
});

test("combined candidate minimizes visible characters, not merely body bits", () => {
  for (const url of cases) {
    const detail = compressCombinedDetailed(url);
    const lengths = Object.values(detail.alternatives).map(candidate => candidate.payloadCharacters);
    assert.equal(detail.payload.length, Math.min(...lengths));
    assert.equal(decompress(detail.payload, { outputAlphabet: detail.outputAlphabet }), new URL(url).href);
    assert.equal(`http://uf.mr#${detail.payload}`.length, 13 + detail.payload.length);
  }
});

test("retired shortUrlV2 never appears in combined choices", () => {
  for (const url of ["https://s.travel/J", "https://go.xyz/", "https://123.example/Ab_9-"]) {
    const detail = compressCombinedDetailed(url);
    assert.ok(!Object.keys(detail.alternatives).some(name => name.includes("shortUrlV2")));
    assert.notEqual(detail.plan.selectedRepresentation, "shortUrlV2");
  }
});
