import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { compressCombinedDetailed, compressDetailed, decompress } from "./codec.js";
import { auditOutputAlphabet, BASE64URL_ALPHABET, SAFE_FRAGMENT_ALPHABET } from "./output-encoding.js";
import { buildDataset } from "./dataset.js";
import { auditHamr } from "./hamr-audit.js";
import { buildHoldoutDataset, buildStressDataset, buildUnseenDataset } from "./validation-datasets.js";

const PREFIX = "http://uf.mr#", HAMR_PREFIX = "http://ha.mr#", BROWSER_PREFIX_LENGTH = new URL(PREFIX).href.length;
const args = new Set(process.argv.slice(2)), sample = args.has("--sample"), reset = args.has("--reset");
const contextExperiment = args.has("--context-experiment"), stressOnly = args.has("--stress");
const mode = contextExperiment ? "context-experiment" : stressOnly ? "stress" : "normal";
const stopArgument = process.argv.find(value => value.startsWith("--stop-after="));
const stopAfter = stopArgument ? Number(stopArgument.split("=")[1]) : Infinity;
const suffix = sample ? "-sample" : "";
const checkpointBase = contextExperiment ? "context-arithmetic-experiment" : "final-output-benchmark";
const reportBase = contextExperiment ? "context-arithmetic-experiment" : stressOnly ? "final-output-stress" : "final-output-benchmark";
const paths = { checkpoint: `reports/${checkpointBase}${suffix}-checkpoint.json`, json: `reports/${reportBase}${suffix}-report.json`, csv: `reports/${reportBase}${suffix}-report.csv` };

const productionCandidates = Object.freeze({
  currentV6Planner: (url, alphabet) => compressDetailed(url, { huffman: true, lz: true, arithmetic: true, globalRawStream: true, outputAlphabet: alphabet }),
  combinedRetained: (url, alphabet) => compressCombinedDetailed(url, { outputAlphabet: alphabet, contextArithmetic: false })
});
const experimentalCandidates = Object.freeze({ combinedWithContextArithmetic: (url, alphabet) => compressCombinedDetailed(url, { outputAlphabet: alphabet, contextArithmetic: true }) });
const candidates = contextExperiment ? experimentalCandidates : productionCandidates, reportCandidateNames = Object.keys(candidates);

function buildAllDatasets() {
  const stress = buildStressDataset();
  if (!sample) return { development: buildDataset(100), holdout: buildHoldoutDataset(50), stress: stress.valid, unseen: buildUnseenDataset(40) };
  const select = (rows, categories) => categories.map(category => rows.find(row => row.category === category)).filter(Boolean);
  return {
    development: select(buildDataset(1), ["short URLs", "long paths", "numeric IDs", "random URLs", "URLs with Unicode", "fragments"]),
    holdout: select(buildHoldoutDataset(1), ["unknown domains", "random long paths", "random query parameters", "unusual TLDs", "nested subdomains", "short holdout", "duplicates and empty values", "percent-encoded values", "holdout fragments"]),
    stress: select(stress.valid, ["very long URLs", "high-entropy values", "unusual valid syntax", "repeated LZ limits", "maximum semantic mixtures"]),
    unseen: select(buildUnseenDataset(1), ["CDN assets", "REST APIs", "signed URLs", "base64 values", "news articles"])
  };
}

