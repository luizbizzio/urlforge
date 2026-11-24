import assert from "node:assert/strict";
import test from "node:test";
import { decodeCompactFragment, encodeCompactFragment, encodeExpandedCompactFragment, encodeHeaderCompactFragment } from "../src/compact-fragment.js";
import { META_LIMITS } from "../src/meta-codec.js";
import { SAFE_FRAGMENT_ALPHABET } from "../src/output-encoding.js";
import { createCompressionResult } from "../src/web/url-service.js";
import { resolvePayloadFragment } from "../src/web/redirect.js";
import { compress as compressHaMr } from "../vendor/ha.mr/docs/compress.js";

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

test("expanded fragments preserve the original frame and round-trip in both link modes", () => {
  const fixtures = [
    ["https://bad_host.example/a?x=%2f#", "exactForge", "forge", "lzBtYZJf4KY:+*ZsfjHIiHlM8"],
    ["https://github.com/LaGTumCf/5dk3zXf___/commit/1?utm_source=github&utm_medium=web", "combinedRetained", "forge", "@HQd5z9HW,4sv?wS;*,L_l:C2r=zDie6P5KHvd7ujxOAu"],
    ["https://github.com/HnyjG2NP/BAzE_7d6T2/blob/main/src/6", "ha.mr", "hamr", "k5ABKhrhL!~2kxl'g+@scfcV;kO,PZA.mHMaj"]
  ];
  const limit = META_LIMITS.maxPayloadCharacters;
  for (const [url, rawCandidate, mode, fragment] of fixtures) {
    for (const askBeforeOpening of [false, true]) {
      const encoded = createCompressionResult(url, base, mode, { askBeforeOpening });
      assert.equal(encoded.selectedRepresentation, "expandedCompactFragment");
      assert.equal(encoded.payload, fragment);
      const plain = encoded.trace.candidates[rawCandidate].payload;
      const hamr = mode === "hamr" ? plain : undefined;
      assert.equal(encodeExpandedCompactFragment(plain, hamr, limit), encoded.payload);
      assert.ok(encoded.payload.length < (encodeCompactFragment(plain, hamr, limit) ?? plain).length);
      assert.equal(decodeCompactFragment(encoded.payload, limit), plain);
      assert.equal(new URL(encoded.shortUrl).href, encoded.shortUrl);
      assert.deepEqual(resolvePayloadFragment(new URL(encoded.shortUrl).hash), {
        ok: true, destination: url, destinationScheme: "https", askBeforeOpening
      });
    }
  }
});

test("expanded decoding rejects ambiguous shared-link syntax and respects both size limits", () => {
  for (const payload of [":AB", "~:AB", "A:~:B", "A&amp;B", "A'a(", "&" + "A".repeat(8192)]) {
    assert.throws(() => decodeCompactFragment(payload, META_LIMITS.maxPayloadCharacters));
  }
  const source = "..AfQO4Ppu4E_ycl4OClKZudQoYeA3SKaF-UCETQ";
  const expanded = encodeExpandedCompactFragment(source, undefined, 8192);
  assert.ok(expanded.length < source.length);
  assert.throws(() => decodeCompactFragment(expanded, expanded.length));
});

test("compact headers restore the pinned ha.mr HTTPS bits in both link modes", () => {
  const limit = META_LIMITS.maxPayloadCharacters;
  const alphabet = [...SAFE_FRAGMENT_ALPHABET];
  const endings = { com: "$", org: "+", net: "/", io: "=", gov: "@", edu: "&" };
  for (const [tld, ending] of Object.entries(endings)) {
    for (const subdomain of ["www.", ""]) {
      const destination = `https://${subdomain}example.${tld}/reference?x=1#section`;
      const raw = compressHaMr(destination, alphabet);
      const payload = encodeHeaderCompactFragment(raw, limit);
      assert.ok(payload.endsWith(ending));
      if (subdomain) assert.equal(payload, "kFReQGx1U$,2.?~jhBCEg" + ending);
      assert.equal(decodeCompactFragment(payload, limit), raw);
      assert.equal(encodeHeaderCompactFragment(raw, limit, payload.length - 1), null);
      for (const [marker, askBeforeOpening] of [["", false], [":", true]]) {
        assert.deepEqual(resolvePayloadFragment(new URL(base + marker + payload).hash), {
          ok: true, destination, destinationScheme: "https", askBeforeOpening
        });
      }
    }
  }
});

test("compact headers leave nonmatching ha.mr flags to the existing formats", () => {
  for (const url of ["http://example.com/reference", "https://example.com:8443/reference", "https://example.com/index.php", "https://example.xyz/reference"]) {
    const raw = compressHaMr(url, [...SAFE_FRAGMENT_ALPHABET]);
    assert.equal(encodeHeaderCompactFragment(raw, 8192), null);
  }
  for (const payload of ["$", "AAB+", ":test/", "~:B=", "B:~:C@", "B&amp;C&"]) {
    assert.throws(() => decodeCompactFragment(payload, 8192));
  }
});
