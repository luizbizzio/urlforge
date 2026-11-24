import { compressCombinedDetailed, compressDetailed, decompress as decompressForge } from "./codec.js";
import { auditHamr, normalizeUrlForComparison } from "./hamr-audit.js";
import { SAFE_FRAGMENT_ALPHABET } from "./output-encoding.js";
import { decompress as decompressHamr } from "../vendor/ha.mr/docs/compress.js";

export const META_FORMAT_VERSION = 7;
export const META_FORGE_PREFIX = ".";
export const META_EXACT_PREFIX = "..";

// Legacy payloads have either no dot or a single leading dot.
export function isExactPayload(payload) {
  return typeof payload === "string" && (payload.startsWith(META_EXACT_PREFIX) || payload.indexOf(".") > 0);
}
export const META_DATA_ALPHABET = SAFE_FRAGMENT_ALPHABET;
export const META_LIMITS = Object.freeze({
  maxPayloadCharacters: 8192,
  maxDecompressedUrlBytes: 65536,
  maxDecodeTokens: 32768,
  maxBackReferences: 4096,
  maxBackReferenceLength: 65535,
  maxVarUintPrefixBits: 256,
  maxNestingDepth: 0
});
const META_ALPHABET_ARRAY = [...META_DATA_ALPHABET];
const textEncoder = new TextEncoder();

export class MetaCodecError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "MetaCodecError";
    this.code = code;
  }
}

const publicError = (code, message) => new MetaCodecError(code, message);

function sanitizeDecodeError(error, family) {
  if (error instanceof MetaCodecError) return error;
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (message.includes("unexpected end")) return publicError("TRUNCATED_PAYLOAD", "The payload is truncated.");
  if (message.includes("unsupported payload version")) return publicError("UNSUPPORTED_VERSION", "The payload uses an unsupported format version.");
  if (message.includes("lz back-reference")) return publicError("INVALID_BACK_REFERENCE", "The payload contains an invalid back-reference.");
  if (message.includes("limit exceeded")) return publicError("DECODE_BUDGET_EXCEEDED", "The payload exceeds the deterministic decode budget.");
  return family === "forge"
    ? publicError("INVALID_FORGE_PAYLOAD", "The Forge payload is invalid or corrupted.")
    : publicError("INVALID_HAMR_PAYLOAD", "The ha.mr payload is invalid or corrupted.");
}

function validatePayload(payload) {
  if (typeof payload !== "string") throw publicError("INVALID_INPUT", "Payload must be a string.");
  if (!payload) throw publicError("EMPTY_PAYLOAD", "Payload must not be empty.");
  if (payload.length > META_LIMITS.maxPayloadCharacters) throw publicError("PAYLOAD_TOO_LARGE", `Payload exceeds ${META_LIMITS.maxPayloadCharacters} characters.`);
  const body = payload.startsWith(META_FORGE_PREFIX) ? payload.slice(1) : payload;
  const family = payload.startsWith(META_FORGE_PREFIX) ? "forge" : "ha.mr";
  if (!body) throw publicError("EMPTY_PAYLOAD", family === "forge" ? "Empty Forge body in meta-v7 payload." : "Payload body must not be empty.");
  if ([...body].some(character => !META_DATA_ALPHABET.includes(character))) throw publicError("INVALID_ALPHABET", family === "forge" ? "Invalid meta-v7 Forge payload alphabet." : "Invalid meta-v7 ha.mr payload alphabet.");
  return { family, body };
}

function validateDecodedUrl(value, family) {
  if (typeof value !== "string") throw publicError("DECODE_FAILED", "The payload did not decode to a URL.");
  if (textEncoder.encode(value).length > META_LIMITS.maxDecompressedUrlBytes) throw publicError("URL_TOO_LARGE", `Decoded URL exceeds ${META_LIMITS.maxDecompressedUrlBytes} UTF-8 bytes.`);
  let parsed;
  try { parsed = new URL(value); } catch { throw publicError("INVALID_URL", "The payload did not decode to a valid URL."); }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw publicError("INVALID_URL", "The payload did not decode to an HTTP(S) URL.");
  try { return normalizeUrlForComparison(parsed.href); }
  catch { throw publicError(family === "forge" ? "INVALID_FORGE_PAYLOAD" : "INVALID_HAMR_PAYLOAD", "The decoded URL could not be normalized safely."); }
}

export function parseMetaInput(input) {
  if (typeof input !== "string") throw publicError("INVALID_INPUT", "URL must be a string.");
  let parsed;
  try { parsed = new URL(input.includes("://") ? input : `https://${input}`); }
  catch { throw publicError("INVALID_URL", "Input is not a valid URL."); }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw publicError("INVALID_URL", "Only HTTP(S) URLs are supported.");
  if (parsed.username || parsed.password) throw publicError("UNSUPPORTED_URL", "URLs containing credentials are not supported.");
  if (textEncoder.encode(parsed.href).length > META_LIMITS.maxDecompressedUrlBytes) throw publicError("INPUT_URL_TOO_LARGE", `Input URL exceeds ${META_LIMITS.maxDecompressedUrlBytes} UTF-8 bytes.`);
  return parsed;
}

