/**
 * 来源解析模块（MIG-002/003/018、MT-001/002）。
 *
 * 已核实的上游版本（务必与 fixtures 同步维护）：
 * - OpenClaw 0f327ca37eb7d2fcc85da6e98004bbd56ff35c3d / d290127ec6750ac3b3504d44ab50b7cee5f92ec7
 *   (v2026.11.2)：会话权威源为 agents/<id>/agent/openclaw-agent.sqlite，
 *   schema_meta(meta_key='primary').schema_version = 41（role='agent'）。JSONL 是 legacy。
 * - Hermes 47edbcd170be6a2edf876eaa5c4b9a8595bc4cf0：state.db 的 schema_version = 33。
 *
 * 安全与一致性规则：
 * - 不直接打开来源文件：先把镜像复制到 0700 临时目录，再以只读方式打开；解析结束即删除。
 * - 非空 -wal / -journal 侧车表示输入不是一致性快照，直接拒绝，不做猜测性合并。
 * - 文件头声明 WAL 模式却缺少 -wal 侧车时同样拒绝：仅凭文件头计数无法证明没有丢失 WAL 帧。
 * - 校验 SQLite 头部、页大小、change counter 与 version-valid-for，并执行 quick_check。
 * - 版本或必需表不匹配时抛出 MigrationImportError，绝不返回"部分成功"的假数据。
 * - 敏感文件（.env、auth.json、私钥等）只记录跳过，不读取内容；凭据列只生成 reauth 项。
 * - 配置文件只保留白名单里的非密钥标量值作为草案，未知字段逐项报告字段级损失。
 * - 文本历史只做确定性脱敏（已知密钥/令牌/私钥/Authorization 模式），不做启发式猜测。
 */

import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { zstdDecompressSync } from "node:zlib";
import type { MigrationInventory, MigrationItem } from "./core.js";

/** 已验证的 OpenClaw agent 数据库 schema 版本。 */
export const OPENCLAW_AGENT_SCHEMA_VERSION = 41;
/** 已验证的 Hermes state.db schema 版本。 */
export const HERMES_STATE_SCHEMA_VERSION = 33;

const MAX_DATABASE_BYTES = 512 * 1024 * 1024;
const MAX_ITEMS = 200_000;
const MAX_ITEM_TEXT_CHARS = 100_000;
const MAX_DOC_BYTES = 512 * 1024;
const MAX_WARNINGS = 200;
const SQLITE_MAGIC = "SQLite format 3\u0000";

export type ImportErrorCode =
  | "INVALID_INPUT"
  | "INVALID_INSTANCE_ID"
  | "SOURCE_DB_MISSING"
  | "SOURCE_LAYOUT_UNSUPPORTED"
  | "SOURCE_LAYOUT_AMBIGUOUS"
  | "SOURCE_DB_UNSAFE_SNAPSHOT"
  | "SOURCE_DB_INVALID"
  | "SOURCE_DB_CORRUPT"
  | "SOURCE_DB_UNSUPPORTED_SCHEMA"
  | "SOURCE_DB_WRONG_ROLE"
  | "SOURCE_LIMIT_EXCEEDED";

export class MigrationImportError extends Error {
  readonly code: ImportErrorCode;

  constructor(code: ImportErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "MigrationImportError";
    this.code = code;
  }
}

type NormalizedFiles = Map<string, Buffer>;

interface SqliteImage {
  readonly db: DatabaseSync;
  readonly warnings: string[];
  dispose(): void;
}

interface Counters {
  nonChat: number;
  undecodable: number;
  truncated: number;
  redacted: number;
  inactive: number;
  /** 只读保留的 System 文本条数。 */
  systemRetained: number;
  /** 只读保留的 Tool 输出条数。 */
  toolRetained: number;
  /** 逐类记录未知非文本内容块，例如 image/audio/thinking。 */
  skippedParts: Map<string, number>;
  /** 逐类记录不作为聊天消息导入的转录事件。 */
  skippedEventTypes: Map<string, number>;
}

function newCounters(): Counters {
  return {
    nonChat: 0,
    undecodable: 0,
    truncated: 0,
    redacted: 0,
    inactive: 0,
    systemRetained: 0,
    toolRetained: 0,
    skippedParts: new Map(),
    skippedEventTypes: new Map(),
  };
}

function countCategory(target: Map<string, number>, category: string, amount = 1): void {
  target.set(category, (target.get(category) ?? 0) + amount);
}

class WarningCollector {
  private readonly values: string[] = [];
  private dropped = 0;

  add(value: string): void {
    if (this.values.length < MAX_WARNINGS) this.values.push(value);
    else this.dropped += 1;
  }

  finalize(): string[] {
    return this.dropped === 0 ? [...this.values] : [...this.values, `warnings_truncated:${this.dropped}`];
  }
}

interface RedactionRule {
  readonly pattern: RegExp;
  readonly replacement: string;
}

/**
 * 只覆盖高置信度、确定性的凭据模式。宁可少脱敏，也不改写普通文本语义。
 * 每条规则都必须带 g 标志，且替换串只使用 $1 这类稳定反向引用。
 */
const REDACTION_RULES: readonly RedactionRule[] = [
  { pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/g, replacement: "[REDACTED]" },
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, replacement: "[REDACTED]" },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, replacement: "[REDACTED]" },
  { pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, replacement: "[REDACTED]" },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, replacement: "[REDACTED]" },
  { pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g, replacement: "[REDACTED]" },
  { pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, replacement: "[REDACTED]" },
  { pattern: /Bearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi, replacement: "Bearer [REDACTED]" },
  {
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replacement: "[REDACTED PRIVATE KEY]",
  },
  {
    pattern: /\b((?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|secret[_-]?key|password|passwd)\s*[:=]\s*)["']?[^\s"',;]{8,}/gi,
    replacement: "$1[REDACTED]",
  },
  {
    pattern: /(^|\s)([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|KEY|PASSWORD)=)[^\s"']{8,}/g,
    replacement: "$1$2[REDACTED]",
  },
];

function redactText(input: string): { text: string; hits: number } {
  let text = input;
  let hits = 0;
  for (const rule of REDACTION_RULES) {
    const matches = text.match(rule.pattern);
    if (!matches) continue;
    hits += matches.length;
    text = text.replace(rule.pattern, rule.replacement);
  }
  return { text, hits };
}

function fail(code: ImportErrorCode, message: string, cause?: unknown): never {
  throw new MigrationImportError(code, message, cause);
}

function normalizePath(raw: string): string {
  return raw.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/{2,}/g, "/").replace(/^\/+/, "");
}

function normalizeFiles(files: Map<string, Buffer>): NormalizedFiles {
  if (!(files instanceof Map)) fail("INVALID_INPUT", "files 必须是 Map<string, Buffer>");
  const view: NormalizedFiles = new Map();
  const origins = new Map<string, string>();
  for (const [raw, value] of files) {
    if (typeof raw !== "string" || raw.length === 0) fail("INVALID_INPUT", "来源文件路径必须是非空字符串");
    if (!Buffer.isBuffer(value)) fail("INVALID_INPUT", `来源文件 ${raw} 的内容不是 Buffer`);
    const path = normalizePath(raw);
    if (!path) fail("INVALID_INPUT", `来源文件路径规范化后为空: ${raw}`);
    const previous = origins.get(path);
    if (previous !== undefined) fail("INVALID_INPUT", `来源文件路径冲突: ${previous} 与 ${raw}`);
    origins.set(path, raw);
    view.set(path, value);
  }
  return view;
}

function assertInstanceId(instanceId: string): void {
  if (typeof instanceId !== "string" || instanceId.trim().length === 0) {
    fail("INVALID_INSTANCE_ID", "instanceId 不能为空；迁移计划依赖它区分来源实例");
  }
}

function basename(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? path : path.slice(index + 1);
}

function depth(path: string): number {
  return path.split("/").length;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** 秒级与毫秒级时间戳都归一化为 ISO 字符串；无法解析时返回 undefined。 */
function toIsoTimestamp(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    const ms = value < 1e11 ? value * 1000 : value;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString();
  }
  return undefined;
}

const SENSITIVE_PATTERNS: readonly RegExp[] = [
  /(^|\/)\.env($|\.)/i,
  /(^|\/)auth\.json$/i,
  /(^|\/)auth-profiles(-\w+)?\.json$/i,
  /(^|\/)credentials?(-\w+)?\.json$/i,
  /(^|\/)oauth[^/]*\.json$/i,
  /(^|\/)secrets?[^/]*\.(json|ya?ml|txt)$/i,
  /(^|\/)tokens?[^/]*\.json$/i,
  /(^|\/)cookies?[^/]*\.(json|txt)$/i,
  /\.(pem|key|p12|pfx|jks)$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /(^|\/)\.netrc$/i,
  /(^|\/)keychain[^/]*$/i,
];

function isSensitivePath(path: string): boolean {
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(path));
}

function reportSensitiveFiles(files: NormalizedFiles, warnings: WarningCollector): string[] {
  const skipped: string[] = [];
  for (const path of [...files.keys()].sort()) {
    if (!isSensitivePath(path)) continue;
    warnings.add(`sensitive_file_skipped:${path}`);
    skipped.push(path);
  }
  return skipped;
}

/** 凭据文件只生成 reauth 项，绝不复制内容。 */
function credentialFileItem(system: "openclaw" | "hermes", path: string): MigrationItem {
  return {
    sourceId: `reauth:file:${path}`,
    type: "reauth",
    content: { system, sourcePath: path, kind: "credential_file", requiredAction: "reauth", valueCopied: false },
    warnings: ["credential_file_not_read"],
  };
}

function readDocText(buffer: Buffer): { text: string; truncated: boolean } {
  const truncated = buffer.length > MAX_DOC_BYTES;
  const slice = truncated ? buffer.subarray(0, MAX_DOC_BYTES) : buffer;
  const text = slice.toString("utf8").replace(/^\uFEFF/, "");
  return { text, truncated };
}

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function inspectSqliteHeader(bytes: Buffer, label: string): { walMode: boolean } {
  if (bytes.length < 100) {
    fail("SOURCE_DB_INVALID", `${label} 不是完整的 SQLite 文件（长度 ${bytes.length} 字节）`);
  }
  if (bytes.subarray(0, 16).toString("latin1") !== SQLITE_MAGIC) {
    fail("SOURCE_DB_INVALID", `${label} 缺少 SQLite 文件头`);
  }
  const rawPageSize = bytes.readUInt16BE(16);
  const pageSize = rawPageSize === 1 ? 65536 : rawPageSize;
  if (pageSize < 512 || pageSize > 65536 || (pageSize & (pageSize - 1)) !== 0) {
    fail("SOURCE_DB_INVALID", `${label} 的页大小无效: ${pageSize}`);
  }
  const writeVersion = bytes[18];
  const readVersion = bytes[19];
  if ((writeVersion !== 1 && writeVersion !== 2) || (readVersion !== 1 && readVersion !== 2)) {
    fail("SOURCE_DB_INVALID", `${label} 的日志模式字节无效: ${writeVersion}/${readVersion}`);
  }
  const changeCounter = bytes.readUInt32BE(24);
  const versionValidFor = bytes.readUInt32BE(92);
  if (changeCounter !== versionValidFor) {
    fail(
      "SOURCE_DB_UNSAFE_SNAPSHOT",
      `${label} 的 change counter (${changeCounter}) 与 version-valid-for (${versionValidFor}) 不一致；` +
        "该镜像疑似在写入过程中被复制，请用源的官方备份/VACUUM INTO 生成一致性快照后重试",
    );
  }
  // 任一版本字节为 2 都表示 WAL 模式；WAL 模式下主文件可能缺少尚未 checkpoint 的帧。
  return { walMode: writeVersion === 2 || readVersion === 2 };
}

function sqliteError(label: string, error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  if (/no such table|no such column/i.test(message)) {
    fail("SOURCE_DB_UNSUPPORTED_SCHEMA", `${label} 缺少已锁定 schema 所需的表或列: ${message}`, error);
  }
  fail("SOURCE_DB_CORRUPT", `${label} 无法读取: ${message}`, error);
}

function readRows(
  image: SqliteImage,
  sql: string,
  params: ReadonlyArray<string | number | null> = [],
  label = "database",
): Record<string, unknown>[] {
  try {
    return image.db.prepare(sql).all(...params) as Record<string, unknown>[];
  } catch (error) {
    sqliteError(label, error);
  }
}

function readScalar(
  image: SqliteImage,
  sql: string,
  params: ReadonlyArray<string | number | null> = [],
  label = "database",
): unknown {
  const row = readRows(image, sql, params, label)[0];
  return row === undefined ? undefined : Object.values(row)[0];
}

function hasTable(image: SqliteImage, name: string): boolean {
  const row = readRows(
    image,
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?",
    [name],
  )[0];
  return row !== undefined;
}

function requireTables(image: SqliteImage, label: string, names: readonly string[]): void {
  const missing = names.filter((name) => !hasTable(image, name));
  if (missing.length > 0) {
    fail(
      "SOURCE_DB_UNSUPPORTED_SCHEMA",
      `${label} 缺少已锁定 schema 所需的表: ${missing.join(", ")}；未知或损坏的 schema 不会被猜测性解析`,
    );
  }
}

