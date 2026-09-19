import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { compress, compressDetailed, decompress } from "./codec.js";
import { buildDataset } from "./dataset.js";
import { auditHamr } from "./hamr-audit.js";
import { buildHoldoutDataset, buildStressDataset, buildUnseenDataset } from "./validation-datasets.js";

const UF_PREFIX = "http://uf.mr#";
const HAMR_PREFIX = "http://ha.mr#";
const HAMR_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_".split("");
const args = new Set(process.argv.slice(2));
const sample = args.has("--sample");
const reset = args.has("--reset");
const globalStreamBenchmark = args.has("--global-stream");
const structureAblationBenchmark = args.has("--structure-ablation");
const targetedBenchmark = globalStreamBenchmark || structureAblationBenchmark;
const stopArgument = process.argv.find(value => value.startsWith("--stop-after="));
const stopAfter = stopArgument ? Number(stopArgument.split("=")[1]) : Infinity;
const reportBase = structureAblationBenchmark ? "generic-structure-ablation" : globalStreamBenchmark ? "global-raw-stream-benchmark" : "local-benchmark";
const suffix = sample ? "-sample" : "";
const paths = {
  checkpoint: `reports/${reportBase}${suffix}-checkpoint.json`,
  json: `reports/${reportBase}${suffix}-report.json`,
  csv: `reports/${reportBase}${suffix}-report.csv`
};

const standardCandidates = Object.freeze({
  currentSemanticHuffmanLz: { huffman: true, lz: true, arithmetic: false },
  globalPlannerWithArithmetic: { huffman: true, lz: true, arithmetic: true }
});
const globalStreamCandidates = Object.freeze({
  currentSemanticHuffmanLz: { huffman: true, lz: true, arithmetic: false, globalRawStream: false },
  currentPlannerWithArithmetic: { huffman: true, lz: true, arithmetic: true, globalRawStream: false },
  globalRawStreamWithoutArithmetic: { huffman: false, lz: false, arithmetic: false, globalRawStream: true },
  globalRawStreamWithArithmetic: { huffman: true, lz: true, arithmetic: true, globalRawStream: true },
  globalRawStreamWithLzHuffman: { huffman: true, lz: true, arithmetic: false, globalRawStream: true }
});
const structureAblationCandidates = Object.freeze({
  currentV6Planner: { huffman: true, lz: true, arithmetic: true, globalRawStream: true },
  queryAsOneBlock: { huffman: true, lz: true, arithmetic: true, globalRawStream: true, queryOneBlock: true },
  directBinaryValues: { huffman: true, lz: true, arithmetic: true, globalRawStream: true, directBinaryValues: true }
});
const executableCandidates = structureAblationBenchmark ? structureAblationCandidates : globalStreamBenchmark ? globalStreamCandidates : standardCandidates;
const aliases = Object.freeze(targetedBenchmark ? {} : { globalPlannerWithoutArithmetic: "currentSemanticHuffmanLz" });
const candidateOrder = targetedBenchmark ? Object.keys(executableCandidates) : ["currentSemanticHuffmanLz", "globalPlannerWithoutArithmetic", "globalPlannerWithArithmetic"];

function datasets() {
  const stress = buildStressDataset();
  if (!sample) return {
    development: { rows: buildDataset(100), malformed: [] },
    holdout: { rows: buildHoldoutDataset(50), malformed: [] },
    stress: { rows: stress.valid, malformed: stress.malformed },
    unseen: { rows: buildUnseenDataset(40), malformed: [] }
  };
  const stressRows = [
    stress.valid.find(row => row.category === "unusual valid syntax"),
    stress.valid.find(row => row.category === "maximum semantic mixtures")
  ].filter(Boolean);
  if (targetedBenchmark) {
    const takeCategories = (rows, categories) => categories.map(category => rows.find(row => row.category === category)).filter(Boolean);
    return {
      development: { rows: takeCategories(buildDataset(1), ["short URLs", "numeric IDs", "fragments"]), malformed: [] },
      holdout: { rows: takeCategories(buildHoldoutDataset(1), ["unknown domains", "random long paths", "random query parameters", "unusual TLDs", "nested subdomains", "non-repeated paths", "short holdout", "duplicates and empty values", "holdout fragments"]), malformed: [] },
      stress: { rows: stressRows, malformed: stress.malformed.slice(0, 4) },
      unseen: { rows: takeCategories(buildUnseenDataset(1), ["CDN assets", "REST APIs", "signed URLs", "base64 values", "news articles"]), malformed: [] }
    };
  }
  return {
    development: { rows: buildDataset(1).slice(0, 6), malformed: [] },
    holdout: { rows: buildHoldoutDataset(1).slice(0, 6), malformed: [] },
    stress: { rows: stressRows, malformed: stress.malformed.slice(0, 4) },
    unseen: { rows: buildUnseenDataset(1).slice(0, 6), malformed: [] }
  };
}

