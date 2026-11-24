import assert from "node:assert/strict";
import test from "node:test";
import { decodeIdentifierSuffix, encodeIdentifierSuffix } from "../src/identifier-suffix.js";
import { encodeSuffix } from "../src/suffix-codec.js";
import { createCompressionResult } from "../src/web/url-service.js";
import { resolvePayloadFragment } from "../src/web/redirect.js";

const base = "https://bench.example/#";

test("Unicode fields restore the serialized spelling on the public redirect route", () => {
  const url = new URL("https://example.com/wiki/Русский_язык").href;
  const result = createCompressionResult(url, base);
  assert.equal(result.selectedRepresentation, "unicodeSuffix");
  assert.equal(result.payload, "u78r.c2Y8Nve.oiBLd5f2wxtc8qeer_");
  assert.equal(resolvePayloadFragment(new URL(result.shortUrl).hash).destination, url);
  assert.equal(resolvePayloadFragment("#u78r.A.MomlpzK-sdN8B").destination, "https://example.com/%E6%97%A5%E6%9C%AC%E8%AA%9E");
});

test("Unicode runs preserve case, word separators and supplementary characters", () => {
  for (const word of ["я", "яяяя", "مرحبا بالعالم", "東京-서울_🚀", "𐀀\u{10ffff}", "é_e\u0301"]) {
    for (const run of [encodeURIComponent(word), encodeURIComponent(word).toLowerCase()]) {
      const tail = "search?q=" + run + "&z=00#";
      const [shape, ...fields] = encodeIdentifierSuffix(tail, true).split(".");
      assert.equal(decodeIdentifierSuffix(shape, fields), tail);
    }
  }
  for (const run of ["%c3%A9", "%ff%fe", "%ED%A0%80", "%41%42", "%C3%A9%5F%C3%A9"]) {
    assert.equal(encodeIdentifierSuffix(run, true), null);
  }
});

test("the identifier candidate and the selected link open alongside the old suffix link", () => {
  const input = "https://example.com/articles/550e8400-e29b-41d4-a716-446655440000";
  const result = createCompressionResult(input, base);
  const identifier = result.trace.candidates.identifierSuffix.payload;
  assert.equal(identifier, "u78r.BCY-Wx7.ezAjsSg5FyxCWvUFihdXhY");
  assert.ok(result.payload.length <= identifier.length);
  for (const payload of [result.payload, identifier, result.trace.candidates.suffixModel.payload]) {
    assert.equal(resolvePayloadFragment(new URL(base + payload).hash).destination, input);
  }
});

test("identifier fields preserve case, length, escaped bytes, literal zeroes and ordering", () => {
  for (const tail of [
    "0000000000000", "path/0/a0?x=000012345678901234567890&x=0000#0",
    "page?lo=0000abcd&hi=0000ABCD&mix=Ab_9Z33&empty=#",
    "p/550E8400-E29B-41D4-A716-446655440000?q=%e6%97%a5&b=%2F%00%FE",
    "p/%2f%2F?&&sig=%E6%97%A5%E6%9C%AC&z=00#",
    "a" + "0".repeat(511)
  ]) {
    const frame = encodeIdentifierSuffix(tail);
    const [shape, ...fields] = frame.split(".");
    assert.equal(decodeIdentifierSuffix(shape, fields), tail);
    assert.equal(resolvePayloadFragment("#u78r." + frame).destination, "https://example.com/" + tail);
  }
});

test("invalid identifier fields, placeholders and expansion limits are rejected", () => {
  const [shape, token] = encodeIdentifierSuffix("p?x=00001234567").split(".");
  for (const [s, fields] of [
    [shape, []], [shape, [token, token]], [shape, ["A"]], [shape, ["B"]],
    [encodeSuffix("0", false, 1), [token]], [shape, ["A" + "A".repeat(513)]],
    [shape, Array(65).fill(token)]
  ]) assert.throws(() => decodeIdentifierSuffix(s, fields));
  assert.equal(encodeIdentifierSuffix("no-ids-here"), null);
  assert.equal(encodeIdentifierSuffix("0".repeat(513)), null);
  const longToken = encodeIdentifierSuffix("1".repeat(512)).split(".")[1];
  assert.throws(() => decodeIdentifierSuffix(encodeSuffix("0/0/0/0/0", false, 1), Array(5).fill(longToken)));
  assert.equal(resolvePayloadFragment("#..u78r." + shape + "." + token).ok, false);
});