function openSqliteImage(files: NormalizedFiles, path: string): SqliteImage {
  const bytes = files.get(path);
  if (!bytes) fail("SOURCE_DB_MISSING", `缺少数据库文件: ${path}`);
  if (bytes.length > MAX_DATABASE_BYTES) {
    fail("SOURCE_LIMIT_EXCEEDED", `${path} 超过单库大小上限 ${MAX_DATABASE_BYTES} 字节`);
  }
  for (const suffix of ["-wal", "-journal"]) {
    const sidecar = files.get(path + suffix);
    if (sidecar && sidecar.length > 0) {
      fail(
        "SOURCE_DB_UNSAFE_SNAPSHOT",
        `${path}${suffix} 非空，说明输入是活动数据库的复制，不是一致性快照；` +
          "请停止来源服务，或使用源的官方备份/VACUUM INTO 生成单文件快照后重试",
      );
    }
  }
  const { walMode } = inspectSqliteHeader(bytes, path);
  const warnings: string[] = [];
  if (walMode) {
    const wal = files.get(path + "-wal");
    if (wal === undefined) {
      // WAL 模式下主文件只包含已 checkpoint 的帧。仅凭文件头（change counter 与
      // version-valid-for 相等）无法证明没有丢失尚未 checkpoint 的已提交事务，
      // 因此缺失 -wal 侧车时必须拒绝，而不是把可能缺少最近写入的镜像当作一致快照。
      fail(
        "SOURCE_DB_UNSAFE_SNAPSHOT",
        `${path} 的文件头声明 WAL 模式（读/写版本字节为 2），但镜像中没有 ${path}-wal；` +
          "只复制主库可能丢掉尚未 checkpoint 的已提交帧，文件头计数相等不能证明快照一致。" +
          `请一并提供 ${path}-wal（哪怕是 0 字节的空 WAL）、停止来源服务，` +
          "或使用源的官方备份/VACUUM INTO 生成单文件快照后重试",
      );
    }
    warnings.push(`wal_mode_snapshot:${path}`);
    if (wal.length === 0) {
      // 侧车存在且为 0 字节：没有待回放的 WAL 帧，主文件即完整快照。
      warnings.push(`wal_sidecar_empty_checkpointed:${path}`);
    }
  }

  const dir = mkdtempSync(join(tmpdir(), "orange-import-"));
  const file = join(dir, "snapshot.sqlite");
  writeFileSync(file, bytes, { mode: 0o600 });
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(file, { readOnly: true });
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    fail(
      "SOURCE_DB_CORRUPT",
      `${path} 无法以只读方式打开: ${error instanceof Error ? error.message : String(error)}`,
      error,
    );
  }
  let closed = false;
  const dispose = (): void => {
    if (!closed) {
      closed = true;
      try {
        db.close();
      } catch {
        // 只读临时副本，关闭失败不改变解析结论。
      }
    }
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    db.exec("PRAGMA query_only = ON");
    const checkRows = db.prepare("PRAGMA quick_check").all() as Record<string, unknown>[];
    const results = checkRows.map((row) => Object.values(row)[0]);
    if (results.length !== 1 || results[0] !== "ok") {
      fail("SOURCE_DB_CORRUPT", `${path} 未通过 quick_check: ${results.slice(0, 5).map(String).join("; ")}`);
    }
  } catch (error) {
    dispose();
    if (error instanceof MigrationImportError) throw error;
    fail(
      "SOURCE_DB_CORRUPT",
      `${path} 完整性检查失败: ${error instanceof Error ? error.message : String(error)}`,
      error,
    );
  }
  return { db, warnings, dispose };
}

function enforceItemBudget(count: number, label: string): void {
  if (count > MAX_ITEMS) {
    fail("SOURCE_LIMIT_EXCEEDED", `${label} 的待导入条目数 ${count} 超过上限 ${MAX_ITEMS}；请拆分来源后再迁移`);
  }
}

function capText(text: string, item: MigrationItem, counters: Counters): string {
  if (text.length <= MAX_ITEM_TEXT_CHARS) return text;
  counters.truncated += 1;
  item.warnings = [...(item.warnings ?? []), "text_truncated"];
  return text.slice(0, MAX_ITEM_TEXT_CHARS);
}

function redactItemContent(value:unknown, item:MigrationItem, counters:Counters):unknown {
  if(typeof value==="string")return applyRedaction(value,item,counters);
  if(Array.isArray(value))return value.map(v=>redactItemContent(v,item,counters));
  if(value && typeof value==="object"){const result:Record<string,unknown>={};for(const [key,child] of Object.entries(value))result[key]=redactItemContent(child,item,counters);return result;}
  return value;
}

function applyRedaction(text: string, item: MigrationItem, counters: Counters): string {
  const { text: redacted, hits } = redactText(text);
  if (hits > 0) {
    counters.redacted += hits;
    item.warnings = [...(item.warnings ?? []), "secret_redacted"];
  }
  return redacted;
}

function sortedCategories(counts: Map<string, number>): Array<[string, number]> {
  return [...counts].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
}

function pushLossWarnings(warnings: WarningCollector, counters: Counters): void {
  if (counters.redacted > 0) warnings.add(`secrets_redacted:${counters.redacted}`);
  if (counters.truncated > 0) warnings.add(`message_text_truncated:${counters.truncated}`);
  if (counters.undecodable > 0) warnings.add(`messages_undecodable:${counters.undecodable}`);
  if (counters.nonChat > 0) warnings.add(`messages_skipped_non_chat:${counters.nonChat}`);
  for (const [eventType, count] of sortedCategories(counters.skippedEventTypes)) {
    warnings.add(`non_chat_event_type:${eventType}:${count}`);
  }
  // 未知非文本按类型逐类报告，便于在审批界面判断具体损失。
  for (const [partType, count] of sortedCategories(counters.skippedParts)) {
    warnings.add(`content_parts_skipped:${partType}:${count}`);
  }
  if (counters.inactive > 0) warnings.add(`messages_inactive_skipped:${counters.inactive}`);
  if (counters.systemRetained > 0) warnings.add(`system_text_retained:${counters.systemRetained}`);
  if (counters.toolRetained > 0) warnings.add(`tool_outputs_retained:${counters.toolRetained}`);
}

const KNOWN_TEXT_PART_TYPES: ReadonlySet<string> = new Set(["text", "input_text", "output_text"]);
const TOOL_CALL_PART_TYPES: ReadonlySet<string> = new Set([
  "toolcall",
  "tool_call",
  "tool-call",
  "tool_use",
]);
const TOOL_RESULT_PART_TYPES: ReadonlySet<string> = new Set([
  "toolresult",
  "tool_result",
  "tool-result",
]);
const MAX_ARGUMENTS_SUMMARY_CHARS = 400;

type TranscriptRole = "user" | "assistant" | "system" | "tool";

/** 一条已识别、可导入的转录消息；tool/system 只读保留，永不重放为工具调用。 */
interface TranscriptTurn {
  role: TranscriptRole;
  text?: string;
  toolName?: string;
  argumentsSummary?: string;
  timestamp?: string;
  readOnly: boolean;
  /** 未知非文本内容块类型，逐类上报。 */
  skippedParts: string[];
}

interface OpenClawContent {
  text?: string;
  toolName?: string;
  argumentsSummary?: string;
  skipped: string[];
}

type OpenClawEventRead =
  | { kind: "turn"; turn: TranscriptTurn }
  | { kind: "event"; eventType: string; parts: string[] }
  | { kind: "invalid" };

function extractTextContent(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (const part of value) {
      const entry = asRecord(part);
      if (!entry) continue;
      const type = typeof entry.type === "string" ? entry.type.toLowerCase() : "";
      if (KNOWN_TEXT_PART_TYPES.has(type) && typeof entry.text === "string") {
        parts.push(entry.text);
      }
    }
    const joined = parts.join("\n").trim();
    return joined.length > 0 ? joined : undefined;
  }
  return undefined;
}

/** 参数摘要只保留可读文本，限制长度；调用方随后统一脱敏。 */
function summarizeArguments(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  let summary: string;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) return undefined;
    summary = trimmed;
  } else {
    try {
      summary = JSON.stringify(value) ?? "";
    } catch {
      return undefined;
    }
  }
  if (summary.length === 0) return undefined;
  return summary.length > MAX_ARGUMENTS_SUMMARY_CHARS
    ? `${summary.slice(0, MAX_ARGUMENTS_SUMMARY_CHARS)}…`
    : summary;
}

function summarizeToolCalls(calls: ReadonlyArray<{ name: string; arguments?: unknown }>): {
  names: string[];
  argumentsSummary?: string;
} {
  const names: string[] = [];
  const parts: string[] = [];
  for (const call of calls) {
    names.push(call.name);
    const args = summarizeArguments(call.arguments);
    parts.push(args === undefined ? call.name : `${call.name}(${args})`);
  }
  const joined = parts.join("; ");
  return {
    names,
    ...(joined.length > 0
      ? {
          argumentsSummary:
            joined.length > MAX_ARGUMENTS_SUMMARY_CHARS
              ? `${joined.slice(0, MAX_ARGUMENTS_SUMMARY_CHARS)}…`
              : joined,
        }
      : {}),
  };
}

function parseOpenClawContent(value: unknown): OpenClawContent {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return { ...(trimmed.length > 0 ? { text: trimmed } : {}), skipped: [] };
  }
  if (!Array.isArray(value)) return { skipped: [] };
  const texts: string[] = [];
  const results: string[] = [];
  const calls: Array<{ name: string; arguments?: unknown }> = [];
  const skipped: string[] = [];
  for (const part of value) {
    const entry = asRecord(part);
    if (!entry) {
      skipped.push("invalid_part");
      continue;
    }
    const type = typeof entry.type === "string" ? entry.type.toLowerCase() : "";
    if (KNOWN_TEXT_PART_TYPES.has(type)) {
      if (typeof entry.text === "string") texts.push(entry.text);
      continue;
    }
    if (TOOL_CALL_PART_TYPES.has(type)) {
      const fn = asRecord(entry.function);
      const name =
        typeof entry.name === "string" ? entry.name : typeof fn?.name === "string" ? fn.name : undefined;
      if (name === undefined || name.length === 0) {
        skipped.push("tool_call_without_name");
        continue;
      }
      calls.push({ name, arguments: entry.arguments ?? entry.input ?? fn?.arguments });
      continue;
    }
    if (TOOL_RESULT_PART_TYPES.has(type)) {
      const resultText = extractTextContent(entry.content ?? entry.text ?? entry.output);
      if (resultText) results.push(resultText);
      continue;
    }
    skipped.push(type.length > 0 ? type : "untyped_part");
  }
  const joined = [texts.join("\n").trim(), results.join("\n").trim()].filter(Boolean).join("\n");
  const summary = summarizeToolCalls(calls);
  return {
    ...(joined.length > 0 ? { text: joined } : {}),
    ...(summary.names[0] === undefined ? {} : { toolName: summary.names[0] }),
    ...(summary.argumentsSummary === undefined ? {} : { argumentsSummary: summary.argumentsSummary }),
    skipped,
  };
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

/**
 * 读取上游 d290127 的一条转录事件：
 * - turn：可导入的 user/assistant/system/tool 消息；
 * - event：已知但非聊天消息的事件（session/compaction/reset/custom_message 等）；
 * - invalid：JSON 结构损坏，调用方决定报告还是拒绝。
 */
function readOpenClawEvent(raw: string): OpenClawEventRead {
  const value = safeJson(raw);
  const event = asRecord(value);
  if (!event) return { kind: "invalid" };
  const eventType = typeof event.type === "string" && event.type.length > 0 ? event.type : "unknown";
  const message = asRecord(event.message);
  if (!message) return { kind: "event", eventType, parts: [] };
  const rawRole = typeof message.role === "string" ? message.role.toLowerCase() : "";
  const role = rawRole === "toolresult" ? "tool" : rawRole;
  const parsed = parseOpenClawContent(message.content);
  const text = parsed.text ?? extractTextContent(message.text);
  const timestamp = toIsoTimestamp(message.timestamp) ?? toIsoTimestamp(event.timestamp);
  const base = {
    ...(timestamp === undefined ? {} : { timestamp }),
    readOnly: role === "tool" || role === "system",
    skippedParts: parsed.skipped,
  };
  if (role === "user" || role === "assistant") {
    if (text === undefined && parsed.toolName === undefined) {
      return { kind: "event", eventType, parts: parsed.skipped };
    }
    return {
      kind: "turn",
      turn: {
        role,
        ...(text === undefined ? {} : { text }),
        ...(parsed.toolName === undefined ? {} : { toolName: parsed.toolName }),
        ...(parsed.argumentsSummary === undefined ? {} : { argumentsSummary: parsed.argumentsSummary }),
        ...base,
      },
    };
  }
  if (role === "system") {
    if (text === undefined) return { kind: "event", eventType, parts: parsed.skipped };
    return {
      kind: "turn",
      turn: {
        role: "system",
        text,
        ...(parsed.argumentsSummary === undefined ? {} : { argumentsSummary: parsed.argumentsSummary }),
        ...base,
      },
    };
  }
  if (role === "tool") {
    const toolName =
      typeof message.toolName === "string" && message.toolName.length > 0
        ? message.toolName
        : parsed.toolName;
    if (text === undefined && toolName === undefined) {
      return { kind: "event", eventType, parts: parsed.skipped };
    }
    return {
      kind: "turn",
      turn: {
        role: "tool",
        ...(text === undefined ? {} : { text }),
        ...(toolName === undefined ? {} : { toolName }),
        ...(parsed.argumentsSummary === undefined ? {} : { argumentsSummary: parsed.argumentsSummary }),
        ...base,
      },
    };
  }
  return { kind: "event", eventType, parts: parsed.skipped };
}

/** 把一条转录消息转换成迁移条目；工具与系统文本只读，参数只保留摘要。 */
function transcriptMessageItem(
  turn: TranscriptTurn,
  options: {
    agentId: string;
    sessionKey: string | null;
    sessionId: string;
    generation?: string;
    origin: "active" | "cold_archive" | "retained_archive";
    seq: number;
    sourceIdPrefix: string;
    counters: Counters;
  },
): MigrationItem {
  const warnings: string[] = [];
  if (options.origin === "cold_archive") warnings.push("cold_archive_history");
  if (options.origin === "retained_archive") warnings.push("retained_archive_history");
  const content: Record<string, unknown> = {
    agentId: options.agentId,
    sessionKey: options.sessionKey,
    sessionId: options.sessionId,
    seq: options.seq,
    role: turn.role,
    origin: options.origin,
  };
  if (options.generation !== undefined) content.generation = options.generation;
  if (turn.toolName !== undefined) content.toolName = turn.toolName;
  if (turn.argumentsSummary !== undefined) content.argumentsSummary = turn.argumentsSummary;
  // 同一会话可能有多个保留型归档代次（generation）；sourceId 必须带代次才唯一。
  const generationScope =
    options.origin === "retained_archive" && options.generation !== undefined
      ? `:${options.generation}`
      : "";
  const item: MigrationItem = {
    sourceId: `${options.sourceIdPrefix}:${options.agentId}:${options.sessionId}${generationScope}:${options.seq}`,
    type: "message",
    content,
    warnings,
  };
  if (turn.timestamp !== undefined) item.sourceTime = turn.timestamp;
  if (turn.argumentsSummary !== undefined) {
    // 参数摘要只是可读文本，绝不作为可执行调用重放。
    content.executable = false;
    warnings.push("tool_arguments_readonly");
    if (!turn.readOnly) warnings.push("tool_execution_not_replayed");
  }
  if (turn.readOnly) {
    content.readOnly = true;
    content.executable = false;
    warnings.push(turn.role === "tool" ? "tool_output_readonly" : "system_text_readonly");
    if (turn.role === "tool") warnings.push("tool_execution_not_replayed");
  }
  if (turn.text !== undefined) {
    content.text = capText(applyRedaction(turn.text, item, options.counters), item, options.counters);
  }
  if (turn.role === "tool") options.counters.toolRetained += 1;
  if (turn.role === "system") options.counters.systemRetained += 1;
  for (const partType of turn.skippedParts) countCategory(options.counters.skippedParts, partType);
  return item;
}

function decodeOpenClawEvent(row: Record<string, unknown>): string | null {
  const json = row.event_json;
  if (typeof json === "string") return json;
  const compressed = row.event_zstd;
  if (compressed instanceof Uint8Array) {
    try {
      return zstdDecompressSync(Buffer.from(compressed)).toString("utf8");
    } catch {
      return null;
    }
  }
  return null;
}

