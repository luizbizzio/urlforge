import { validateTelemetryEvent } from "../_lib/telemetry-schema.js";

const headers = Object.freeze({
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type",
  "cache-control": "no-store"
});
const response = (status, body = null) => new Response(body === null ? null : JSON.stringify(body), { status, headers: { ...headers, ...(body === null ? {} : { "content-type": "application/json" }) } });

export async function onRequestOptions() { return response(204); }

export async function onRequestPost(context) {
  const declaredLength = Number(context.request.headers.get("content-length") || 0);
  if (declaredLength > 1024) return response(413, { error: "EVENT_TOO_LARGE" });
  let text;
  try { text = await context.request.text(); } catch { return response(400, { error: "INVALID_BODY" }); }
  if (new TextEncoder().encode(text).length > 1024) return response(413, { error: "EVENT_TOO_LARGE" });
  let parsed;
  try { parsed = JSON.parse(text); } catch { return response(400, { error: "INVALID_JSON" }); }
  const validation = validateTelemetryEvent(parsed);
  if (!validation.ok) return response(400, { error: validation.errorCode });
  if (!context.env.DB) return response(503, { error: "TELEMETRY_UNAVAILABLE" });
  const event = validation.value;
  try {
    await context.env.DB.prepare(`INSERT INTO telemetry_events (
      server_timestamp, event_type, success, original_url_bytes, compressed_payload_chars,
      final_short_url_chars, saved_chars, selected_family, selected_representation,
      destination_scheme, locale, duration_ms, error_code, client_version
    ) VALUES (CURRENT_TIMESTAMP, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(event.event_type, event.success ? 1 : 0, event.original_url_bytes, event.compressed_payload_chars,
        event.final_short_url_chars, event.saved_chars, event.selected_family, event.selected_representation,
        event.destination_scheme, event.locale, event.duration_ms, event.error_code, event.client_version).run();
    return response(204);
  } catch { return response(503, { error: "TELEMETRY_UNAVAILABLE" }); }
}

export async function onRequest(context) {
  if (context.request.method === "OPTIONS") return onRequestOptions(context);
  if (context.request.method === "POST") return onRequestPost(context);
  return response(405, { error: "METHOD_NOT_ALLOWED" });
}
