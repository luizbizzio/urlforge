import { CLIENT_VERSION } from "./config.js";

export const TELEMETRY_EVENT_TYPES = Object.freeze(["compress_success", "compress_failure", "resolve_success", "resolve_failure"]);

export function createTelemetryEvent(eventType, fields = {}) {
  const event = {
    event_type: eventType,
    success: eventType.endsWith("_success"),
    original_url_bytes: fields.originalUrlBytes ?? null,
    compressed_payload_chars: fields.compressedPayloadChars ?? null,
    final_short_url_chars: fields.finalShortUrlChars ?? null,
    saved_chars: fields.savedChars ?? null,
    selected_family: fields.selectedFamily ?? null,
    selected_representation: fields.selectedRepresentation ?? null,
    destination_scheme: fields.destinationScheme ?? null,
    locale: fields.locale,
    duration_ms: Math.max(0, Math.round(fields.durationMs ?? 0)),
    error_code: fields.errorCode ?? null,
    client_version: CLIENT_VERSION
  };
  return Object.freeze(event);
}

export function sendTelemetry(event, { endpoint, navigatorLike = globalThis.navigator, fetchImpl = globalThis.fetch } = {}) {
  if (!endpoint) return false;
  try {
    const body = JSON.stringify(event);
    if (new TextEncoder().encode(body).length > 1024) return false;
    if (typeof navigatorLike?.sendBeacon === "function") {
      const blob = new Blob([body], { type: "application/json" });
      if (navigatorLike.sendBeacon(endpoint, blob)) return true;
    }
    if (typeof fetchImpl === "function") {
      Promise.resolve(fetchImpl(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body, keepalive: true, credentials: "omit" })).catch(() => {});
      return true;
    }
  } catch { /* Telemetry must never affect the product flow. */ }
  return false;
}
