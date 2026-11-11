import { afterEach, describe, expect, test } from "vitest";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { zstdCompressSync } from "node:zlib";
import {
  HERMES_STATE_SCHEMA_VERSION,
  MigrationImportError,
  OPENCLAW_AGENT_SCHEMA_VERSION,
  parseHermes,
  parseOpenClaw,
} from "../src/migrations/importers.js";

const FIXTURES = resolve(import.meta.dirname, "fixtures/migrations");
const FIXTURE_DIRS: string[] = [];
const T0 = Date.UTC(2026, 0, 2, 3, 4, 5);
const FAKE_SK_KEY = "sk-" + "livekey0123456789abcdef";
const FAKE_JWT =
  "eyJhbGciOiJIUzI1NiJ9" + "." + "eyJzdWIiOiIxMjM0NTY3ODkwIn0" + "." + "abcdefghijklmnopqrstuvwxyz";

afterEach(() => {
  for (const dir of FIXTURE_DIRS.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(path: string): Buffer {
  return readFileSync(join(FIXTURES, path));
}

function buildDatabase(
  schema: string,
  seed: (db: DatabaseSync) => void,
  options: { journalMode?: "wal" } = {},
): Buffer {
  const dir = mkdtempSync(join(tmpdir(), "orange-import-fixture-"));
  FIXTURE_DIRS.push(dir);
  const file = join(dir, "fixture.sqlite");
  const db = new DatabaseSync(file);
  try {
    db.exec(readFileSync(join(FIXTURES, schema), "utf8"));
    if (options.journalMode === "wal") db.exec("PRAGMA journal_mode = WAL");
    seed(db);
  } finally {
    db.close();
  }
  return readFileSync(file);
}

function expectImportError(run: () => unknown, code: string): MigrationImportError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(MigrationImportError);
    const typed = error as MigrationImportError;
    expect(typed.code).toBe(code);
    return typed;
  }
  throw new Error(`expected MigrationImportError ${code}`);
}

function seedOpenClaw(
  db: DatabaseSync,
  options: { schemaVersion?: number; role?: string } = {},
): void {
  db.prepare(
    "INSERT INTO schema_meta (meta_key, role, schema_version, agent_id, app_version, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
  ).run("primary", options.role ?? "agent", options.schemaVersion ?? 41, "main", "2026.11.2", T0, T0);
  db.prepare(
    "INSERT INTO session_nodes (session_key, current_session_id, entry_json, created_at, updated_at, status, display_name) VALUES (?,?,?,?,?,?,?)",
  ).run("main", "sess-1", "{}", T0, T0, "done", "Main session");
  db.prepare(
    "INSERT INTO session_windows (session_id, session_key, created_at, updated_at, reason) VALUES (?,?,?,?,?)",
  ).run("sess-1", "main", T0, T0, "initial");

  const insertEvent = db.prepare(
    "INSERT INTO transcript_events (session_id, seq, event_json, created_at, event_zstd, event_utf8_bytes) VALUES (?,?,?,?,?,?)",
  );
  const insertActive = db.prepare(
    "INSERT INTO session_transcript_active_events (session_id, active_position, event_seq, message_position) VALUES (?,?,?,?)",
  );
  insertEvent.run(
    "sess-1",
    1,
    JSON.stringify({ type: "message", message: { role: "user", content: "Earlier question", timestamp: T0 } }),
    T0,
    null,
    null,
  );
  insertActive.run("sess-1", 0, 1, 0);
  insertEvent.run(
    "sess-1",
    2,
    JSON.stringify({
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Answer with " + FAKE_SK_KEY }, { type: "image" }],
        timestamp: T0 + 1000,
      },
    }),
    T0 + 1000,
    null,
    null,
  );
  insertActive.run("sess-1", 1, 2, 1);
  insertEvent.run(
    "sess-1",
    3,
    JSON.stringify({ type: "message", message: { role: "tool", content: "tool output" } }),
    T0 + 2000,
    null,
    null,
  );
  insertActive.run("sess-1", 2, 3, 2);
  const compressedJson = JSON.stringify({
    type: "message",
    message: { role: "user", content: "Compressed hello", timestamp: T0 + 3000 },
  });
  insertEvent.run(
    "sess-1",
    4,
    null,
    T0 + 3000,
    zstdCompressSync(Buffer.from(compressedJson)),
    Buffer.byteLength(compressedJson),
  );
  insertActive.run("sess-1", 3, 4, 3);
}

function openClawFiles(db: Buffer): Map<string, Buffer> {
  return new Map([
    ["agents/main/agent/openclaw-agent.sqlite", db],
    ["agents/main/agent/auth-profiles.json", Buffer.from("{\"token\":\"auth-profile-secret\"}")],
    ["agents/main/sessions/legacy.jsonl", Buffer.from("{\"type\":\"message\"}\n")],
    ["openclaw.json", fixture("openclaw/openclaw.json")],
    ["workspace/MEMORY.md", fixture("openclaw/workspace/MEMORY.md")],
    ["workspace/SOUL.md", Buffer.from("# Soul\nBe precise.\n")],
    ["skills/demo/SKILL.md", fixture("openclaw/skills/demo/SKILL.md")],
    ["skills/demo/run.sh", Buffer.from("echo should-not-be-executed\n")],
    ["cron/jobs.json", fixture("openclaw/cron/jobs.v1.json")],
  ]);
}

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

interface ColdEventFixture {
  seq: number;
  createdAt: number;
  eventJson: string;
}

interface ColdChunkFixture {
  chunkIndex: number;
  archiveName: string;
  archiveSha256: string;
  firstSeq: number;
  lastSeq: number;
  eventCount: number;
  rawBytes: number;
  archiveBytes: number;
}

interface ColdArchiveFixture {
  archiveName: string;
  archiveSha256: string;
  archiveBytes: number;
  eventCount: number;
  rawBytes: number;
  lastSeq: number;
  chunks: ColdChunkFixture[];
  files: Map<string, Buffer>;
}

/** 按上游 d290127 的 session-cold-storage-prepare.ts 写入顺序生成夹具。 */
function buildColdArchive(
  sessionId: string,
  generation: string,
  events: ColdEventFixture[],
  split: number[] = [events.length],
): ColdArchiveFixture {
  const groups: ColdEventFixture[][] = [];
  let offset = 0;
  for (const size of split) {
    groups.push(events.slice(offset, offset + size));
    offset += size;
  }
  if (offset !== events.length || groups.some((group) => group.length === 0)) {
    throw new Error("invalid cold archive split");
  }
  const chunks: ColdChunkFixture[] = [];
  const files = new Map<string, Buffer>();
  for (const [chunkIndex, group] of groups.entries()) {
    const first = group[0]!;
    const last = group.at(-1)!;
    const lines: string[] = [];
    lines.push(JSON.stringify({ kind: "header", version: 1, sessionId, generation }) + "\n");
    for (const event of group) {
      lines.push(
        JSON.stringify({
          kind: "event",
          row: { seq: event.seq, event_json: event.eventJson, created_at: event.createdAt },
        }) + "\n",
      );
    }
    lines.push(
      JSON.stringify({
        kind: "identity",
        row: {
          event_id: "event-" + String(first.seq),
          seq: first.seq,
          event_type: "message",
          parent_id: null,
          message_idempotency_key: null,
          created_at: first.createdAt,
        },
      }) + "\n",
    );
    lines.push(
      JSON.stringify({
        kind: "active",
        row: { active_position: 0, event_seq: first.seq, message_position: 0, context_eligible: 1 },
      }) + "\n",
    );
    if (chunkIndex === groups.length - 1) {
      lines.push(
        JSON.stringify({
          kind: "index",
          row: {
            indexed_seq: last.seq,
            leaf_event_id: null,
            needs_rebuild: 0,
            active_event_count: group.length,
            active_message_count: group.length,
            updated_at: last.createdAt,
          },
        }) + "\n",
      );
    }
    lines.push(
      JSON.stringify({
        kind: "fts",
        row: { text: "indexed text", message_id: "event-" + String(first.seq), role: "user", timestamp: null },
      }) + "\n",
    );
    const bytes = zstdCompressSync(Buffer.from(lines.join("")));
    const sha = sha256Hex(bytes);
    const rawEventBytes = group.reduce((total, event) => total + Buffer.byteLength(event.eventJson), 0);
    const chunk: ColdChunkFixture = {
      chunkIndex,
      archiveName: sha + ".jsonl.zst",
      archiveSha256: sha,
      firstSeq: first.seq,
      lastSeq: last.seq,
      eventCount: group.length,
      rawBytes: rawEventBytes + group.length - 1,
      archiveBytes: bytes.length,
    };
    chunks.push(chunk);
    files.set(chunk.archiveName, bytes);
  }
  if (chunks.length === 1) {
    const only = chunks[0]!;
    return {
      archiveName: only.archiveName,
      archiveSha256: only.archiveSha256,
      archiveBytes: only.archiveBytes,
      eventCount: only.eventCount,
      rawBytes: only.rawBytes,
      lastSeq: only.lastSeq,
      chunks,
      files,
    };
  }
  const hash = sha256Hex(
    Buffer.from(
      JSON.stringify(
        chunks.map((chunk) => [
          chunk.chunkIndex,
          chunk.archiveName,
          chunk.archiveSha256,
          chunk.firstSeq,
          chunk.lastSeq,
          chunk.eventCount,
          chunk.rawBytes,
          chunk.archiveBytes,
        ]),
      ),
    ),
  );
  return {
    archiveName: hash + ".jsonl.zst",
    archiveSha256: hash,
    archiveBytes: chunks.reduce((total, chunk) => total + chunk.archiveBytes, 0),
    eventCount: chunks.reduce((total, chunk) => total + chunk.eventCount, 0),
    rawBytes: chunks.reduce((total, chunk) => total + chunk.rawBytes, 0) + chunks.length - 1,
    lastSeq: chunks.at(-1)!.lastSeq,
    chunks,
    files,
  };
}

