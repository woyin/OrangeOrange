-- Hermes state.db schema 33 的最小合成夹具（列与上游 hermes_state_common.py 对齐）。
-- 上游固定提交 47edbcd170be6a2edf876eaa5c4b9a8595bc4cf0。
-- https://github.com/NousResearch/hermes-agent/blob/47edbcd170be6a2edf876eaa5c4b9a8595bc4cf0/hermes_state_common.py
CREATE TABLE schema_version (version INTEGER NOT NULL);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  display_name TEXT,
  title TEXT,
  model TEXT,
  started_at REAL NOT NULL,
  ended_at REAL,
  message_count INTEGER DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  pinned INTEGER NOT NULL DEFAULT 0,
  parent_session_id TEXT
);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT,
  tool_calls TEXT,
  tool_name TEXT,
  timestamp REAL NOT NULL,
  compacted INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);