function parseJsonFile(files: NormalizedFiles, path: string): { value: unknown } | { error: string } {
  const buffer = files.get(path);
  if (!buffer) return { error: "missing" };
  try {
    return { value: JSON.parse(buffer.toString("utf8")) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function readSkillName(text: string): string | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return undefined;
  const nameLine = /^name:\s*(.+)$/m.exec(match[1] ?? "");
  const name = nameLine?.[1]?.trim().replace(/^["']|["']$/g, "");
  return name && name.length > 0 ? name : undefined;
}

interface SkillEntry {
  skillPath: string;
  buffer: Buffer;
  files: Array<{ path: string; bytes: number; sha256: string }>;
}

function collectSkills(files: NormalizedFiles, warnings: WarningCollector): SkillEntry[] {
  const skills: SkillEntry[] = [];
  const paths = [...files.keys()].sort();
  for (const path of paths) {
    if (basename(path).toLowerCase() !== "skill.md") continue;
    const buffer = files.get(path);
    if (!buffer) continue;
    const root = path.slice(0, path.length - basename(path).length);
    const siblings: SkillEntry["files"] = [];
    for (const other of paths) {
      if (other === path || !other.startsWith(root)) continue;
      const sibling = files.get(other);
      if (!sibling) continue;
      siblings.push({ path: other, bytes: sibling.length, sha256: sha256(sibling) });
    }
    skills.push({ skillPath: path, buffer, files: siblings });
  }
  if (skills.length > 0) warnings.add(`skills_imported_for_review:${skills.length}`);
  return skills;
}

const CRON_SAFE_FIELDS = ["id", "name", "description", "enabled", "schedule", "prompt", "timezone", "runMode", "targetChannel", "requiredCapabilities", "delivery"] as const;

function parseCronStore(
  files: NormalizedFiles,
  path: string,
  warnings: WarningCollector,
  counters: Counters,
): MigrationItem[] {
  const parsed = parseJsonFile(files, path);
  if ("error" in parsed) {
    warnings.add(`cron_store_unreadable:${path}`);
    return [];
  }
  const store = asRecord(parsed.value);
  if (!store) {
    warnings.add(`cron_store_unsupported:${path}`);
    return [];
  }
  const version = store.version;
  if (version !== undefined && version !== 1) {
    warnings.add(`cron_store_schema_unverified:${path}:version=${String(version)}`);
    return [];
  }
  const rawJobs = store.jobs;
  if (!Array.isArray(rawJobs)) {
    warnings.add(`cron_store_unsupported:${path}`);
    return [];
  }
  const items: MigrationItem[] = [];
  for (const raw of rawJobs) {
    const job = asRecord(raw);
    if (!job) continue;
    const id = typeof job.id === "string" && job.id.length > 0 ? job.id : undefined;
    if (!id) {
      warnings.add(`cron_job_without_id:${path}`);
      continue;
    }
    const content: Record<string, unknown> = {};
    const item: MigrationItem = { sourceId: `cron:${id}`, type: "cron", content };
    for (const field of CRON_SAFE_FIELDS) {
      const value=job[field];
      if(field==="requiredCapabilities" && Array.isArray(value) && value.every(v=>typeof v==='string')){content[field]=value.map(v=>applyRedaction(capText(v,item,counters),item,counters));}
      else if(field==="delivery" && value && typeof value==='object' && !Array.isArray(value)){const delivery=value as Record<string,unknown>, safe:Record<string,unknown>={};for(const key of ['channel','platform'])if(typeof delivery[key]==='string')safe[key]=applyRedaction(capText(delivery[key] as string,item,counters),item,counters);content.delivery=safe;const omitted=Object.keys(delivery).filter(k=>!(k in safe));if(omitted.length)item.warnings=[...(item.warnings??[]),...omitted.map(k=>`cron_field_omitted:delivery.${k}`)];}
      else if(field==="schedule" && value && typeof value==="object" && !Array.isArray(value)){
        const schedule=value as Record<string,unknown>, safe:Record<string,unknown>={};
        for(const key of ["kind","expr","tz","timezone","at","everyMs","anchorMs"]){const v=schedule[key];if(typeof v==="string")safe[key]=applyRedaction(capText(v,item,counters),item,counters);else if(typeof v==="number"&&Number.isFinite(v))safe[key]=v;}
        const omittedSchedule=Object.keys(schedule).filter(k=>!(k in safe));if(omittedSchedule.length)item.warnings=[...(item.warnings??[]),...omittedSchedule.map(k=>`cron_field_omitted:schedule.${k}`)];
        content.schedule=safe;
      } else if(typeof value==="string")content[field]=applyRedaction(capText(value,item,counters),item,counters);
      else if(typeof value==="boolean" || (typeof value==="number"&&Number.isFinite(value)))content[field==="enabled"?"sourceEnabled":field]=value;
      else if(value!==undefined)item.warnings=[...(item.warnings??[]),`cron_field_omitted:${field}`];
    }
    const omitted = Object.keys(job).filter((key) => !(CRON_SAFE_FIELDS as readonly string[]).includes(key));
    if (omitted.length > 0) {
      item.warnings = [...(item.warnings ?? []), `cron_fields_omitted:${omitted.sort().join(",")}`];
    }
    item.warnings = [...(item.warnings ?? []), "cron_requires_review"];
    items.push(item);
  }
  if (items.length > 0) warnings.add(`cron_imported_disabled:${items.length}`);
  return items;
}

/** 配置字段白名单：只保留这些路径的标量值作为草案；`*` 匹配单段，路径按小写比较。 */
const CONFIG_WHITELIST: readonly string[] = [
  "model",
  "language",
  "locale",
  "timezone",
  "memory.enabled",
  "agents.defaults.workspace",
  "agents.defaults.model",
  "agents.*.workspace",
  "providers.*.model",
  "providers.*.baseurl",
  "gateway.host",
  "gateway.port",
];

/** 凭据列名：小写并去掉非字母数字后精确匹配或后缀匹配，命中即视为秘密，值绝不进入清单。 */
const SECRET_FIELD_NAMES: ReadonlySet<string> = new Set([
  "token",
  "secret",
  "password",
  "passwd",
  "apikey",
  "key",
  "authkey",
  "authtoken",
  "accesstoken",
  "refreshtoken",
  "clientsecret",
  "bottoken",
  "privatekey",
  "secretkey",
  "credential",
  "credentials",
  "cookie",
  "cookies",
  "sessionid",
  "sessiontoken",
  "webhooksecret",
]);
const SECRET_FIELD_SUFFIXES: readonly string[] = [
  "token",
  "secret",
  "password",
  "passwd",
  "apikey",
  "privatekey",
  "credential",
  "cookie",
];

const MAX_CONFIG_DEPTH = 8;
const MAX_CONFIG_FIELDS = 500;
const MAX_CONFIG_VALUE_CHARS = 2048;

/** YAML 子集里无法安全解析的值；遇到时按未知字段报告损失，而不是猜测内容。 */
const UNSUPPORTED_YAML_VALUE = Symbol("unsupported-yaml");

type ConfigFieldKind = "whitelist" | "secret" | "unknown";

interface ConfigField {
  readonly path: string;
  readonly kind: ConfigFieldKind;
  value?: string | number | boolean;
  reason?: string;
}

function normalizeConfigKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isSecretConfigKey(key: string): boolean {
  const normalized = normalizeConfigKey(key);
  if (normalized.length === 0) return false;
  if (SECRET_FIELD_NAMES.has(normalized)) return true;
  return SECRET_FIELD_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

function isWhitelistedConfigPath(path: string): boolean {
  const segments = path.toLowerCase().split(".");
  return CONFIG_WHITELIST.some((rule) => {
    const ruleSegments = rule.split(".");
    if (ruleSegments.length !== segments.length) return false;
    return ruleSegments.every((segment, index) => segment === "*" || segment === segments[index]);
  });
}

/**
 * 只解析配置常用的 block mapping + 标量语法（注释、空行、引号字符串、布尔、数字）。
 * 序列、flow 集合、块标量、锚点和别名都标记为无法解析，交由上层按字段报告损失。
 */
function stripYamlComment(line: string): string {
  let quote: string | null = null;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index] as string;
    if (quote !== null) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "#" && (index === 0 || /\s/.test(line[index - 1] as string))) return line.slice(0, index);
  }
  return line;
}

function parseYamlScalar(raw: string): string | number | boolean | null | undefined {
  const text = raw.trim();
  if (text.length === 0) return undefined;
  if (text.startsWith('"') || text.startsWith("'")) {
    const quote = text[0] as string;
    if (text.length < 2 || !text.endsWith(quote)) return undefined;
    const body = text.slice(1, -1);
    if (quote === '"') {
      try {
        const parsed: unknown = JSON.parse(text);
        return typeof parsed === "string" ? parsed : undefined;
      } catch {
        return undefined;
      }
    }
    return body.replace(/''/g, "'");
  }
  if (/^(?:true|True|TRUE|yes|Yes)$/.test(text)) return true;
  if (/^(?:false|False|FALSE|no|No)$/.test(text)) return false;
  if (/^(?:null|Null|NULL|~)$/.test(text)) return null;
  if (/^-?\d+(?:\.\d+)?$/.test(text)) return Number(text);
  if (/^[&*!|>%@`\[\]{}]/.test(text)) return undefined;
  return text.length > MAX_CONFIG_VALUE_CHARS ? text.slice(0, MAX_CONFIG_VALUE_CHARS) : text;
}

interface YamlFrame {
  readonly indent: number;
  readonly node: Record<string, unknown>;
  readonly key?: string;
  readonly parent?: Record<string, unknown>;
}

function parseSimpleYaml(text: string): { value: Record<string, unknown>; unparsed: number } {
  const root: Record<string, unknown> = {};
  const stack: YamlFrame[] = [{ indent: -1, node: root }];
  let unparsed = 0;
  let skipIndent: number | null = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripYamlComment(rawLine);
    if (line.trim().length === 0) continue;
    if (line.includes("\t")) {
      unparsed += 1;
      continue;
    }
    const indent = line.length - line.trimStart().length;
    if (skipIndent !== null) {
      if (indent > skipIndent) continue;
      skipIndent = null;
    }
    const trimmed = line.trim();
    if (trimmed === "---" || trimmed === "...") continue;
    if (trimmed.startsWith("-")) {
      while (stack.length > 1 && indent < (stack[stack.length - 1] as YamlFrame).indent) stack.pop();
      const frame = stack[stack.length - 1] as YamlFrame;
      if (frame.key !== undefined && frame.parent !== undefined) {
        frame.parent[frame.key] = UNSUPPORTED_YAML_VALUE;
      }
      unparsed += 1;
      skipIndent = indent;
      continue;
    }
    const match = /^([^:]+?)\s*:\s*(.*)$/.exec(trimmed);
    const rawKey = match?.[1]?.trim().replace(/^["']|["']$/g, "") ?? "";
    if (!match || !/^[A-Za-z0-9_.-]{1,200}$/.test(rawKey)) {
      unparsed += 1;
      skipIndent = indent;
      continue;
    }
    while (stack.length > 1 && indent <= (stack[stack.length - 1] as YamlFrame).indent) stack.pop();
    const frame = stack[stack.length - 1] as YamlFrame;
    const rest = (match[2] ?? "").trim();
    if (frame.node[rawKey] !== undefined) {
      unparsed += 1;
      skipIndent = indent;
      continue;
    }
    if (rest.length === 0) {
      const child: Record<string, unknown> = {};
      frame.node[rawKey] = child;
      stack.push({ indent, node: child, key: rawKey, parent: frame.node });
      continue;
    }
    const scalar = parseYamlScalar(rest);
    if (scalar === undefined) {
      frame.node[rawKey] = UNSUPPORTED_YAML_VALUE;
      unparsed += 1;
      skipIndent = indent;
      continue;
    }
    frame.node[rawKey] = scalar;
  }
  return { value: root, unparsed };
}

function collectConfigFields(value: unknown, prefix: string, depth: number, out: ConfigField[]): void {
  if (out.length >= MAX_CONFIG_FIELDS) return;
  const record = asRecord(value);
  if (!record) return;
  for (const key of Object.keys(record).sort()) {
    if (out.length >= MAX_CONFIG_FIELDS) return;
    if (key.length === 0 || key.length > 200) continue;
    const path = prefix.length > 0 ? `${prefix}.${key}` : key;
    const secretKey = isSecretConfigKey(key);
    const child = record[key];
    if (child === UNSUPPORTED_YAML_VALUE) {
      out.push({ path, kind: secretKey ? "secret" : "unknown", reason: "unsupported_yaml_syntax" });
      continue;
    }
    if (asRecord(child) !== undefined) {
      if (depth >= MAX_CONFIG_DEPTH) {
        out.push({ path, kind: secretKey ? "secret" : "unknown", reason: "nesting_too_deep" });
        continue;
      }
      collectConfigFields(child, path, depth + 1, out);
      continue;
    }
    if (Array.isArray(child) || (typeof child === "object" && child !== null)) {
      out.push({ path, kind: secretKey ? "secret" : "unknown", reason: "non_scalar_value" });
      continue;
    }
    if (child === null || child === undefined) continue;
    if (typeof child !== "string" && typeof child !== "number" && typeof child !== "boolean") {
      out.push({ path, kind: secretKey ? "secret" : "unknown", reason: "non_scalar_value" });
      continue;
    }
    if (secretKey) {
      out.push({ path, kind: "secret" });
      continue;
    }
    if (!isWhitelistedConfigPath(path)) {
      out.push({ path, kind: "unknown", reason: "not_in_whitelist" });
      continue;
    }
    if (typeof child === "string" && child.length > MAX_CONFIG_VALUE_CHARS) {
      out.push({ path, kind: "whitelist", value: child.slice(0, MAX_CONFIG_VALUE_CHARS), reason: "value_truncated" });
      continue;
    }
    out.push({ path, kind: "whitelist", value: child });
  }
}

/**
 * 配置只做草案：白名单内的非密钥标量值进入 draft；未知字段逐项记录字段级损失；
 * 凭据列只输出 reauth 项，值绝不复制。
 */
function parseConfigInventory(
  files: NormalizedFiles,
  path: string,
  system: "openclaw" | "hermes",
  warnings: WarningCollector,
  counters: Counters,
): MigrationItem[] {
  const buffer = files.get(path);
  if (!buffer) return [];
  const lower = basename(path).toLowerCase();
  const format = lower.endsWith(".json")
    ? "json"
    : lower.endsWith(".yaml") || lower.endsWith(".yml")
      ? "yaml"
      : "unknown";
  const item: MigrationItem = {
    sourceId: `config:${path}`,
    type: "config",
    content: {
      path,
      system,
      format,
      sha256: sha256(buffer),
      imported: false,
      draft: {},
      unknownFields: [],
      reauthFields: [],
    },
  };
  const content = item.content as Record<string, unknown>;
  let parsedValue: unknown;
  let parsed = false;
  if (format === "json") {
    const result = parseJsonFile(files, path);
    if ("value" in result) {
      parsedValue = result.value;
      parsed = true;
    } else {
      item.warnings = [...(item.warnings ?? []), "config_unparsable"];
      warnings.add(`config_unparsable:${path}`);
    }
  } else if (format === "yaml") {
    const { text, truncated } = readDocText(buffer);
    const result = parseSimpleYaml(text);
    parsedValue = result.value;
    parsed = true;
    if (truncated) {
      item.warnings = [...(item.warnings ?? []), "document_truncated"];
      warnings.add(`document_truncated:${path}`);
    }
    if (result.unparsed > 0) {
      item.warnings = [...(item.warnings ?? []), `config_yaml_lines_unparsed:${result.unparsed}`];
      warnings.add(`config_yaml_lines_unparsed:${path}:${result.unparsed}`);
    }
  } else {
    item.warnings = [...(item.warnings ?? []), "config_format_unsupported"];
    warnings.add(`config_format_unsupported:${path}`);
  }

  const root = asRecord(parsedValue);
  const fields: ConfigField[] = [];
  if (parsed && root === undefined) {
    item.warnings = [...(item.warnings ?? []), "config_root_not_mapping"];
    warnings.add(`config_root_not_mapping:${path}`);
  }
  if (root !== undefined) {
    content.topLevelKeys = Object.keys(root).sort();
    collectConfigFields(root, "", 0, fields);
  }
  if (fields.length >= MAX_CONFIG_FIELDS) {
    item.warnings = [...(item.warnings ?? []), "config_fields_truncated"];
    warnings.add(`config_fields_truncated:${path}`);
  }

  const draft: Record<string, string | number | boolean> = {};
  const unknownFields: Array<{ path: string; reason: string }> = [];
  const reauthFields: string[] = [];
  for (const field of fields) {
    if (field.kind === "secret") {
      reauthFields.push(field.path);
      continue;
    }
    if (field.kind === "unknown") {
      unknownFields.push({ path: field.path, reason: field.reason ?? "not_in_whitelist" });
      continue;
    }
    let value = field.value as string | number | boolean;
    if (typeof value === "string") {
      if (/^https?:\/\//i.test(value)) {
        try {const url=new URL(value);if(url.username||url.password||url.search||url.hash||url.pathname!=="/"){unknownFields.push({path:field.path,reason:"url_components_not_copied"});if(url.username||url.password||url.search)reauthFields.push(field.path);}value=url.origin;}
        catch {unknownFields.push({path:field.path,reason:"invalid_url_not_copied"});continue;}
      }
      value = applyRedaction(value, item, counters);
    }
    draft[field.path] = value;
    if (field.reason === "value_truncated") {
      item.warnings = [...(item.warnings ?? []), `config_value_truncated:${field.path}`];
    }
  }
  content.draft = draft;
  content.unknownFields = unknownFields;
  content.reauthFields = reauthFields;

  const items: MigrationItem[] = [item];
  for (const field of unknownFields) {
    item.warnings = [...(item.warnings ?? []), `config_field_omitted:${field.path}`];
  }
  for (const field of reauthFields) {
    item.warnings = [...(item.warnings ?? []), `credential_requires_reauth:${field}`];
    items.push({
      sourceId: `reauth:config:${path}:${field}`,
      type: "reauth",
      content: { system, sourcePath: path, field, requiredAction: "reauth", valueCopied: false },
      warnings: ["credential_not_migrated"],
    });
  }
  item.warnings = [...(item.warnings ?? []), "config_draft_requires_review"];
  const draftCount = Object.keys(draft).length;
  if (draftCount > 0) warnings.add(`config_draft_fields:${path}:${draftCount}`);
  if (unknownFields.length > 0) warnings.add(`config_field_loss:${path}:${unknownFields.length}`);
  if (reauthFields.length > 0) warnings.add(`config_credentials_require_reauth:${path}:${reauthFields.length}`);
  warnings.add(`config_requires_manual_review:${path}`);
  return items;
}

/** 上游 d290127 把冷归档写成 <sha256>.jsonl.zst；名字里不含路径分隔符。 */
const COLD_ARCHIVE_NAME_PATTERN = /^[a-f0-9]{64}\.jsonl\.zst$/;
/** 上游 MAX_COLD_ARCHIVE_BYTES：单个冷归档文件解压后的上限。 */
const MAX_COLD_ARCHIVE_DECODED_BYTES = 64 * 1024 * 1024;
/** 压缩字节上限与解压上限分开，避免异常输入先占用内存。 */
const MAX_COLD_ARCHIVE_COMPRESSED_BYTES = 64 * 1024 * 1024;
/** 单次解析允许解压的冷归档总字节数。 */
const MAX_COLD_ARCHIVE_TOTAL_DECODED_BYTES = 128 * 1024 * 1024;
/** 单次解析允许解码的冷归档事件总数。 */
const MAX_COLD_ARCHIVE_EVENTS = 200_000;

type ColdArchiveFaultCode =
  | "archive_metadata_incomplete"
  | "archive_metadata_invalid"
  | "archive_name_mismatch"
  | "archive_path_ambiguous"
  | "archive_body_missing"
  | "archive_size_mismatch"
  | "archive_hash_mismatch"
  | "archive_chunk_metadata_incomplete"
  | "archive_chunk_manifest_mismatch"
  | "archive_compressed_bytes_exceeded"
  | "archive_decoded_bytes_exceeded"
  | "archive_records_exceeded"
  | "archive_container_invalid"
  | "archive_record_invalid"
  | "archive_metadata_mismatch"
  | "archive_decode_budget_exhausted";

/**
 * 只携带固定原因码：绝不把正文、事件文本或解压错误消息写进报告。
 * bodyPresent 表示解码失败前已确认归档正文存在。
 */
class ColdArchiveDecodeError extends Error {
  bodyPresent = false;

  constructor(readonly code: ColdArchiveFaultCode) {
    super(code);
    this.name = "ColdArchiveDecodeError";
  }
}

interface ColdArchiveBudget {
  decodedBytes: number;
  events: number;
  exhausted: boolean;
  exhaustedReported: boolean;
}

interface ColdArchiveChunkMetadata {
  chunkIndex: number;
  archiveName: string;
  archiveSha256: string;
  firstSeq: number;
  lastSeq: number;
  eventCount: number;
  rawBytes: number;
  archiveBytes: number;
}

interface ColdArchiveTurn {
  seq: number;
  createdAt: number;
  role: TranscriptRole;
  text?: string;
  toolName?: string;
  argumentsSummary?: string;
  timestamp?: string;
  readOnly: boolean;
  skippedParts: string[];
}

interface ColdArchiveHeaderMetadata {
  sessionId: string;
  generation: string;
  archiveName: string;
  archiveSha256: string;
  eventCount: number;
  rawBytes: number;
  archiveBytes: number;
  lastSeq: number;
  storage: "file" | "sqlite";
}

interface ColdArchiveDecoded {
  storage: "file" | "sqlite";
  path: string | null;
  bytes: number;
  sha256: string;
  chunks: number;
  events: number;
  turns: ColdArchiveTurn[];
  skippedEvents: number;
  skippedParts: Map<string, number>;
  skippedEventTypes: Map<string, number>;
}

type ColdArchiveBody =
  | { kind: "file"; path: string; bytes: Buffer }
  | { kind: "database"; chunks: ColdArchiveChunkMetadata[]; chunksTotal: number };

function coldArchiveOptionalInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

function coldArchiveFileMatches(files: NormalizedFiles, archiveName: string): string[] {
  const wanted = normalizePath(archiveName);
  if (wanted.length === 0) return [];
  return [...files.keys()].sort().filter((path) => path === wanted || path.endsWith(`/${wanted}`));
}

function coldArchiveString(row: Record<string, unknown>, field: string): string {
  const value = row[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new ColdArchiveDecodeError("archive_metadata_incomplete");
  }
  return value;
}

function coldArchiveInteger(row: Record<string, unknown>, field: string, minimum: number): number {
  const value = row[field];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    throw new ColdArchiveDecodeError("archive_metadata_incomplete");
  }
  return value;
}

/** 逐字段复述上游 session_transcript_cold_archives 的约束；缺失或越界都不猜测。 */
function readColdArchiveHeader(row: Record<string, unknown>): ColdArchiveHeaderMetadata {
  const archiveName = coldArchiveString(row, "archive_name");
  const archiveSha256 = coldArchiveString(row, "archive_sha256");
  if (!/^[a-f0-9]{64}$/.test(archiveSha256)) {
    throw new ColdArchiveDecodeError("archive_metadata_invalid");
  }
  if (`${archiveSha256}.jsonl.zst` !== archiveName) {
    throw new ColdArchiveDecodeError("archive_name_mismatch");
  }
  const storage = row.storage;
  if (storage !== "file" && storage !== "sqlite") {
    throw new ColdArchiveDecodeError("archive_metadata_invalid");
  }
  return {
    sessionId: coldArchiveString(row, "session_id"),
    generation: coldArchiveString(row, "generation"),
    archiveName,
    archiveSha256,
    eventCount: coldArchiveInteger(row, "event_count", 1),
    rawBytes: coldArchiveInteger(row, "raw_bytes", 0),
    archiveBytes: coldArchiveInteger(row, "archive_bytes", 0),
    lastSeq: coldArchiveInteger(row, "last_seq", 0),
    storage,
  };
}

function readColdArchiveChunks(
  image: SqliteImage,
  sessionId: string,
  label: string,
): { total: number; chunks: ColdArchiveChunkMetadata[] } {
  if (!hasTable(image, "session_transcript_cold_archive_chunks")) return { total: 0, chunks: [] };
  const total = Number(
    readScalar(
      image,
      "SELECT COUNT(*) AS count FROM session_transcript_cold_archive_chunks WHERE session_id = ?",
      [sessionId],
      label,
    ) ?? 0,
  );
  if (total === 0) return { total: 0, chunks: [] };
  // 每个分块至少 1 个事件；超过事件总预算的分块清单不再读取。
  if (total > MAX_COLD_ARCHIVE_EVENTS) throw new ColdArchiveDecodeError("archive_records_exceeded");
  const columns = readRows(image, "PRAGMA table_info(session_transcript_cold_archive_chunks)", [], label).map(
    (row) => String(row.name),
  );
  const required = [
    "chunk_index",
    "archive_name",
    "archive_sha256",
    "first_seq",
    "last_seq",
    "event_count",
    "raw_bytes",
    "archive_bytes",
  ];
  if (required.some((name) => !columns.includes(name))) {
    throw new ColdArchiveDecodeError("archive_chunk_metadata_incomplete");
  }
  const rows = readRows(
    image,
    `SELECT ${required.join(", ")}
       FROM session_transcript_cold_archive_chunks
      WHERE session_id = ?
      ORDER BY chunk_index ASC`,
    [sessionId],
    label,
  );
  return {
    total,
    chunks: rows.map((row) => {
      const archiveName = coldArchiveString(row, "archive_name");
      const archiveSha256 = coldArchiveString(row, "archive_sha256");
      if (!COLD_ARCHIVE_NAME_PATTERN.test(archiveName) || `${archiveSha256}.jsonl.zst` !== archiveName) {
        throw new ColdArchiveDecodeError("archive_chunk_manifest_mismatch");
      }
      return {
        chunkIndex: coldArchiveInteger(row, "chunk_index", 0),
        archiveName,
        archiveSha256,
        firstSeq: coldArchiveInteger(row, "first_seq", 0),
        lastSeq: coldArchiveInteger(row, "last_seq", 0),
        eventCount: coldArchiveInteger(row, "event_count", 1),
        rawBytes: coldArchiveInteger(row, "raw_bytes", 0),
        archiveBytes: coldArchiveInteger(row, "archive_bytes", 0),
      };
    }),
  };
}

/** 与上游 hashSessionColdChunks 完全一致的字段顺序。 */
function coldArchiveChunkHash(chunks: readonly ColdArchiveChunkMetadata[]): string {
  return createHash("sha256")
    .update(
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
    )
    .digest("hex");
}

function readColdArchiveBlob(
  image: SqliteImage,
  sessionId: string,
  generation: string,
  chunkIndex: number | null,
  expectedBytes: number,
  expectedSha256: string,
  label: string,
): Buffer {
  if (expectedBytes > MAX_COLD_ARCHIVE_COMPRESSED_BYTES) {
    throw new ColdArchiveDecodeError("archive_compressed_bytes_exceeded");
  }
  const table =
    chunkIndex === null ? "session_transcript_cold_archives" : "session_transcript_cold_archive_chunks";
  const where = chunkIndex === null ? "session_id = ? AND generation = ?" : "session_id = ? AND chunk_index = ?";
  const params = chunkIndex === null ? [sessionId, generation] : [sessionId, chunkIndex];
  const declared = readScalar(image, `SELECT length(archive_blob) AS size FROM ${table} WHERE ${where}`, params, label);
  if (declared === null || declared === undefined) throw new ColdArchiveDecodeError("archive_body_missing");
  const length = typeof declared === "number" ? declared : Number(declared);
  if (!Number.isSafeInteger(length) || length <= 0) throw new ColdArchiveDecodeError("archive_body_missing");
  if (length !== expectedBytes) throw new ColdArchiveDecodeError("archive_size_mismatch");
  const row = readRows(image, `SELECT archive_blob FROM ${table} WHERE ${where}`, params, label)[0];
  const blob = row?.archive_blob;
  if (!(blob instanceof Uint8Array)) throw new ColdArchiveDecodeError("archive_body_missing");
  const bytes = Buffer.from(blob);
  if (bytes.length !== expectedBytes) throw new ColdArchiveDecodeError("archive_size_mismatch");
  if (sha256(bytes) !== expectedSha256) throw new ColdArchiveDecodeError("archive_hash_mismatch");
  return bytes;
}

function readColdArchiveFileBytes(
  files: NormalizedFiles,
  archiveName: string,
  expectedBytes: number,
  expectedSha256: string,
): { path: string; bytes: Buffer } {
  const matches = coldArchiveFileMatches(files, archiveName);
  if (matches.length === 0) throw new ColdArchiveDecodeError("archive_body_missing");
  if (matches.length > 1) throw new ColdArchiveDecodeError("archive_path_ambiguous");
  const path = matches[0]!;
  const bytes = files.get(path);
  if (!bytes) throw new ColdArchiveDecodeError("archive_body_missing");
  if (bytes.length > MAX_COLD_ARCHIVE_COMPRESSED_BYTES) {
    throw new ColdArchiveDecodeError("archive_compressed_bytes_exceeded");
  }
  if (bytes.length !== expectedBytes) throw new ColdArchiveDecodeError("archive_size_mismatch");
  if (sha256(bytes) !== expectedSha256) throw new ColdArchiveDecodeError("archive_hash_mismatch");
  return { path, bytes };
}

/** 先确认正文是否存在，使失败报告能区分“缺失”和“存在但不可解码”。 */
function locateColdArchiveBody(args: {
  files: NormalizedFiles;
  image: SqliteImage;
  label: string;
  sessionId: string;
  generation: string;
  archiveName: string;
  storage: unknown;
}): ColdArchiveBody {
  let chunkInfo: { total: number; chunks: ColdArchiveChunkMetadata[] };
  try {
    chunkInfo = readColdArchiveChunks(args.image, args.sessionId, args.label);
  } catch (error) {
    if (error instanceof ColdArchiveDecodeError) error.bodyPresent = true;
    throw error;
  }
  if (chunkInfo.total > 0) {
    if (args.storage !== "file" && args.storage !== "sqlite") {
      throw new ColdArchiveDecodeError("archive_metadata_invalid");
    }
    return { kind: "database", chunks: chunkInfo.chunks, chunksTotal: chunkInfo.total };
  }
  if (args.storage === "sqlite") {
    const declared = readScalar(
      args.image,
      "SELECT length(archive_blob) AS size FROM session_transcript_cold_archives WHERE session_id = ? AND generation = ?",
      [args.sessionId, args.generation],
      args.label,
    );
    const length = typeof declared === "number" ? declared : Number(declared ?? 0);
    if (!Number.isSafeInteger(length) || length <= 0) {
      throw new ColdArchiveDecodeError("archive_body_missing");
    }
    return { kind: "database", chunks: [], chunksTotal: 0 };
  }
  const matches = coldArchiveFileMatches(args.files, args.archiveName);
  if (matches.length === 0) throw new ColdArchiveDecodeError("archive_body_missing");
  if (matches.length > 1) throw new ColdArchiveDecodeError("archive_path_ambiguous");
  const path = matches[0]!;
  const bytes = args.files.get(path);
  if (!bytes) throw new ColdArchiveDecodeError("archive_body_missing");
  return { kind: "file", path, bytes };
}

/**
 * 只解码已通过字节数、sha256 和计数校验的正文。
 * 行格式来自上游 session-cold-storage-codec.ts：首条 header(version=1)，
 * 随后 event/identity/active/index/fts；事件 seq 必须严格递增。
 */
function decodeColdArchiveFile(
  bytes: Buffer,
  expected: {
    sessionId: string;
    generation: string;
    firstSeq?: number;
    lastSeq: number;
    eventCount: number;
    rawBytes: number;
  },
  budget: ColdArchiveBudget,
): {
  turns: ColdArchiveTurn[];
  nonChat: number;
  skippedParts: Map<string, number>;
  skippedEventTypes: Map<string, number>;
} {
  if (budget.exhausted) throw new ColdArchiveDecodeError("archive_decode_budget_exhausted");
  if (bytes.length > MAX_COLD_ARCHIVE_COMPRESSED_BYTES) {
    throw new ColdArchiveDecodeError("archive_compressed_bytes_exceeded");
  }
  let decoded: Buffer;
  try {
    decoded = zstdDecompressSync(bytes, { maxOutputLength: MAX_COLD_ARCHIVE_DECODED_BYTES });
  } catch (error) {
    if (error instanceof RangeError && (error as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE") {
      throw new ColdArchiveDecodeError("archive_decoded_bytes_exceeded");
    }
    throw new ColdArchiveDecodeError("archive_container_invalid");
  }
  if (decoded.length > MAX_COLD_ARCHIVE_TOTAL_DECODED_BYTES - budget.decodedBytes) {
    budget.exhausted = true;
    throw new ColdArchiveDecodeError("archive_decode_budget_exhausted");
  }
  budget.decodedBytes += decoded.length;
  let headerSeen = false;
  let eventCount = 0;
  let rawBytes = -1;
  let lastSeq: number | undefined;
  let nonChat = 0;
  const skippedParts = new Map<string, number>();
  const skippedEventTypes = new Map<string, number>();
  const turns: ColdArchiveTurn[] = [];
  for (let offset = 0; offset < decoded.length; ) {
    const newline = decoded.indexOf(10, offset);
    const end = newline < 0 ? decoded.length : newline;
    const line = decoded.toString("utf8", offset, end);
    if (line.trim().length === 0) {
      if (decoded.subarray(end + 1).toString("utf8").trim().length === 0) break;
      throw new ColdArchiveDecodeError("archive_record_invalid");
    }
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new ColdArchiveDecodeError("archive_record_invalid");
    }
    const record = asRecord(value);
    if (!record || typeof record.kind !== "string") {
      throw new ColdArchiveDecodeError("archive_record_invalid");
    }
    if (!headerSeen) {
      if (
        record.kind !== "header" ||
        record.version !== 1 ||
        record.sessionId !== expected.sessionId ||
        record.generation !== expected.generation
      ) {
        throw new ColdArchiveDecodeError("archive_metadata_mismatch");
      }
      headerSeen = true;
      offset = end + 1;
      continue;
    }
    if (record.kind === "header") throw new ColdArchiveDecodeError("archive_metadata_mismatch");
    if (record.kind === "event") {
      const row = asRecord(record.row);
      const seq = coldArchiveOptionalInteger(row?.seq);
      const createdAt = coldArchiveOptionalInteger(row?.created_at);
      if (!row || seq === undefined || createdAt === undefined || typeof row.event_json !== "string") {
        throw new ColdArchiveDecodeError("archive_record_invalid");
      }
      if (eventCount === 0 && expected.firstSeq !== undefined && seq !== expected.firstSeq) {
        throw new ColdArchiveDecodeError("archive_metadata_mismatch");
      }
      if (lastSeq !== undefined && seq <= lastSeq) {
        throw new ColdArchiveDecodeError("archive_metadata_mismatch");
      }
      eventCount += 1;
      rawBytes += Buffer.byteLength(row.event_json) + 1;
      lastSeq = seq;
      budget.events += 1;
      if (budget.events > MAX_COLD_ARCHIVE_EVENTS) {
        budget.exhausted = true;
        throw new ColdArchiveDecodeError("archive_records_exceeded");
      }
      const read = readOpenClawEvent(row.event_json);
      if (read.kind === "turn") {
        turns.push({ seq, createdAt, ...read.turn });
      } else if (read.kind === "event") {
        nonChat += 1;
        countCategory(skippedEventTypes, read.eventType);
        for (const partType of read.parts) countCategory(skippedParts, partType);
      } else {
        throw new ColdArchiveDecodeError("archive_record_invalid");
      }
    } else if (record.kind === "identity") {
      const row = asRecord(record.row);
      if (!row || typeof row.event_id !== "string" || coldArchiveOptionalInteger(row.seq) === undefined) {
        throw new ColdArchiveDecodeError("archive_record_invalid");
      }
    } else if (record.kind === "active") {
      const row = asRecord(record.row);
      if (
        !row ||
        coldArchiveOptionalInteger(row.active_position) === undefined ||
        coldArchiveOptionalInteger(row.event_seq) === undefined
      ) {
        throw new ColdArchiveDecodeError("archive_record_invalid");
      }
    } else if (record.kind === "index") {
      const row = asRecord(record.row);
      if (!row || coldArchiveOptionalInteger(row.indexed_seq) === undefined) {
        throw new ColdArchiveDecodeError("archive_record_invalid");
      }
    } else if (record.kind === "fts") {
      if (!asRecord(record.row)) throw new ColdArchiveDecodeError("archive_record_invalid");
    } else {
      throw new ColdArchiveDecodeError("archive_record_invalid");
    }
    offset = end + 1;
  }
  if (
    !headerSeen ||
    eventCount !== expected.eventCount ||
    lastSeq !== expected.lastSeq ||
    rawBytes !== expected.rawBytes
  ) {
    throw new ColdArchiveDecodeError("archive_metadata_mismatch");
  }
  return { turns, nonChat, skippedParts, skippedEventTypes };
}

function decodeLocatedColdArchive(args: {
  files: NormalizedFiles;
  image: SqliteImage;
  label: string;
  row: Record<string, unknown>;
  sessionId: string;
  generation: string;
  body: ColdArchiveBody;
  budget: ColdArchiveBudget;
}): ColdArchiveDecoded {
  const meta = readColdArchiveHeader(args.row);
  if (meta.sessionId !== args.sessionId || meta.generation !== args.generation) {
    throw new ColdArchiveDecodeError("archive_metadata_mismatch");
  }
  if (args.body.kind === "database" && args.body.chunksTotal > 0) {
    const chunks = args.body.chunks;
    const ordered = chunks.every(
      (chunk, index) =>
        chunk.chunkIndex === index &&
        chunk.firstSeq <= chunk.lastSeq &&
        (index === 0 || chunk.firstSeq > chunks[index - 1]!.lastSeq),
    );
    const manifestHash = coldArchiveChunkHash(chunks);
    if (
      !ordered ||
      chunks.length !== args.body.chunksTotal ||
      chunks.reduce((total, chunk) => total + chunk.eventCount, 0) !== meta.eventCount ||
      chunks.reduce((total, chunk) => total + chunk.rawBytes, 0) + chunks.length - 1 !== meta.rawBytes ||
      chunks.reduce((total, chunk) => total + chunk.archiveBytes, 0) !== meta.archiveBytes ||
      chunks.at(-1)!.lastSeq !== meta.lastSeq ||
      manifestHash !== meta.archiveSha256 ||
      `${manifestHash}.jsonl.zst` !== meta.archiveName
    ) {
      throw new ColdArchiveDecodeError("archive_chunk_manifest_mismatch");
    }
    const turns: ColdArchiveTurn[] = [];
    const skippedParts = new Map<string, number>();
    const skippedEventTypes = new Map<string, number>();
    let skippedEvents = 0;
    for (const chunk of chunks) {
      const bytes =
        meta.storage === "sqlite"
          ? readColdArchiveBlob(
              args.image,
              args.sessionId,
              args.generation,
              chunk.chunkIndex,
              chunk.archiveBytes,
              chunk.archiveSha256,
              args.label,
            )
          : readColdArchiveFileBytes(args.files, chunk.archiveName, chunk.archiveBytes, chunk.archiveSha256).bytes;
      const decoded = decodeColdArchiveFile(
        bytes,
        {
          sessionId: args.sessionId,
          generation: args.generation,
          firstSeq: chunk.firstSeq,
          lastSeq: chunk.lastSeq,
          eventCount: chunk.eventCount,
          rawBytes: chunk.rawBytes,
        },
        args.budget,
      );
      for (const turn of decoded.turns) turns.push(turn);
      skippedEvents += decoded.nonChat;
      for (const [partType, count] of decoded.skippedParts) {
        countCategory(skippedParts, partType, count);
      }
      for (const [eventType, count] of decoded.skippedEventTypes) {
        countCategory(skippedEventTypes, eventType, count);
      }
    }
    return {
      storage: meta.storage,
      path: null,
      bytes: meta.archiveBytes,
      sha256: meta.archiveSha256,
      chunks: chunks.length,
      events: meta.eventCount,
      turns,
      skippedEvents,
      skippedParts,
      skippedEventTypes,
    };
  }
  const source =
    meta.storage === "sqlite"
      ? {
          path: null,
          bytes: readColdArchiveBlob(
            args.image,
            args.sessionId,
            args.generation,
            null,
            meta.archiveBytes,
            meta.archiveSha256,
            args.label,
          ),
        }
      : readColdArchiveFileBytes(args.files, meta.archiveName, meta.archiveBytes, meta.archiveSha256);
  const decoded = decodeColdArchiveFile(
    source.bytes,
    {
      sessionId: args.sessionId,
      generation: args.generation,
      eventCount: meta.eventCount,
      lastSeq: meta.lastSeq,
      rawBytes: meta.rawBytes,
    },
    args.budget,
  );
  return {
    storage: meta.storage,
    path: source.path,
    bytes: source.bytes.length,
    sha256: meta.archiveSha256,
    chunks: 0,
    events: meta.eventCount,
    turns: decoded.turns,
    skippedEvents: decoded.nonChat,
    skippedParts: decoded.skippedParts,
    skippedEventTypes: decoded.skippedEventTypes,
  };
}

function decodeColdArchive(args: {
  files: NormalizedFiles;
  image: SqliteImage;
  label: string;
  row: Record<string, unknown>;
  sessionId: string;
  generation: string;
  budget: ColdArchiveBudget;
}): ColdArchiveDecoded {
  const archiveName = typeof args.row.archive_name === "string" ? args.row.archive_name : "";
  let body: ColdArchiveBody;
  try {
    body = locateColdArchiveBody({
      files: args.files,
      image: args.image,
      label: args.label,
      sessionId: args.sessionId,
      generation: args.generation,
      archiveName,
      storage: args.row.storage,
    });
  } catch (error) {
    if (error instanceof ColdArchiveDecodeError && error.code !== "archive_body_missing") {
      error.bodyPresent = true;
    }
    throw error;
  }
  try {
    return decodeLocatedColdArchive({ ...args, body });
  } catch (error) {
    if (error instanceof ColdArchiveDecodeError) error.bodyPresent = true;
    throw error;
  }
}

/**
 * OpenClaw 冷归档：保留行内可用字段、归档文件哈希与已校验的正文历史。
 * 解码严格依赖上游 d290127 的 zstd JSONL 记录格式；任何校验失败只报告固定
 * 原因码，不保留原始正文，也不做部分导入。
 */
function parseColdArchives(
  files: NormalizedFiles,
  image: SqliteImage,
  label: string,
  databasePath: string,
  agentId: string,
  sessionKeys: Map<string, string>,
  warnings: WarningCollector,
  counters: Counters,
  budget: ColdArchiveBudget,
): MigrationItem[] {
  if (!hasTable(image, "session_transcript_cold_archives")) {
    warnings.add(`cold_archive_table_absent:${databasePath}`);
    return [];
  }
  const columns = readRows(image, "PRAGMA table_info(session_transcript_cold_archives)", [], label).map((row) => String(row.name));
  const safeColumns = ["archive_sha256", "event_count", "raw_bytes", "archive_bytes", "last_seq", "archived_at", "storage"].filter((name) => columns.includes(name));
  const omittedColumns = columns.filter((name) => !["session_id", "generation", "archive_name", ...safeColumns].includes(name));
  const rows = readRows(
    image,
    `SELECT session_id, generation, archive_name${safeColumns.map((name) => `, ${name}`).join("")}
       FROM session_transcript_cold_archives
      ORDER BY session_id ASC, generation ASC`,
    [],
    label,
  );
  const items: MigrationItem[] = [];
  let archives = 0;
  let bodyMissing = 0;
  let bodyDecoded = 0;
  let bodyUndecodable = 0;
  let decodedMessages = 0;
  let decodedChunks = 0;
  let malformed = 0;
  for (const row of rows) {
    const sessionId = typeof row.session_id === "string" && row.session_id.length > 0 ? row.session_id : undefined;
    const generation = typeof row.generation === "string" && row.generation.length > 0 ? row.generation : undefined;
    const archiveName = typeof row.archive_name === "string" && row.archive_name.length > 0 ? row.archive_name : undefined;
    if (!sessionId || !generation || !archiveName) {
      malformed += 1;
      continue;
    }
    const losses: Array<{ field: string; reason: string }> = omittedColumns.map((field) => ({ field, reason: "archive_field_not_retained" }));
    const metadata: Record<string, unknown> = {};
    for (const field of safeColumns) metadata[field] = row[field];
    const itemWarnings: string[] = ["cold_archive_requires_review"];
    const matches = coldArchiveFileMatches(files, archiveName);
    const archivePath = matches.length === 1 ? matches[0]! : undefined;
    const fileBody = archivePath === undefined ? undefined : files.get(archivePath);
    let evidence: Record<string, unknown> | null =
      fileBody === undefined
        ? null
        : { path: archivePath!, storage: typeof row.storage === "string" ? row.storage : null, bytes: fileBody.length, sha256: sha256(fileBody) };
    let bodyAvailable = fileBody !== undefined;
    let decoded: Record<string, unknown> | null = null;
    const messageItems: MigrationItem[] = [];
    try {
      const result = decodeColdArchive({ files, image, label, row, sessionId, generation, budget });
      bodyAvailable = true;
      bodyDecoded += 1;
      decodedChunks += result.chunks;
      evidence = { path: result.path, storage: result.storage, bytes: result.bytes, sha256: result.sha256 };
      decoded = { chunks: result.chunks, events: result.events, messages: result.turns.length, skippedEvents: result.skippedEvents };
      decodedMessages += result.turns.length;
      for (const turn of result.turns) {
        const message = transcriptMessageItem(turn, {
          agentId,
          sessionKey: sessionKeys.get(sessionId) ?? null,
          sessionId,
          generation,
          origin: "cold_archive",
          seq: turn.seq,
          sourceIdPrefix: "cold_message",
          counters,
        });
        if (message.sourceTime === undefined) message.sourceTime = toIsoTimestamp(turn.createdAt);
        messageItems.push(message);
      }
      // 未知非文本逐类累计，最终由 pushLossWarnings 输出。
      for (const [partType, count] of result.skippedParts) {
        countCategory(counters.skippedParts, partType, count);
      }
      for (const [eventType, count] of result.skippedEventTypes) {
        countCategory(counters.skippedEventTypes, eventType, count);
      }
      if (messageItems.length > 0) itemWarnings.push("cold_archive_history_imported");
    } catch (error) {
      if (!(error instanceof ColdArchiveDecodeError)) throw error;
      bodyAvailable = error.bodyPresent;
      if (error.code === "archive_body_missing") {
        bodyMissing += 1;
        itemWarnings.push("cold_archive_body_missing");
        losses.push({ field: "archive_body", reason: "archive_content_missing_from_snapshot" });
        losses.push({ field: "archive_body.messages", reason: "unavailable_without_archive_content" });
      } else {
        bodyUndecodable += 1;
        itemWarnings.push(`cold_archive_undecodable:${error.code}`);
        losses.push({ field: "archive_body.messages", reason: error.code });
      }
    }
    archives += 1;
    items.push({
      sourceId: `cold_archive:${agentId}:${sessionId}:${generation}`,
      type: "archive",
      content: {
        agentId,
        sessionId,
        sessionKey: sessionKeys.get(sessionId) ?? null,
        generation,
        archiveName,
        metadata,
        imported: false,
        bodyAvailable,
        bodyDecoded: decoded !== null,
        body: evidence,
        decoded,
        losses,
      },
      warnings: itemWarnings,
    });
    for (const message of messageItems) items.push(message);
  }
  if (archives > 0) warnings.add(`cold_archive_items:${databasePath}:${archives}`);
  if (bodyDecoded > 0) warnings.add(`cold_archive_body_decoded:${databasePath}:${bodyDecoded}`);
  if (bodyUndecodable > 0) warnings.add(`cold_archive_body_undecodable:${databasePath}:${bodyUndecodable}`);
  if (bodyMissing > 0) warnings.add(`cold_archive_body_missing:${databasePath}:${bodyMissing}`);
  if (decodedMessages > 0) warnings.add(`cold_archive_messages:${databasePath}:${decodedMessages}`);
  if (decodedChunks > 0) warnings.add(`cold_archive_chunks_decoded:${databasePath}:${decodedChunks}`);
  if (malformed > 0) warnings.add(`cold_archive_rows_malformed:${databasePath}:${malformed}`);
  if (budget.exhausted && !budget.exhaustedReported) {
    budget.exhaustedReported = true;
    warnings.add(`cold_archive_decode_budget_exhausted:${databasePath}`);
  }
  return items;
}


/** 上游 session_transcript_archives：保留型上游归档（deleted/reset），identity 或 zstd。 */
const MAX_RETAINED_ARCHIVE_STORED_BYTES = 64 * 1024 * 1024;
const MAX_RETAINED_ARCHIVE_DECODED_BYTES = 64 * 1024 * 1024;
const MAX_RETAINED_ARCHIVE_TOTAL_DECODED_BYTES = 128 * 1024 * 1024;
const MAX_RETAINED_ARCHIVE_RECORDS = 200_000;

type RetainedArchiveFaultCode =
  | "archive_metadata_incomplete"
  | "archive_metadata_invalid"
  | "archive_blob_missing"
  | "archive_hash_mismatch"
  | "archive_encoding_unsupported"
  | "archive_stored_bytes_exceeded"
  | "archive_decoded_bytes_exceeded"
  | "archive_container_invalid"
  | "archive_record_invalid"
  | "archive_header_mismatch"
  | "archive_records_exceeded"
  | "archive_decode_budget_exhausted";

/** 只携带固定原因码：不把正文、事件文本或解压错误消息写进报告。 */
class RetainedArchiveDecodeError extends Error {
  constructor(readonly code: RetainedArchiveFaultCode) {
    super(code);
    this.name = "RetainedArchiveDecodeError";
  }
}

interface RetainedArchiveBudget {
  decodedBytes: number;
  records: number;
  exhausted: boolean;
  exhaustedReported: boolean;
}

interface RetainedArchiveDecoded {
  encoding: "identity" | "zstd";
  storedBytes: number;
  decodedBytes: number;
  sha256: string;
  records: number;
  turns: Array<{ seq: number; turn: TranscriptTurn }>;
  skippedParts: Map<string, number>;
  skippedEventTypes: Map<string, number>;
}

/**
 * 解码一条已注册归档：先校验原始 blob 的 sha256（上游对存储字节取哈希），
 * 再按 encoding 解码，最后逐条校验 JSONL 转录记录。
 * 任何一步失败都整体放弃该归档，绝不部分导入。
 */
function decodeRetainedArchive(
  image: SqliteImage,
  label: string,
  row: Record<string, unknown>,
  sessionId: string,
  generation: string,
  budget: RetainedArchiveBudget,
): RetainedArchiveDecoded {
  if (budget.exhausted) throw new RetainedArchiveDecodeError("archive_decode_budget_exhausted");
  const encoding = row.encoding;
  if (encoding !== "identity" && encoding !== "zstd") {
    throw new RetainedArchiveDecodeError("archive_encoding_unsupported");
  }
  const declaredSha = row.archive_sha256;
  if (typeof declaredSha !== "string" || !/^[a-f0-9]{64}$/.test(declaredSha)) {
    throw new RetainedArchiveDecodeError("archive_metadata_invalid");
  }
  const declaredLength = readScalar(
    image,
    "SELECT length(archive_blob) AS size FROM session_transcript_archives WHERE session_id = ? AND generation = ?",
    [sessionId, generation],
    label,
  );
  const length = Number(declaredLength ?? 0);
  if (declaredLength === null || declaredLength === undefined || !Number.isSafeInteger(length) || length <= 0) {
    throw new RetainedArchiveDecodeError("archive_blob_missing");
  }
  if (length > MAX_RETAINED_ARCHIVE_STORED_BYTES) {
    throw new RetainedArchiveDecodeError("archive_stored_bytes_exceeded");
  }
  const blob = readRows(
    image,
    "SELECT archive_blob FROM session_transcript_archives WHERE session_id = ? AND generation = ?",
    [sessionId, generation],
    label,
  )[0]?.archive_blob;
  if (!(blob instanceof Uint8Array)) throw new RetainedArchiveDecodeError("archive_blob_missing");
  const stored = Buffer.from(blob);
  if (stored.length !== length) throw new RetainedArchiveDecodeError("archive_metadata_invalid");
  if (sha256(stored) !== declaredSha) throw new RetainedArchiveDecodeError("archive_hash_mismatch");
  let decoded: Buffer;
  if (encoding === "identity") {
    decoded = stored;
  } else {
    try {
      decoded = zstdDecompressSync(stored, { maxOutputLength: MAX_RETAINED_ARCHIVE_DECODED_BYTES });
    } catch (error) {
      if (error instanceof RangeError && (error as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE") {
        throw new RetainedArchiveDecodeError("archive_decoded_bytes_exceeded");
      }
      throw new RetainedArchiveDecodeError("archive_container_invalid");
    }
  }
  if (decoded.length > MAX_RETAINED_ARCHIVE_DECODED_BYTES) {
    throw new RetainedArchiveDecodeError("archive_decoded_bytes_exceeded");
  }
  if (decoded.length > MAX_RETAINED_ARCHIVE_TOTAL_DECODED_BYTES - budget.decodedBytes) {
    budget.exhausted = true;
    throw new RetainedArchiveDecodeError("archive_decode_budget_exhausted");
  }
  budget.decodedBytes += decoded.length;
  let headerSeen = false;
  let records = 0;
  let ordinal = 0;
  const turns: Array<{ seq: number; turn: TranscriptTurn }> = [];
  const skippedParts = new Map<string, number>();
  const skippedEventTypes = new Map<string, number>();
  for (let offset = 0; offset < decoded.length; ) {
    const newline = decoded.indexOf(10, offset);
    const end = newline < 0 ? decoded.length : newline;
    const line = decoded.toString("utf8", offset, end);
    if (line.trim().length === 0) {
      if (decoded.subarray(end + 1).toString("utf8").trim().length === 0) break;
      throw new RetainedArchiveDecodeError("archive_record_invalid");
    }
    records += 1;
    budget.records += 1;
    if (records > MAX_RETAINED_ARCHIVE_RECORDS || budget.records > MAX_RETAINED_ARCHIVE_RECORDS) {
      budget.exhausted = true;
      throw new RetainedArchiveDecodeError("archive_records_exceeded");
    }
    const record = asRecord(safeJson(line));
    if (!record) throw new RetainedArchiveDecodeError("archive_record_invalid");
    if (!headerSeen) {
      // 上游第一行是会话头；id 必须与注册的 session_id 一致。
      if (record.type !== "session" || record.id !== sessionId) {
        throw new RetainedArchiveDecodeError("archive_header_mismatch");
      }
      headerSeen = true;
      offset = end + 1;
      continue;
    }
    ordinal += 1;
    const read = readOpenClawEvent(line);
    if (read.kind === "invalid") throw new RetainedArchiveDecodeError("archive_record_invalid");
    offset = end + 1;
    if (read.kind === "event") {
      countCategory(skippedEventTypes, read.eventType);
      for (const partType of read.parts) countCategory(skippedParts, partType);
      continue;
    }
    turns.push({ seq: ordinal, turn: read.turn });
  }
  if (!headerSeen) throw new RetainedArchiveDecodeError("archive_header_mismatch");
  return {
    encoding,
    storedBytes: stored.length,
    decodedBytes: decoded.length,
    sha256: declaredSha,
    records,
    turns,
    skippedParts,
    skippedEventTypes,
  };
}

/**
 * session_transcript_archives：会话（含已删除窗口）及其脱敏文本历史。
 * 归档正文始终按只读处理；工具名、参数摘要、输出只作为文本留存，不重放执行。
 */
function parseRetainedArchives(
  image: SqliteImage,
  label: string,
  databasePath: string,
  agentId: string,
  sessionKeys: Map<string, string>,
  knownSessionKeys: ReadonlySet<string>,
  warnings: WarningCollector,
  counters: Counters,
  budget: RetainedArchiveBudget,
): MigrationItem[] {
  if (!hasTable(image, "session_transcript_archives")) return [];
  const columns = readRows(image, "PRAGMA table_info(session_transcript_archives)", [], label).map((row) =>
    String(row.name),
  );
  const required = [
    "session_id",
    "generation",
    "session_key",
    "reason",
    "encoding",
    "archive_blob",
    "archive_sha256",
    "archive_name",
    "created_at",
  ];
  const missing = required.filter((name) => !columns.includes(name));
  if (missing.length > 0) {
    warnings.add(`retained_archive_columns_missing:${databasePath}:${missing.join("+")}`);
    return [];
  }
  const safeColumns = ["session_key", "reason", "encoding", "archive_sha256", "created_at", "published_at"].filter(
    (name) => columns.includes(name),
  );
  const omittedColumns = columns.filter(
    (name) => !["session_id", "generation", "archive_name", "archive_blob", ...safeColumns].includes(name),
  );
  const rows = readRows(
    image,
    `SELECT session_id, generation, archive_name${safeColumns.map((name) => `, ${name}`).join("")}
       FROM session_transcript_archives
      ORDER BY session_id ASC, generation ASC`,
    [],
    label,
  );
  const items: MigrationItem[] = [];
  const emittedSessionKeys = new Set<string>();
  let archives = 0;
  let bodyDecoded = 0;
  let bodyUndecodable = 0;
  let decodedMessages = 0;
  let malformed = 0;
  for (const row of rows) {
    const sessionId = typeof row.session_id === "string" && row.session_id.length > 0 ? row.session_id : undefined;
    const generation = typeof row.generation === "string" && row.generation.length > 0 ? row.generation : undefined;
    const archiveName = typeof row.archive_name === "string" && row.archive_name.length > 0 ? row.archive_name : undefined;
    if (!sessionId || !generation || !archiveName) {
      malformed += 1;
      continue;
    }
    const sessionKey = typeof row.session_key === "string" ? row.session_key : null;
    const metadata: Record<string, unknown> = {};
    for (const field of safeColumns) metadata[field] = row[field];
    // archive_blob 只用于校验与解码，不复制进迁移计划。
    const losses: Array<{ field: string; reason: string }> = [
      { field: "archive_blob", reason: "archive_field_not_retained" },
      ...omittedColumns.map((field) => ({ field, reason: "archive_field_not_retained" })),
    ];
    const itemWarnings: string[] = ["retained_archive_requires_review"];
    let evidence: Record<string, unknown> | null = null;
    let decodedSummary: Record<string, unknown> | null = null;
    let bodyAvailable = false;
    let bodyDecodedFlag = false;
    const messageItems: MigrationItem[] = [];
    try {
      const decoded = decodeRetainedArchive(image, label, row, sessionId, generation, budget);
      bodyAvailable = true;
      bodyDecodedFlag = true;
      bodyDecoded += 1;
      decodedMessages += decoded.turns.length;
      const skippedEvents = [...decoded.skippedEventTypes.values()].reduce((total, count) => total + count, 0);
      evidence = {
        storage: "sqlite",
        encoding: decoded.encoding,
        bytes: decoded.storedBytes,
        decodedBytes: decoded.decodedBytes,
        sha256: decoded.sha256,
      };
      decodedSummary = {
        records: decoded.records,
        messages: decoded.turns.length,
        skippedEvents,
      };
      for (const entry of decoded.turns) {
        messageItems.push(
          transcriptMessageItem(entry.turn, {
            agentId,
            sessionKey: sessionKey ?? sessionKeys.get(sessionId) ?? null,
            sessionId,
            generation,
            origin: "retained_archive",
            seq: entry.seq,
            sourceIdPrefix: "retained_message",
            counters,
          }),
        );
      }
      for (const [partType, count] of decoded.skippedParts) {
        countCategory(counters.skippedParts, partType, count);
      }
      for (const [eventType, count] of decoded.skippedEventTypes) {
        countCategory(counters.skippedEventTypes, eventType, count);
      }
      if (messageItems.length > 0) itemWarnings.push("retained_archive_history_imported");
    } catch (error) {
      if (!(error instanceof RetainedArchiveDecodeError)) throw error;
      bodyAvailable = error.code !== "archive_blob_missing";
      bodyUndecodable += 1;
      itemWarnings.push(`retained_archive_undecodable:${error.code}`);
      losses.push({ field: "archive_body.messages", reason: error.code });
    }
    archives += 1;
    items.push({
      sourceId: `retained_archive:${agentId}:${sessionId}:${generation}`,
      type: "archive",
      content: {
        agentId,
        sessionId,
        sessionKey,
        generation,
        reason: row.reason,
        archiveName,
        encoding: row.encoding,
        metadata,
        imported: false,
        readOnly: true,
        bodyAvailable,
        bodyDecoded: bodyDecodedFlag,
        body: evidence,
        decoded: decodedSummary,
        losses,
      },
      warnings: itemWarnings,
    });
    for (const message of messageItems) items.push(message);
    // 归档窗口常已从活动表移除；补只读会话项，保证历史可检索、可加入延续上下文。
    const archivedKey = sessionKey ?? sessionKeys.get(sessionId);
    if (archivedKey && !knownSessionKeys.has(archivedKey) && !emittedSessionKeys.has(archivedKey)) {
      emittedSessionKeys.add(archivedKey);
      items.push({
        sourceId: `session:${agentId}:${archivedKey}`,
        type: "session",
        content: { agentId, sessionKey: archivedKey, sessionId, archived: true, origin: "transcript_archive", readOnly: true },
        warnings: ["retained_archive_requires_review"],
      });
    }
  }
  if (archives > 0) warnings.add(`retained_archive_items:${databasePath}:${archives}`);
  if (bodyDecoded > 0) warnings.add(`retained_archive_body_decoded:${databasePath}:${bodyDecoded}`);
  if (bodyUndecodable > 0) warnings.add(`retained_archive_body_undecodable:${databasePath}:${bodyUndecodable}`);
  if (decodedMessages > 0) warnings.add(`retained_archive_messages:${databasePath}:${decodedMessages}`);
  if (malformed > 0) warnings.add(`retained_archive_rows_malformed:${databasePath}:${malformed}`);
  if (budget.exhausted && !budget.exhaustedReported) {
    budget.exhaustedReported = true;
    warnings.add(`retained_archive_decode_budget_exhausted:${databasePath}`);
  }
  return items;
}

function openClawAgentIds(files: NormalizedFiles): Array<{ agentId: string; path: string }> {
  const pattern = /(?:^|\/)agents\/([^/]+)\/agent\/openclaw-agent\.sqlite$/;
  const found: Array<{ agentId: string; path: string }> = [];
  for (const path of [...files.keys()].sort()) {
    const match = pattern.exec(path);
    if (match?.[1]) found.push({ agentId: match[1], path });
  }
  return found;
}

function legacyOpenClawTranscripts(files: NormalizedFiles): string[] {
  return [...files.keys()]
    .filter((path) => /(?:^|\/)(?:sessions?\/[^/]*\.jsonl|sessions?\.jsonl)$/i.test(path))
    .sort();
}

const ARCHIVED_MESSAGE_ORIGINS: ReadonlySet<string> = new Set(["cold_archive", "retained_archive"]);

/** 归档窗口属于同一会话的较早历史；让其在消息顺序上先于当前活动消息。 */
function orderArchivedMessages(items: MigrationItem[]): void {
  const cold: MigrationItem[] = [];
  const rest: MigrationItem[] = [];
  for (const item of items) {
    const origin = item.type === "message" ? (item.content as { origin?: unknown }).origin : undefined;
    if (typeof origin === "string" && ARCHIVED_MESSAGE_ORIGINS.has(origin)) {
      cold.push(item);
    } else {
      rest.push(item);
    }
  }
  if (cold.length === 0) return;
  const firstMessage = rest.findIndex((item) => item.type === "message");
  const limit = firstMessage < 0 ? rest.length : firstMessage;
  const ordered: MigrationItem[] = [];
  for (let index = 0; index < limit; index += 1) ordered.push(rest[index]!);
  for (const item of cold) ordered.push(item);
  for (let index = limit; index < rest.length; index += 1) ordered.push(rest[index]!);
  items.length = 0;
  for (const item of ordered) items.push(item);
}

/**
 * 解析 OpenClaw 静态备份。
 *
 * 只支持写 agents/<id>/agent/openclaw-agent.sqlite（agent schema 41）的版本；
 * 仅有 JSONL 的旧布局会被明确拒绝，不会当作"已完整支持"。
 */
export function parseOpenClaw(files: Map<string, Buffer>, instanceId: string): MigrationInventory {
  assertInstanceId(instanceId);
  const view = normalizeFiles(files);
  const warnings = new WarningCollector();
  const counters = newCounters();
  const disposers: Array<() => void> = [];
  const items: MigrationItem[] = [];
  const coldBudget: ColdArchiveBudget = { decodedBytes: 0, events: 0, exhausted: false, exhaustedReported: false };
  const retainedBudget: RetainedArchiveBudget = {
    decodedBytes: 0,
    records: 0,
    exhausted: false,
    exhaustedReported: false,
  };

  try {
    for (const sensitivePath of reportSensitiveFiles(view, warnings)) {
      items.push(credentialFileItem("openclaw", sensitivePath));
    }
    const legacy = legacyOpenClawTranscripts(view);
    const databases = openClawAgentIds(view);
    if (databases.length === 0) {
      if (legacy.length > 0) {
        fail(
          "SOURCE_LAYOUT_UNSUPPORTED",
          `只找到 ${legacy.length} 个 OpenClaw legacy JSONL 转录文件（如 ${legacy[0]}）。` +
            "已验证的版本把会话权威源放在 agents/<id>/agent/openclaw-agent.sqlite（agent schema 41）；" +
            "JSONL 不是当前版本的完整会话源，本解析器拒绝把它当作成功导入。请从来源生成包含该 SQLite 的备份。",
        );
      }
      fail(
        "SOURCE_DB_MISSING",
        "未找到 agents/<id>/agent/openclaw-agent.sqlite。请提供 OpenClaw 完整备份或显式选取状态目录/工作区目录。",
      );
    }
    if (legacy.length > 0) warnings.add(`legacy_jsonl_ignored:${legacy.length}`);

    let totalMessages = 0;
    const sourceSchemas=new Set<number>();
    for (const database of databases) {
      const image = openSqliteImage(view, database.path);
      disposers.push(image.dispose);
      const label = `OpenClaw agent 数据库 ${database.path}`;
      for (const warning of image.warnings) warnings.add(warning);
      requireTables(image, label, [
        "schema_meta",
        "session_nodes",
        "session_windows",
        "transcript_events",
        "session_transcript_active_events",
      ]);

      const meta = readRows(
        image,
        "SELECT meta_key, role, schema_version, agent_id, app_version FROM schema_meta WHERE meta_key = 'primary'",
        [],
        label,
      )[0];
      if (!meta) {
        fail(
          "SOURCE_DB_UNSUPPORTED_SCHEMA",
          `${label} 的 schema_meta 缺少 meta_key='primary' 记录；无法确认 agent schema 版本`,
        );
      }
      if (meta.role !== "agent") {
        fail(
          "SOURCE_DB_WRONG_ROLE",
          `${label} 的 schema_meta.role=${String(meta.role)}，不是 agent 数据库；` +
            "请确认没有把 OpenClaw state 数据库当作 agent 数据库传入",
        );
      }
      if (meta.schema_version !== OPENCLAW_AGENT_SCHEMA_VERSION && meta.schema_version !== 27) {
        fail(
          "SOURCE_DB_UNSUPPORTED_SCHEMA",
          `${label} 的 agent schema 版本为 ${String(meta.schema_version)}，已验证版本为 ${OPENCLAW_AGENT_SCHEMA_VERSION}；` +
            "未知版本不会被猜测性解析",
        );
      }
      sourceSchemas.add(Number(meta.schema_version));
      const metaAgentId = typeof meta.agent_id === "string" && meta.agent_id.length > 0 ? meta.agent_id : null;
      if (!metaAgentId) warnings.add(`agent_id_missing:${database.path}`);
      if (metaAgentId && metaAgentId !== database.agentId) {
        warnings.add(`agent_id_directory_mismatch:${database.path}:${metaAgentId}`);
      }
      const agentId = metaAgentId ?? database.agentId;

      const activeMessageCount = readScalar(
        image,
        "SELECT count(*) FROM session_transcript_active_events WHERE message_position IS NOT NULL",
        [],
        label,
      );
      if (typeof activeMessageCount === "number") {
        totalMessages += activeMessageCount;
        enforceItemBudget(totalMessages, label);
      }

      const sessions = readRows(
        image,
        `SELECT session_key, current_session_id, label, display_name, status, created_at, updated_at,
                last_activity_at, parent_session_key, created_via, archived_at
           FROM session_nodes
          ORDER BY updated_at DESC, session_key ASC`,
        [],
        label,
      );
      const windowsByKey = new Map<string, Record<string, unknown>[]>();
      const sessionKeysById = new Map<string, string>();
      for (const session of sessions) {
        const sessionKey = typeof session.session_key === "string" ? session.session_key : undefined;
        if (!sessionKey) continue;
        const windows = readRows(
          image,
          `SELECT session_id, created_at, previous_session_id, reason, display_name, started_at, ended_at
             FROM session_windows
            WHERE session_key = ?
            ORDER BY created_at ASC, session_id ASC`,
          [sessionKey],
          label,
        );
        windowsByKey.set(sessionKey, windows);
        for (const window of windows) {
          const windowSessionId = typeof window.session_id === "string" ? window.session_id : undefined;
          if (windowSessionId) sessionKeysById.set(windowSessionId, sessionKey);
        }
        items.push({
          sourceId: `session:${agentId}:${sessionKey}`,
          type: "session",
          content: {
            agentId,
            sessionKey,
            currentSessionId: session.current_session_id,
            label: session.label,
            displayName: session.display_name,
            status: session.status,
            createdVia: session.created_via,
            parentSessionKey: session.parent_session_key,
            archived: typeof session.archived_at === "number",
            windowCount: windows.length,
          },
          sourceTime: toIsoTimestamp(session.created_at) ?? toIsoTimestamp(session.updated_at),
        });
      }

      for (const session of sessions) {
        const sessionKey = typeof session.session_key === "string" ? session.session_key : undefined;
        if (!sessionKey) continue;
        const windows = windowsByKey.get(sessionKey) ?? [];
        for (const window of windows) {
          const sessionId = typeof window.session_id === "string" ? window.session_id : undefined;
          if (!sessionId) continue;
          const rows = readRows(
            image,
            `SELECT a.message_position AS position, e.seq AS seq, e.created_at AS created_at,
                    e.event_json AS event_json, e.event_zstd AS event_zstd
               FROM session_transcript_active_events a
               JOIN transcript_events e ON e.session_id = a.session_id AND e.seq = a.event_seq
              WHERE a.session_id = ? AND a.message_position IS NOT NULL
              ORDER BY a.message_position ASC`,
            [sessionId],
            label,
          );
          for (const row of rows) {
            const raw = decodeOpenClawEvent(row);
            if (raw === null) {
              counters.undecodable += 1;
              continue;
            }
            const seq = typeof row.seq === "number" ? row.seq : null;
            if (seq === null) continue;
            const read = readOpenClawEvent(raw);
            if (read.kind === "invalid") {
              counters.undecodable += 1;
              continue;
            }
            if (read.kind === "event") {
              counters.nonChat += 1;
              countCategory(counters.skippedEventTypes, read.eventType);
              for (const partType of read.parts) countCategory(counters.skippedParts, partType);
              continue;
            }
            // Tool/System 文本只读保留；工具名与参数摘要只作为文本，永不重放。
            const item = transcriptMessageItem(read.turn, {
              agentId,
              sessionKey,
              sessionId,
              origin: "active",
              seq,
              sourceIdPrefix: "message",
              counters,
            });
            if (item.sourceTime === undefined) item.sourceTime = toIsoTimestamp(row.created_at);
            items.push(item);
          }
        }
      }
      // 冷归档在通过配额/哈希/计数校验后才解码正文；失败逐项报告固定原因码。
      for (const item of parseColdArchives(view, image, label, database.path, agentId, sessionKeysById, warnings, counters, coldBudget)) {
        items.push(item);
      }
      // session_transcript_archives：identity/zstd 都先校验 sha256，再解码为只读文本历史。
      const knownSessionKeys = new Set(
        sessions
          .map((session) => session.session_key)
          .filter((key): key is string => typeof key === "string" && key.length > 0),
      );
      for (const item of parseRetainedArchives(
        image,
        label,
        database.path,
        agentId,
        sessionKeysById,
        knownSessionKeys,
        warnings,
        counters,
        retainedBudget,
      )) {
        items.push(item);
      }
    }

    // 工作区文档：只接受已知文件名，且必须位于 workspace 段下或输入根目录。
    const docNames = new Set(["AGENTS.md", "SOUL.md", "USER.md", "MEMORY.md", "IDENTITY.md"]);
    for (const path of [...view.keys()].sort()) {
      const name = basename(path);
      if (!docNames.has(name)) continue;
      const inWorkspace = /(?:^|\/)workspace\//.test(path);
      if (!inWorkspace && depth(path) !== 1) continue;
      const buffer = view.get(path);
      if (!buffer) continue;
      const item: MigrationItem = {
        sourceId: `doc:${path}`,
        type: name === "MEMORY.md" || name === "USER.md" ? "memory" : "instruction",
        content: { path, text: "" },
      };
      const { text, truncated } = readDocText(buffer);
      const redacted = applyRedaction(text, item, counters);
      (item.content as Record<string, unknown>).text = capText(redacted, item, counters);
      if (truncated) {
        item.warnings = [...(item.warnings ?? []), "document_truncated"];
        warnings.add(`document_truncated:${path}`);
      }
      items.push(item);
    }

    for (const skill of collectSkills(view, warnings)) {
      const item: MigrationItem = {
        sourceId: `skill:${skill.skillPath}`,
        type: "skill",
        content: { path: skill.skillPath, text: "" },
      };
      const { text, truncated } = readDocText(skill.buffer);
      const redacted = applyRedaction(text, item, counters);
      (item.content as Record<string, unknown>).text = capText(redacted, item, counters);
      (item.content as Record<string, unknown>).name = readSkillName(text) ?? null;
      (item.content as Record<string, unknown>).files = skill.files;
      if (truncated) item.warnings = [...(item.warnings ?? []), "document_truncated"];
      item.warnings = [...(item.warnings ?? []), "skill_not_enabled"];
      items.push(item);
    }

    for (const path of [...view.keys()].sort()) {
      if (basename(path) !== "jobs.json" || !/(?:^|\/)cron\/jobs\.json$/.test(path)) continue;
      items.push(...parseCronStore(view, path, warnings, counters));
    }

    for (const path of [...view.keys()].sort()) {
      if (basename(path).toLowerCase() !== "openclaw.json" || depth(path) > 3) continue;
      items.push(...parseConfigInventory(view, path, "openclaw", warnings, counters));
    }

    orderArchivedMessages(items);
    enforceItemBudget(items.length, "OpenClaw");
    for(const item of items)item.content=redactItemContent(item.content,item,counters);
    pushLossWarnings(warnings, counters);
    return {
      system: "openclaw",
      instanceId,
      version: `openclaw:agent-schema-${[...sourceSchemas].sort((a,b)=>a-b).join("+")}`,
      items,
      warnings: warnings.finalize(),
    };
  } finally {
    for (const dispose of disposers.reverse()) dispose();
  }
}

/** Hermes 的 tool_calls 保留工具名与参数摘要；参数只作为文本，永不执行。 */
function parseHermesToolCalls(value: unknown): {
  names: string[];
  toolName?: string;
  argumentsSummary?: string;
} {
  let parsed: unknown = value;
  if (typeof value === "string") {
    if (value.trim().length === 0) return { names: [] };
    parsed = safeJson(value);
    if (parsed === undefined) return { names: [] };
  }
  if (!Array.isArray(parsed)) return { names: [] };
  const calls: Array<{ name: string; arguments?: unknown }> = [];
  for (const entry of parsed) {
    const record = asRecord(entry);
    if (!record) continue;
    const fn = asRecord(record.function);
    const name =
      typeof fn?.name === "string" ? fn.name : typeof record.name === "string" ? record.name : undefined;
    if (name === undefined || name.length === 0) continue;
    calls.push({ name, arguments: fn?.arguments ?? record.arguments });
  }
  const summary = summarizeToolCalls(calls);
  return {
    names: summary.names,
    ...(summary.names[0] === undefined ? {} : { toolName: summary.names[0] }),
    ...(summary.argumentsSummary === undefined ? {} : { argumentsSummary: summary.argumentsSummary }),
  };
}

/** Hermes content 可能是字符串、JSON 数组字符串或 parts 数组。 */
function parseHermesContent(value: unknown): { text?: string; skipped: string[] } {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
      const parsed = safeJson(trimmed);
      if (parsed !== undefined) {
        const content = parseOpenClawContent(parsed);
        return {
          ...(content.text === undefined ? {} : { text: content.text }),
          skipped: content.skipped,
        };
      }
    }
    return trimmed.length > 0 ? { text: trimmed, skipped: [] } : { skipped: [] };
  }
  const content = parseOpenClawContent(
    Array.isArray(value) ? value : value !== null && typeof value === "object" ? [value] : value,
  );
  return { ...(content.text === undefined ? {} : { text: content.text }), skipped: content.skipped };
}

/** 解析 Hermes ~/.hermes 导出；state.db 必须是 schema 33 的一致性快照。 */
export function parseHermes(files: Map<string, Buffer>, instanceId: string): MigrationInventory {
  assertInstanceId(instanceId);
  const view = normalizeFiles(files);
  const warnings = new WarningCollector();
  const counters = newCounters();
  const disposers: Array<() => void> = [];
  const items: MigrationItem[] = [];

  try {
    for (const sensitivePath of reportSensitiveFiles(view, warnings)) {
      items.push(credentialFileItem("hermes", sensitivePath));
    }
    const databases = [...view.keys()].filter((path) => path === "state.db" || path.endsWith("/state.db"));
    if (databases.length === 0) {
      const routingIndex = [...view.keys()].some((path) => /(?:^|\/)sessions\/sessions\.json$/.test(path));
      fail(
        "SOURCE_DB_MISSING",
        routingIndex
          ? "只找到 sessions/sessions.json。它是 Gateway 路由索引，不是完整会话历史；请提供 Hermes state.db 的一致性快照。"
          : "未找到 Hermes state.db。请提供 ~/.hermes 的离线导出或只读副本。",
      );
    }
    if (databases.length > 1) {
      const profiles = databases.filter((path) => /^profiles\/[^/]+\/state\.db$/.test(path));
      if (profiles.length === databases.length) {
        fail(
          "SOURCE_LAYOUT_AMBIGUOUS",
          `发现多个 profile 的 state.db（${databases.join(", ")}）；请一次只选择一个 profile。`,
        );
      }
      fail("SOURCE_LAYOUT_AMBIGUOUS", `发现多个 state.db（${databases.join(", ")}）；无法确定主数据源。`);
    }
    const databasePath = databases[0] as string;
    const image = openSqliteImage(view, databasePath);
    disposers.push(image.dispose);
    const label = `Hermes 数据库 ${databasePath}`;
    for (const warning of image.warnings) warnings.add(warning);
    requireTables(image, label, ["schema_version", "sessions", "messages"]);

    const version = readScalar(image, "SELECT version FROM schema_version LIMIT 1", [], label);
    if (version !== HERMES_STATE_SCHEMA_VERSION && version !== 32) {
      fail(
        "SOURCE_DB_UNSUPPORTED_SCHEMA",
        `${label} 的 schema_version=${String(version)}，已验证版本为 ${HERMES_STATE_SCHEMA_VERSION}；` +
          "未知版本不会被猜测性解析，请先用已验证的 Hermes 版本升级/导出",
      );
    }

    const routingIndex = [...view.keys()].filter((path) => /(?:^|\/)sessions\/sessions\.json$/.test(path));
    if (routingIndex.length > 0) warnings.add("sessions_json_is_routing_index_not_session_list");
    const logFiles = [...view.keys()].filter((path) => /(?:^|\/)logs\//.test(path));
    if (logFiles.length > 0) warnings.add(`logs_skipped:${logFiles.length}`);

    const sessionCount = readScalar(image, "SELECT count(*) FROM sessions", [], label);
    const messageCount = readScalar(image, "SELECT count(*) FROM messages WHERE active = 1", [], label);
    enforceItemBudget(
      (typeof sessionCount === "number" ? sessionCount : 0) + (typeof messageCount === "number" ? messageCount : 0),
      label,
    );

    const sessions = readRows(
      image,
      `SELECT id, source, display_name, title, model, started_at, ended_at, message_count,
              archived, pinned, parent_session_id
         FROM sessions
        ORDER BY started_at ASC, id ASC`,
      [],
      label,
    );
    for (const session of sessions) {
      const id = typeof session.id === "string" ? session.id : undefined;
      if (!id) continue;
      items.push({
        sourceId: `session:${id}`,
        type: "session",
        content: {
          id,
          source: session.source,
          title: session.title,
          displayName: session.display_name,
          model: session.model,
          startedAt: toIsoTimestamp(session.started_at),
          endedAt: toIsoTimestamp(session.ended_at),
          messageCount: session.message_count,
          archived: session.archived === 1,
          pinned: session.pinned === 1,
          parentSessionId: session.parent_session_id,
        },
        sourceTime: toIsoTimestamp(session.started_at),
      });

      const messages = readRows(
        image,
        `SELECT id, role, content, tool_calls, tool_name, timestamp, compacted
           FROM messages
          WHERE session_id = ? AND active = 1
          ORDER BY timestamp ASC, id ASC`,
        [id],
        label,
      );
      for (const message of messages) {
        const messageId = typeof message.id === "number" ? message.id : undefined;
        if (messageId === undefined) continue;
        const role = typeof message.role === "string" ? message.role.toLowerCase() : "";
        const itemWarnings: string[] = [];
        if (message.compacted === 1) itemWarnings.push("compacted_message");
        const baseContent: Record<string, unknown> = { sessionId: id, messageId, role };
        const content = parseHermesContent(message.content);
        // 未知非文本逐类上报，例如 image/audio/thinking。
        for (const partType of content.skipped) countCategory(counters.skippedParts, partType);
        if (role === "system") {
          // System 文本保留但只读：它可以作为背景，不构成指令或授权。
          if (content.text === undefined) {
            counters.nonChat += 1;
            countCategory(counters.skippedEventTypes, "system_without_text");
            continue;
          }
          counters.systemRetained += 1;
          baseContent.readOnly = true;
          baseContent.executable = false;
          itemWarnings.push("system_text_readonly");
          const item: MigrationItem = {
            sourceId: `message:${messageId}`,
            type: "message",
            content: baseContent,
            sourceTime: toIsoTimestamp(message.timestamp),
            warnings: itemWarnings,
          };
          baseContent.text = capText(applyRedaction(content.text, item, counters), item, counters);
          items.push(item);
          continue;
        }
        if (role === "tool") {
          // Tool 输出保留为只读文本，工具名保留；绝不重放执行。
          counters.toolRetained += 1;
          if (typeof message.tool_name === "string" && message.tool_name.length > 0) {
            baseContent.toolName = message.tool_name;
          }
          baseContent.readOnly = true;
          baseContent.executable = false;
          itemWarnings.push("tool_output_readonly", "tool_execution_not_replayed");
          const item: MigrationItem = {
            sourceId: `message:${messageId}`,
            type: "message",
            content: baseContent,
            sourceTime: toIsoTimestamp(message.timestamp),
            warnings: itemWarnings,
          };
          if (content.text !== undefined) {
            baseContent.text = capText(applyRedaction(content.text, item, counters), item, counters);
          }
          items.push(item);
          continue;
        }
        const toolCalls = parseHermesToolCalls(message.tool_calls);
        if (content.text === undefined && toolCalls.names.length === 0) {
          counters.nonChat += 1;
          countCategory(counters.skippedEventTypes, role.length > 0 ? `role_${role}_without_text` : "message_without_text");
          continue;
        }
        const item: MigrationItem = {
          sourceId: `message:${messageId}`,
          type: "message",
          content: baseContent,
          sourceTime: toIsoTimestamp(message.timestamp),
          warnings: itemWarnings,
        };
        if (content.text !== undefined) {
          baseContent.text = capText(applyRedaction(content.text, item, counters), item, counters);
        }
        if (toolCalls.names.length > 0) {
          baseContent.toolCalls = toolCalls.names;
          if (toolCalls.toolName !== undefined) baseContent.toolName = toolCalls.toolName;
          if (toolCalls.argumentsSummary !== undefined) {
            baseContent.argumentsSummary = capText(
              applyRedaction(toolCalls.argumentsSummary, item, counters),
              item,
              counters,
            );
          }
          baseContent.readOnly = true;
          itemWarnings.push("tool_arguments_readonly", "tool_execution_not_replayed");
        }
        items.push(item);
      }
    }

    // 记忆与指令文档：原文留存，只做确定性密钥脱敏。
    for (const path of [...view.keys()].sort()) {
      const name = basename(path);
      const isMemory = /(?:^|\/)memories\/[^/]+\.md$/.test(path);
      const isInstruction =
        path === "SOUL.md" || path === "AGENTS.md" || /(?:^|\/)workspace\/(?:SOUL|AGENTS)\.md$/.test(path);
      if (!isMemory && !isInstruction) continue;
      const buffer = view.get(path);
      if (!buffer) continue;
      const item: MigrationItem = {
        sourceId: `doc:${path}`,
        type: isMemory ? "memory" : "instruction",
        content: { path, text: "" },
      };
      const { text, truncated } = readDocText(buffer);
      const redacted = applyRedaction(text, item, counters);
      (item.content as Record<string, unknown>).text = capText(redacted, item, counters);
      if (truncated) {
        item.warnings = [...(item.warnings ?? []), "document_truncated"];
        warnings.add(`document_truncated:${path}`);
      }
      if (isMemory && name !== "MEMORY.md" && name !== "USER.md") {
        item.warnings = [...(item.warnings ?? []), "unknown_memory_file"];
      }
      items.push(item);
    }

    for (const skill of collectSkills(view, warnings)) {
      const item: MigrationItem = {
        sourceId: `skill:${skill.skillPath}`,
        type: "skill",
        content: { path: skill.skillPath, text: "" },
      };
      const { text, truncated } = readDocText(skill.buffer);
      const redacted = applyRedaction(text, item, counters);
      (item.content as Record<string, unknown>).text = capText(redacted, item, counters);
      (item.content as Record<string, unknown>).name = readSkillName(text) ?? null;
      (item.content as Record<string, unknown>).files = skill.files;
      if (truncated) item.warnings = [...(item.warnings ?? []), "document_truncated"];
      item.warnings = [...(item.warnings ?? []), "skill_not_enabled"];
      items.push(item);
    }

    for (const path of [...view.keys()].sort()) {
      if (basename(path) !== "jobs.json" || !/(?:^|\/)cron\/jobs\.json$/.test(path)) continue;
      items.push(...parseCronStore(view, path, warnings, counters));
    }

    for (const path of [...view.keys()].sort()) {
      if (!/^config\.ya?ml$/i.test(path)) continue;
      items.push(...parseConfigInventory(view, path, "hermes", warnings, counters));
    }

    enforceItemBudget(items.length, "Hermes");
    for(const item of items)item.content=redactItemContent(item.content,item,counters);
    pushLossWarnings(warnings, counters);
    return {
      system: "hermes",
      instanceId,
      version: `hermes:state-schema-${String(version)}`,
      items,
      warnings: warnings.finalize(),
    };
  } finally {
    for (const dispose of disposers.reverse()) dispose();
  }
}
