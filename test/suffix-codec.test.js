import assert from "node:assert/strict";
import test from "node:test";
import { compressMetaV7 } from "../src/meta-codec.js";
import { decodeSuffix, encodeSuffix } from "../src/suffix-codec.js";
import { compressBestUrl, tryDecompress } from "../src/url-codec.js";
import { createCompressionResult } from "../src/web/url-service.js";
import { resolvePayloadFragment } from "../src/web/redirect.js";

const base = "https://bench.example/#";

test("frozen suffix model decodes its original bitstream", () => {
  const tail = "articles/how-we-built-a-language-model";
  assert.equal(encodeSuffix(tail), "bjaQaosiMIG_LKMIdBo");
  assert.equal(decodeSuffix("bjaQaosiMIG_LKMIdBo"), tail);
  assert.equal(tryDecompress("..u78r.bjaQaosiMIG_LKMIdBo").value, `https://example.com/${tail}`);
  assert.equal(tryDecompress("u78r.bjaQaosiMIG_LKMIdBo").value, `https://example.com/${tail}`);
});

test("model payload wins for the article and survives the web entry points", () => {
  const url = "https://example.com/articles/how-we-built-a-language-model";
  const result = createCompressionResult(url, base);
  assert.equal(result.selectedRepresentation, "suffixModel");
  assert.equal(result.payload, "u78r.bjaQaosiMIG_LKMIdBo");
  assert.ok(result.payload.length < compressMetaV7(url).payload.length);
  assert.equal(resolvePayloadFragment(new URL(result.shortUrl).hash).destination, url);
});

test("app restores the serialized URL exactly, including edge-case suffixes", () => {
  const inputs = [
    "https://example.com/a?",
    "https://example.com/a#",
    "https://example.com/a?#",
    "https://example.com/a?x=%2f&x=&flag#",
    "https://example.com//a//b?&&x=1&x=2#",
    "https://example.com/a?signature=%2b%2f%25&x=1&x=2",
    "https://example.com/2026-02-31T12:00:00Z",
    "https://example.com/2026-11-23T24:00:00Z",
    "http://[2001:db8::1]:8080/articles/how-we-built-a-language-model#",
    "https://例え.テスト/ação/🚀?q=%2f#"
  ];
  for (const input of inputs) {
    const encoded = createCompressionResult(input, base);
    assert.equal(resolvePayloadFragment(new URL(encoded.shortUrl).hash).destination, new URL(input).href, input);
  }
});

test("exact Forge fallback handles an origin that ha.mr cannot encode", () => {
  const input = "https://bad_host.example/a?x=%2f#";
  const result = compressBestUrl(input);
  const fallback = result.trace.candidates.exactForge.payload;
  assert.equal(tryDecompress(fallback).value, input);
  assert.ok(result.payload.length < fallback.length);
  assert.equal(tryDecompress(result.payload).value, input);
});

test("new public decoder opens payloads made by both legacy families", () => {
  for (const input of ["https://x.com/", `https://example.com/${"repeat/".repeat(40)}`]) {
    const legacy = compressMetaV7(input);
    assert.equal(resolvePayloadFragment(new URL(base + legacy.payload).hash).destination, input);
  }
});

test("new payload routing rejects invalid framing, origins and arithmetic streams", () => {
  for (const payload of ["..", "...", "..a.", "..a...a", "..%41", "..u78r.A", "..u78r.AbjaQaosiMIG_LKMIdBo",
    `..${"a".repeat(513)}.bjaQaosiMIG_LKMIdBo`, `..${"a".repeat(8192)}`]) {
    assert.equal(tryDecompress(payload).ok, false, payload.slice(0, 20));
  }
});

test("adaptive queries keep the repeated fields and trailing fragment in their frozen wire format", () => {
  const tail = "search?tag=blue&tag=blue&tag=blue&tag=green&tag=blue#";
  const url = `https://example.com/${tail}`;
  const encoded = createCompressionResult(url, base);
  assert.equal(encoded.selectedRepresentation, "adaptiveQuery");
  assert.equal(encoded.payload, "u78r..BQTL~9UHlJet4IpH0eI0pi");
  assert.equal(resolvePayloadFragment(new URL(encoded.shortUrl).hash).destination, url);
});

test("adaptive query histories preserve the serialized query, meet the length limit and reset per URL", () => {
  const tails = [
    "path/?flag&&=v&flag=&a=one&a=two&val=x=y?#a?x=y&",
    "?signed=%2b%2F%25&q=a+b&q=a%20b&=",
    "path?__proto__=x&constructor=y&hasOwnProperty=z",
    "path?x=" + "a".repeat(2041)
  ];
  for (const tail of tails) {
    const payload = encodeSuffix(tail, true);
    assert.equal(decodeSuffix(payload, true), tail);
    assert.equal(tryDecompress(`u78r..${payload}`).value, `https://example.com/${tail}`);
    assert.equal(encodeSuffix(tail, true), payload);
  }
  assert.equal(encodeSuffix(tails.at(-1) + "a", true), null);
  assert.equal(decodeSuffix(encodeSuffix("path#only?x=1", true), true), "path#only?x=1");
});

test("directory and adaptive path candidates restore repeated separators, escapes and fragment markers", () => {
  for (const tail of ["articles/how-to-build-and-test-a-static-site", "x///long-enough-for-the-suffix?#",
    "Docs%2fDraft/My_Draft/My_Draft#only?query", "x/%E2%82%AC/articles/and-articles"]) {
    const url = "https://example.com/" + tail;
    const { trace } = compressBestUrl(url);
    for (const name of ["directorySuffix", "adaptivePath"]) {
      assert.equal(resolvePayloadFragment("#" + trace.candidates[name].payload).destination, url);
    }
  }
});

test("both suffix decoders reject alternate radix and arithmetic finalizations", () => {
  for (const adaptive of [false, true]) {
    const payload = encodeSuffix("search?tag=blue&tag=blue#end", adaptive);
    assert.throws(() => decodeSuffix("A" + payload, adaptive));
    assert.throws(() => decodeSuffix(payload + "A", adaptive));
    assert.throws(() => decodeSuffix(payload.slice(0, -1), adaptive));
  }
  for (const payload of ["u78r..", "u78r...A", "..u78r..BQTL~9UHlJet4IpH0eI0pi"]) {
    assert.equal(tryDecompress(payload).ok, false);
  }
});
