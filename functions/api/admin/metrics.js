const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export async function onRequestGet(context) {
  const expected = context.env.ADMIN_TOKEN;
  const supplied = context.request.headers.get("authorization");
  if (!expected || supplied !== `Bearer ${expected}`) return json(401, { error: "UNAUTHORIZED" });
  if (!context.env.DB) return json(503, { error: "METRICS_UNAVAILABLE" });
  try {
    const statements = [
      context.env.DB.prepare(`SELECT
        SUM(CASE WHEN event_type LIKE 'compress_%' THEN 1 ELSE 0 END) AS total_compressions,
        SUM(CASE WHEN event_type = 'compress_success' THEN 1 ELSE 0 END) AS successful_compressions,
        SUM(CASE WHEN event_type LIKE 'resolve_%' THEN 1 ELSE 0 END) AS total_resolutions,
        SUM(CASE WHEN event_type = 'resolve_success' THEN 1 ELSE 0 END) AS successful_resolutions,
        AVG(CASE WHEN event_type = 'compress_success' THEN saved_chars END) AS average_saved_characters
        FROM telemetry_events`),
      context.env.DB.prepare("SELECT selected_family AS family, COUNT(*) AS count FROM telemetry_events WHERE selected_family IS NOT NULL GROUP BY selected_family ORDER BY count DESC"),
      context.env.DB.prepare("SELECT error_code, COUNT(*) AS count FROM telemetry_events WHERE error_code IS NOT NULL GROUP BY error_code ORDER BY count DESC"),
      context.env.DB.prepare("SELECT substr(server_timestamp, 1, 10) AS day, COUNT(*) AS events FROM telemetry_events GROUP BY day ORDER BY day DESC LIMIT 90")
    ];
    const [summaryResult, familyResult, errorResult, dailyResult] = await context.env.DB.batch(statements);
    const summary = summaryResult.results[0] || {};
    const totalCompressions = Number(summary.total_compressions || 0), totalResolutions = Number(summary.total_resolutions || 0);
    return json(200, {
      total_compressions: totalCompressions,
      compression_success_rate: totalCompressions ? Number(summary.successful_compressions || 0) / totalCompressions : null,
      total_resolution_attempts: totalResolutions,
      resolution_success_rate: totalResolutions ? Number(summary.successful_resolutions || 0) / totalResolutions : null,
      average_saved_characters: summary.average_saved_characters === null ? null : Number(summary.average_saved_characters),
      selected_families: familyResult.results,
      errors_by_code: errorResult.results,
      events_by_day: dailyResult.results
    });
  } catch { return json(503, { error: "METRICS_UNAVAILABLE" }); }
}

export async function onRequest(context) {
  if (context.request.method === "GET") return onRequestGet(context);
  return json(405, { error: "METHOD_NOT_ALLOWED" });
}
