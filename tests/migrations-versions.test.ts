/**
 * OpenClaw / Hermes 第二固定版本 fixture 的版本门禁测试。
 *
 * 第一固定版本（既有夹具，见 tests/migrations-importers.test.ts）：
 * - OpenClaw 2026.11.2 / d290127ec6750ac3b3504d44ab50b7cee5f92ec7 / agent schema 41
 * - Hermes 47edbcd170be6a2edf876eaa5c4b9a8595bc4cf0 / state.db schema 33
 *
 * 第二固定版本（本次新增，均为独立的上游稳定 tag）：
 * - OpenClaw v2026.11.3 / 847611dcaa3bf0e2783335f961dd1fd0580e4d9f / agent schema 27
 * - Hermes v0.23.0 / 2bd378ed1b8d6bf2192cb26e0a55ff3091e6bd19 / state.db schema 32
 *
 * 选取规则：取上游最新稳定 tag，且其 schema 版本与第一固定版本不同。
 * 仓库、tag、提交、日期、schema 常量与 DDL 来源记录在两个 fixture 头部注释中，
 * 均于 2026-11-10 通过 GitHub API 与 raw 内容接口核实；未 clone 上游仓库，未安装依赖，
 * 未生成真实数据库产物。
 *
 * 解析器针对两个固定版本的 schema 27 与 32 做确定性解析测试。
 * 这些合成夹具不能代替真实备份验收。
 */

import { afterEach, describe, expect, test } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  HERMES_STATE_SCHEMA_VERSION,
  MigrationImportError,
  OPENCLAW_AGENT_SCHEMA_VERSION,
  parseHermes,
  parseOpenClaw,
} from "../src/migrations/importers.js";

const FIXTURES = resolve(import.meta.dirname, "fixtures/migrations");
const T0 = Date.UTC(2026, 0, 2, 3, 4, 5);
const tempDirs: string[] = [];

/** 第二固定版本证据；fixture 头部注释必须与这里一致。 */
const OPENCLAW_SECOND = {
  tag: "v2026.11.3",
  commit: "847611dcaa3bf0e2783335f961dd1fd0580e4d9f",
  committedAt: "2026-11-10T09:44:17Z",
  agentSchema: 27,
  schema: "openclaw/agent-schema27.sql",
  versionFile: "src/state/openclaw-agent-db-contract.ts",
  schemaFile: "src/state/openclaw-agent-schema.sql",
  constantLine: "export const OPENCLAW_AGENT_SCHEMA_VERSION = 27;",
} as const;

const HERMES_SECOND = {
  tag: "v0.23.0",
  commit: "2bd378ed1b8d6bf2192cb26e0a55ff3091e6bd19",
  committedAt: "2026-11-05T17:52:53Z",
  stateSchema: 32,
  schema: "hermes/state-schema32.sql",
  constantLine: "SCHEMA_VERSION = 32",
} as const;

/** 解析器 SELECT 语句依赖的列；新增查询时必须同步更新。 */
const OPENCLAW_PARSER_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  schema_meta: ["meta_key", "role", "schema_version", "agent_id", "app_version"],
  session_nodes: [
    "session_key",
    "current_session_id",
    "label",
    "display_name",
    "status",
    "created_at",
    "updated_at",
    "last_activity_at",
    "parent_session_key",
    "created_via",
    "archived_at",
  ],
  session_windows: [
    "session_id",
    "session_key",
    "created_at",
    "previous_session_id",
    "reason",
    "display_name",
    "started_at",
    "ended_at",
  ],
  transcript_events: ["seq", "created_at", "event_json", "event_zstd"],
  session_transcript_active_events: ["active_position", "event_seq", "message_position"],
};

const HERMES_PARSER_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  schema_version: ["version"],
  sessions: [
    "id",
    "source",
    "display_name",
    "title",
    "model",
    "started_at",
    "ended_at",
    "message_count",
    "archived",
    "pinned",
    "parent_session_id",
  ],
  messages: ["id", "session_id", "role", "content", "tool_calls", "tool_name", "timestamp", "compacted", "active"],
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixtureText(relativePath: string): string {
  return readFileSync(join(FIXTURES, relativePath), "utf8");
}

