import assert from "node:assert/strict";
import test from "node:test";
import { decodeCompactFragment } from "../src/compact-fragment.js";
import { createCompressionResult } from "../src/web/url-service.js";
import { resolvePayloadFragment } from "../src/web/redirect.js";

const base = "https://bench.example/#";

test("compact links carry both a Forge frame and a locked ha.mr frame", () => {
  const fixtures = [
    [
      "https://example.com/articles/550e8400-e29b-41d4-a716-446655440000",
      "=iQ8s88zZ!e3B+h?Be9K1wCMmnTLgF,8B2", "u78r.BCY-Wx7.ezAjsSg5FyxCWvUFihdXhY"
    ],
    [
      "https://github.com/mikuta0407/win4wine",
      "HM6/NdoyxmkLBmOrI6CD", "csvautuyO7E2zIiLe_21A"
    ]
  ];
  for (const [url, compact, legacy] of fixtures) {
    const encoded = createCompressionResult(url, base);
    assert.equal(encoded.payload, compact);
    assert.equal(encoded.selectedRepresentation, "compactFragment");
    assert.ok(compact.length < legacy.length);
    assert.equal(decodeCompactFragment(compact, 8192), legacy);
    assert.equal(resolvePayloadFragment(new URL(base + compact).hash).destination, url);
    assert.equal(resolvePayloadFragment(new URL(base + legacy).hash).destination, url);
  }
});

test("compact decoding rejects invalid digits, endings, and oversized payloads", () => {
  for (const payload of ["A!", "!<A", "!A\n", "!éA", "!A~", "!" + "A".repeat(8192)]) {
    assert.equal(resolvePayloadFragment("#" + payload).ok, false);
  }
  assert.throws(() => decodeCompactFragment("HM6/NdoyxmkLBmOrI6CD", 20));
});