const hashRows = rows => createHash("sha256").update(JSON.stringify(rows)).digest("hex");
const blankHistogram = () => ({});
const addHistogram = (histogram, value) => { const key = String(value); histogram[key] = (histogram[key] || 0) + 1; };
const blankComparison = () => ({ wins: 0, losses: 0, ties: 0, excludedInvalidHamr: 0 });
function compare(bucket, own, reference) {
  if (reference === null) bucket.excludedInvalidHamr++;
  else if (own < reference) bucket.wins++;
  else if (own > reference) bucket.losses++;
  else bucket.ties++;
}
function valuesFromHistogram(histogram) {
  return Object.entries(histogram).sort((a, b) => Number(a[0]) - Number(b[0])).flatMap(([value, count]) => Array(count).fill(Number(value)));
}
function percentile(sorted, ratio) {
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * ratio, lower = Math.floor(position), upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}
function histogramStats(histogram) {
  const values = valuesFromHistogram(histogram);
  if (!values.length) return { average: null, median: null, p90: null, p95: null, maximum: null };
  return {
    average: values.reduce((sum, value) => sum + value, 0) / values.length,
    median: percentile(values, 0.5), p90: percentile(values, 0.9), p95: percentile(values, 0.95), maximum: values.at(-1)
  };
}
const completeStats = payload => Object.fromEntries(Object.entries(payload).map(([key, value]) => [key, value === null ? null : value + UF_PREFIX.length]));
const blankTiming = () => ({ count: 0, totalMs: 0, maximumMs: 0 });
function addTiming(timing, duration) { timing.count++; timing.totalMs += duration; timing.maximumMs = Math.max(timing.maximumMs, duration); }
const timingStats = timing => ({ averageMs: timing.count ? timing.totalMs / timing.count : null, maximumMs: timing.count ? timing.maximumMs : null, totalMs: timing.totalMs });
const blankFraming = () => ({ count: 0, localSegmentedBits: 0, globalRawStreamBits: 0, baselineBits: 0, selectedBits: 0, savedBits: 0, savedVsBaselineBits: 0, maximumSavedBits: 0, selectedGlobal: 0, selectedLocal: 0 });
function addFraming(framing, plan) {
  if (plan.globalRawStreamBodyBits === null) return;
  framing.count++; framing.localSegmentedBits += plan.localSegmentedBodyBits; framing.globalRawStreamBits += plan.globalRawStreamBodyBits;
  framing.baselineBits += plan.baselineBodyBits; framing.selectedBits += plan.selectedBodyBits; framing.savedBits += plan.savedBodyBits; framing.savedVsBaselineBits += plan.savedVsBaselineBits; framing.maximumSavedBits = Math.max(framing.maximumSavedBits, plan.savedVsBaselineBits);
  if (plan.selectedRepresentation === "globalRawStream") framing.selectedGlobal++; else framing.selectedLocal++;
}
const framingStats = framing => framing?.count ? ({
  measured: framing.count, averageLocalSegmentedBits: framing.localSegmentedBits / framing.count, averageGlobalRawStreamBits: framing.globalRawStreamBits / framing.count,
  averageBaselineBits: framing.baselineBits / framing.count, averageSelectedBits: framing.selectedBits / framing.count, averageSavedBits: framing.savedBits / framing.count, totalSavedBits: framing.savedBits,
  averageSavedVsBaselineBits: framing.savedVsBaselineBits / framing.count, totalSavedVsBaselineBits: framing.savedVsBaselineBits,
  maximumSavedBits: framing.maximumSavedBits, selectedGlobal: framing.selectedGlobal, selectedLocal: framing.selectedLocal
}) : null;
function progress(dataset, candidate, index, count, started) {
  const elapsed = ((performance.now() - started) / 1000).toFixed(1), memory = (process.memoryUsage().rss / 1048576).toFixed(1);
  console.log(`[${dataset}] candidate=${candidate} url=${index}/${count} elapsed=${elapsed}s memory=${memory}MB`);
}
function csvCell(value) { const text = value === null || value === undefined ? "" : String(value); return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text; }

