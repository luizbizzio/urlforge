import { compressExactBody } from "./codec.js";
import { normalizeUrlForComparison } from "./hamr-audit.js";
import { compressMetaV7, decodeForgeBody, isExactPayload, META_DATA_ALPHABET, META_EXACT_PREFIX, META_LIMITS, MetaCodecError, parseMetaInput, tryDecompress as tryLegacy } from "./meta-codec.js";
import { decodeSuffix, encodeSuffix } from "./suffix-codec.js";
import { decodeIdentifierSuffix, encodeIdentifierSuffix } from "./identifier-suffix.js";
import { decodeCompactFragment, encodeCompactFragment } from "./compact-fragment.js";
import { isCompactFragment } from "./output-encoding.js";
import { compress as compressHamr, decompress as decompressHamr } from "../vendor/ha.mr/docs/compress.js";

const EXACT_PAYLOAD_PATTERN = /^([A-Za-z0-9_~-]+)(?:(\.{1,2})([A-Za-z0-9_~-]+))?$/;
const MAX_ORIGIN_PAYLOAD_CHARACTERS = 512;
const META_ALPHABET_ARRAY = [...META_DATA_ALPHABET];
const publicError = (code, message) => new MetaCodecError(code, message);

function readExactOrigin(body) {
  const url = readPrefix(body);
  if (url.href !== `${url.origin}/`) throw new Error("Expected an origin without a suffix");
  return url.origin;
}

function readPrefix(body) {
  if (body.length > MAX_ORIGIN_PAYLOAD_CHARACTERS) throw new Error("Origin payload limit exceeded");
  const url = parseMetaInput(decompressHamr(body, META_ALPHABET_ARRAY));
  if (url.href !== url.origin + url.pathname) throw new Error("Unexpected query or fragment in prefix");
  return url;
}

function appendSuffixCandidates(url, candidates) {
  const tail = url.href.slice(url.origin.length + 1);
  const encoded = encodeSuffix(tail);
  if (!encoded) return;
  let origin;
  try {
    origin = compressHamr(`${url.origin}/`, META_ALPHABET_ARRAY);
    if (readExactOrigin(origin) !== url.origin) return;
  } catch { return; }
  candidates.push({ name: "suffixModel", family: "forge", representation: "suffixModel", payload: `${origin}.${encoded}` });
  if (url.search || tail.length >= 24) {
    const name = url.search ? "adaptiveQuery" : "adaptivePath";
    candidates.push({ name, family: "forge", representation: name, payload: `${origin}..${encodeSuffix(tail, true)}` });
  }
  const identifiers = encodeIdentifierSuffix(tail);
  if (identifiers) candidates.push({ name: "identifierSuffix", family: "forge", representation: "identifierSuffix", payload: `${origin}.${identifiers}` });
  if (/%[c-f][\da-f]%[89ab]/i.test(tail)) {
    const unicode = encodeIdentifierSuffix(tail, true);
    if (unicode) candidates.push({ name: "unicodeSuffix", family: "forge", representation: "unicodeSuffix", payload: `${origin}.${unicode}` });
  }
  // The same one-dot frame can also carry the first directory in the head.
  const end = url.pathname.indexOf("/", 1);
  if (end <= 1 || tail.length - end < 8) return;
  const prefix = url.origin + url.pathname.slice(0, end);
  try {
    const head = compressHamr(prefix, META_ALPHABET_ARRAY);
    if (readPrefix(head).href !== prefix) return;
    const suffix = encodeSuffix(tail.slice(end));
    candidates.push({ name: "directorySuffix", family: "forge", representation: "directorySuffix", payload: `${head}.${suffix}` });
  } catch { return; }
}

function decompressExact(payload) {
  if (payload.length > META_LIMITS.maxPayloadCharacters) throw publicError("PAYLOAD_TOO_LARGE", "Payload exceeds the character limit.");
  const body = payload.startsWith(META_EXACT_PREFIX) ? payload.slice(META_EXACT_PREFIX.length) : payload;
  const match = EXACT_PAYLOAD_PATTERN.exec(body);
  let url;
  if (match && !(match[2] === ".." && payload.startsWith(META_EXACT_PREFIX))) {
    const [, head, separator, suffix] = match;
    if (suffix === undefined) url = decodeForgeBody(head);
    else if (separator === "." && !payload.startsWith(META_EXACT_PREFIX)) {
      const prefix = readPrefix(head);
      if (!/^\/[^/]*$/.test(prefix.pathname)) throw new Error("Invalid directory prefix");
      url = (prefix.pathname === "/" ? prefix.origin : prefix.href) + "/" + decodeSuffix(suffix);
    } else url = `${readExactOrigin(head)}/${decodeSuffix(suffix, separator === "..")}`;
  } else {
    const parts = body.split(".");
    if (payload.startsWith(META_EXACT_PREFIX) || parts.length < 3 || !parts.every(part => /^[A-Za-z0-9_~-]+$/.test(part))) {
      throw publicError("INVALID_ALPHABET", "Invalid exact Forge payload alphabet.");
    }
    const [head, shape, ...fields] = parts;
    url = `${readExactOrigin(head)}/${decodeIdentifierSuffix(shape, fields)}`;
  }
  const parsed = parseMetaInput(url);
  if (parsed.href !== url) throw publicError("INVALID_URL", "The decoded URL is not in serialized form.");
  return url;
}

