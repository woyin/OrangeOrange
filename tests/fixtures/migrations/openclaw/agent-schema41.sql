-- OpenClaw agent schema 41 的最小合成夹具（列与上游 openclaw-agent-schema.sql 对齐）。
-- 上游固定提交 d290127ec6750ac3b3504d44ab50b7cee5f92ec7；schema 41 在该提交为未发布版本。
-- https://github.com/openclaw/openclaw/blob/d290127ec6750ac3b3504d44ab50b7cee5f92ec7/src/state/openclaw-agent-schema.sql
-- 仅用于解析器测试，不包含运行期约束之外的逻辑。
CREATE TABLE schema_meta (
  meta_key TEXT NOT NULL PRIMARY KEY,
  role TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  agent_id TEXT,
  app_version TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE session_nodes (
  session_key TEXT NOT NULL PRIMARY KEY,
  current_session_id TEXT NOT NULL,
  entry_json TEXT NOT NULL,
  session_started_at INTEGER,
  updated_at INTEGER NOT NULL,
  status TEXT,
  created_at INTEGER,
  created_via TEXT,
  parent_session_key TEXT,
  label TEXT,
  display_name TEXT,
  archived_at INTEGER,
  last_activity_at INTEGER
) STRICT;

CREATE TABLE session_windows (
  session_id TEXT NOT NULL PRIMARY KEY,
  session_key TEXT NOT NULL,
  previous_session_id TEXT,
  reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  started_at INTEGER,
  ended_at INTEGER,
  display_name TEXT
) STRICT;

CREATE TABLE transcript_events (
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  event_json TEXT,
  created_at INTEGER NOT NULL,
  event_zstd BLOB,
  event_utf8_bytes INTEGER,
  PRIMARY KEY (session_id, seq)
) STRICT;

CREATE TABLE session_transcript_active_events (
  session_id TEXT NOT NULL,
  active_position INTEGER NOT NULL,
  event_seq INTEGER NOT NULL,
  message_position INTEGER,
  context_eligible INTEGER,
  PRIMARY KEY (session_id, active_position)
) STRICT;

CREATE TABLE session_transcript_cold_archives (
  session_id TEXT NOT NULL,
  generation TEXT NOT NULL,
  archive_name TEXT NOT NULL,
  PRIMARY KEY (session_id, generation)
) STRICT;

-- 保留型归档：archive_blob 的 sha256 必须先校验，encoding 为 identity 或 zstd。
CREATE TABLE session_transcript_archives (
  session_id TEXT NOT NULL,
  generation TEXT NOT NULL,
  session_key TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('deleted', 'reset')),
  encoding TEXT NOT NULL CHECK (encoding IN ('identity', 'zstd')),
  archive_blob BLOB NOT NULL,
  archive_sha256 TEXT NOT NULL CHECK (length(archive_sha256) = 64),
  archive_name TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  published_at INTEGER,
  publish_attempts INTEGER NOT NULL DEFAULT 0 CHECK (publish_attempts >= 0),
  last_publish_attempt_at INTEGER,
  last_publish_error TEXT,
  PRIMARY KEY (session_id, generation)
) STRICT;
