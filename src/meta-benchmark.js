import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { compressMetaV7, decompressMetaV7, metaRoundTripEquivalent } from "./meta-codec.js";

const PREFIX = "http://uf.mr#";
const rows = [
  { category: "short", url: "https://x.com/" },
  { category: "short", url: "https://example.com/a" },
  { category: "random", url: "https://unknown.photography/R7mQ2vL9/xK4pN8dS?alpha=q7Zx3&beta=M9vK2" },
  { category: "random", url: "https://api.unlisted.museum/v3/object/kR7pQ2nM9sL4?mode=Zx81&nonce=aP4mT7" },
  { category: "repetitive", url: `https://example.com/${"repeat-path/".repeat(24)}end?copy=${"repeat-value-".repeat(12)}` },
  { category: "repetitive", url: `https://unknown.example/${"abcabcabc/".repeat(30)}#${"abcabcabc".repeat(12)}` },
  { category: "unicode", url: "https://例え.テスト/東京/mañana?q=ação+über#résumé" },
  { category: "unicode", url: "https://münchen.example/straße/🚀?cidade=São%20Paulo" },
  { category: "maps", url: "https://maps.google.com/?q=48.856613,2.352222&z=14" },
  { category: "maps", url: "https://maps.google.com/?q=-33.868820,151.209290&z=17" },
  { category: "youtube", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" },
  { category: "youtube", url: "https://www.youtube.com/watch?v=AbCdEfGhI_1&list=PLx7QmN2k9" },
  { category: "large query", url: `https://search.example.com/find?${Array.from({ length: 30 }, (_, index) => `parameter${index}=value-${index}-${index * 7919}`).join("&")}` },
  { category: "large query", url: `https://unknown.example/query?payload=${"signed-value-ABC123_".repeat(20)}&empty=&empty=&flag` },
  { category: "hash", url: "https://github.com/org/repository/commit/deadbeef0123456789abcdef0123456789abcdef" },
  { category: "hash", url: "https://cdn.example.net/assets/0123456789abcdef0123456789abcdef0123456789abcdef.js" },
  { category: "base64", url: "https://cdn.example/value/ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_" },
  { category: "base64", url: "https://auth.example/callback?state=eyJ1c2VyIjoiYWxpY2UiLCJub25jZSI6IjEyMzQ1Njc4OTAifQ&sig=QWxwaGFCZXRhMTIzNDU2Nzg5MF8" }
];

const comparison = { wins: 0, ties: 0, losses: 0, excludedUnsupportedHamr: 0 };
const selectedCounts = {}, categoryResults = {}, traces = [];
let compressionMs = 0, decompressionMs = 0, roundTrips = 0;
for (let index = 0; index < rows.length; index++) {
  const row = rows[index], started = performance.now(), result = compressMetaV7(row.url); compressionMs += performance.now() - started;
  const decodeStarted = performance.now(), decoded = decompressMetaV7(result.payload); decompressionMs += performance.now() - decodeStarted;
  const equivalent = metaRoundTripEquivalent(row.url, decoded); if (equivalent) roundTrips++;
  else throw new Error(`meta-v7 round-trip failed at sample URL ${index + 1}`);
  const hamr = result.trace.candidates.haMr, own = result.trace.finalPayloadCharacters;
  if (!hamr.eligible) comparison.excludedUnsupportedHamr++;
  else if (own < hamr.payloadCharacters) comparison.wins++;
  else if (own === hamr.payloadCharacters) comparison.ties++;
  else comparison.losses++;
  selectedCounts[result.trace.selectedCandidate] = (selectedCounts[result.trace.selectedCandidate] || 0) + 1;
  const category = categoryResults[row.category] ||= { count: 0, wins: 0, ties: 0, losses: 0, excludedUnsupportedHamr: 0, selected: {} };
  category.count++; category.selected[result.trace.selectedCandidate] = (category.selected[result.trace.selectedCandidate] || 0) + 1;
  if (!hamr.eligible) category.excludedUnsupportedHamr++; else if (own < hamr.payloadCharacters) category.wins++; else if (own === hamr.payloadCharacters) category.ties++; else category.losses++;
  traces.push({ index: index + 1, category: row.category, input: row.url, decoded, roundTripEquivalent: equivalent, ...result.trace });
  console.log(`[meta-v7-sample] url=${index + 1}/${rows.length} category=${row.category} selected=${result.trace.selectedCandidate} chars=${own}`);
}

const report = {
  schemaVersion: 1, benchmark: "meta-v7 sample", generatedAt: new Date().toISOString(), count: rows.length,
  prefix: { value: PREFIX, characters: PREFIX.length }, alphabet: "safe65 data alphabet with '.' reserved as the Forge family marker",
  comparisonRule: "Same 13-character prefix and safe65 data alphabet. Raw ha.mr is the zero-overhead default namespace; Forge pays one leading '.' character.",
  versusHamr: comparison, selectedCandidateCounts: selectedCounts, categories: categoryResults,
  roundTripSuccess: `${roundTrips}/${rows.length}`, timing: { compressionAverageMs: compressionMs / rows.length, decompressionAverageMs: decompressionMs / rows.length },
  sourceSize: { metaCodecBytes: statSync(new URL("./meta-codec.js", import.meta.url)).size }, traces
};
const reportDirectory = "reports/generated";
const jsonPath = `${reportDirectory}/meta-v7-sample-report.json`;
const csvPath = `${reportDirectory}/meta-v7-sample-report.csv`;
mkdirSync(reportDirectory, { recursive: true });
writeFileSync(jsonPath, JSON.stringify(report, null, 2));
const header = ["index", "category", "selected", "forge_chars", "current_v6_chars", "hamr_chars", "hamr_eligible", "discard_reason", "final_chars", "final_wire_bits", "round_trip"];
const csv = [header.join(","), ...traces.map(trace => {
  const values = [trace.index, trace.category, trace.selectedCandidate, trace.candidates.combinedRetained.payloadCharacters, trace.candidates.currentV6Planner.payloadCharacters, trace.candidates.haMr.payloadCharacters, trace.candidates.haMr.eligible, trace.candidates.haMr.discardReason?.reason || trace.candidates.haMr.normalization?.differenceReason || "", trace.finalPayloadCharacters, trace.finalWireBits, trace.roundTripEquivalent];
  return values.map(value => { const text = String(value ?? ""); return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text; }).join(",");
})].join("\n");
writeFileSync(csvPath, `${csv}\n`);
console.log(`Completed meta-v7 sample: wins=${comparison.wins} ties=${comparison.ties} losses=${comparison.losses} excluded=${comparison.excludedUnsupportedHamr}.`);
console.log(`JSON: ${jsonPath}`);
console.log(`CSV: ${csvPath}`);
