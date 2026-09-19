import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { META_DATA_ALPHABET, META_FORGE_PREFIX, auditMetaAlphabet, compressMetaV7, decompressMetaV7 } from "../src/meta-codec.js";

const PROPERTY_CASES = 2500;
let state = 0x7f4a7c15;
const next = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0);
const choose = values => values[next() % values.length];
const token = (length, alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_") => Array.from({ length }, () => alphabet[next() % alphabet.length]).join("");

function generatedUrl(index) {
  const domains = ["example.com", "unknown.photography", "api.service.museum", "alpha.beta.gamma.dev", "cdn.unlisted.xyz", "www.youtube.com", "maps.google.com"];
  const domain = choose(domains), id = next() % 1000000000;
  switch (index % 10) {
    case 0: return `https://${domain}/${token(1 + next() % 5)}`;
    case 1: return `https://${domain}/${token(8)}/${token(13)}/${id}?a=${token(9)}&b=${token(17)}`;
    case 2: return `https://${domain}/query?empty=&dup=${id}&dup=&flag&&encoded=a%2fb%20c#result-${token(7)}`;
    case 3: return `https://${domain}/東京/${choose(["ação", "mañana", "straße", "ελλάδα", "서울"])}?q=${choose(["café", "日本語", "Zürich", "🚀"])}#résumé`;
    case 4: { const repeated = token(5).toLowerCase(); return `https://${domain}/${(`${repeated}/`).repeat(4 + next() % 10)}end?copy=${repeated.repeat(3)}`; }
    case 5: return `https://${domain}/commit/${token(40, "0123456789abcdef")}?sha=${token(32, "0123456789abcdef")}#L${1 + next() % 900}`;
    case 6: return `https://${domain}/value/${token(48)}?state=${token(64)}&sig=${token(32)}`;
    case 7: return `http://${domain}:${8000 + next() % 1000}/api/v${1 + next() % 9}/items/${id}/?limit=${next() % 100}&offset=${next() % 10000}`;
    case 8: return `https://maps.google.com/?q=${(next() % 90)}.${String(next() % 1000000).padStart(6, "0")},-${next() % 180}.${String(next() % 1000000).padStart(6, "0")}&z=${next() % 20}`;
    default: return `https://www.youtube.com/watch?v=${token(11)}&list=${token(8 + next() % 20)}`;
  }
}

test("ha.mr output alphabet makes the dot family routing languages mathematically disjoint", () => {
  const audit = auditMetaAlphabet();
  assert.deepEqual(audit.haMrConfiguredAlphabet, [..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_~"]);
  assert.equal(audit.markerInHaMrAlphabet, false);
  assert.equal(audit.classicalPrefixFree, false);
  assert.equal(audit.routingLanguagesDisjoint, true);
  assert.deepEqual(audit.possibleFirstCharacters.forge, ["."]);
  const source = readFileSync(new URL("../vendor/ha.mr/docs/compress.js", import.meta.url), "utf8");
  assert.match(source, /string \+= alphabet\[number % alphabetSize\]/);
  assert.match(source, /return numberToString\(number, alphabet\)/);
});

test(`meta-v7 deterministic properties across ${PROPERTY_CASES} generated URLs`, t => {
  let hamrSupported = 0, hamrDiscarded = 0, forgeRoutes = 0, hamrRoutes = 0, normalizationDifferences = 0;
  for (let index = 0; index < PROPERTY_CASES; index++) {
    const input = generatedUrl(index), result = compressMetaV7(input), trace = result.trace, hamr = trace.candidates.haMr;
    const link = `http://uf.mr#${result.payload}`, serialized = new URL(link).href, recoveredFragment = new URL(serialized).hash.slice(1);
    assert.equal(recoveredFragment, result.payload, `WHATWG fragment mismatch at ${index}`);
    assert.equal(new URL(serialized).hash.slice(1), result.payload, `copy/paste mismatch at ${index}`);
    assert.equal(decodeURIComponent(recoveredFragment), result.payload, `decodeURIComponent changed payload at ${index}`);
    assert.equal(result.payload.includes("#"), false);
    assert.equal(decompressMetaV7(result.payload), trace.normalizedUrl, `exact normalized round-trip failed at ${index}`);
    assert.equal(trace.finalMetaPayload, result.payload);
    assert.equal(trace.rawPayloads.forge, trace.candidates.combinedRetained.rawPayload);
    assert.equal(trace.comparison.requiresSafeWhatwgFragmentCompatibility, true);

    if (hamr.eligible) {
      hamrSupported++;
      assert.ok(result.payload.length <= hamr.rawPayload.length, `meta exceeded ha.mr at ${index}`);
      assert.equal(hamr.rawPayload.startsWith(META_FORGE_PREFIX), false, `ha.mr routing collision at ${index}`);
      assert.ok([...hamr.rawPayload].every(character => META_DATA_ALPHABET.includes(character)));
      if (!hamr.normalization.exact) normalizationDifferences++;
    } else hamrDiscarded++;

    if (result.payload.startsWith(META_FORGE_PREFIX)) {
      forgeRoutes++; assert.equal(trace.selectedFamily, "forge"); assert.ok(trace.rawPayloads.forge);
    } else {
      hamrRoutes++; assert.equal(trace.selectedFamily, "ha.mr"); assert.equal(result.payload, hamr.rawPayload);
    }
  }
  t.diagnostic(JSON.stringify({ generated: PROPERTY_CASES, hamrSupported, hamrDiscarded, forgeRoutes, hamrRoutes, normalizationDifferences }));
});