function coldEvents(): ColdEventFixture[] {
  return [
    {
      seq: 10,
      createdAt: T0,
      eventJson: JSON.stringify({
        type: "message",
        message: { role: "user", content: "Archived question", timestamp: T0 },
      }),
    },
    {
      seq: 11,
      createdAt: T0 + 1000,
      eventJson: JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Archived answer with " + FAKE_SK_KEY }, { type: "image" }],
          timestamp: T0 + 1000,
        },
      }),
    },
    {
      seq: 12,
      createdAt: T0 + 2000,
      eventJson: JSON.stringify({
        type: "message",
        message: { role: "tool", content: "RAW COLD TOOL OUTPUT SHOULD NOT IMPORT" },
      }),
    },
    {
      seq: 13,
      createdAt: T0 + 3000,
      eventJson: JSON.stringify({
        type: "message",
        message: { role: "system", content: "cold system prompt should not import" },
      }),
    },
  ];
}

function seedColdArchiveSchema(db: DatabaseSync): void {
  db.exec(`ALTER TABLE session_transcript_cold_archives ADD COLUMN archive_sha256 TEXT;
    ALTER TABLE session_transcript_cold_archives ADD COLUMN event_count INTEGER;
    ALTER TABLE session_transcript_cold_archives ADD COLUMN raw_bytes INTEGER;
    ALTER TABLE session_transcript_cold_archives ADD COLUMN archive_bytes INTEGER;
    ALTER TABLE session_transcript_cold_archives ADD COLUMN last_seq INTEGER;
    ALTER TABLE session_transcript_cold_archives ADD COLUMN archived_at INTEGER;
    ALTER TABLE session_transcript_cold_archives ADD COLUMN storage TEXT;
    ALTER TABLE session_transcript_cold_archives ADD COLUMN archive_blob BLOB;
    CREATE TABLE session_transcript_cold_archive_chunks (
      session_id TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      archive_name TEXT NOT NULL UNIQUE,
      archive_sha256 TEXT NOT NULL,
      first_seq INTEGER NOT NULL,
      last_seq INTEGER NOT NULL,
      event_count INTEGER NOT NULL,
      raw_bytes INTEGER NOT NULL,
      archive_bytes INTEGER NOT NULL,
      archive_blob BLOB,
      PRIMARY KEY (session_id, chunk_index)
    ) STRICT;`);
}

function insertColdArchive(
  db: DatabaseSync,
  sessionId: string,
  generation: string,
  archive: ColdArchiveFixture,
  options: { storage?: "file" | "sqlite"; overrides?: Record<string, unknown> } = {},
): void {
  const storage = options.storage ?? "file";
  const values: Record<string, unknown> = {
    archive_name: archive.archiveName,
    archive_sha256: archive.archiveSha256,
    event_count: archive.eventCount,
    raw_bytes: archive.rawBytes,
    archive_bytes: archive.archiveBytes,
    last_seq: archive.lastSeq,
    archived_at: T0,
    storage,
    ...options.overrides,
  };
  db.prepare(
    `INSERT INTO session_transcript_cold_archives
       (session_id, generation, archive_name, archive_sha256, event_count, raw_bytes,
        archive_bytes, last_seq, archived_at, storage, archive_blob)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    sessionId,
    generation,
    values.archive_name as string,
    values.archive_sha256 as string,
    values.event_count as number,
    values.raw_bytes as number,
    values.archive_bytes as number,
    values.last_seq as number,
    values.archived_at as number,
    values.storage as string,
    storage === "sqlite" ? archive.files.get(archive.chunks[0]!.archiveName) ?? null : null,
  );
  if (archive.chunks.length > 1) {
    const insertChunk = db.prepare(
      `INSERT INTO session_transcript_cold_archive_chunks
         (session_id, chunk_index, archive_name, archive_sha256, first_seq, last_seq,
          event_count, raw_bytes, archive_bytes, archive_blob)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    );
    for (const chunk of archive.chunks) {
      insertChunk.run(
        sessionId,
        chunk.chunkIndex,
        chunk.archiveName,
        chunk.archiveSha256,
        chunk.firstSeq,
        chunk.lastSeq,
        chunk.eventCount,
        chunk.rawBytes,
        chunk.archiveBytes,
        storage === "sqlite" ? archive.files.get(chunk.archiveName)! : null,
      );
    }
  }
}

function coldArchiveDatabase(
  archive: ColdArchiveFixture,
  options: { storage?: "file" | "sqlite"; overrides?: Record<string, unknown>; rowSessionId?: string } = {},
): Buffer {
  return buildDatabase("openclaw/agent-schema41.sql", (database) => {
    seedOpenClaw(database);
    seedColdArchiveSchema(database);
    insertColdArchive(database, options.rowSessionId ?? "sess-1", "gen-1", archive, options);
  });
}

function coldArchiveFiles(
  db: Buffer,
  archive?: ColdArchiveFixture,
  options: { storage?: "file" | "sqlite" } = {},
): Map<string, Buffer> {
  const files = openClawFiles(db);
  if (archive && (options.storage ?? "file") === "file") {
    for (const [name, bytes] of archive.files) files.set("agents/main/sessions/cold/" + name, bytes);
  }
  return files;
}

function rawColdArchiveFixture(bytes: Buffer): ColdArchiveFixture {
  const sha = sha256Hex(bytes);
  return {
    archiveName: sha + ".jsonl.zst",
    archiveSha256: sha,
    archiveBytes: bytes.length,
    eventCount: 1,
    rawBytes: 1,
    lastSeq: 1,
    chunks: [],
    files: new Map([[sha + ".jsonl.zst", bytes]]),
  };
}

interface RetainedArchiveFixture {
  bytes: Buffer;
  sha256: string;
  encoding: "identity" | "zstd";
}

/** 按上游 d290127 的归档内容格式生成夹具：会话头一行，其后每条事件一行 JSON。 */
function buildRetainedArchive(
  sessionId: string,
  events: string[],
  options: { encoding?: "identity" | "zstd" } = {},
): RetainedArchiveFixture {
  const content = [JSON.stringify({ type: "session", id: sessionId }), ...events].join("\n") + "\n";
  const plain = Buffer.from(content, "utf8");
  const encoding = options.encoding ?? "identity";
  const bytes = encoding === "zstd" ? zstdCompressSync(plain) : plain;
  return { bytes, sha256: sha256Hex(bytes), encoding };
}

