import { performance } from "node:perf_hooks";
import { mkdirSync, writeFileSync, statSync } from "node:fs";
import { compress, decompress } from "./codec.js";
import { buildDataset } from "./dataset.js";
import { buildHoldoutDataset, buildStressDataset } from "./validation-datasets.js";
import { auditHamr } from "./hamr-audit.js";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_".split("");
const FORGE_PREFIX = "http://uf.mr#", HAMR_PREFIX = "http://ha.mr#";
function percentile(values, ratio) { const sorted = [...values].sort((a, b) => a - b), position = (sorted.length - 1) * ratio, lower = Math.floor(position), fraction = position - lower; return sorted[lower] + ((sorted[lower + 1] ?? sorted[lower]) - sorted[lower]) * fraction; }
const stats = values => ({ average: values.reduce((a, b) => a + b, 0) / values.length, median: percentile(values, 0.5), p90: percentile(values, 0.9), p95: percentile(values, 0.95), maximum: Math.max(...values) });
const blank = () => ({ wins: 0, losses: 0, ties: 0 });
const compare = (bucket, left, right) => { if (left < right) bucket.wins++; else if (left > right) bucket.losses++; else bucket.ties++; };

function validateDataset(name, sourceRows, malformed = []) {
  const payloads = [], links = [], compressTimes = [], decompressTimes = [], fallbackPayloads = [], hamrPayloads = [], rows = [], categories = new Map(), versusHamr = blank();
  let roundTrips = 0, hamrValid = 0, hamrInvalid = 0, specializedSelected = 0, fallbackEqual = 0, structuralWorse = 0;
  for (const source of sourceRows) {
    const input = new URL(source.url).href;
    let start = performance.now(); const payload = compress(input), compressionMs = performance.now() - start;
    start = performance.now(); const decoded = decompress(payload), decompressionMs = performance.now() - start;
    const fallback = compress(input, { structural: false }), valid = decoded === input;
    if (valid) roundTrips++; payloads.push(payload.length); links.push(FORGE_PREFIX.length + payload.length); fallbackPayloads.push(fallback.length); compressTimes.push(compressionMs); decompressTimes.push(decompressionMs);
    if (payload.length < fallback.length) specializedSelected++; else if (payload.length === fallback.length) fallbackEqual++; else structuralWorse++;
    const hamr = auditHamr(input, ALPHABET);
    if (hamr.valid) { hamrValid++; hamrPayloads.push(hamr.payload.length); compare(versusHamr, payload.length, hamr.payload.length); } else hamrInvalid++;
    const category = categories.get(source.category) || { payloads: [], links: [], fallback: [], hamrPayloads: [], versusHamr: blank(), roundTrips: 0, hamrInvalid: 0 };
    category.payloads.push(payload.length); category.links.push(FORGE_PREFIX.length + payload.length); category.fallback.push(fallback.length); if (valid) category.roundTrips++;
    if (hamr.valid) { category.hamrPayloads.push(hamr.payload.length); compare(category.versusHamr, payload.length, hamr.payload.length); } else category.hamrInvalid++;
    categories.set(source.category, category);
    rows.push({ category: source.category, input, payloadLength: payload.length, fallbackPayloadLength: fallback.length, completeLinkLength: FORGE_PREFIX.length + payload.length, roundTrip: valid, compressionMs, decompressionMs, structuralResult: payload.length < fallback.length ? "selected-smaller" : payload.length === fallback.length ? "same-size" : "worse", hamrPayloadLength: hamr.payload?.length ?? null, hamrRoundTrip: hamr.valid, hamrFailureReason: hamr.reason });
  }
  const malformedResults = malformed.map(item => { let forgeRejected = false, forgeError = null; try { compress(item.url); } catch (error) { forgeRejected = true; forgeError = error.message; } let hamrRejected = false, hamrError = null; try { const result = auditHamr(item.url, ALPHABET); hamrRejected = !result.valid; hamrError = result.detail; } catch (error) { hamrRejected = true; hamrError = error.message; } return { ...item, forgeRejected, forgeError, hamrRejected, hamrError }; });
  const categorySummary = Object.fromEntries([...categories].map(([category, value]) => [category, { count: value.payloads.length, payload: stats(value.payloads), completeLink: stats(value.links), fallbackPayload: stats(value.fallback), hamrPayload: value.hamrPayloads.length ? stats(value.hamrPayloads) : null, structuralAverageDelta: stats(value.payloads).average - stats(value.fallback).average, versusHamr: value.versusHamr, roundTrips: value.roundTrips, hamrInvalid: value.hamrInvalid }]));
  return { name, count: sourceRows.length, payload: stats(payloads), completeLink: stats(links), universalFallbackPayload: stats(fallbackPayloads), structuralAverageDelta: stats(payloads).average - stats(fallbackPayloads).average, hamrPayload: hamrPayloads.length ? stats(hamrPayloads) : null, hamrCompleteLink: hamrPayloads.length ? stats(hamrPayloads.map(length => HAMR_PREFIX.length + length)) : null, versusHamr: { payload: versusHamr, completeLink: { ...versusHamr } }, timing: { compressionMs: stats(compressTimes), decompressionMs: stats(decompressTimes) }, roundTrips, hamrValid, hamrInvalid, fallbackAudit: { specializedSelected, fallbackEqual, structuralWorse }, malformed: { count: malformedResults.length, forgeRejected: malformedResults.filter(row => row.forgeRejected).length, allExpectedRejected: malformedResults.every(row => row.forgeRejected), rows: malformedResults }, categories: categorySummary, rows };
}