const inputs = datasets();
const datasetSignatures = Object.fromEntries(Object.entries(inputs).map(([name, value]) => [name, hashRows(value.rows)]));
const signatureInput = targetedBenchmark
  ? { schema: 2, benchmark: structureAblationBenchmark ? "genericStructureAblation" : "globalRawStream", sample, candidates: executableCandidates, aliases, datasets: datasetSignatures }
  : { schema: 1, sample, candidates: executableCandidates, aliases, datasets: datasetSignatures };
const signature = createHash("sha256").update(JSON.stringify(signatureInput)).digest("hex");
mkdirSync("reports", { recursive: true });
if (reset) for (const path of Object.values(paths)) rmSync(path, { force: true });

let checkpoint;
if (existsSync(paths.checkpoint)) {
  checkpoint = JSON.parse(readFileSync(paths.checkpoint, "utf8"));
  if (checkpoint.signature !== signature) throw new Error(`Checkpoint ${paths.checkpoint} belongs to a different deterministic benchmark configuration. Use --reset to replace it.`);
  const completed = Object.values(checkpoint.datasets).reduce((sum, item) => sum + Object.keys(item.candidates || {}).length, 0);
  console.log(`Resuming ${paths.checkpoint}; ${completed} unique candidate runs already complete.`);
} else {
  checkpoint = { schemaVersion: targetedBenchmark ? 2 : 1, signature, mode: sample ? "sample" : "full", createdAt: new Date().toISOString(), updatedAt: null, complete: false, datasets: {} };
}

function saveCheckpoint() {
  checkpoint.updatedAt = new Date().toISOString();
  writeFileSync(paths.checkpoint, JSON.stringify(checkpoint, null, 2));
}

function ensureDataset(name, source) {
  const fingerprint = hashRows(source.rows);
  const stored = checkpoint.datasets[name];
  if (stored && stored.fingerprint !== fingerprint) throw new Error(`Dataset ${name} changed since the checkpoint was created.`);
  return checkpoint.datasets[name] ||= { count: source.rows.length, fingerprint, reference: null, malformed: null, candidates: {} };
}

function runReference(name, rows, state) {
  if (state.reference) return;
  const payloads = [], histogram = blankHistogram(), reasons = {}, started = performance.now(), every = sample ? 2 : 5;
  for (let index = 0; index < rows.length; index++) {
    const input = new URL(rows[index].url).href, audit = auditHamr(input, HAMR_ALPHABET), length = audit.valid ? audit.payload.length : null;
    payloads.push(length);
    if (length === null) reasons[audit.reason || "unknown"] = (reasons[audit.reason || "unknown"] || 0) + 1;
    else addHistogram(histogram, length);
    if ((index + 1) % every === 0 || index + 1 === rows.length) progress(name, "ha.mr-reference", index + 1, rows.length, started);
  }
  state.reference = { payloads, payload: histogramStats(histogram), invalid: payloads.filter(value => value === null).length, failureReasons: reasons };
  saveCheckpoint();
}

function validateMalformed(rows) {
  let rejected = 0, accepted = 0;
  for (const row of rows) { try { compress(row.url); accepted++; } catch { rejected++; } }
  return { count: rows.length, rejected, accepted };
}

