import { performance } from "node:perf_hooks";
import { mkdirSync, writeFileSync, statSync } from "node:fs";
import { compress, decompress } from "./codec.js";
import { buildDataset } from "./dataset.js";
import { buildHoldoutDataset, buildStressDataset, buildUnseenDataset } from "./validation-datasets.js";
import { auditHamr } from "./hamr-audit.js";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_".split(""), PREFIX = "http://uf.mr#";
const candidates = {
  rawLiteral: { huffman: false, lz: false, arithmetic: false },
  staticHuffman: { huffman: true, lz: false, arithmetic: false },
  lzPlusHuffman: { huffman: true, lz: true, arithmetic: false },
  lzPlusArithmetic: { huffman: false, lz: true, arithmetic: true },
  mixedGlobal: { huffman: true, lz: true, arithmetic: true }
};
function percentile(values, ratio) { const sorted = [...values].sort((a, b) => a - b), p = (sorted.length - 1) * ratio, i = Math.floor(p); return sorted[i] + ((sorted[i + 1] ?? sorted[i]) - sorted[i]) * (p - i); }
const stats = values => ({ average: values.reduce((a, b) => a + b, 0) / values.length, median: percentile(values, .5), p90: percentile(values, .9), p95: percentile(values, .95), maximum: Math.max(...values) });
const blank = () => ({ wins: 0, losses: 0, ties: 0 });
const compare = (bucket, a, b) => { if (a < b) bucket.wins++; else if (a > b) bucket.losses++; else bucket.ties++; };

function runDataset(name, rows) {
  const data = Object.fromEntries(Object.keys(candidates).map(candidate => [candidate, { payloads: [], compression: [], decompression: [], roundTrips: 0, versusHamr: blank(), categories: new Map() }]));
  let hamrInvalid = 0;
  for (const source of rows) {
    const input = new URL(source.url).href, hamr = auditHamr(input, ALPHABET); if (!hamr.valid) hamrInvalid++;
    for (const [candidate, options] of Object.entries(candidates)) {
      const item = data[candidate]; let start = performance.now(); const payload = compress(input, options); item.compression.push(performance.now() - start);
      start = performance.now(); const decoded = decompress(payload); item.decompression.push(performance.now() - start); if (decoded === input) item.roundTrips++;
      item.payloads.push(payload.length); if (hamr.valid) compare(item.versusHamr, payload.length, hamr.payload.length);
      const category = item.categories.get(source.category) || []; category.push(payload.length); item.categories.set(source.category, category);
    }
  }
  return { name, count: rows.length, hamrInvalid, candidates: Object.fromEntries(Object.entries(data).map(([candidate, item]) => [candidate, { payload: stats(item.payloads), completeLink: stats(item.payloads.map(length => PREFIX.length + length)), compressionMs: stats(item.compression), decompressionMs: stats(item.decompression), roundTrips: item.roundTrips, versusHamr: item.versusHamr, categories: Object.fromEntries([...item.categories].map(([category, values]) => [category, stats(values)])) }])) };
}

const stress = buildStressDataset();
const datasets = {
  development: runDataset("development", buildDataset(100)),
  holdout: runDataset("holdout", buildHoldoutDataset(50)),
  stress: runDataset("stress", stress.valid),
  unseen: runDataset("unseen", buildUnseenDataset(40))
};
const report = { generatedAt: new Date().toISOString(), prefix: PREFIX, candidates, payloadOverhead: { fixedFormatBits: 9, fixedFormatDescription: "3-bit version, 1-bit protocol, 5-bit terminator", literalHeaderBits: 6, huffmanHeaderBits: 10, lzHeaderBits: 5, statisticalHeaderBits: 8, completeLinkPrefixCharacters: PREFIX.length, note: "Every planner cost includes variable-length lengths and encoded block data." }, sourceSize: { codecBytes: statSync(new URL("./codec.js", import.meta.url)).size, benchmarkBytes: statSync(new URL("./advanced-benchmark.js", import.meta.url)).size }, datasets };
const reportPath = "reports/generated/advanced-compression-report.json";
mkdirSync("reports/generated", { recursive: true });
writeFileSync(reportPath, JSON.stringify(report, null, 2));
for (const dataset of Object.values(datasets)) { console.log(`\n${dataset.name}: ${dataset.count} URLs, ha.mr invalid ${dataset.hamrInvalid}`); console.table(Object.fromEntries(Object.entries(dataset.candidates).map(([name, value]) => [name, { average: value.payload.average.toFixed(2), median: value.payload.median.toFixed(2), p90: value.payload.p90.toFixed(2), p95: value.payload.p95.toFixed(2), max: value.payload.maximum, wins: value.versusHamr.wins, losses: value.versusHamr.losses, ties: value.versusHamr.ties, encodeMs: value.compressionMs.average.toFixed(3), decodeMs: value.decompressionMs.average.toFixed(3), roundTrips: `${value.roundTrips}/${dataset.count}` }]))); }
console.log("\nOverhead", report.payloadOverhead, "source", report.sourceSize);
console.log(`Report: ${reportPath}`);
