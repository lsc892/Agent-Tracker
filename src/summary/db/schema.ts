export const SCHEMA_VERSION = 1;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS manifest (
  id INTEGER PRIMARY KEY,
  provider TEXT NOT NULL CHECK(provider IN ('claude', 'codex')),
  source_root TEXT NOT NULL,
  path TEXT NOT NULL,
  session_id TEXT,
  size_bytes INTEGER NOT NULL DEFAULT 0 CHECK(size_bytes >= 0),
  mtime_ms REAL NOT NULL DEFAULT 0,
  dev TEXT,
  inode TEXT,
  parser_version INTEGER NOT NULL DEFAULT 0,
  last_seen_scan_id TEXT,
  processing_status TEXT NOT NULL DEFAULT 'processing'
    CHECK(processing_status IN ('processing','done','error','interrupted')),
  processing_position TEXT,
  recorded_at TEXT NOT NULL,
  last_error TEXT,
  UNIQUE(provider, path)
);
CREATE INDEX IF NOT EXISTS idx_manifest_identity ON manifest(provider, dev, inode);
CREATE INDEX IF NOT EXISTS idx_manifest_root_id ON manifest(provider, source_root, id);
CREATE INDEX IF NOT EXISTS idx_manifest_session ON manifest(provider, session_id, id);

CREATE TABLE IF NOT EXISTS turn_summary (
  id INTEGER PRIMARY KEY,
  provider TEXT NOT NULL CHECK(provider IN ('claude', 'codex')),
  project_key TEXT NOT NULL,
  project_name TEXT NOT NULL,
  session_id TEXT NOT NULL,
  root_turn_id TEXT NOT NULL,
  turn_index INTEGER NOT NULL,
  started_at_ms INTEGER,
  completed_at_ms INTEGER,
  duration_ms INTEGER CHECK(duration_ms >= 0),
  duration_quality TEXT NOT NULL CHECK(duration_quality IN ('exact','derived','approximate','missing')),
  input_tokens INTEGER NOT NULL CHECK(input_tokens >= 0),
  output_tokens INTEGER NOT NULL CHECK(output_tokens >= 0),
  total_tokens INTEGER NOT NULL CHECK(total_tokens = input_tokens + output_tokens),
  status TEXT NOT NULL CHECK(status IN ('completed','in_progress')),
  quality_flags TEXT,
  diagnostic_file_id INTEGER REFERENCES manifest(id) ON DELETE SET NULL,
  diagnostic_offset INTEGER,
  last_error TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE(provider, session_id, root_turn_id)
);
CREATE INDEX IF NOT EXISTS idx_summary_period ON turn_summary(started_at_ms, provider);
CREATE INDEX IF NOT EXISTS idx_summary_project_period ON turn_summary(provider, project_key, started_at_ms);
CREATE INDEX IF NOT EXISTS idx_summary_session ON turn_summary(provider, session_id, turn_index);
`;
