import { compress, decompress } from "../vendor/ha.mr/docs/compress.js";

export const FAILURE_REASONS = Object.freeze({
  WRAPPER: "wrapper or integration bug",
  NORMALIZATION: "URL normalization difference",
  UNSUPPORTED: "unsupported URL feature",
  DECODER: "ha.mr decoder failure",
  ROUND_TRIP: "actual ha.mr round-trip failure"
});

export function normalizeUrlForComparison(input) {
  const canonical = new URL(input).href;
  return canonical.replace(/%[0-9a-fA-F]{2}/g, escape => escape.toUpperCase());
}

export function auditHamr(input, alphabet) {
  const canonicalInput = new URL(input).href;
  let payload;
  try {
    payload = compress(canonicalInput, alphabet);
    if (typeof payload !== "string" || !payload) return { valid: false, reason: FAILURE_REASONS.WRAPPER, detail: "compressor returned no string payload", payload: null, decoded: null };
  } catch (error) {
    const hostname = new URL(canonicalInput).hostname;
    const unsupportedDomainCharacter = /[^a-zA-Z0-9.-]/.test(hostname);
    return { valid: false, reason: unsupportedDomainCharacter ? FAILURE_REASONS.UNSUPPORTED : FAILURE_REASONS.ROUND_TRIP, detail: error.message, payload: null, decoded: null };
  }
  let decoded;
  try { decoded = decompress(payload, alphabet); }
  catch (error) { return { valid: false, reason: FAILURE_REASONS.DECODER, detail: error.message, payload, decoded: null }; }

  if (decoded === canonicalInput) return { valid: true, exact: true, normalizedEqual: true, reason: null, detail: null, payload, decoded };
  try {
    if (normalizeUrlForComparison(decoded) === normalizeUrlForComparison(canonicalInput)) {
      return { valid: true, exact: false, normalizedEqual: true, reason: FAILURE_REASONS.NORMALIZATION, detail: "decoded URL differs textually but is equal after URL and percent-escape normalization", payload, decoded };
    }
  } catch (error) {
    return { valid: false, exact: false, normalizedEqual: false, reason: FAILURE_REASONS.DECODER, detail: `decoder produced an invalid URL: ${error.message}`, payload, decoded };
  }
  return { valid: false, exact: false, normalizedEqual: false, reason: FAILURE_REASONS.ROUND_TRIP, detail: "normalized decoded URL does not equal normalized input", payload, decoded };
}
