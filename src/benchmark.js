import { performance } from "node:perf_hooks";
import { writeFileSync, mkdirSync } from "node:fs";
import { compress, decompress } from "./codec.js";
import { buildDataset } from "./dataset.js";
import { auditHamr } from "./hamr-audit.js";

const SHARED_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_".split("");
const OFF = { hostname: false, query: false, short: false, youtube: false, maps: false };
const only = feature => ({ ...OFF, [feature]: true });
const variants = {
  baselineSemanticHuffmanLz: { structural: false },
  hostname: { structural: only("hostname") },
  queryParameters: { structural: only("query") },
  shortUrls: { structural: only("short") },
  youtube: { structural: only("youtube") },
  googleMaps: { structural: only("maps") },
  allStructural: {}
};
const perCategory = Math.max(1, Number(process.argv[2]) || 100), dataset = buildDataset(perCategory);
const forgePrefix = "http://uf.mr#", hamrPrefix = "http://ha.mr#";
function percentile(values, ratio) { const sorted = [...values].sort((a, b) => a - b), position = (sorted.length - 1) * ratio, lower = Math.floor(position), fraction = position - lower; return sorted[lower] + ((sorted[lower + 1] ?? sorted[lower]) - sorted[lower]) * fraction; }
const summarize = values => ({ average: values.reduce((a, b) => a + b, 0) / values.length, median: percentile(values, 0.5), p90: percentile(values, 0.9), min: Math.min(...values), max: Math.max(...values) });
const blankComparison = () => ({ wins: 0, losses: 0, ties: 0 });
const compare = (bucket, left, right) => { if (left < right) bucket.wins++; else if (left > right) bucket.losses++; else bucket.ties++; };
const data = Object.fromEntries(Object.keys(variants).map(name => [name, { payloads: [], compressTimes: [], decompressTimes: [], roundTrips: 0, versusHamr: blankComparison(), categories: new Map() }]));
const hamrPayloads = [], rows = [], failureReasons = {}; let exactHamr = 0, normalizedHamr = 0, invalidHamr = 0;

for (const source of dataset) {
  const input = new URL(source.url).href, outputs = {};
  for (const [name, options] of Object.entries(variants)) {
    let start = performance.now(); const payload = compress(input, options), compressionMs = performance.now() - start;
    start = performance.now(); const decoded = decompress(payload), decompressionMs = performance.now() - start;
    const valid = decoded === input, item = data[name]; item.payloads.push(payload.length); item.compressTimes.push(compressionMs); item.decompressTimes.push(decompressionMs); if (valid) item.roundTrips++;
    const category = item.categories.get(source.category) || []; category.push(payload.length); item.categories.set(source.category, category);
    outputs[name] = { payloadLength: payload.length, completeLinkLength: forgePrefix.length + payload.length, roundTrip: valid };
  }
  const hamr = auditHamr(input, SHARED_ALPHABET);
  if (hamr.exact) exactHamr++; else if (hamr.valid) normalizedHamr++; else invalidHamr++;
  if (hamr.reason) failureReasons[hamr.reason] = (failureReasons[hamr.reason] || 0) + 1;
  if (hamr.valid) { hamrPayloads.push(hamr.payload.length); for (const [name, output] of Object.entries(outputs)) compare(data[name].versusHamr, output.payloadLength, hamr.payload.length); }
  rows.push({ category: source.category, input, originalLength: input.length, variants: outputs, hamr: { payloadLength: hamr.payload?.length ?? null, completeLinkLength: hamr.valid ? hamrPrefix.length + hamr.payload.length : null, exactRoundTrip: hamr.exact ?? false, normalizedRoundTrip: hamr.valid, failureReason: hamr.reason, failureDetail: hamr.detail } });
}

const summaries = Object.fromEntries(Object.entries(data).map(([name, value]) => [name, {
  options: variants[name], payload: summarize(value.payloads), completeLink: summarize(value.payloads.map(length => forgePrefix.length + length)),
  speed: { compressionMs: summarize(value.compressTimes), decompressionMs: summarize(value.decompressTimes) }, roundTrips: value.roundTrips,
  versusHamr: { payload: value.versusHamr, completeLink: { ...value.versusHamr } },
  categories: Object.fromEntries([...value.categories].map(([category, lengths]) => [category, summarize(lengths)]))
}]));

const baseline = summaries.baselineSemanticHuffmanLz, featureResults = {};
for (const name of ["hostname", "queryParameters", "shortUrls", "youtube", "googleMaps", "allStructural"]) {
  const candidate = summaries[name], categoryResults = {};
  for (const category of Object.keys(baseline.categories)) { const before = baseline.categories[category].average, after = candidate.categories[category].average; categoryResults[category] = { baseline: before, candidate: after, delta: after - before, result: after < before ? "improved" : after > before ? "worse" : "unchanged" }; }
  featureResults[name] = { averageDelta: candidate.payload.average - baseline.payload.average, medianDelta: candidate.payload.median - baseline.payload.median, p90Delta: candidate.payload.p90 - baseline.payload.p90, keep: candidate.roundTrips === dataset.length && candidate.payload.average < baseline.payload.average, categories: categoryResults };
}
const hamrSummary = summarize(hamrPayloads), report = {
  generatedAt: new Date().toISOString(), datasetSize: dataset.length, perCategory,
  normalization: "WHATWG URL canonicalization plus uppercase percent-escape hex digits",
  prefixes: { forge: forgePrefix, hamr: hamrPrefix, forgeLength: forgePrefix.length, hamrLength: hamrPrefix.length, equalLength: forgePrefix.length === hamrPrefix.length },
  alphabet: SHARED_ALPHABET.join(""), originalLength: summarize(rows.map(row => row.originalLength)), variants: summaries, featureResults,
  hamr: { payload: hamrSummary, completeLink: { average: hamrSummary.average + hamrPrefix.length, median: hamrSummary.median + hamrPrefix.length, p90: hamrSummary.p90 + hamrPrefix.length, min: hamrSummary.min + hamrPrefix.length, max: hamrSummary.max + hamrPrefix.length }, exactRoundTrips: exactHamr, normalizationDifferences: normalizedHamr, invalidRoundTrips: invalidHamr, failureReasons }, rows
};
const reportPath = "reports/generated/benchmark-report.json";
mkdirSync("reports/generated", { recursive: true });
writeFileSync(reportPath, JSON.stringify(report, null, 2));
console.log(`Dataset: ${dataset.length}; shared Base64URL alphabet; prefixes ${forgePrefix} / ${hamrPrefix} (${forgePrefix.length} each)`);
console.table(Object.fromEntries(Object.entries(summaries).map(([name, value]) => [name, { average: value.payload.average.toFixed(2), median: value.payload.median.toFixed(2), p90: value.payload.p90.toFixed(2), fullLink: value.completeLink.average.toFixed(2), roundTrips: `${value.roundTrips}/${dataset.length}`, wins: value.versusHamr.payload.wins, losses: value.versusHamr.payload.losses, ties: value.versusHamr.payload.ties }])));
console.log("Accounting invariant:", Object.fromEntries(Object.entries(summaries).map(([name, value]) => [name, JSON.stringify(value.versusHamr.payload) === JSON.stringify(value.versusHamr.completeLink)])));
console.log("Feature decisions:"); console.table(Object.fromEntries(Object.entries(featureResults).map(([name, value]) => [name, { averageDelta: value.averageDelta.toFixed(3), medianDelta: value.medianDelta.toFixed(3), p90Delta: value.p90Delta.toFixed(3), keep: value.keep }])));
console.log(`Report: ${reportPath}`);