const normalizedInput = input => normalizeUrlForComparison(parseMetaInput(input).href);

function measuredCandidate({ name, family, body, identifier = "", codecBits = null, codecBitsNote = null, eligible = true, selectable = true, discardReason = null, normalization = null, representation = null }) {
  const payload = eligible ? `${identifier}${body}` : null;
  const bodyCharacters = eligible ? body.length : null, identifierCharacters = eligible ? identifier.length : null;
  const payloadCharacters = eligible ? payload.length : null;
  const parsedFragment = payload === null ? null : new URL(`http://uf.mr#${payload}`).hash.slice(1);
  const urlCompatibility = payload === null ? null : {
    alphabetValid: [...payload].every(character => character === META_FORGE_PREFIX || META_DATA_ALPHABET.includes(character)),
    excludesFragmentDelimiter: !payload.includes("#"),
    whatwgFragmentRoundTrip: parsedFragment === payload,
    decodeURIComponentRoundTrip: decodeURIComponent(payload) === payload,
    safeForSelection: parsedFragment === payload && decodeURIComponent(payload) === payload && !payload.includes("#")
  };
  return {
    name, family, eligible, selectable, discardReason, normalization, representation,
    alphabet: "safe65-data-plus-reserved-dot-prefix",
    identifier, identifierCharacters, identifierWireBits: identifierCharacters === null ? null : identifierCharacters * 8,
    rawPayload: eligible ? body : null, metaPayload: payload, bodyCharacters, payloadCharacters, codecBits, codecBitsNote, urlCompatibility,
    alphabetCapacityBits: payloadCharacters === null ? null : identifierCharacters * 8 + bodyCharacters * Math.log2(META_DATA_ALPHABET.length),
    finalWireBits: payloadCharacters === null ? null : payloadCharacters * 8,
    payload
  };
}

export function chooseMetaCandidate(candidates) {
  const forge = candidates.combinedRetained, hamr = candidates.haMr;
  if (!forge?.eligible) throw new Error("combinedRetained must be available");
  if (!hamr?.eligible) return forge;
  return forge.payloadCharacters <= hamr.payloadCharacters ? forge : hamr;
}

export function compressMetaV7(input, { includeReference = true } = {}) {
  const normalizedUrl = normalizedInput(input);
  const combined = compressCombinedDetailed(normalizedUrl, { outputAlphabet: "safe65", contextArithmetic: false });
  const hamrAudit = auditHamr(normalizedUrl, META_ALPHABET_ARRAY);

  const candidates = {
    combinedRetained: measuredCandidate({
      name: "combinedRetained", family: "forge", body: combined.payload, identifier: META_FORGE_PREFIX,
      codecBits: combined.bitLength, representation: combined.combinedCandidate
    }),
    haMr: measuredCandidate({
      name: "ha.mr", family: "ha.mr", body: hamrAudit.valid ? hamrAudit.payload : "", codecBits: null,
      codecBitsNote: "The unmodified vendor API exposes only the final alphabet payload; finalWireBits is exact and is the selection metric.",
      eligible: hamrAudit.valid, discardReason: hamrAudit.valid ? null : { reason: hamrAudit.reason, detail: hamrAudit.detail },
      normalization: hamrAudit.valid ? {
        exact: hamrAudit.exact,
        normalizedEquivalent: hamrAudit.normalizedEqual,
        differenceReason: hamrAudit.reason,
        decoded: hamrAudit.decoded
      } : null
    })
  };
  if (includeReference) {
    const current = compressDetailed(normalizedUrl, { huffman: true, lz: true, arithmetic: true, globalRawStream: true, outputAlphabet: "safe65" });
    candidates.currentV6Planner = measuredCandidate({
      name: "currentV6Planner", family: "forge", body: current.payload, identifier: META_FORGE_PREFIX,
      codecBits: current.bitLength, selectable: false, representation: current.plan.selectedRepresentation
    });
  }
  for (const candidate of Object.values(candidates)) if (candidate.eligible && !candidate.urlCompatibility.safeForSelection) {
    candidate.eligible = false;
    candidate.discardReason = { reason: "unsafe URL fragment encoding", detail: candidate.urlCompatibility };
  }
  const selected = chooseMetaCandidate(candidates);
  if (selected.payloadCharacters > META_LIMITS.maxPayloadCharacters) throw publicError("ENCODED_PAYLOAD_TOO_LARGE", `Compressed payload exceeds ${META_LIMITS.maxPayloadCharacters} characters.`);
  return {
    payload: selected.payload,
    trace: {
      metaVersion: META_FORMAT_VERSION,
      limits: META_LIMITS,
      normalizedUrl,
      prefix: "http://uf.mr#",
      prefixCharacters: 13,
      dataAlphabet: META_DATA_ALPHABET,
      emittedAlphabet: `${META_DATA_ALPHABET}${META_FORGE_PREFIX}`,
      specialCharacters: { forgeFamilyMarker: META_FORGE_PREFIX, fragmentDelimiterExcluded: "#", percentEscapeIntroducerExcluded: "%" },
      normalizationPolicy: "WHATWG URL serialization followed by uppercase hexadecimal percent escapes.",
      reservedPrefixes: { forge: META_FORGE_PREFIX, haMr: "implicit/default" },
      selectedCandidate: selected.name,
      selectedFamily: selected.family,
      tieRule: "Forge wins an equal final character count; currentV6Planner is reference-only.",
      candidates,
      rawPayloads: { forge: candidates.combinedRetained.rawPayload, currentV6Planner: candidates.currentV6Planner?.rawPayload ?? null, haMr: candidates.haMr.rawPayload },
      finalMetaPayload: selected.payload,
      comparison: { byFinalCharacters: true, byExactAsciiWireBits: true, requiresSafeWhatwgFragmentCompatibility: true },
      finalPayloadCharacters: selected.payloadCharacters,
      finalWireBits: selected.finalWireBits,
      finalLinkCharacters: 13 + selected.payloadCharacters
    }
  };
}