function runCandidate(datasetName, rows, state, candidateName, options) {
  if (state.candidates[candidateName]) return false;
  const result = { count: rows.length, payloadHistogram: blankHistogram(), categories: {}, compression: blankTiming(), decompression: blankTiming(), comparison: blankComparison(), framing: blankFraming(), candidateSelections: 0, roundTrips: 0, failures: [] };
  const started = performance.now(), every = sample ? 2 : 5;
  for (let index = 0; index < rows.length; index++) {
    const source = rows[index], input = new URL(source.url).href;
    let mark = performance.now(); const detail = compressDetailed(input, options), payload = detail.payload; addTiming(result.compression, performance.now() - mark); addFraming(result.framing, detail.plan);
    mark = performance.now(); const decoded = decompress(payload); addTiming(result.decompression, performance.now() - mark);
    if (decoded === input) result.roundTrips++; else result.failures.push({ index, category: source.category, expected: input, actual: decoded });
    addHistogram(result.payloadHistogram, payload.length);
    const selectedFeature = candidateName === "directBinaryValues" ? (detail.plan.selectedFeatures.directBinaryValues || 0) > 0 : candidateName === "queryAsOneBlock" ? detail.plan.selectedRepresentation === candidateName : false;
    if (selectedFeature) result.candidateSelections++;
    const category = result.categories[source.category] ||= { count: 0, payloadHistogram: blankHistogram(), comparison: blankComparison(), framing: blankFraming(), candidateSelections: 0 };
    if (selectedFeature) category.candidateSelections++;
    category.count++; addHistogram(category.payloadHistogram, payload.length); addFraming(category.framing, detail.plan);
    const reference = state.reference.payloads[index]; compare(result.comparison, payload.length, reference); compare(category.comparison, payload.length, reference);
    if ((index + 1) % every === 0 || index + 1 === rows.length) progress(datasetName, candidateName, index + 1, rows.length, started);
  }
  if (result.roundTrips !== rows.length) throw new Error(`${datasetName}/${candidateName}: ${rows.length - result.roundTrips} URL Forge round-trip failures`);
  state.candidates[candidateName] = result; saveCheckpoint(); writeReports(false); return true;
}

function candidateSummary(result) {
  const payload = histogramStats(result.payloadHistogram);
  return {
    count: result.count, payload, completeLink: completeStats(payload), compression: timingStats(result.compression), decompression: timingStats(result.decompression), framingOverheadBits: framingStats(result.framing), candidateSelections: result.candidateSelections || 0,
    roundTrips: result.roundTrips, roundTripSuccess: `${result.roundTrips}/${result.count}`, versusHamr: result.comparison,
    categories: Object.fromEntries(Object.entries(result.categories).map(([name, category]) => [name, { count: category.count, payload: histogramStats(category.payloadHistogram), versusHamr: category.comparison, framingOverheadBits: framingStats(category.framing), candidateSelections: category.candidateSelections || 0 }]))
  };
}