const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const add = (histogram, value) => { const key = String(value); histogram[key] = (histogram[key] || 0) + 1; };
const tick = (histogram, key) => { histogram[key] = (histogram[key] || 0) + 1; };
const blankComparison = () => ({ wins: 0, losses: 0, ties: 0, excludedInvalidHamr: 0 });
function compare(bucket, own, reference) { if (reference === null) bucket.excludedInvalidHamr++; else if (own < reference) bucket.wins++; else if (own > reference) bucket.losses++; else bucket.ties++; }
function values(histogram) { return Object.entries(histogram).sort((a, b) => Number(a[0]) - Number(b[0])).flatMap(([value, count]) => Array(count).fill(Number(value))); }
function percentile(sorted, fraction) { if (!sorted.length) return null; const position = (sorted.length - 1) * fraction, low = Math.floor(position), high = Math.ceil(position); return sorted[low] + (sorted[high] - sorted[low]) * (position - low); }
function stats(histogram) { const sorted = values(histogram); return sorted.length ? { average: sorted.reduce((sum, value) => sum + value, 0) / sorted.length, median: percentile(sorted, .5), p90: percentile(sorted, .9), p95: percentile(sorted, .95), maximum: sorted.at(-1) } : { average: null, median: null, p90: null, p95: null, maximum: null }; }
function csvCell(value) { const string = value === null || value === undefined ? "" : String(value); return /[",\n]/.test(string) ? `"${string.replaceAll('"', '""')}"` : string; }
function progress(dataset, candidate, index, total, started) { console.log(`[${dataset}] candidate=${candidate} url=${index}/${total} elapsed=${((performance.now() - started) / 1000).toFixed(1)}s memory=${(process.memoryUsage().rss / 1048576).toFixed(1)}MB`); }
function stressProgress(dataset, candidate, index, total, elapsedMs) {
  console.log(`[${dataset}] candidate=${candidate} url=${index}/${total} urlElapsed=${(elapsedMs / 1000).toFixed(1)}s memory=${(process.memoryUsage().rss / 1048576).toFixed(1)}MB`);
  if (elapsedMs > 60000) console.warn(`WARNING: [${dataset}] candidate=${candidate} url=${index}/${total} exceeded 60 seconds (${(elapsedMs / 1000).toFixed(1)}s); result was retained.`);
}

const allDatasets = buildAllDatasets(), activeDatasetNames = stressOnly ? ["stress"] : ["development", "holdout", "unseen"];
const datasetFingerprints = Object.fromEntries(Object.entries(allDatasets).map(([name, rows]) => [name, hash(rows)]));
const configurationSignature = hash({ schema: 2, sample, datasets: datasetFingerprints, productionCandidates: Object.keys(productionCandidates) });
mkdirSync("reports", { recursive: true });
if (reset) for (const path of Object.values(paths)) rmSync(path, { force: true });
let checkpoint = existsSync(paths.checkpoint) ? JSON.parse(readFileSync(paths.checkpoint, "utf8")) : { schemaVersion: 2, configurationSignature, complete: false, completedModes: {}, datasets: {} };
if (!contextExperiment && !checkpoint.configurationSignature) {
  checkpoint.legacySignatures = [...new Set([...(checkpoint.legacySignatures || []), checkpoint.signature].filter(Boolean))];
  checkpoint.schemaVersion = 2; checkpoint.configurationSignature = configurationSignature; checkpoint.completedModes ||= {};
}
if (checkpoint.configurationSignature !== configurationSignature) throw new Error("Checkpoint datasets differ from this deterministic benchmark configuration. Use --reset only if you intend to discard it.");
checkpoint.completedModes ||= {};

function save() { checkpoint.updatedAt = new Date().toISOString(); writeFileSync(paths.checkpoint, JSON.stringify(checkpoint, null, 2)); }
function ensureDataset(name) {
  const rows = allDatasets[name], fingerprint = datasetFingerprints[name], state = checkpoint.datasets[name];
  if (state && state.fingerprint !== fingerprint) throw new Error(`Dataset ${name} changed; refusing to recompress completed work.`);
  return checkpoint.datasets[name] ||= { count: rows.length, fingerprint, reference: null, candidates: {}, inProgress: {} };
}

function runReference(datasetName, rows, state) {
  if (state.reference) return false;
  state.inProgress ||= {};
  const partial = state.inProgress.reference ||= { nextIndex: 0, best: [], fair: [], invalidReasons: {} }, started = performance.now();
  for (let index = partial.nextIndex; index < rows.length; index++) {
    const itemStarted = performance.now(), url = new URL(rows[index].url).href;
    const bestAudit = auditHamr(url, [...SAFE_FRAGMENT_ALPHABET]), fairAudit = auditHamr(url, [...BASE64URL_ALPHABET]);
    partial.best.push(bestAudit.valid ? bestAudit.payload.length : null); partial.fair.push(fairAudit.valid ? fairAudit.payload.length : null);
    for (const audit of [bestAudit, fairAudit]) if (!audit.valid) tick(partial.invalidReasons, audit.reason || "unknown");
    partial.nextIndex = index + 1;
    if (stressOnly) { save(); stressProgress(datasetName, "ha.mr-reference", index + 1, rows.length, performance.now() - itemStarted); }
    else if ((index + 1) % (sample ? 2 : 10) === 0 || index + 1 === rows.length) progress(datasetName, "ha.mr-reference", index + 1, rows.length, started);
  }
  state.reference = { best: partial.best, fair: partial.fair, invalidReasons: partial.invalidReasons }; delete state.inProgress.reference; save(); return true;
}

const blankResult = count => ({ count, payloadBest: {}, payloadFair: {}, bits: {}, linksBest: {}, linksFair: {}, browserLinksBest: {}, browserLinksFair: {}, alphabets: {}, representations: {}, features: {}, combinedCandidates: {}, bestComparison: blankComparison(), fairComparison: blankComparison(), roundTrips: 0, compressionMs: 0, decompressionMs: 0, paddingBits: 0, radixCapacityBits: 0, categories: {} });
function categoryBucket(result, name) { return result.categories[name] ||= { count: 0, payloadBest: {}, payloadFair: {}, bestComparison: blankComparison(), fairComparison: blankComparison(), alphabets: {}, representations: {} }; }
function measureUrl(datasetName, row, index, state, result, encode) {
  const url = new URL(row.url).href; let mark = performance.now();
  const best = encode(url, "best"), fair = encode(url, "base64url"); result.compressionMs += performance.now() - mark;
  mark = performance.now(); const bestDecoded = decompress(best.payload, { outputAlphabet: best.outputAlphabet }), fairDecoded = decompress(fair.payload); result.decompressionMs += performance.now() - mark;
  if (bestDecoded !== url || fairDecoded !== url) throw new Error(`${datasetName}/${index}: round-trip failure`);
  result.roundTrips++;
  add(result.payloadBest, best.payload.length); add(result.payloadFair, fair.payload.length); add(result.bits, best.bitLength); add(result.linksBest, PREFIX.length + best.payload.length); add(result.linksFair, PREFIX.length + fair.payload.length); add(result.browserLinksBest, BROWSER_PREFIX_LENGTH + best.payload.length); add(result.browserLinksFair, BROWSER_PREFIX_LENGTH + fair.payload.length);
  tick(result.alphabets, best.outputAlphabet); tick(result.representations, best.plan.selectedRepresentation); for (const [feature, count] of Object.entries(best.plan.selectedFeatures)) result.features[feature] = (result.features[feature] || 0) + count; if (best.combinedCandidate) tick(result.combinedCandidates, best.combinedCandidate);
  result.paddingBits += Math.ceil(best.bitLength / 8) * 8 - best.bitLength; result.radixCapacityBits += best.payload.length * Math.log2(best.outputAlphabet === "safe65" ? 65 : 64) - best.bitLength;
  compare(result.bestComparison, best.payload.length, state.reference.best[index]); compare(result.fairComparison, fair.payload.length, state.reference.fair[index]);
  const category = categoryBucket(result, row.category); category.count++; add(category.payloadBest, best.payload.length); add(category.payloadFair, fair.payload.length); tick(category.alphabets, best.outputAlphabet); tick(category.representations, best.plan.selectedRepresentation); compare(category.bestComparison, best.payload.length, state.reference.best[index]); compare(category.fairComparison, fair.payload.length, state.reference.fair[index]);
}
function runCandidate(datasetName, rows, state, name, encode) {
  if (state.candidates[name]) return false;
  state.inProgress ||= {};
  const partial = state.inProgress[name] ||= { nextIndex: 0, result: blankResult(rows.length) }, started = performance.now();
  for (let index = partial.nextIndex; index < rows.length; index++) {
    const itemStarted = performance.now(); measureUrl(datasetName, rows[index], index, state, partial.result, encode); partial.nextIndex = index + 1;
    if (stressOnly) { save(); stressProgress(datasetName, name, index + 1, rows.length, performance.now() - itemStarted); }
    else if ((index + 1) % (sample ? 2 : 10) === 0 || index + 1 === rows.length) progress(datasetName, name, index + 1, rows.length, started);
  }
  state.candidates[name] = partial.result; delete state.inProgress[name]; save(); writeReports(false); return true;
}

function summarize(result) {
  return {
    count: result.count, payloadCharacters: { bestValidAlphabet: stats(result.payloadBest), fairBase64Url: stats(result.payloadFair) }, bitLength: stats(result.bits),
    finalVisibleLink: { specified13CharacterPrefix: { bestValidAlphabet: stats(result.linksBest), fairBase64Url: stats(result.linksFair) }, browserCanonical14CharacterPrefix: { bestValidAlphabet: stats(result.browserLinksBest), fairBase64Url: stats(result.browserLinksFair) } }, outputAlphabetCounts: result.alphabets,
    selectedRepresentationCounts: result.representations, selectedFeatureCounts: result.features, selectedCombinedCandidateCounts: result.combinedCandidates,
    versusHamr: { realBestValidAlphabet: result.bestComparison, fairBase64Url: result.fairComparison }, roundTripSuccess: `${result.roundTrips}/${result.count}`,
    timing: { compressionAverageMs: result.compressionMs / result.count, decompressionAverageMs: result.decompressionMs / result.count },
    payloadOverhead: { averageBytePaddingBits: result.paddingBits / result.count, averageRadixCapacityMinusPayloadBits: result.radixCapacityBits / result.count },
    categories: Object.fromEntries(Object.entries(result.categories).map(([name, category]) => [name, { count: category.count, payloadCharacters: { bestValidAlphabet: stats(category.payloadBest), fairBase64Url: stats(category.payloadFair) }, outputAlphabetCounts: category.alphabets, selectedRepresentationCounts: category.representations, versusHamr: { realBestValidAlphabet: category.bestComparison, fairBase64Url: category.fairComparison } }]))
  };
}
function modeComplete(datasetNames) { return datasetNames.every(name => { const state = checkpoint.datasets[name]; return state?.reference && reportCandidateNames.every(candidate => state.candidates?.[candidate]); }); }
function buildReport(complete) {
  const visibleDatasets = activeDatasetNames;
  return {
    schemaVersion: 2, status: complete ? "complete" : "partial", generatedAt: new Date().toISOString(), invocationMode: mode, datasetScope: activeDatasetNames, deterministicSignature: configurationSignature,
    candidates: reportCandidateNames, excludedCandidates: contextExperiment ? [] : ["combinedWithContextArithmetic"],
    prefixes: { urlForge: PREFIX, haMr: HAMR_PREFIX, specifiedCharacters: PREFIX.length, browserCanonicalCharacters: BROWSER_PREFIX_LENGTH, note: "WHATWG URL serialization inserts '/' before the fragment; both domains gain the same one character." },
    alphabets: { base64url: auditOutputAlphabet("base64url"), safe65: auditOutputAlphabet("safe65"), haMrAsciiRejected: { reason: "Contains # and shell/Markdown punctuation; not counted as a safe visible-fragment alphabet." } },
    comparisonModes: { realBestValidAlphabet: "Each codec uses safe65, the largest enabled alphabet passing every required transport audit.", fairBase64Url: "Both codecs use exactly Base64URL." },
    sourceSize: { codecBytes: statSync(new URL("./codec.js", import.meta.url)).size, outputEncodingBytes: statSync(new URL("./output-encoding.js", import.meta.url)).size, benchmarkBytes: statSync(new URL(import.meta.url)).size },
    datasets: Object.fromEntries(visibleDatasets.map(name => { const rows = allDatasets[name], state = checkpoint.datasets[name]; const measured = Object.fromEntries(reportCandidateNames.flatMap(candidate => state?.candidates?.[candidate] ? [[candidate, summarize(state.candidates[candidate])]] : [])); return [name, { count: rows.length, completed: Boolean(state?.reference) && reportCandidateNames.every(candidate => state?.candidates?.[candidate]), haMrInvalidReasons: state?.reference?.invalidReasons || {}, candidates: measured }]; }))
  };
}
function writeReports(complete) {
  const report = buildReport(complete); writeFileSync(paths.json, JSON.stringify(report, null, 2));
  const header = ["dataset", "candidate", "count", "average_payload_best", "median_payload_best", "p90_payload_best", "p95_payload_best", "max_payload_best", "average_link_specified_prefix", "average_link_browser_canonical", "average_bits", "best_wins", "best_losses", "best_ties", "fair_wins", "fair_losses", "fair_ties", "round_trips", "compression_average_ms", "decompression_average_ms", "alphabet_counts", "representation_counts"];
  const lines = [header.join(",")];
  for (const [dataset, item] of Object.entries(report.datasets)) for (const [candidate, value] of Object.entries(item.candidates)) lines.push([dataset, candidate, value.count, value.payloadCharacters.bestValidAlphabet.average, value.payloadCharacters.bestValidAlphabet.median, value.payloadCharacters.bestValidAlphabet.p90, value.payloadCharacters.bestValidAlphabet.p95, value.payloadCharacters.bestValidAlphabet.maximum, value.finalVisibleLink.specified13CharacterPrefix.bestValidAlphabet.average, value.finalVisibleLink.browserCanonical14CharacterPrefix.bestValidAlphabet.average, value.bitLength.average, value.versusHamr.realBestValidAlphabet.wins, value.versusHamr.realBestValidAlphabet.losses, value.versusHamr.realBestValidAlphabet.ties, value.versusHamr.fairBase64Url.wins, value.versusHamr.fairBase64Url.losses, value.versusHamr.fairBase64Url.ties, value.roundTripSuccess, value.timing.compressionAverageMs, value.timing.decompressionAverageMs, JSON.stringify(value.outputAlphabetCounts), JSON.stringify(value.selectedRepresentationCounts)].map(csvCell).join(","));
  writeFileSync(paths.csv, `${lines.join("\n")}\n`);
}

let completedRuns = 0;
for (const datasetName of activeDatasetNames) {
  const rows = allDatasets[datasetName], state = ensureDataset(datasetName); runReference(datasetName, rows, state);
  for (const [name, encode] of Object.entries(candidates)) {
    if (runCandidate(datasetName, rows, state, name, encode)) completedRuns++;
    if (completedRuns >= stopAfter) { writeReports(false); console.log("Checkpoint saved. Resume with the same command without --reset or --stop-after."); process.exit(0); }
  }
}
checkpoint.completedModes[mode] = true;
if (!contextExperiment) checkpoint.complete = modeComplete(["development", "holdout", "stress", "unseen"]);
save(); writeReports(modeComplete(activeDatasetNames));
console.log(`Completed ${sample ? "sample " : ""}${mode} final-output benchmark; all measured URL Forge round-trips passed.`);
console.log(`JSON: ${paths.json}`); console.log(`CSV: ${paths.csv}`); console.log(`Checkpoint: ${paths.checkpoint}`);