export function decodeForgeBody(body) {
  return decompressForge(body, {
    outputAlphabet: "safe65",
    limits: {
      maxOutputBytes: META_LIMITS.maxDecompressedUrlBytes,
      maxTokens: META_LIMITS.maxDecodeTokens,
      maxBackReferences: META_LIMITS.maxBackReferences,
      maxBackReferenceLength: META_LIMITS.maxBackReferenceLength
    }
  });
}

export function decompressMetaV7(payload) {
  const { family, body } = validatePayload(payload);
  if (family === "forge") {
    try {
      const decoded = decodeForgeBody(body);
      return validateDecodedUrl(decoded, family);
    } catch (error) { throw sanitizeDecodeError(error, family); }
  }
  try { return validateDecodedUrl(decompressHamr(body, META_ALPHABET_ARRAY), family); }
  catch (error) { throw sanitizeDecodeError(error, family); }
}


export function compress(url) {
  try { return compressMetaV7(url).payload; }
  catch (error) {
    if (error instanceof MetaCodecError) throw error;
    throw publicError("ENCODE_FAILED", "The URL could not be compressed safely.");
  }
}
export function decompress(payload) { return decompressMetaV7(payload); }

export function tryDecompress(payload) {
  try { return { ok: true, value: decompressMetaV7(payload), error: null }; }
  catch (error) {
    const sanitized = sanitizeDecodeError(error, typeof payload === "string" && payload.startsWith(META_FORGE_PREFIX) ? "forge" : "ha.mr");
    return { ok: false, value: null, error: { code: sanitized.code, message: sanitized.message } };
  }
}

export function inspect(payload) {
  const result = tryDecompress(payload);
  const isString = typeof payload === "string";
  return {
    metaVersion: META_FORMAT_VERSION,
    family: isString && payload.startsWith(META_FORGE_PREFIX) ? "forge" : "ha.mr",
    payloadCharacters: isString ? payload.length : null,
    withinPayloadLimit: isString ? payload.length <= META_LIMITS.maxPayloadCharacters : false,
    valid: result.ok,
    decodedUrl: result.value,
    error: result.error,
    limits: META_LIMITS
  };
}

export function metaRoundTripEquivalent(input, decoded) {
  return normalizeUrlForComparison(normalizedInput(input)) === normalizeUrlForComparison(decoded);
}

export function auditMetaAlphabet() {
  return {
    haMrConfiguredAlphabet: [...META_DATA_ALPHABET],
    haMrPossibleOutputCharacters: [...META_DATA_ALPHABET],
    forgeRawAlphabet: [...META_DATA_ALPHABET],
    metaAdditionalCharacters: [META_FORGE_PREFIX],
    possibleFirstCharacters: { haMr: [...META_DATA_ALPHABET], forge: [META_FORGE_PREFIX] },
    markerInHaMrAlphabet: META_DATA_ALPHABET.includes(META_FORGE_PREFIX),
    classicalPrefixFree: false,
    routingLanguagesDisjoint: !META_DATA_ALPHABET.includes(META_FORGE_PREFIX),
    routingLanguages: { haMr: "safe65+", forge: ".safe65+" },
    proof: "ha.mr numberToString emits only alphabet[number % alphabet.length]; the supplied safe65 alphabet excludes '.', so no ha.mr payload can begin with or contain the Forge '.' marker. The two routing languages are disjoint even though the implicit/default family prefix is not a classical prefix code."
  };
}