function buildReport(complete) {
  const reportDatasets = {};
  for (const [datasetName, source] of Object.entries(inputs)) {
    const state = checkpoint.datasets[datasetName]; if (!state) continue;
    const candidateReports = {};
    for (const name of candidateOrder) {
      const measured = aliases[name] || name, result = state.candidates[measured];
      if (result) candidateReports[name] = { ...candidateSummary(result), ...(aliases[name] ? { equivalentTo: measured, note: "Identical selectable representation; measured once to avoid duplicate comparison." } : {}) };
    }
    reportDatasets[datasetName] = { count: source.rows.length, haMr: state.reference ? { payload: state.reference.payload, completeLink: Object.fromEntries(Object.entries(state.reference.payload).map(([key, value]) => [key, value === null ? null : value + HAMR_PREFIX.length])), invalid: state.reference.invalid, failureReasons: state.reference.failureReasons } : null, malformed: state.malformed, candidates: candidateReports };
  }
  return {
    schemaVersion: targetedBenchmark ? 2 : 1, generatedAt: new Date().toISOString(), status: complete ? "complete" : "partial", deterministicSignature: signature,
    benchmark: structureAblationBenchmark ? "generic structure ablation" : globalStreamBenchmark ? "globalRawStream ablation" : "standard", mode: sample ? "sample" : "full", prefixes: { urlForge: UF_PREFIX, haMr: HAMR_PREFIX, equalLength: UF_PREFIX.length === HAMR_PREFIX.length, characters: UF_PREFIX.length },
    candidates: { ...executableCandidates, ...(!targetedBenchmark ? { globalPlannerWithoutArithmetic: { equivalentTo: "currentSemanticHuffmanLz" } } : {}) },
    payloadOverhead: { fixedFormatBits: 9, rawLiteralHeaderBits: 6, huffmanHeaderBits: 10, lzHeaderBits: 5, arithmeticHeaderBits: 8, globalStreamBoundaryBits: 0, note: "Global stream boundaries are reconstructed from URL delimiters. Measured framing compares complete body bitstreams and includes token and block headers." },
    sourceSize: { codecBytes: statSync(new URL("./codec.js", import.meta.url)).size, localBenchmarkBytes: statSync(new URL("./local-benchmark.js", import.meta.url)).size }, datasets: reportDatasets
  };
}

function writeReports(complete) {
  const report = buildReport(complete); writeFileSync(paths.json, JSON.stringify(report, null, 2));
  const header = ["dataset", "candidate", "count", "average_payload", "median_payload", "p90_payload", "p95_payload", "maximum_payload", "average_complete_link", "wins", "losses", "ties", "hamr_invalid", "compression_average_ms", "decompression_average_ms", "round_trips", "average_local_segmented_bits", "average_global_stream_bits", "average_bits_saved_vs_v6", "candidate_selections", "global_selected", "local_selected", "equivalent_to"];
  const lines = [header.join(",")];
  for (const [dataset, item] of Object.entries(report.datasets)) for (const [candidate, value] of Object.entries(item.candidates)) lines.push([
    dataset, candidate, value.count, value.payload.average, value.payload.median, value.payload.p90, value.payload.p95, value.payload.maximum, value.completeLink.average,
    value.versusHamr.wins, value.versusHamr.losses, value.versusHamr.ties, item.haMr?.invalid, value.compression.averageMs, value.decompression.averageMs, value.roundTripSuccess,
    value.framingOverheadBits?.averageLocalSegmentedBits, value.framingOverheadBits?.averageGlobalRawStreamBits, value.framingOverheadBits?.averageSavedVsBaselineBits, value.candidateSelections,
    value.framingOverheadBits?.selectedGlobal, value.framingOverheadBits?.selectedLocal, value.equivalentTo || ""
  ].map(csvCell).join(","));
  writeFileSync(paths.csv, `${lines.join("\n")}\n`);
}

let newlyCompleted = 0;
for (const [datasetName, source] of Object.entries(inputs)) {
  const state = ensureDataset(datasetName, source); runReference(datasetName, source.rows, state);
  if (!state.malformed) { state.malformed = validateMalformed(source.malformed); saveCheckpoint(); }
  for (const [candidateName, options] of Object.entries(executableCandidates)) {
    if (runCandidate(datasetName, source.rows, state, candidateName, options)) newlyCompleted++;
    if (newlyCompleted >= stopAfter) { writeReports(false); console.log(`Checkpoint saved after ${newlyCompleted} new candidate runs. Resume with the same command without --reset or --stop-after.`); process.exit(0); }
  }
  writeReports(false);
}

checkpoint.complete = true; saveCheckpoint(); writeReports(true);
const report = buildReport(true), total = Object.values(report.datasets).reduce((sum, item) => sum + item.count, 0);
console.log(`Completed ${sample ? "sample" : "full"} local benchmark: ${total} URLs, all URL Forge round-trips passed.`);
console.log(`JSON: ${paths.json}`); console.log(`CSV: ${paths.csv}`); console.log(`Checkpoint: ${paths.checkpoint}`);