const stress = buildStressDataset();
const results = {
  development: validateDataset("development", buildDataset(100)),
  holdout: validateDataset("holdout", buildHoldoutDataset(50)),
  stress: validateDataset("stress", stress.valid, stress.malformed)
};
const report = { generatedAt: new Date().toISOString(), alphabet: ALPHABET.join(""), prefixes: { forge: FORGE_PREFIX, hamr: HAMR_PREFIX, equalLength: FORGE_PREFIX.length === HAMR_PREFIX.length }, sourceSize: { codecBytes: statSync(new URL("./codec.js", import.meta.url)).size, validationDatasetBytes: statSync(new URL("./validation-datasets.js", import.meta.url)).size, validationBenchmarkBytes: statSync(new URL("./validate-benchmark.js", import.meta.url)).size }, datasets: results };
const reportPath = "reports/generated/external-validation-report.json";
mkdirSync("reports/generated", { recursive: true });
writeFileSync(reportPath, JSON.stringify(report, null, 2));
for (const result of Object.values(results)) {
  console.log(`\n${result.name}: ${result.count} valid URLs`);
  console.table({ payload: result.payload, completeLink: result.completeLink, compressionMs: result.timing.compressionMs, decompressionMs: result.timing.decompressionMs });
  console.log("vs ha.mr", result.versusHamr.payload, "ha.mr", result.hamrPayload, "round-trip", `${result.roundTrips}/${result.count}`, "fallback", result.fallbackAudit, "structural average delta", result.structuralAverageDelta.toFixed(3), "malformed", result.malformed);
  console.table(Object.fromEntries(Object.entries(result.categories).map(([category, value]) => [category, { average: value.payload.average.toFixed(2), median: value.payload.median.toFixed(2), p90: value.payload.p90.toFixed(2), p95: value.payload.p95.toFixed(2), max: value.payload.maximum, hamrP90: value.hamrPayload?.p90.toFixed(2) ?? "n/a", wins: value.versusHamr.wins, losses: value.versusHamr.losses, ties: value.versusHamr.ties, structuralDelta: value.structuralAverageDelta.toFixed(2) }])));
}
console.log("\nSource size", report.sourceSize);
console.log(`Report: ${reportPath}`);