const shortest = (best, candidate) => candidate.payload.length < best.payload.length ? candidate : best;

function manualHamr(url) {
  let payload;
  try { payload = compressHamr(url.href, META_ALPHABET_ARRAY); }
  catch { throw publicError("HAMR_UNSUPPORTED", "ha.mr cannot preserve this URL."); }
  if (typeof payload === "string" && payload.length > META_LIMITS.maxPayloadCharacters) {
    throw publicError("ENCODED_PAYLOAD_TOO_LARGE", "Compressed payload exceeds the character limit.");
  }
  if (!payload || tryLegacy(payload).value !== url.href) {
    throw publicError("HAMR_UNSUPPORTED", "ha.mr cannot preserve this URL.");
  }
  return { name: "ha.mr", family: "ha.mr", representation: "ha.mr", payload };
}

export function compressBestUrl(input, mode = "auto") {
  if (mode !== "auto" && mode !== "forge" && mode !== "hamr") throw new TypeError("Unknown compression mode");
  const url = parseMetaInput(input);
  const candidates = [];
  if (mode === "hamr") candidates.push(manualHamr(url));
  else if (normalizeUrlForComparison(url.href) === url.href) {
    try {
      const legacy = compressMetaV7(url.href, { includeReference: false });
      for (const candidate of [legacy.trace.candidates.combinedRetained, legacy.trace.candidates.haMr]) {
        if (mode === "forge" && candidate.family === "ha.mr") continue;
        if (!candidate.eligible || candidate.payload.length > META_LIMITS.maxPayloadCharacters) continue;
        // The ha.mr audit has already decoded this exact payload.
        if (candidate.normalization?.decoded === url.href || tryLegacy(candidate.payload).value === url.href) candidates.push(candidate);
      }
    } catch (error) {
      if (error?.code !== "ENCODED_PAYLOAD_TOO_LARGE") throw error;
    }
  }
  if (mode !== "hamr") {
    const needsExactFallback = !candidates.some(candidate => candidate.family === "forge");
    appendSuffixCandidates(url, candidates);
    if (needsExactFallback) {
      const payload = META_EXACT_PREFIX + compressExactBody(url);
      candidates.push({ name: "exactForge", family: "forge", representation: "exactForge", payload });
    }
  }
  let selected = candidates.reduce(shortest);
  const haMr = candidates.find(candidate => candidate.name === "ha.mr");
  const forge = candidates.filter(candidate => candidate.family === "forge");
  const raw = new Set([selected, haMr, forge.length ? forge.reduce(shortest) : null]);
  for (const candidate of raw) {
    if (!candidate) continue;
    const limit = META_LIMITS.maxPayloadCharacters;
    const compact = encodeCompactFragment(candidate.payload, candidate === haMr ? haMr.payload : undefined,
      limit, Math.min(selected.payload.length - 1, limit));
    if (compact) selected = { name: "compactFragment", family: candidate.family, representation: "compactFragment", payload: compact };
  }
  if (selected.name === "compactFragment") candidates.push(selected);
  if (selected.payload.length > META_LIMITS.maxPayloadCharacters) throw publicError("ENCODED_PAYLOAD_TOO_LARGE", "Compressed payload exceeds the character limit.");
  return {
    payload: selected.payload,
    trace: {
      normalizedUrl: url.href,
      selectedCandidate: selected.name,
      selectedFamily: selected.family,
      candidates: Object.fromEntries(candidates.map(candidate => [candidate.name, { ...candidate, payloadCharacters: candidate.payload.length }]))
    }
  };
}

export function tryDecompress(payload) {
  try {
    if (isCompactFragment(payload)) payload = decodeCompactFragment(payload, META_LIMITS.maxPayloadCharacters);
    if (!isExactPayload(payload)) return tryLegacy(payload);
    return { ok: true, value: decompressExact(payload), error: null };
  }
  catch (error) {
    const code = error instanceof MetaCodecError ? error.code : "INVALID_FORGE_PAYLOAD";
    return { ok: false, value: null, error: { code, message: "The exact Forge payload could not be decoded." } };
  }
}
