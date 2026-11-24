import { compressBestUrl } from "../url-codec.js";
import { INPUT_URL_MAX_BYTES } from "./config.js";
import { CONFIRMATION_MARKER } from "./link-fragment.js";

const encoder = new TextEncoder();

export class UrlInputError extends Error {
  constructor(code) { super(code); this.name = "UrlInputError"; this.code = code; }
}

export function validateDestination(input, maxBytes = INPUT_URL_MAX_BYTES) {
  if (typeof input !== "string" || !input.trim()) throw new UrlInputError("INVALID_URL");
  const value = input.trim();
  const inputBytes = encoder.encode(value).length;
  if (inputBytes > maxBytes) throw new UrlInputError("INPUT_LIMIT");
  let parsed;
  try { parsed = new URL(value); } catch { throw new UrlInputError("INVALID_URL"); }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new UrlInputError("INVALID_SCHEME");
  if (parsed.username || parsed.password) throw new UrlInputError("CREDENTIALS");
  return { url: parsed, normalizedUrl: parsed.href, inputBytes, destinationScheme: parsed.protocol.slice(0, -1) };
}

export function createCompressionResult(input, shortUrlBase, mode = "auto", { askBeforeOpening = false } = {}) {
  const validated = validateDestination(input);
  const encoded = compressBestUrl(validated.normalizedUrl, mode);
  const marker = askBeforeOpening ? CONFIRMATION_MARKER : "";
  const shortUrl = `${shortUrlBase}${marker}${encoded.payload}`;
  const originalCharacters = validated.normalizedUrl.length;
  const savedCharacters = originalCharacters - shortUrl.length;
  const savingsPercent = originalCharacters ? savedCharacters / originalCharacters * 100 : 0;
  const selected = encoded.trace.candidates[encoded.trace.selectedCandidate];
  return {
    ...validated,
    payload: encoded.payload,
    shortUrl,
    payloadCharacters: encoded.payload.length,
    finalShortUrlCharacters: shortUrl.length,
    originalCharacters,
    savedCharacters,
    savingsPercent,
    selectedFamily: encoded.trace.selectedFamily === "ha.mr" ? "hamr" : "forge",
    selectedRepresentation: selected?.representation || null,
    trace: encoded.trace
  };
}
