import assert from "node:assert/strict";
import test from "node:test";

import { onRequestPost } from "../functions/api/telemetry.js";
import { validateTelemetryEvent } from "../functions/_lib/telemetry-schema.js";
import { createTelemetryEvent, sendTelemetry } from "../src/web/telemetry.js";

const validEvent = () => createTelemetryEvent("compress_success", {
  originalUrlBytes: 120,
  compressedPayloadChars: 40,
  finalShortUrlChars: 65,
  savedChars: 55,
  selectedFamily: "forge",
  selectedRepresentation: "v7DirectBinary",
  destinationScheme: "https",
  locale: "pt-BR",
  durationMs: 12.4
});

test("telemetry schema accepts only the documented closed event", () => {
  const event = validEvent();
  assert.equal(validateTelemetryEvent(event).ok, true);
  assert.equal(validateTelemetryEvent({ ...event, payload: "must-not-be-accepted" }).errorCode, "INVALID_FIELDS");
  assert.equal(validateTelemetryEvent({ ...event, event_type: "other" }).errorCode, "INVALID_EVENT_TYPE");
  assert.equal(validateTelemetryEvent({ ...event, success: false }).errorCode, "INVALID_SUCCESS");
  assert.equal("server_timestamp" in event, false);
  assert.equal("url" in event, false);
  assert.equal("payload" in event, false);
});

test("site sends no request without TELEMETRY_ENDPOINT", () => {
  let called = false;
  const sent = sendTelemetry(validEvent(), { endpoint: null, navigatorLike: { sendBeacon() { called = true; } }, fetchImpl() { called = true; } });
  assert.equal(sent, false);
  assert.equal(called, false);
});

test("telemetry transport failures never throw or block the caller", () => {
  assert.doesNotThrow(() => {
    const sent = sendTelemetry(validEvent(), {
      endpoint: "https://telemetry.example/api/telemetry",
      navigatorLike: { sendBeacon() { throw new Error("offline"); } },
      fetchImpl() { throw new Error("blocked"); }
    });
    assert.equal(sent, false);
  });
  const marker = { continued: true };
  assert.equal(marker.continued, true);
});

test("Cloudflare endpoint enforces 1 KB and writes only schema fields with a server timestamp", async () => {
  let sql = "", bindings = null;
  const DB = { prepare(statement) {
    sql = statement;
    return { bind(...values) { bindings = values; return { async run() { return { success: true }; } }; } };
  } };
  const request = new Request("https://example.test/api/telemetry", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(validEvent()) });
  const response = await onRequestPost({ request, env: { DB } });
  assert.equal(response.status, 204);
  assert.match(sql, /CURRENT_TIMESTAMP/);
  assert.equal(bindings.length, 13);
  assert.ok(!bindings.some(value => typeof value === "string" && value.includes("https://")));

  const oversized = new Request("https://example.test/api/telemetry", { method: "POST", headers: { "content-length": "1025" }, body: "{}" });
  assert.equal((await onRequestPost({ request: oversized, env: { DB } })).status, 413);
});
