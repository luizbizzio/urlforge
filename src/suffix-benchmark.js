import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { buildDataset } from "./dataset.js";
import { buildHoldoutDataset, buildUnseenDataset } from "./validation-datasets.js";
import { compressMetaV7, tryDecompress } from "./meta-codec.js";
import { SAFE_FRAGMENT_ALPHABET } from "./output-encoding.js";
import { collectPublicUrls, collectQueryHoldout, publicUrls } from "./suffix-datasets.js";
import { createCompressionResult } from "./web/url-service.js";
import { resolvePayloadFragment } from "./web/redirect.js";
import { normalizeShortUrlBase } from "./web/config.js";
import { outputAlphabetASCII } from "../vendor/ha.mr/docs/alphabets.js";
import { compress as compressHamr, decompress as decompressHamr } from "../vendor/ha.mr/docs/compress.js";

const { values } = parseArgs({ options: {
  base: { type: "string", default: "https://bench.example/#" },
  "per-category": { type: "string", default: "10" },
  ada: { type: "string" },
  holdout: { type: "string" }
} });
const perCategory = Number(values["per-category"]);
if (!Number.isSafeInteger(perCategory) || perCategory < 1) throw new Error("--per-category must be a positive integer");
const base = normalizeShortUrlBase(values.base);
const cohorts = {
  development: buildDataset(perCategory),
  generatedHoldout: buildHoldoutDataset(perCategory),
  generatedUnseen: buildUnseenDataset(perCategory)
};
const holdoutPath = values.holdout ?? new URL("../test/fixtures/hacker-news-2026-11-23.txt", import.meta.url);
const holdoutText = readFileSync(holdoutPath, "utf8");
const fingerprints = { holdout: createHash("sha256").update(holdoutText).digest("hex") };
cohorts.publicHoldout = publicUrls(holdoutText).map(url => ({ url: url.href, category: suffixType(url) }));
if (values.ada) {
  const ada = readFileSync(values.ada, "utf8");
  fingerprints.ada = createHash("sha256").update(ada).digest("hex");
  const datasets = collectPublicUrls(ada, holdoutText);
  cohorts.adaHoldout = datasets.adaHoldout.map(url => ({ url: url.href, category: suffixType(url) }));
  cohorts.queryHoldout = collectQueryHoldout(ada, datasets).map(url => ({ url: url.href, category: "query" }));
}

function suffixType(url) {
  const tail = url.href.slice(url.origin.length);
  return tail.split("#", 1)[0].includes("?") ? "query" : tail.includes("#") ? "fragment" : "path";
}

function compare(results, extract) {
  const deltas = results.flatMap(result => {
    const reference = extract(result);
    return reference === null ? [] : [result.current - reference];
  });
  return {
    comparable: deltas.length,
    wins: deltas.filter(value => value < 0).length,
    ties: deltas.filter(value => value === 0).length,
    losses: deltas.filter(value => value > 0).length,
    meanDeltaCharacters: average(deltas),
    bestGainCharacters: Math.max(0, ...deltas.map(value => -value))
  };
}

function average(values) {
  return values.length ? +(values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(3) : null;
}

function p95(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted.length ? +sorted[Math.ceil(sorted.length * 0.95) - 1].toFixed(3) : null;
}

function reference(input, alphabet) {
  try {
    const payload = compressHamr(input, alphabet);
    const shortUrl = new URL(base + payload);
    return new URL(decompressHamr(shortUrl.hash.slice(1), alphabet)).href === input ? shortUrl.href.length : null;
  } catch { return null; }
}

function measure(row) {
  const input = new URL(row.url).href;
  const legacy = compressMetaV7(input, { includeReference: false });
  const legacyExact = tryDecompress(legacy.payload).value === input;
  const start = performance.now();
  const result = createCompressionResult(input, base);
  const encodeMs = performance.now() - start;
  const open = performance.now();
  const short = new URL(result.shortUrl);
  const restored = resolvePayloadFragment(short.hash);
  const decodeMs = performance.now() - open;
  if (!restored.ok || restored.destination !== input) throw new Error(`Current round trip failed in ${row.category}`);
  const beforeHeader = Object.values(result.trace.candidates).filter(candidate => candidate.name !== "headerCompactFragment");
  const beforeExpanded = beforeHeader.filter(candidate => candidate.name !== "expandedCompactFragment");
  const beforeCompact = beforeExpanded.filter(candidate => candidate.name !== "compactFragment");
  const beforeUnicode = beforeCompact.filter(candidate => candidate.name !== "unicodeSuffix");
  const previousCandidates = beforeUnicode.filter(candidate => candidate.name !== "adaptivePath" && candidate.name !== "directorySuffix");
  const bestLength = candidates => base.length + Math.min(...candidates.map(candidate => candidate.payloadCharacters));
  return {
    category: row.category, current: short.href.length, original: input.length,
    beforeAdaptive: bestLength(previousCandidates.filter(candidate => candidate.name !== "adaptiveQuery" && candidate.name !== "identifierSuffix")),
    beforeIdentifiers: bestLength(previousCandidates.filter(candidate => candidate.name !== "identifierSuffix")),
    beforePaths: bestLength(previousCandidates),
    beforeUnicode: bestLength(beforeUnicode),
    beforeCompact: bestLength(beforeCompact),
    beforeExpanded: bestLength(beforeExpanded),
    beforeHeader: bestLength(beforeHeader),
    legacy: legacyExact ? base.length + legacy.payload.length : null,
    hamr: reference(input, outputAlphabetASCII), hamrSafe65: reference(input, [...SAFE_FRAGMENT_ALPHABET]),
    selected: result.trace.selectedCandidate, encodeMs, decodeMs
  };
}

function summarize(results) {
  const selected = {};
  for (const row of results) selected[row.selected] = (selected[row.selected] ?? 0) + 1;
  return {
    count: results.length,
    roundTrips: results.length,
    meanCurrentCharacters: average(results.map(row => row.current)),
    vsOriginal: compare(results, row => row.original),
    vsLegacy: compare(results, row => row.legacy),
    vsBeforeAdaptiveQuery: compare(results, row => row.beforeAdaptive),
    vsBeforeIdentifierSuffix: compare(results, row => row.beforeIdentifiers),
    vsBeforePathChanges: compare(results, row => row.beforePaths),
    vsBeforeUnicode: compare(results, row => row.beforeUnicode),
    vsBeforeCompact: compare(results, row => row.beforeCompact),
    vsBeforeExpanded: compare(results, row => row.beforeExpanded),
    vsBeforeHeader: compare(results, row => row.beforeHeader),
    vsHamrNative: compare(results, row => row.hamr),
    vsHamrSafe65: compare(results, row => row.hamrSafe65),
    selected,
    encodeP95Ms: p95(results.map(row => row.encodeMs)),
    decodeP95Ms: p95(results.map(row => row.decodeMs))
  };
}

const result = { base, node: process.version, fingerprints, datasets: {} };
for (const [name, rows] of Object.entries(cohorts)) {
  const results = rows.map(measure);
  const categories = new Map();
  for (const row of results) {
    if (!categories.has(row.category)) categories.set(row.category, []);
    categories.get(row.category).push(row);
  }
  result.datasets[name] = {
    ...summarize(results),
    categories: Object.fromEntries([...categories].map(([category, rows]) => [category, summarize(rows)]))
  };
}
console.log(JSON.stringify(result, null, 2));