function insertRetainedArchive(
  db: DatabaseSync,
  options: {
    sessionId: string;
    generation: string;
    archive: RetainedArchiveFixture;
    sessionKey?: string;
    reason?: "deleted" | "reset";
    encoding?: "identity" | "zstd";
    archiveName?: string;
    sha256?: string;
  },
): void {
  db.prepare(
    `INSERT INTO session_transcript_archives
       (session_id, generation, session_key, reason, encoding, archive_blob, archive_sha256, archive_name, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(
    options.sessionId,
    options.generation,
    options.sessionKey ?? "main",
    options.reason ?? "reset",
    options.encoding ?? options.archive.encoding,
    options.archive.bytes,
    options.sha256 ?? options.archive.sha256,
    options.archiveName ?? `${options.archive.sha256}.jsonl.${options.reason ?? "reset"}`,
    T0,
  );
}

function retainedArchiveDatabase(
  insert: (db: DatabaseSync) => void,
): Buffer {
  return buildDatabase("openclaw/agent-schema41.sql", (database) => {
    seedOpenClaw(database);
    insert(database);
  });
}

function retainedArchiveItem(inventory: ReturnType<typeof parseOpenClaw>) {
  return inventory.items.find(
    (item) => item.type === "archive" && item.sourceId.startsWith("retained_archive:"),
  )!;
}

function retainedMessages(inventory: ReturnType<typeof parseOpenClaw>) {
  return inventory.items.filter(
    (item) => item.type === "message" && (item.content as { origin?: string }).origin === "retained_archive",
  );
}

function coldArchiveItem(inventory: ReturnType<typeof parseOpenClaw>) {
  return inventory.items.find((item) => item.type === "archive")!;
}

function coldMessages(inventory: ReturnType<typeof parseOpenClaw>) {
  return inventory.items.filter(
    (item) => item.type === "message" && (item.content as { origin?: string }).origin === "cold_archive",
  );
}

describe("parseOpenClaw", () => {
  test("parses agent schema 41 sessions, transcript, docs, skills, cron and config", () => {
    const inventory = parseOpenClaw(openClawFiles(buildDatabase("openclaw/agent-schema41.sql", seedOpenClaw)), "oc-instance");

    expect(inventory.system).toBe("openclaw");
    expect(inventory.instanceId).toBe("oc-instance");
    expect(inventory.version).toBe(`openclaw:agent-schema-${OPENCLAW_AGENT_SCHEMA_VERSION}`);

    const session = inventory.items.find((item) => item.type === "session");
    expect(session?.sourceId).toBe("session:main:main");
    expect(session?.sourceTime).toBe(new Date(T0).toISOString());

    const messages = inventory.items.filter((item) => item.type === "message");
    expect(messages.map((item) => (item.content as { text?: string }).text)).toEqual([
      "Earlier question",
      "Answer with [REDACTED]",
      "tool output",
      "Compressed hello",
    ]);
    expect(messages.map((item) => (item.content as { role: string }).role)).toEqual([
      "user",
      "assistant",
      "tool",
      "user",
    ]);
    expect(messages[1]?.warnings).toContain("secret_redacted");
    expect(messages[3]?.sourceTime).toBe(new Date(T0 + 3000).toISOString());
    // Tool 输出只读保留，不重放；未知非文本（image）逐类上报。
    expect(messages[2]?.content).toMatchObject({ readOnly: true, executable: false });
    expect(messages[2]?.warnings).toEqual(
      expect.arrayContaining(["tool_output_readonly", "tool_execution_not_replayed"]),
    );
    expect(inventory.warnings).toContain("content_parts_skipped:image:1");
    expect(inventory.warnings).toContain("tool_outputs_retained:1");

    const memory = inventory.items.find((item) => item.type === "memory");
    expect(memory?.content).toMatchObject({ path: "workspace/MEMORY.md" });
    expect((memory?.content as { text: string }).text).toContain("Keep replies short");

    const skill = inventory.items.find((item) => item.type === "skill");
    const skillContent = skill?.content as { name: string; files: Array<{ path: string }> };
    expect(skillContent.name).toBe("demo-skill");
    expect(skillContent.files.map((entry) => entry.path)).toEqual(["skills/demo/run.sh"]);
    expect(skill?.warnings).toContain("skill_not_enabled");

    const cron = inventory.items.find((item) => item.type === "cron");
    const cronContent = cron?.content as { prompt: string; sourceEnabled: boolean };
    expect(cronContent.prompt).toContain("api_key=[REDACTED]");
    expect(cronContent.prompt).not.toContain("delivery-token-should-not-appear");
    expect(cronContent.sourceEnabled).toBe(true);
    expect(cron?.warnings).toContain("cron_requires_review");
    expect(cronContent).toMatchObject({delivery:{channel:"telegram"}});
    expect(cron?.warnings).toContain("cron_field_omitted:delivery.token");

    const config = inventory.items.find((item) => item.type === "config");
    const configText = JSON.stringify(config?.content);
    expect(configText).toContain("topLevelKeys");
    expect(configText).not.toContain("config-secret-token-should-not-appear");
    expect(configText).not.toContain("telegram-token-should-not-appear");

    expect(inventory.warnings).toContain("sensitive_file_skipped:agents/main/agent/auth-profiles.json");
    expect(inventory.warnings).toContain("legacy_jsonl_ignored:1");
    expect(inventory.warnings.some((warning) => warning.startsWith("secrets_redacted:"))).toBe(true);
    expect(inventory.warnings).toContain("skills_imported_for_review:1");
    expect(JSON.stringify(inventory)).not.toContain("auth-profile-secret");
    expect(JSON.stringify(inventory)).not.toContain(FAKE_SK_KEY);
  });

  test("rejects unsupported agent schema versions", () => {
    const db = buildDatabase("openclaw/agent-schema41.sql", (database) =>
      seedOpenClaw(database, { schemaVersion: OPENCLAW_AGENT_SCHEMA_VERSION + 1 }),
    );
    const error = expectImportError(() => parseOpenClaw(openClawFiles(db), "oc"), "SOURCE_DB_UNSUPPORTED_SCHEMA");
    expect(error.message).toContain(String(OPENCLAW_AGENT_SCHEMA_VERSION + 1));
  });

  test("rejects a state database passed as an agent database", () => {
    const db = buildDatabase("openclaw/agent-schema41.sql", (database) =>
      seedOpenClaw(database, { role: "state" }),
    );
    expectImportError(() => parseOpenClaw(openClawFiles(db), "oc"), "SOURCE_DB_WRONG_ROLE");
  });

  test("rejects a database missing a required v41 table", () => {
    const db = buildDatabase("openclaw/agent-schema41.sql", (database) => {
      seedOpenClaw(database);
      database.exec("DROP TABLE session_transcript_active_events");
    });
    expectImportError(() => parseOpenClaw(openClawFiles(db), "oc"), "SOURCE_DB_UNSUPPORTED_SCHEMA");
  });

  test("rejects legacy JSONL-only layouts instead of pretending success", () => {
    const files = new Map<string, Buffer>([
      ["agents/main/sessions/2026-01-01.jsonl", Buffer.from("{\"type\":\"message\"}\n")],
    ]);
    const error = expectImportError(() => parseOpenClaw(files, "oc"), "SOURCE_LAYOUT_UNSUPPORTED");
    expect(error.message).toContain("JSONL");
  });

  test("keeps whitelisted config values as a draft with per-field loss and reauth items", () => {
    const files = openClawFiles(buildDatabase("openclaw/agent-schema41.sql", seedOpenClaw));
    files.set(
      "openclaw.json",
      Buffer.from(
        JSON.stringify({
          gateway: { auth: { token: "gateway-token-should-not-appear" }, host: "127.0.0.1", port: 8080 },
          agents: { defaults: { workspace: "/srv/openclaw/workspace", unknownFlag: true } },
          channels: { telegram: { botToken: "telegram-token-should-not-appear", allowlist: ["u1"] } },
          logging: { level: "info" },
        }),
      ),
    );

    const inventory = parseOpenClaw(files, "oc-config");
    const config = inventory.items.find((item) => item.type === "config");
    const content = config?.content as {
      imported: boolean;
      format: string;
      draft: Record<string, unknown>;
      unknownFields: Array<{ path: string; reason: string }>;
      reauthFields: string[];
    };

    expect(content.format).toBe("json");
    expect(content.imported).toBe(false);
    expect(content.draft).toEqual({
      "agents.defaults.workspace": "/srv/openclaw/workspace",
      "gateway.host": "127.0.0.1",
      "gateway.port": 8080,
    });
    expect(content.unknownFields).toEqual([
      { path: "agents.defaults.unknownFlag", reason: "not_in_whitelist" },
      { path: "channels.telegram.allowlist", reason: "non_scalar_value" },
      { path: "logging.level", reason: "not_in_whitelist" },
    ]);
    expect(content.reauthFields).toEqual(["channels.telegram.botToken", "gateway.auth.token"]);
    expect(config?.warnings).toContain("config_field_omitted:agents.defaults.unknownFlag");
    expect(config?.warnings).toContain("config_field_omitted:logging.level");
    expect(config?.warnings).toContain("credential_requires_reauth:gateway.auth.token");

    const reauth = inventory.items.filter(
      (item) => item.type === "reauth" && (item.content as { field?: string }).field !== undefined,
    );
    expect(reauth.map((item) => (item.content as { field: string }).field)).toEqual([
      "channels.telegram.botToken",
      "gateway.auth.token",
    ]);
    for (const item of reauth) {
      expect(item.content).toMatchObject({ requiredAction: "reauth", valueCopied: false });
      expect(JSON.stringify(item.content)).not.toContain("should-not-appear");
    }

    expect(inventory.warnings).toContain("config_draft_fields:openclaw.json:3");
    expect(inventory.warnings).toContain("config_field_loss:openclaw.json:3");
    expect(inventory.warnings).toContain("config_credentials_require_reauth:openclaw.json:2");
    const serialized = JSON.stringify(inventory);
    expect(serialized).not.toContain("gateway-token-should-not-appear");
    expect(serialized).not.toContain("telegram-token-should-not-appear");
  });

  test("redacts credentials in session metadata", () => {
    const db=buildDatabase("hermes/state-schema33.sql", database=>{seedHermes(database);database.prepare("UPDATE sessions SET title=?").run("title sk-abcdefghijklmnopqrstuv");});
    const result=parseHermes(hermesFiles(db),"metadata");expect(JSON.stringify(result)).not.toContain("sk-abcdefghijklmnopqrstuv");expect(JSON.stringify(result)).toContain("[REDACTED]");
  });

  test("does not copy credentials or query values embedded in config URLs", () => {
    const db=buildDatabase("openclaw/agent-schema41.sql", seedOpenClaw);const files=openClawFiles(db);
    files.set("openclaw.json",Buffer.from(JSON.stringify({providers:{demo:{baseUrl:"https://alice:privatevalue@example.org/path?token=secretvalue"}}})));
    const result=parseOpenClaw(files,"instance");const serialized=JSON.stringify(result);expect(serialized).not.toContain("privatevalue");expect(serialized).not.toContain("secretvalue");expect(serialized).toContain("https://example.org");expect(serialized).toContain("url_components_not_copied");
  });

  test("preserves cold archive fields and reports explicit field-level losses", () => {
    const withArchive = (archive: Buffer | null): Map<string, Buffer> => {
      const db = buildDatabase("openclaw/agent-schema41.sql", (database) => {
        seedOpenClaw(database);
        database
          .prepare("INSERT INTO session_transcript_cold_archives (session_id, generation, archive_name) VALUES (?,?,?)")
          .run("sess-1", "gen-1", "cold/sess-1.1.jsonl.zst");
      });
      const files = openClawFiles(db);
      if (archive) files.set("agents/main/agent/cold/sess-1.1.jsonl.zst", archive);
      return files;
    };

    const missing = parseOpenClaw(withArchive(null), "oc-cold");
    const archive = missing.items.find((item) => item.type === "archive");
    const content = archive?.content as {
      sessionKey: string | null;
      generation: string;
      archiveName: string;
      bodyAvailable: boolean;
      body: unknown;
      losses: Array<{ field: string; reason: string }>;
    };
    expect(archive?.sourceId).toBe("cold_archive:main:sess-1:gen-1");
    expect(content.sessionKey).toBe("main");
    expect(content.generation).toBe("gen-1");
    expect(content.archiveName).toBe("cold/sess-1.1.jsonl.zst");
    expect(content.bodyAvailable).toBe(false);
    expect(content.body).toBeNull();
    expect(content.losses).toEqual([
      { field: "archive_body", reason: "archive_content_missing_from_snapshot" },
      { field: "archive_body.messages", reason: "unavailable_without_archive_content" },
    ]);
    expect(archive?.warnings).toContain("cold_archive_body_missing");
    expect(missing.warnings).toContain("cold_archive_items:agents/main/agent/openclaw-agent.sqlite:1");
    expect(missing.warnings).toContain("cold_archive_body_missing:agents/main/agent/openclaw-agent.sqlite:1");

    const body = zstdCompressSync(Buffer.from(JSON.stringify({ type: "message" }) + "\n"));
    const present = parseOpenClaw(withArchive(body), "oc-cold-body");
    const withBody = present.items.find((item) => item.type === "archive")?.content as {
      bodyAvailable: boolean;
      bodyDecoded: boolean;
      body: { path: string; storage: string | null; bytes: number; sha256: string } | null;
      losses: Array<{ field: string; reason: string }>;
    };
    expect(withBody.bodyAvailable).toBe(true);
    expect(withBody.bodyDecoded).toBe(false);
    expect(withBody.body?.path).toBe("agents/main/agent/cold/sess-1.1.jsonl.zst");
    expect(withBody.body?.bytes).toBe(body.length);
    expect(withBody.body?.storage).toBeNull();
    expect(withBody.body?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(withBody.losses).toEqual([{ field: "archive_body.messages", reason: "archive_metadata_incomplete" }]);
    expect(present.warnings).toContain("cold_archive_body_undecodable:agents/main/agent/openclaw-agent.sqlite:1");
  });

  test("decodes verified cold archive history with redaction and no raw body leakage", () => {
    const archive = buildColdArchive("sess-1", "gen-1", coldEvents());
    const inventory = parseOpenClaw(coldArchiveFiles(coldArchiveDatabase(archive), archive), "oc-cold-decode");
    const archiveItem = coldArchiveItem(inventory);
    const content = archiveItem.content as {
      bodyAvailable: boolean;
      bodyDecoded: boolean;
      body: { path: string | null; storage: string; bytes: number; sha256: string } | null;
      decoded: { chunks: number; events: number; messages: number; skippedEvents: number } | null;
      losses: Array<{ field: string; reason: string }>;
      metadata: Record<string, unknown>;
    };
    expect(archiveItem.sourceId).toBe("cold_archive:main:sess-1:gen-1");
    expect(content.bodyAvailable).toBe(true);
    expect(content.bodyDecoded).toBe(true);
    expect(content.body).toEqual({
      path: "agents/main/sessions/cold/" + archive.archiveName,
      storage: "file",
      bytes: archive.archiveBytes,
      sha256: archive.archiveSha256,
    });
    expect(content.decoded).toEqual({ chunks: 0, events: 4, messages: 4, skippedEvents: 0 });
    expect(content.metadata).toMatchObject({ event_count: 4, storage: "file" });
    expect(content.losses).toEqual([{ field: "archive_blob", reason: "archive_field_not_retained" }]);
    expect(archiveItem.warnings).toContain("cold_archive_history_imported");

    const messages = coldMessages(inventory);
    expect(messages.map((item) => (item.content as { text?: string }).text)).toEqual([
      "Archived question",
      "Archived answer with [REDACTED]",
      "RAW COLD TOOL OUTPUT SHOULD NOT IMPORT",
      "cold system prompt should not import",
    ]);
    expect(messages.map((item) => (item.content as { role: string }).role)).toEqual([
      "user",
      "assistant",
      "tool",
      "system",
    ]);
    expect(messages[0]?.sourceId).toBe("cold_message:main:sess-1:10");
    expect(messages[1]?.sourceTime).toBe(new Date(T0 + 1000).toISOString());
    expect(messages[1]?.warnings).toContain("secret_redacted");
    // Tool/System 文本只读保留：可读、可检索，但不是指令，也不会被重放执行。
    expect(messages[2]?.content).toMatchObject({ readOnly: true, executable: false });
    expect(messages[2]?.warnings).toEqual(
      expect.arrayContaining(["tool_output_readonly", "tool_execution_not_replayed"]),
    );
    expect(messages[3]?.content).toMatchObject({ readOnly: true, executable: false });
    expect(messages[3]?.warnings).toContain("system_text_readonly");
    // 冷归档属于较早窗口，消息顺序必须排在同会话的活动消息之前。
    const allMessages = inventory.items.filter((item) => item.type === "message");
    expect(allMessages.slice(0, 4).map((item) => (item.content as { origin?: string }).origin)).toEqual([
      "cold_archive",
      "cold_archive",
      "cold_archive",
      "cold_archive",
    ]);

    const serialized = JSON.stringify(inventory);
    expect(serialized).not.toContain(FAKE_SK_KEY);
    expect(inventory.warnings).toContain("cold_archive_body_decoded:agents/main/agent/openclaw-agent.sqlite:1");
    expect(inventory.warnings).toContain("cold_archive_messages:agents/main/agent/openclaw-agent.sqlite:4");
    expect(inventory.warnings).toContain("content_parts_skipped:image:2");
    expect(inventory.warnings).toContain("system_text_retained:1");
    // 活动转录与冷归档各有一条 tool 消息，均为只读保留。
    expect(inventory.warnings).toContain("tool_outputs_retained:2");
  });

  test("validates the chunk manifest before importing chunked cold archive history", () => {
    const archive = buildColdArchive("sess-1", "gen-1", coldEvents(), [2, 2]);
    expect(archive.chunks).toHaveLength(2);
    const inventory = parseOpenClaw(coldArchiveFiles(coldArchiveDatabase(archive), archive), "oc-cold-chunks");
    const content = coldArchiveItem(inventory).content as {
      body: { path: string | null; storage: string } | null;
      decoded: { chunks: number; events: number; messages: number; skippedEvents: number } | null;
    };
    expect(content.decoded).toEqual({ chunks: 2, events: 4, messages: 4, skippedEvents: 0 });
    expect(content.body).toMatchObject({ path: null, storage: "file" });
    expect(coldMessages(inventory)).toHaveLength(4);
    expect(inventory.warnings).toContain("cold_archive_chunks_decoded:agents/main/agent/openclaw-agent.sqlite:2");

    const tampered = coldArchiveFiles(coldArchiveDatabase(archive), archive);
    const firstName = archive.chunks[0]!.archiveName;
    const key = "agents/main/sessions/cold/" + firstName;
    const bytes = Buffer.from(tampered.get(key)!);
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0xff;
    tampered.set(key, bytes);
    const failed = parseOpenClaw(tampered, "oc-cold-tampered");
    const failedContent = coldArchiveItem(failed).content as {
      bodyAvailable: boolean;
      bodyDecoded: boolean;
      losses: Array<{ field: string; reason: string }>;
    };
    expect(failedContent.bodyAvailable).toBe(true);
    expect(failedContent.bodyDecoded).toBe(false);
    expect(failedContent.losses).toContainEqual({ field: "archive_body.messages", reason: "archive_hash_mismatch" });
    expect(coldMessages(failed)).toEqual([]);
    expect(failed.warnings).toContain("cold_archive_body_undecodable:agents/main/agent/openclaw-agent.sqlite:1");
  });

  test("reports fixed cold archive failure codes without partial import", () => {
    const archive = buildColdArchive("sess-1", "gen-1", coldEvents());
    const wrongCount = parseOpenClaw(
      coldArchiveFiles(coldArchiveDatabase(archive, { overrides: { event_count: 3 } }), archive),
      "oc-cold-count",
    );
    const countContent = coldArchiveItem(wrongCount).content as {
      bodyDecoded: boolean;
      losses: Array<{ field: string; reason: string }>;
    };
    expect(countContent.bodyDecoded).toBe(false);
    expect(countContent.losses).toContainEqual({ field: "archive_body.messages", reason: "archive_metadata_mismatch" });
    expect(coldMessages(wrongCount)).toEqual([]);

    const otherHeader = buildColdArchive("sess-other", "gen-1", coldEvents());
    const headerMismatch = parseOpenClaw(
      coldArchiveFiles(coldArchiveDatabase(otherHeader), otherHeader),
      "oc-cold-header",
    );
    const headerContent = coldArchiveItem(headerMismatch).content as {
      losses: Array<{ field: string; reason: string }>;
    };
    expect(headerContent.losses).toContainEqual({ field: "archive_body.messages", reason: "archive_metadata_mismatch" });
    expect(coldMessages(headerMismatch)).toEqual([]);

    const badBytes = zstdCompressSync(
      Buffer.from(
        JSON.stringify({ kind: "header", version: 1, sessionId: "sess-1", generation: "gen-1" }) +
          "\n" +
          JSON.stringify({ kind: "mystery", row: {} }) +
          "\n",
      ),
    );
    const badArchive = rawColdArchiveFixture(badBytes);
    const bad = parseOpenClaw(coldArchiveFiles(coldArchiveDatabase(badArchive), badArchive), "oc-cold-record");
    const badContent = coldArchiveItem(bad).content as { losses: Array<{ field: string; reason: string }> };
    expect(badContent.losses).toContainEqual({ field: "archive_body.messages", reason: "archive_record_invalid" });
    expect(coldMessages(bad)).toEqual([]);
  });

  test("bounds cold archive decompression by the upstream 64 MiB limit", () => {
    const oversized = zstdCompressSync(Buffer.alloc(64 * 1024 * 1024 + 1, 0x61));
    const sha = sha256Hex(oversized);
    const archive: ColdArchiveFixture = {
      archiveName: sha + ".jsonl.zst",
      archiveSha256: sha,
      archiveBytes: oversized.length,
      eventCount: 1,
      rawBytes: 1,
      lastSeq: 1,
      chunks: [],
      files: new Map([[sha + ".jsonl.zst", oversized]]),
    };
    const inventory = parseOpenClaw(coldArchiveFiles(coldArchiveDatabase(archive), archive), "oc-cold-quota");
    const content = coldArchiveItem(inventory).content as {
      bodyDecoded: boolean;
      losses: Array<{ field: string; reason: string }>;
    };
    expect(content.bodyDecoded).toBe(false);
    expect(content.losses).toContainEqual({ field: "archive_body.messages", reason: "archive_decoded_bytes_exceeded" });
    expect(coldMessages(inventory)).toEqual([]);
  });

  test("decodes embedded sqlite cold archives without retaining the blob", () => {
    const archive = buildColdArchive("sess-1", "gen-1", coldEvents());
    const inventory = parseOpenClaw(
      coldArchiveFiles(coldArchiveDatabase(archive, { storage: "sqlite" }), archive, { storage: "sqlite" }),
      "oc-cold-sqlite",
    );
    const content = coldArchiveItem(inventory).content as {
      body: { path: string | null; storage: string; bytes: number; sha256: string } | null;
      bodyDecoded: boolean;
      losses: Array<{ field: string; reason: string }>;
    };
    expect(content.bodyDecoded).toBe(true);
    expect(content.body).toEqual({
      path: null,
      storage: "sqlite",
      bytes: archive.archiveBytes,
      sha256: archive.archiveSha256,
    });
    expect(content.losses).toEqual([{ field: "archive_blob", reason: "archive_field_not_retained" }]);
    expect(coldMessages(inventory)).toHaveLength(4);
    // 工具输出保留为只读文本，不包含任何可执行字段。
    const toolMessage = coldMessages(inventory).find(
      (item) => (item.content as { role: string }).role === "tool",
    );
    expect(toolMessage?.content).toMatchObject({ readOnly: true, executable: false });
  });

  test("records cold archive metadata and omitted columns", () => {
    const db=buildDatabase("openclaw/agent-schema41.sql", database=>{seedOpenClaw(database);database.exec("ALTER TABLE session_transcript_cold_archives ADD COLUMN archive_sha256 TEXT; ALTER TABLE session_transcript_cold_archives ADD COLUMN archive_blob BLOB; INSERT INTO session_transcript_cold_archives(session_id,generation,archive_name,archive_sha256,archive_blob) VALUES('sess-1','g','a.zst','abc',x'0102')");});
    const parsed=parseOpenClaw(openClawFiles(db),"instance");const item=parsed.items.find(i=>i.type==="archive")!;expect(item.content).toMatchObject({metadata:{archive_sha256:"abc"},losses:expect.arrayContaining([{field:"archive_blob",reason:"archive_field_not_retained"}])});
  });

  test("decodes session_transcript_archives identity history as redacted read-only text", () => {
    const archive = buildRetainedArchive("sess-old", [
      JSON.stringify({
        type: "message",
        message: { role: "user", content: "Archived old question", timestamp: T0 },
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Old answer with " + FAKE_SK_KEY }, { type: "image" }],
          timestamp: T0 + 1000,
        },
      }),
      JSON.stringify({
        type: "message",
        message: { role: "tool", toolName: "exec", content: "RAW RETAINED TOOL OUTPUT" },
      }),
      JSON.stringify({ type: "message", message: { role: "system", content: "retained system prompt" } }),
    ]);
    const database = retainedArchiveDatabase((db) =>
      insertRetainedArchive(db, {
        sessionId: "sess-old",
        generation: "gen-1",
        sessionKey: "archived-key",
        archive,
      }),
    );
    const inventory = parseOpenClaw(openClawFiles(database), "oc-retained");
    const item = retainedArchiveItem(inventory);
    const content = item.content as {
      sessionId: string;
      generation: string;
      sessionKey: string;
      encoding: string;
      bodyAvailable: boolean;
      bodyDecoded: boolean;
      readOnly: boolean;
      body: { storage: string; encoding: string; bytes: number; sha256: string; decodedBytes: number } | null;
      decoded: { records: number; messages: number; skippedEvents: number } | null;
      losses: Array<{ field: string; reason: string }>;
    };
    expect(item.sourceId).toBe("retained_archive:main:sess-old:gen-1");
    expect(content).toMatchObject({
      sessionId: "sess-old",
      generation: "gen-1",
      sessionKey: "archived-key",
      encoding: "identity",
      bodyAvailable: true,
      bodyDecoded: true,
      readOnly: true,
    });
    expect(content.body).toEqual({
      storage: "sqlite",
      encoding: "identity",
      bytes: archive.bytes.length,
      sha256: archive.sha256,
      decodedBytes: archive.bytes.length,
    });
    expect(content.decoded).toEqual({ records: 5, messages: 4, skippedEvents: 0 });
    expect(content.losses).toContainEqual({ field: "archive_blob", reason: "archive_field_not_retained" });
    expect(item.warnings).toContain("retained_archive_history_imported");

    const messages = retainedMessages(inventory);
    expect(messages.map((entry) => (entry.content as { role: string }).role)).toEqual([
      "user",
      "assistant",
      "tool",
      "system",
    ]);
    expect(messages.map((entry) => (entry.content as { text?: string }).text)).toEqual([
      "Archived old question",
      "Old answer with [REDACTED]",
      "RAW RETAINED TOOL OUTPUT",
      "retained system prompt",
    ]);
    // sourceId 带 generation，同一会话多个归档代次不会冲突。
    expect(messages[0]?.sourceId).toBe("retained_message:main:sess-old:gen-1:1");
    expect(messages[1]?.warnings).toContain("secret_redacted");
    expect(messages[2]?.content).toMatchObject({ toolName: "exec", readOnly: true, executable: false });
    expect(messages[2]?.warnings).toEqual(
      expect.arrayContaining(["tool_output_readonly", "tool_execution_not_replayed"]),
    );
    expect(messages[3]?.content).toMatchObject({ readOnly: true, executable: false });
    expect(messages[3]?.warnings).toContain("system_text_readonly");
    // 归档会话已不在活动表中：补只读会话项，历史仍可检索。
    const archivedSession = inventory.items.find(
      (entry) => entry.type === "session" && entry.sourceId === "session:main:archived-key",
    );
    expect(archivedSession?.content).toMatchObject({
      archived: true,
      readOnly: true,
      origin: "transcript_archive",
    });
    // 归档历史排在同会话活动消息之前。
    const ordered = inventory.items.filter((entry) => entry.type === "message");
    expect(ordered.slice(0, 4).map((entry) => (entry.content as { origin?: string }).origin)).toEqual([
      "retained_archive",
      "retained_archive",
      "retained_archive",
      "retained_archive",
    ]);
    expect(inventory.warnings).toContain("retained_archive_items:agents/main/agent/openclaw-agent.sqlite:1");
    expect(inventory.warnings).toContain(
      "retained_archive_body_decoded:agents/main/agent/openclaw-agent.sqlite:1",
    );
    expect(inventory.warnings).toContain("retained_archive_messages:agents/main/agent/openclaw-agent.sqlite:4");
    expect(inventory.warnings).toContain("content_parts_skipped:image:2");
    expect(inventory.warnings).toContain("system_text_retained:1");
    expect(inventory.warnings).toContain("tool_outputs_retained:2");
    expect(JSON.stringify(inventory)).not.toContain(FAKE_SK_KEY);
  });

  test("decodes retained archives with zstd encoding after sha256 verification", () => {
    const events = [
      JSON.stringify({ type: "message", message: { role: "user", content: "Zstd archived question" } }),
      JSON.stringify({ type: "message", message: { role: "assistant", content: "Zstd archived answer" } }),
    ];
    const identity = buildRetainedArchive("sess-z", events);
    const zstd = buildRetainedArchive("sess-z", events, { encoding: "zstd" });
    expect(zstd.sha256).not.toBe(identity.sha256);
    const database = retainedArchiveDatabase((db) =>
      insertRetainedArchive(db, { sessionId: "sess-z", generation: "gen-z", archive: zstd }),
    );
    const inventory = parseOpenClaw(openClawFiles(database), "oc-retained-zstd");
    const content = retainedArchiveItem(inventory).content as {
      encoding: string;
      bodyDecoded: boolean;
      body: { encoding: string; bytes: number; sha256: string } | null;
    };
    expect(content.encoding).toBe("zstd");
    expect(content.bodyDecoded).toBe(true);
    expect(content.body).toMatchObject({ encoding: "zstd", bytes: zstd.bytes.length, sha256: zstd.sha256 });
    expect(retainedMessages(inventory).map((entry) => (entry.content as { text: string }).text)).toEqual([
      "Zstd archived question",
      "Zstd archived answer",
    ]);
  });

  test("reports fixed retained archive failure codes without partial import", () => {
    const message = (text: string) =>
      JSON.stringify({ type: "message", message: { role: "user", content: text } });

    const good = buildRetainedArchive("sess-f", [message("should not import")]);
    const hashDatabase = retainedArchiveDatabase((db) =>
      insertRetainedArchive(db, {
        sessionId: "sess-f",
        generation: "gen-hash",
        archive: good,
        sha256: "0".repeat(64),
      }),
    );
    const hashFailure = parseOpenClaw(openClawFiles(hashDatabase), "oc-retained-hash");
    expect(retainedMessages(hashFailure)).toEqual([]);
    const hashContent = retainedArchiveItem(hashFailure).content as {
      bodyDecoded: boolean;
      losses: Array<{ field: string; reason: string }>;
    };
    expect(hashContent.bodyDecoded).toBe(false);
    expect(hashContent.losses).toContainEqual({
      field: "archive_body.messages",
      reason: "archive_hash_mismatch",
    });
    expect(hashFailure.warnings).toContain(
      "retained_archive_body_undecodable:agents/main/agent/openclaw-agent.sqlite:1",
    );

    const otherHeader = buildRetainedArchive("sess-other", [message("wrong session")]);
    const headerDatabase = retainedArchiveDatabase((db) =>
      insertRetainedArchive(db, {
        sessionId: "sess-f",
        generation: "gen-header",
        archive: otherHeader,
      }),
    );
    const headerFailure = parseOpenClaw(openClawFiles(headerDatabase), "oc-retained-header");
    expect(retainedMessages(headerFailure)).toEqual([]);
    expect((retainedArchiveItem(headerFailure).content as { losses: Array<{ field: string; reason: string }> }).losses).toContainEqual({
      field: "archive_body.messages",
      reason: "archive_header_mismatch",
    });

    const corruptBytes = Buffer.from("not-a-zstd-frame");
    const corrupt: RetainedArchiveFixture = {
      bytes: corruptBytes,
      sha256: sha256Hex(corruptBytes),
      encoding: "zstd",
    };
    const corruptDatabase = retainedArchiveDatabase((db) =>
      insertRetainedArchive(db, { sessionId: "sess-f", generation: "gen-corrupt", archive: corrupt }),
    );
    const corruptFailure = parseOpenClaw(openClawFiles(corruptDatabase), "oc-retained-corrupt");
    expect(retainedMessages(corruptFailure)).toEqual([]);
    expect((retainedArchiveItem(corruptFailure).content as { losses: Array<{ field: string; reason: string }> }).losses).toContainEqual({
      field: "archive_body.messages",
      reason: "archive_container_invalid",
    });

    const badRecord = buildRetainedArchive("sess-f", ["not json"]);
    const badDatabase = retainedArchiveDatabase((db) =>
      insertRetainedArchive(db, { sessionId: "sess-f", generation: "gen-record", archive: badRecord }),
    );
    const badFailure = parseOpenClaw(openClawFiles(badDatabase), "oc-retained-record");
    expect(retainedMessages(badFailure)).toEqual([]);
    expect((retainedArchiveItem(badFailure).content as { losses: Array<{ field: string; reason: string }> }).losses).toContainEqual({
      field: "archive_body.messages",
      reason: "archive_record_invalid",
    });
  });

  test("reports unknown non-text content parts per category and keeps tool arguments read-only", () => {
    const db = buildDatabase("openclaw/agent-schema41.sql", (database) => {
      seedOpenClaw(database);
      const insertEvent = database.prepare(
        "INSERT INTO transcript_events (session_id, seq, event_json, created_at) VALUES (?,?,?,?)",
      );
      const insertActive = database.prepare(
        "INSERT INTO session_transcript_active_events (session_id, active_position, event_seq, message_position) VALUES (?,?,?,?)",
      );
      insertEvent.run(
        "sess-1",
        5,
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "known text" }, { type: "image" }, { type: "audio" }, { type: "thinking" }],
          },
        }),
        T0 + 4000,
      );
      insertActive.run("sess-1", 4, 5, 4);
      insertEvent.run(
        "sess-1",
        6,
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "toolCall", name: "exec", arguments: { command: "echo hi", key: FAKE_SK_KEY } }],
          },
        }),
        T0 + 5000,
      );
      insertActive.run("sess-1", 5, 6, 5);
      insertEvent.run(
        "sess-1",
        7,
        JSON.stringify({ type: "custom_message", customType: "note", content: "custom text" }),
        T0 + 6000,
      );
      insertActive.run("sess-1", 6, 7, 6);
    });
    const inventory = parseOpenClaw(openClawFiles(db), "oc-parts");
    const bySeq = (seq: number) =>
      inventory.items.find(
        (entry) => entry.type === "message" && (entry.content as { seq?: number }).seq === seq,
      )!;
    expect(bySeq(5).content).toMatchObject({ text: "known text" });
    const toolCall = bySeq(6);
    expect(toolCall.content).toMatchObject({
      toolName: "exec",
      executable: false,
    });
    expect((toolCall.content as { argumentsSummary: string }).argumentsSummary).toContain("exec(");
    expect(toolCall.warnings).toEqual(
      expect.arrayContaining(["tool_arguments_readonly", "tool_execution_not_replayed"]),
    );
    expect(JSON.stringify(toolCall.content)).not.toContain(FAKE_SK_KEY);
    // 未知非文本逐类报告；自定义事件单独归类（含夹具自带的 image 块）。
    expect(inventory.warnings).toContain("content_parts_skipped:image:2");
    expect(inventory.warnings).toContain("content_parts_skipped:audio:1");
    expect(inventory.warnings).toContain("content_parts_skipped:thinking:1");
    expect(inventory.warnings).toContain("non_chat_event_type:custom_message:1");
    expect(inventory.warnings).toContain("messages_skipped_non_chat:1");
  });

  test("reports credential files as reauth items instead of copying them", () => {
    const openclaw = parseOpenClaw(openClawFiles(buildDatabase("openclaw/agent-schema41.sql", seedOpenClaw)), "oc-reauth");
    const openclawReauth = openclaw.items.filter(
      (item) => item.type === "reauth" && (item.content as { kind?: string }).kind === "credential_file",
    );
    expect(openclawReauth.map((item) => item.sourceId)).toEqual(["reauth:file:agents/main/agent/auth-profiles.json"]);
    expect(openclawReauth[0]?.content).toMatchObject({ kind: "credential_file", requiredAction: "reauth" });
    expect(JSON.stringify(openclawReauth)).not.toContain("auth-profile-secret");

    const hermes = parseHermes(hermesFiles(buildDatabase("hermes/state-schema33.sql", seedHermes)), "hermes-reauth");
    const hermesReauth = hermes.items.filter(
      (item) => item.type === "reauth" && (item.content as { kind?: string }).kind === "credential_file",
    );
    expect(hermesReauth.map((item) => item.sourceId)).toEqual(["reauth:file:.env", "reauth:file:auth.json"]);
    expect(JSON.stringify(hermesReauth)).not.toContain("sk-should-not-be-read");
    expect(JSON.stringify(hermesReauth)).not.toContain("auth-json-secret");
  });

  test("rejects a WAL-mode agent database without its -wal sidecar", () => {
    const db = buildDatabase("openclaw/agent-schema41.sql", seedOpenClaw, { journalMode: "wal" });
    const error = expectImportError(() => parseOpenClaw(openClawFiles(db), "oc-wal"), "SOURCE_DB_UNSAFE_SNAPSHOT");
    expect(error.message).toContain("openclaw-agent.sqlite-wal");

    const withEmptyWal = openClawFiles(db);
    withEmptyWal.set("agents/main/agent/openclaw-agent.sqlite-wal", Buffer.alloc(0));
    const inventory = parseOpenClaw(withEmptyWal, "oc-wal-empty");
    expect(inventory.warnings).toContain("wal_mode_snapshot:agents/main/agent/openclaw-agent.sqlite");
    expect(inventory.warnings).toContain("wal_sidecar_empty_checkpointed:agents/main/agent/openclaw-agent.sqlite");
    expect(inventory.items.some((item) => item.type === "message")).toBe(true);
  });
});

function seedHermes(db: DatabaseSync, version = HERMES_STATE_SCHEMA_VERSION): void {
  db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(version);
  db.prepare(
    "INSERT INTO sessions (id, source, display_name, title, model, started_at, ended_at, message_count, archived, pinned, parent_session_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
  ).run("sess-h", "telegram", "Work chat", "Work chat", "glm-4.6", 1700000000.5, null, 4, 0, 1, null);
  const insert = db.prepare(
    "INSERT INTO messages (id, session_id, role, content, tool_calls, tool_name, timestamp, compacted, active) VALUES (?,?,?,?,?,?,?,?,?)",
  );
  insert.run(
    1,
    "sess-h",
    "user",
    "My JWT " + FAKE_JWT + " and Bearer abcdefghijklmnopqrstuvwxyz",
    null,
    null,
    1700000001.25,
    0,
    1,
  );
  insert.run(
    2,
    "sess-h",
    "assistant",
    JSON.stringify([{ type: "text", text: "Sure." }, { type: "image" }]),
    null,
    null,
    1700000002.5,
    0,
    1,
  );
  insert.run(3, "sess-h", "tool", "RAW TOOL OUTPUT SHOULD NOT IMPORT", null, "web_search", 1700000003, 0, 1);
  insert.run(4, "sess-h", "system", "system prompt", null, null, 1700000000.9, 0, 1);
  insert.run(5, "sess-h", "user", "rewound message", null, null, 1700000004, 0, 0);
  insert.run(
    6,
    "sess-h",
    "assistant",
    null,
    JSON.stringify([{ function: { name: "search_web", arguments: "{\"q\":\"x\"}" } }]),
    null,
    1700000005,
    0,
    1,
  );
}

function hermesFiles(db: Buffer): Map<string, Buffer> {
  return new Map([
    ["state.db", db],
    [".env", Buffer.from("OPENAI_API_KEY=sk-should-not-be-read")],
    ["auth.json", Buffer.from("{\"token\":\"auth-json-secret\"}")],
    ["sessions/sessions.json", fixture("hermes/sessions.json")],
    ["memories/MEMORY.md", fixture("hermes/memories/MEMORY.md")],
    ["memories/USER.md", Buffer.from("# User\nPrefers Chinese.\n")],
    ["SOUL.md", Buffer.from("# Soul\nDirect.\n")],
    ["skills/demo/SKILL.md", fixture("hermes/skills/demo/SKILL.md")],
    ["skills/demo/run.sh", Buffer.from("echo should-not-be-executed\n")],
    ["cron/jobs.json", fixture("hermes/cron/jobs.json")],
    ["config.yaml", fixture("hermes/config.yaml")],
    ["logs/agent.log", Buffer.from("log line")],
  ]);
}

describe("parseHermes", () => {
  test("parses schema 33 sessions, messages, memories, skills, cron and config", () => {
    const inventory = parseHermes(hermesFiles(buildDatabase("hermes/state-schema33.sql", seedHermes)), "hermes-instance");

    expect(inventory.system).toBe("hermes");
    expect(inventory.instanceId).toBe("hermes-instance");
    expect(inventory.version).toBe(`hermes:state-schema-${HERMES_STATE_SCHEMA_VERSION}`);

    const session = inventory.items.find((item) => item.type === "session");
    expect(session?.sourceId).toBe("session:sess-h");
    expect(session?.sourceTime).toBe(new Date(1700000000500).toISOString());
    expect(session?.content).toMatchObject({ pinned: true, archived: false, model: "glm-4.6" });

    const messages = inventory.items.filter((item) => item.type === "message");
    expect(messages.map((item) => (item.content as { messageId: number }).messageId)).toEqual([4, 1, 2, 3, 6]);
    // System 文本只读保留：可读、可检索，但不是指令，也不重放。
    expect(messages[0]?.content).toMatchObject({
      role: "system",
      text: "system prompt",
      readOnly: true,
      executable: false,
    });
    expect(messages[0]?.warnings).toContain("system_text_readonly");
    const first = messages[1]?.content as { text: string };
    expect(first.text).not.toContain(FAKE_JWT);
    expect(first.text).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(first.text).toContain("[REDACTED]");
    expect(messages[1]?.warnings).toContain("secret_redacted");

    const tool = messages[3]?.content as {
      text?: string;
      toolName: string;
      readOnly: boolean;
      executable: boolean;
    };
    expect(tool.text).toBe("RAW TOOL OUTPUT SHOULD NOT IMPORT");
    expect(tool.toolName).toBe("web_search");
    expect(tool.readOnly).toBe(true);
    expect(tool.executable).toBe(false);
    expect(messages[3]?.warnings).toEqual(
      expect.arrayContaining(["tool_output_readonly", "tool_execution_not_replayed"]),
    );

    const assistantTool = messages[4]?.content as {
      toolCalls: string[];
      toolName: string;
      argumentsSummary: string;
      text?: string;
      readOnly: boolean;
    };
    expect(assistantTool.toolCalls).toEqual(["search_web"]);
    expect(assistantTool.toolName).toBe("search_web");
    expect(assistantTool.argumentsSummary).toBe('search_web({"q":"x"})');
    expect(assistantTool.text).toBeUndefined();
    expect(assistantTool.readOnly).toBe(true);
    expect(messages[4]?.warnings).toEqual(
      expect.arrayContaining(["tool_arguments_readonly", "tool_execution_not_replayed"]),
    );

    const memories = inventory.items.filter((item) => item.type === "memory");
    expect(memories.map((item) => (item.content as { path: string }).path)).toEqual([
      "memories/MEMORY.md",
      "memories/USER.md",
    ]);
    expect(inventory.items.some((item) => item.type === "instruction" && item.sourceId === "doc:SOUL.md")).toBe(true);

    const skill = inventory.items.find((item) => item.type === "skill");
    expect((skill?.content as { name: string }).name).toBe("hermes-demo");
    expect((skill?.content as { files: Array<{ path: string }> }).files.map((entry) => entry.path)).toEqual([
      "skills/demo/run.sh",
    ]);

    const cron = inventory.items.find((item) => item.type === "cron");
    const cronContent = cron?.content as { prompt: string; sourceEnabled: boolean };
    expect(cronContent.sourceEnabled).toBe(false);
    expect(cronContent.prompt).toContain("client_secret=[REDACTED]");
    expect(cronContent.prompt).not.toContain("weekly-secret-value");
    expect(cron?.warnings).toContain("cron_requires_review");

    const config = inventory.items.find((item) => item.type === "config");
    expect(config?.content).toMatchObject({ path: "config.yaml", imported: false });

    expect(inventory.warnings).toContain("sensitive_file_skipped:.env");
    expect(inventory.warnings).toContain("sensitive_file_skipped:auth.json");
    expect(inventory.warnings).toContain("sessions_json_is_routing_index_not_session_list");
    expect(inventory.warnings).toContain("logs_skipped:1");
    expect(inventory.warnings).toContain("system_text_retained:1");
    expect(inventory.warnings).toContain("tool_outputs_retained:1");
    expect(inventory.warnings).toContain("content_parts_skipped:image:1");
    expect(inventory.warnings.some((warning) => warning.startsWith("secrets_redacted:"))).toBe(true);

    const serialized = JSON.stringify(inventory);
    expect(serialized).not.toContain("sk-should-not-be-read");
    expect(serialized).not.toContain("auth-json-secret");
    expect(serialized).not.toContain("config-yaml-secret-should-not-appear");
    expect(serialized).not.toContain("rewound message");
  });

  test("rejects a WAL-mode database whose -wal sidecar is missing", () => {
    // 关闭连接后 WAL 被 checkpoint 并删除，但文件头仍保留 WAL 模式标记。
    // 只复制主库可能丢掉未 checkpoint 的已提交帧，文件头计数相等不能证明一致。
    const db = buildDatabase("hermes/state-schema33.sql", seedHermes, { journalMode: "wal" });
    expect(db[18]).toBe(2);
    expect(db[19]).toBe(2);
    expect(db.readUInt32BE(24)).toBe(db.readUInt32BE(92));
    const error = expectImportError(() => parseHermes(hermesFiles(db), "hermes-instance"), "SOURCE_DB_UNSAFE_SNAPSHOT");
    expect(error.message).toContain("state.db-wal");
    expect(error.message).toContain("WAL");
  });

  test("accepts a WAL-mode database only when an empty -wal sidecar proves no pending frames", () => {
    const db = buildDatabase("hermes/state-schema33.sql", seedHermes, { journalMode: "wal" });
    const files = hermesFiles(db);
    files.set("state.db-wal", Buffer.alloc(0));
    const inventory = parseHermes(files, "hermes-instance");
    expect(inventory.warnings).toContain("wal_mode_snapshot:state.db");
    expect(inventory.warnings).toContain("wal_sidecar_empty_checkpointed:state.db");
    expect(inventory.warnings).not.toContain("wal_sidecar_absent_possible_stale:state.db");
    expect(inventory.items.some((item) => item.type === "message")).toBe(true);
  });

  test("rejects a non-empty rollback journal sidecar", () => {
    const db = buildDatabase("hermes/state-schema33.sql", seedHermes);
    const files = hermesFiles(db);
    files.set("state.db-journal", Buffer.alloc(64, 7));
    const error = expectImportError(() => parseHermes(files, "h"), "SOURCE_DB_UNSAFE_SNAPSHOT");
    expect(error.message).toContain("state.db-journal");
  });

  test("rejects unsupported schema versions", () => {
    const db = buildDatabase("hermes/state-schema33.sql", (database) =>
      seedHermes(database, HERMES_STATE_SCHEMA_VERSION + 1),
    );
    const error = expectImportError(() => parseHermes(hermesFiles(db), "h"), "SOURCE_DB_UNSUPPORTED_SCHEMA");
    expect(error.message).toContain(String(HERMES_STATE_SCHEMA_VERSION + 1));
  });

  test("rejects a non-empty WAL sidecar instead of merging frames", () => {
    const db = buildDatabase("hermes/state-schema33.sql", seedHermes);
    const files = hermesFiles(db);
    files.set("state.db-wal", Buffer.alloc(32, 1));
    const error = expectImportError(() => parseHermes(files, "h"), "SOURCE_DB_UNSAFE_SNAPSHOT");
    expect(error.message).toContain("state.db-wal");
  });

  test("rejects a torn header (change counter mismatch)", () => {
    const db = Buffer.from(buildDatabase("hermes/state-schema33.sql", seedHermes));
    db.writeUInt32BE(db.readUInt32BE(24) + 1, 24);
    expectImportError(() => parseHermes(hermesFiles(db), "h"), "SOURCE_DB_UNSAFE_SNAPSHOT");
  });

  test("rejects a file that is not SQLite", () => {
    const files = hermesFiles(Buffer.alloc(200, 0x41));
    expectImportError(() => parseHermes(files, "h"), "SOURCE_DB_INVALID");
  });

  test("rejects a database with a corrupt page image", () => {
    const db = Buffer.from(buildDatabase("hermes/state-schema33.sql", seedHermes));
    const pageSize = db.readUInt16BE(16) === 1 ? 65536 : db.readUInt16BE(16);
    db.fill(0, pageSize, pageSize * 2);
    expectImportError(() => parseHermes(hermesFiles(db), "h"), "SOURCE_DB_CORRUPT");
  });

  test("rejects routing-index-only input and ambiguous profiles", () => {
    const onlyRouting = new Map<string, Buffer>([
      ["sessions/sessions.json", fixture("hermes/sessions.json")],
    ]);
    const missing = expectImportError(() => parseHermes(onlyRouting, "h"), "SOURCE_DB_MISSING");
    expect(missing.message).toContain("sessions.json");

    const db = buildDatabase("hermes/state-schema33.sql", seedHermes);
    const profiles = new Map<string, Buffer>([
      ["profiles/a/state.db", db],
      ["profiles/b/state.db", db],
    ]);
    expectImportError(() => parseHermes(profiles, "h"), "SOURCE_LAYOUT_AMBIGUOUS");
  });

  test("rejects an empty instance id", () => {
    const db = buildDatabase("hermes/state-schema33.sql", seedHermes);
    expectImportError(() => parseHermes(hermesFiles(db), "  "), "INVALID_INSTANCE_ID");
    expectImportError(() => parseOpenClaw(new Map(), ""), "INVALID_INSTANCE_ID");
  });

  test("drafts only whitelisted config.yaml values and requires reauth for credentials", () => {
    const db = buildDatabase("hermes/state-schema33.sql", seedHermes);
    const inventory = parseHermes(hermesFiles(db), "hermes-config");
    const config = inventory.items.find((item) => item.type === "config");
    const content = config?.content as {
      format: string;
      imported: boolean;
      draft: Record<string, unknown>;
      unknownFields: unknown[];
      reauthFields: string[];
    };

    expect(content.format).toBe("yaml");
    expect(content.imported).toBe(false);
    expect(content.draft).toEqual({ model: "glm-4.6", "memory.enabled": true });
    expect(content.reauthFields).toEqual(["providers.openai.api_key"]);
    expect(content.unknownFields).toEqual([]);
    expect(config?.warnings).toContain("credential_requires_reauth:providers.openai.api_key");

    const reauth = inventory.items.filter(
      (item) => item.type === "reauth" && (item.content as { field?: string }).field !== undefined,
    );
    expect(reauth.map((item) => (item.content as { field: string }).field)).toEqual(["providers.openai.api_key"]);
    expect(JSON.stringify(reauth)).not.toContain("config-yaml-secret-should-not-appear");
    expect(JSON.stringify(inventory)).not.toContain("config-yaml-secret-should-not-appear");
    expect(inventory.warnings).toContain("config_draft_fields:config.yaml:2");
    expect(inventory.warnings).toContain("config_credentials_require_reauth:config.yaml:1");
  });

  test("reports unsupported YAML constructs per field instead of guessing values", () => {
    const db = buildDatabase("hermes/state-schema33.sql", seedHermes);
    const files = hermesFiles(db);
    files.set(
      "config.yaml",
      Buffer.from(["model: glm-4.6", "skills:", "  - name: demo", "timezone: Asia/Shanghai"].join("\n")),
    );
    const inventory = parseHermes(files, "hermes-yaml");
    const content = inventory.items.find((item) => item.type === "config")?.content as {
      draft: Record<string, unknown>;
      unknownFields: Array<{ path: string; reason: string }>;
    };
    expect(content.draft).toEqual({ model: "glm-4.6", timezone: "Asia/Shanghai" });
    expect(content.unknownFields).toEqual([{ path: "skills", reason: "unsupported_yaml_syntax" }]);
    expect(inventory.warnings).toContain("config_yaml_lines_unparsed:config.yaml:1");
    expect(inventory.warnings).toContain("config_field_loss:config.yaml:1");
  });
});
