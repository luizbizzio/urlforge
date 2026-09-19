export const TELEMETRY_FIELDS = Object.freeze([
  "event_type", "success", "original_url_bytes", "compressed_payload_chars",
  "final_short_url_chars", "saved_chars", "selected_family", "selected_representation",
  "destination_scheme", "locale", "duration_ms", "error_code", "client_version"
]);

const EVENT_TYPES = new Set(["compress_success", "compress_failure", "resolve_success", "resolve_failure"]);
const nullableInteger = (value, minimum, maximum) => value === null || Number.isSafeInteger(value) && value >= minimum && value <= maximum;
const nullableToken = (value, maximum) => value === null || typeof value === "string" && value.length <= maximum && /^[A-Za-z0-9._-]+$/.test(value);

export function validateTelemetryEvent(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return { ok: false, errorCode: "INVALID_BODY" };
  const keys = Object.keys(value).sort(), expected = [...TELEMETRY_FIELDS].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) return { ok: false, errorCode: "INVALID_FIELDS" };
  if (!EVENT_TYPES.has(value.event_type)) return { ok: false, errorCode: "INVALID_EVENT_TYPE" };
  if (typeof value.success !== "boolean" || value.success !== value.event_type.endsWith("_success")) return { ok: false, errorCode: "INVALID_SUCCESS" };
  if (!nullableInteger(value.original_url_bytes, 0, 10000000)) return { ok: false, errorCode: "INVALID_ORIGINAL_SIZE" };
  if (!nullableInteger(value.compressed_payload_chars, 0, 8192)) return { ok: false, errorCode: "INVALID_PAYLOAD_SIZE" };
  if (!nullableInteger(value.final_short_url_chars, 0, 16384)) return { ok: false, errorCode: "INVALID_FINAL_SIZE" };
  if (!nullableInteger(value.saved_chars, -10000000, 10000000)) return { ok: false, errorCode: "INVALID_SAVINGS" };
  if (value.selected_family !== null && value.selected_family !== "hamr" && value.selected_family !== "forge") return { ok: false, errorCode: "INVALID_FAMILY" };
  if (!nullableToken(value.selected_representation, 64)) return { ok: false, errorCode: "INVALID_REPRESENTATION" };
  if (value.destination_scheme !== null && value.destination_scheme !== "http" && value.destination_scheme !== "https") return { ok: false, errorCode: "INVALID_SCHEME" };
  if (value.locale !== "pt-BR" && value.locale !== "en") return { ok: false, errorCode: "INVALID_LOCALE" };
  if (!nullableInteger(value.duration_ms, 0, 600000)) return { ok: false, errorCode: "INVALID_DURATION" };
  if (!nullableToken(value.error_code, 48)) return { ok: false, errorCode: "INVALID_ERROR_CODE" };
  if (typeof value.client_version !== "string" || value.client_version.length > 24 || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(value.client_version)) return { ok: false, errorCode: "INVALID_CLIENT_VERSION" };
  return { ok: true, value };
}