function headerOf(relativePath: string): string {
  const text = fixtureText(relativePath);
  const end = text.indexOf("\nCREATE TABLE");
  expect(end).toBeGreaterThan(0);
  return text.slice(0, end);
}

function withDatabase(
  schema: string,
  seed: (db: DatabaseSync) => void,
  run: (db: DatabaseSync, file: string) => void,
): void {
  const dir = mkdtempSync(join(tmpdir(), "orange-migrations-versions-"));
  tempDirs.push(dir);
  const file = join(dir, "fixture.sqlite");
  const db = new DatabaseSync(file);
  try {
    db.exec(fixtureText(schema));
    seed(db);
    run(db, file);
  } finally {
    db.close();
  }
}

function buildDatabase(schema: string, seed: (db: DatabaseSync) => void): Buffer {
  let bytes: Buffer | undefined;
  withDatabase(schema, seed, (_db, file) => {
    bytes = readFileSync(file);
  });
  return bytes as Buffer;
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

function expectColumns(db: DatabaseSync, table: string, expected: readonly string[]): void {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  const columns = rows.map((row) => row.name);
  expect(columns.length, `表 ${table} 不存在或没有列`).toBeGreaterThan(0);
  for (const name of expected) {
    expect(columns, `表 ${table} 缺少解析器读取的列 ${name}`).toContain(name);
  }
}

function seedOpenClaw(db: DatabaseSync, schemaVersion: number = OPENCLAW_SECOND.agentSchema): void {
  db.prepare(
    "INSERT INTO schema_meta (meta_key, role, schema_version, agent_id, app_version, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
  ).run("primary", "agent", schemaVersion, "main", OPENCLAW_SECOND.tag.slice(1), T0, T0);
  db.prepare(
    "INSERT INTO session_nodes (session_key, current_session_id, entry_json, created_at, updated_at, status, created_via, display_name) VALUES (?,?,?,?,?,?,?,?)",
  ).run("main", "sess-1", "{}", T0, T0, "done", "operator", "Main session");
  db.prepare(
    "INSERT INTO session_windows (session_id, session_key, created_at, updated_at, reason, display_name) VALUES (?,?,?,?,?,?)",
  ).run("sess-1", "main", T0, T0, "initial", "Main window");
  db.prepare(
    "INSERT INTO transcript_events (session_id, seq, event_json, created_at) VALUES (?,?,?,?)",
  ).run(
    "sess-1",
    1,
    JSON.stringify({ type: "message", message: { role: "user", content: "Earlier question", timestamp: T0 } }),
    T0,
  );
  db.prepare(
    "INSERT INTO session_transcript_active_events (session_id, active_position, event_seq, message_position) VALUES (?,?,?,?)",
  ).run("sess-1", 0, 1, 0);
}

function openClawFiles(db: Buffer): Map<string, Buffer> {
  return new Map([["agents/main/agent/openclaw-agent.sqlite", db]]);
}

function seedHermes(db: DatabaseSync, schemaVersion: number = HERMES_SECOND.stateSchema): void {
  db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(schemaVersion);
  db.prepare(
    "INSERT INTO sessions (id, source, display_name, title, model, started_at, ended_at, message_count, archived, pinned, parent_session_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
  ).run("sess-h", "telegram", "Work chat", "Work chat", "glm-4.6", 1700000000.5, null, 1, 0, 0, null);
  db.prepare(
    "INSERT INTO messages (id, session_id, role, content, tool_calls, tool_name, timestamp, compacted, active) VALUES (?,?,?,?,?,?,?,?,?)",
  ).run(1, "sess-h", "user", "Hello from v0.23.0", null, null, 1700000001.25, 0, 1);
}

function hermesFiles(db: Buffer): Map<string, Buffer> {
  return new Map([["state.db", db]]);
}

describe("第二固定版本 fixture 证据", () => {
  test("OpenClaw fixture 头部记录 v2026.11.3 的 tag、提交与 agent schema 27", () => {
    const header = headerOf(OPENCLAW_SECOND.schema);
    expect(header).toContain("https://github.com/openclaw/openclaw");
    expect(header).toContain(`tag：${OPENCLAW_SECOND.tag}`);
    expect(header).toContain(OPENCLAW_SECOND.commit);
    expect(header).toContain(OPENCLAW_SECOND.committedAt);
    expect(header).toContain(OPENCLAW_SECOND.constantLine);
    expect(header).toContain(OPENCLAW_SECOND.versionFile);
    expect(header).toContain(OPENCLAW_SECOND.schemaFile);
    expect(header).toContain('"agent":27');
  });

  test("Hermes fixture 头部记录 v0.23.0 的 tag、提交与 state schema 32", () => {
    const header = headerOf(HERMES_SECOND.schema);
    expect(header).toContain("https://github.com/NousResearch/hermes-agent");
    expect(header).toContain(`tag：${HERMES_SECOND.tag}`);
    expect(header).toContain(HERMES_SECOND.commit);
    expect(header).toContain(HERMES_SECOND.committedAt);
    expect(header).toContain(HERMES_SECOND.constantLine);
    expect(header).toContain("v33: data-only");
  });
});

describe("解析器声明的固定 schema 版本", () => {
  test("解析器主版本常量记录 schema 41 与 33", () => {
    expect(OPENCLAW_AGENT_SCHEMA_VERSION).toBe(41);
    expect(HERMES_STATE_SCHEMA_VERSION).toBe(33);
    // 第二固定版本使用独立的受支持 schema。
    expect(OPENCLAW_SECOND.agentSchema).toBeLessThan(OPENCLAW_AGENT_SCHEMA_VERSION);
    expect(HERMES_SECOND.stateSchema).toBeLessThan(HERMES_STATE_SCHEMA_VERSION);
  });
});

describe("OpenClaw v2026.11.3（agent schema 27）", () => {
  test("解析固定版本 schema 27 的会话与消息", () => {
    const db = buildDatabase(OPENCLAW_SECOND.schema, (database) => seedOpenClaw(database));
    const result=parseOpenClaw(openClawFiles(db), "oc-second");
    expect(result.version).toBe("openclaw:agent-schema-27");expect(result.items.some(i=>i.type==="session")).toBe(true);expect(result.items.some(i=>i.type==="message"&&JSON.stringify(i.content).includes("Earlier question"))).toBe(true);
  });

  test("真实 schema 27 包含解析器读取的所有列", () => {
    withDatabase(
      OPENCLAW_SECOND.schema,
      (database) => seedOpenClaw(database),
      (database) => {
        for (const [table, columns] of Object.entries(OPENCLAW_PARSER_COLUMNS)) {
          expectColumns(database, table, columns);
        }
      },
    );
  });
});

describe("Hermes v0.23.0（state.db schema 32）", () => {
  test("解析固定版本 schema 32 的会话与消息", () => {
    const db = buildDatabase(HERMES_SECOND.schema, (database) => seedHermes(database));
    const result=parseHermes(hermesFiles(db), "hermes-second");
    expect(result.version).toBe("hermes:state-schema-32");expect(result.items.some(i=>i.type==="session")).toBe(true);expect(result.items.some(i=>i.type==="message"&&JSON.stringify(i.content).includes("Hello from v0.23.0"))).toBe(true);
  });

  test("真实 schema 32 包含解析器读取的所有列", () => {
    withDatabase(
      HERMES_SECOND.schema,
      (database) => seedHermes(database),
      (database) => {
        for (const [table, columns] of Object.entries(HERMES_PARSER_COLUMNS)) {
          expectColumns(database, table, columns);
        }
      },
    );
  });
});
