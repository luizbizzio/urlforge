CREATE TABLE IF NOT EXISTS telemetry_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_timestamp TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  event_type TEXT NOT NULL CHECK (event_type IN ('compress_success', 'compress_failure', 'resolve_success', 'resolve_failure')),
  success INTEGER NOT NULL CHECK (success IN (0, 1)),
  original_url_bytes INTEGER,
  compressed_payload_chars INTEGER,
  final_short_url_chars INTEGER,
  saved_chars INTEGER,
  selected_family TEXT CHECK (selected_family IS NULL OR selected_family IN ('hamr', 'forge')),
  selected_representation TEXT,
  destination_scheme TEXT CHECK (destination_scheme IS NULL OR destination_scheme IN ('http', 'https')),
  locale TEXT NOT NULL CHECK (locale IN ('pt-BR', 'en')),
  duration_ms INTEGER NOT NULL,
  error_code TEXT,
  client_version TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_telemetry_events_timestamp ON telemetry_events(server_timestamp);
CREATE INDEX IF NOT EXISTS idx_telemetry_events_type ON telemetry_events(event_type);
