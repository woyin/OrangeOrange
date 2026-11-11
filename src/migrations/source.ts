/**
 * 迁移安全输入模块（MIG-002/003/011、NFR-021）。
 *
 * 安全模型：
 * - 所有目录输入必须落在服务端显式配置的只读挂载根内。根路径与输入路径都先 realpath，
 *   越界（含符号链接指向根外）直接拒绝。
 * - 扫描期间绝不跟随符号链接；符号链接条目只记录、不读取，可由策略改为整包拒绝。
 * - 严格模式校验根目录及其嵌套挂载均为只读；挂载表变化仍需部署环境限制。
 * - 每个文件以 O_RDONLY | O_NOFOLLOW | O_NONBLOCK 打开，并用 fstat 的 dev/ino/size
 *   与 lstat 结果比对，检测扫描后的替换或截断。
 * - ZIP 只解析中央目录；路径规范化后拒绝绝对路径、盘符、反斜杠、..、空段、控制字符和重复项。
 * - 配额同时约束条目数、单条大小、总量、压缩比、路径长度、目录深度和压缩包自身大小。
 * - 所有内容在扫描时计算 SHA-256；读取时重新校验大小、CRC32（ZIP）和 SHA-256。
 * - 本模块只读：不创建、不修改、不删除任何来源文件，不安装依赖，不执行来源脚本。
 */

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, readFile, realpath, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { crc32, createInflateRaw } from "node:zlib";

export type SourceErrorCode =
  | "INVALID_INPUT"
  | "PATH_UNSAFE"
  | "LINK_BLOCKED"
  | "QUOTA_EXCEEDED"
  | "UNSUPPORTED_FORMAT"
  | "CORRUPT_ARCHIVE"
  | "HASH_MISMATCH"
  | "SOURCE_CHANGED"
  | "MOUNT_NOT_READ_ONLY"
  | "IO_ERROR";

export class MigrationSourceError extends Error {
  readonly code: SourceErrorCode;

  constructor(code: SourceErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "MigrationSourceError";
    this.code = code;
  }
}

export type SourceMountId = "directory" | "workspace" | "archive";
export type SourceEntryKind = "file" | "directory" | "symlink" | "other";
export type SourceWarningCode =
  | "symlink-skipped"
  | "hard-link"
  | "unsupported-entry";

export interface SourceLimits {
  /** 文件与目录条目总数上限。 */
  maxEntries: number;
  /** 全部文件解压/读取后的总字节上限。 */
  maxTotalBytes: number;
  /** 单个文件字节上限。 */
  maxEntryBytes: number;
  /** ZIP 上传包自身字节上限。 */
  maxArchiveBytes: number;
  /** 单条目的最大解压/压缩比（仅对解压后大于 1 MiB 的条目生效）。 */
  maxCompressionRatio: number;
  /** 相对路径的目录深度上限（按分段计数）。 */
  maxDepth: number;
  /** 相对路径 UTF-8 字符长度上限。 */
  maxPathLength: number;
  /** readText 默认字节上限。 */
  maxTextBytes: number;
}

export const DEFAULT_SOURCE_LIMITS: Readonly<SourceLimits> = Object.freeze({
  maxEntries: 20_000,
  maxTotalBytes: 512 * 1024 * 1024,
  maxEntryBytes: 128 * 1024 * 1024,
  maxArchiveBytes: 512 * 1024 * 1024,
  maxCompressionRatio: 100,
  maxDepth: 32,
  maxPathLength: 1024,
  maxTextBytes: 8 * 1024 * 1024,
});

export interface SourcePolicy {
  /** 符号链接策略：skip 只记录并跳过，reject 直接拒绝整个来源。 */
  links: "skip" | "reject";
}

export type ReadOnlyStatus =
  | "read-only"
  | "read-write"
  | "unknown"
  | "not-applicable";

export interface ReadOnlyMountEvidence {
  status: ReadOnlyStatus;
  source: "linux-mountinfo" | "unavailable" | "archive";
  mountPoint?: string;
  mountOptions?: string;
  detail: string;
}

export interface SourceMount {
  id: SourceMountId;
  requestedPath: string | null;
  configuredRoot: string | null;
  resolvedPath: string | null;
  resolvedRoot: string | null;
  deviceId: number | null;
  containment: "realpath-inside-allowed-root" | "archive-paths-normalized";
  entries: number;
  bytes: number;
  readOnly: ReadOnlyMountEvidence;
}

export interface SourceEntry {
  mount: SourceMountId;
  /** 规范化后的 POSIX 相对路径，不含前导 ./ 或尾部 /。 */
  path: string;
  kind: SourceEntryKind;
  /** 普通文件的字节数；其他类型为 0。 */
  size: number;
  /** 普通文件的 SHA-256（小写十六进制）；其他类型为 null。 */
  sha256: string | null;
}

export type SourceEntryRef = Pick<SourceEntry, "mount" | "path">;

export interface SourceWarning {
  code: SourceWarningCode;
  mount: SourceMountId;
  path: string;
  detail: string;
}

export interface ReadEntryOptions {
  /** 本次读取的字节上限，不会超过调用场景对应的配额。 */
  maxBytes?: number;
}

export interface MigrationSource {
  kind: "directory" | "zip";
  mounts: readonly SourceMount[];
  entries: readonly SourceEntry[];
  warnings: readonly SourceWarning[];
  totalBytes: number;
  limits: SourceLimits;
  /** 规范化条目清单的 SHA-256，可用于计划哈希与一致性比对。 */
  manifestHash: string;
  /** 只读取清单中已核验的普通文件；未知条目直接拒绝。 */
  read(entry: SourceEntryRef, options?: ReadEntryOptions): Promise<Buffer>;
  readText(entry: SourceEntryRef, options?: ReadEntryOptions): Promise<string>;
}

export interface ArchiveSourceRequest {
  archive: Buffer;
}

export interface DirectorySourceRequest {
  /** 只读状态目录（或官方备份解包目录）。 */
  directory: string;
  /** 可选的工作区目录，可能位于状态目录之外，但同样必须落在允许根内。 */
  workspace?: string;
}

export type SourceRequest = ArchiveSourceRequest | DirectorySourceRequest;

export interface OpenSourceOptions {
  /** 服务端配置的显式只读挂载根；目录输入必填。 */
  allowedRoots?: readonly string[];
  limits?: Partial<SourceLimits>;
  policy?: Partial<SourcePolicy>;
  /** 为 true 时，目录挂载必须被验证为 ro；未知或 rw 都拒绝。 */
  requireReadOnlyMount?: boolean;
  /** 测试注入：替换 /proc/self/mountinfo 读取。 */
  readMountInfo?: () => Promise<string>;
}

interface DirectoryFileRecord {
  mount: "directory" | "workspace";
  path: string;
  kind: "file";
  size: number;
  sha256: string;
  absolutePath: string;
  rootResolved: string;
  deviceId: number;
  inode: number;
}

interface ZipFileRecord {
  mount: "archive";
  path: string;
  kind: "file";
  size: number;
  sha256: string;
  method: number;
  flags: number;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  dataStart: number;
}

type StoredFileRecord = DirectoryFileRecord | ZipFileRecord;

interface ConfinedRoot {
  requested: string;
  configuredRoot: string;
  resolvedRoot: string;
  resolvedPath: string;
  deviceId: number;
}

const CHUNK_SIZE = 64 * 1024;
const RATIO_FLOOR_BYTES = 1024 * 1024;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const ZIP64_MARKER = 0xffffffff;
const ZIP64_COUNT_MARKER = 0xffff;

function fail(code: SourceErrorCode, message: string, cause?: unknown): never {
  throw new MigrationSourceError(code, message, cause);
}

function invalid(message: string): never {
  fail("INVALID_INPUT", message);
}

function unsafePath(message: string): never {
  fail("PATH_UNSAFE", message);
}

function quota(message: string): never {
  fail("QUOTA_EXCEEDED", message);
}

function corrupt(message: string, cause?: unknown): never {
  fail("CORRUPT_ARCHIVE", message, cause);
}

function unsupported(message: string): never {
  fail("UNSUPPORTED_FORMAT", message);
}

function mapFsError(error: unknown, action: string): MigrationSourceError {
  if (error instanceof MigrationSourceError) return error;
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as NodeJS.ErrnoException).code)
      : "";
  if (code === "ENOENT") {
    return new MigrationSourceError("INVALID_INPUT", `${action}：路径不存在`, error);
  }
  if (code === "EACCES" || code === "EPERM") {
    return new MigrationSourceError("IO_ERROR", `${action}：没有读取权限`, error);
  }
  if (code === "ELOOP") {
    return new MigrationSourceError("LINK_BLOCKED", `${action}：检测到符号链接`, error);
  }
  if (code === "ENAMETOOLONG") {
    return new MigrationSourceError("PATH_UNSAFE", `${action}：路径过长`, error);
  }
  const detail = error instanceof Error ? error.message : "未知文件系统错误";
  return new MigrationSourceError("IO_ERROR", `${action}：${detail}`, error);
}

async function fsCall<T>(action: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw mapFsError(error, action);
  }
}

function resolveLimits(input?: Partial<SourceLimits>): SourceLimits {
  const limits: SourceLimits = { ...DEFAULT_SOURCE_LIMITS, ...input };
  for (const key of Object.keys(DEFAULT_SOURCE_LIMITS) as (keyof SourceLimits)[]) {
    const value = limits[key];
    if (!Number.isSafeInteger(value) || value < 1) {
      invalid(`配额 ${key} 必须是正整数`);
    }
  }
  return limits;
}

function resolvePolicy(input?: Partial<SourcePolicy>): SourcePolicy {
  const policy: SourcePolicy = { links: "skip", ...input };
  if (policy.links !== "skip" && policy.links !== "reject") {
    invalid("符号链接策略只能是 skip 或 reject");
  }
  return policy;
}

function isContained(base: string, candidate: string): boolean {
  const rel = relative(base, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * 规范化 ZIP/清单中的相对路径。拒绝绝对路径、盘符、反斜杠、控制字符、
 * 空段和 ..；丢弃可选的 "." 段与前导 ./。
 */
export function normalizeEntryPath(raw: string): string {
  if (typeof raw !== "string" || raw.length === 0) {
    unsafePath("条目路径不能为空");
  }
  if (raw.includes("\\")) {
    unsafePath("条目路径不得包含反斜杠");
  }
  if (CONTROL_CHARACTERS.test(raw)) {
    unsafePath("条目路径包含控制字符");
  }
  if (raw.startsWith("/")) {
    unsafePath("条目路径不得为绝对路径");
  }
  if (/^[A-Za-z]:/.test(raw)) {
    unsafePath("条目路径不得包含盘符");
  }
  const withoutTrailingSlash = raw.endsWith("/") ? raw.slice(0, -1) : raw;
  const segments: string[] = [];
  for (const segment of withoutTrailingSlash.split("/")) {
    if (segment === "") unsafePath("条目路径包含空段");
    if (segment === ".") continue;
    if (segment === "..") unsafePath("条目路径不得包含 ..");
    segments.push(segment);
  }
  if (segments.length === 0) unsafePath("条目路径为空");
  return segments.join("/");
}

function assertEntryPathLimits(path: string, limits: SourceLimits): void {
  if (path.length > limits.maxPathLength) {
    quota(`条目路径超过 ${limits.maxPathLength} 个字符：${path.slice(0, 80)}…`);
  }
  const depth = path.split("/").length;
  if (depth > limits.maxDepth) {
    quota(`条目路径深度超过 ${limits.maxDepth}：${path}`);
  }
}

function validateEntryName(name: string): void {
  if (!name || name === "." || name === "..") {
    unsafePath("目录中存在非法条目名");
  }
  if (name.includes("/") || name.includes("\\")) {
    unsafePath(`目录条目名包含路径分隔符：${name}`);
  }
  if (CONTROL_CHARACTERS.test(name)) {
    unsafePath("目录条目名包含控制字符");
  }
}

function compareEntries(a: SourceEntry, b: SourceEntry): number {
  if (a.mount !== b.mount) return a.mount < b.mount ? -1 : 1;
  if (a.path === b.path) return 0;
  return a.path < b.path ? -1 : 1;
}

function recordKey(mount: SourceMountId, path: string): string {
  return `${mount}\u0000${path}`;
}

/** 对规范化条目清单计算稳定 SHA-256。 */
export function sourceManifestHash(entries: readonly SourceEntry[]): string {
  const hash = createHash("sha256");
  hash.update("hda-migration-source/1\n");
  for (const entry of [...entries].sort(compareEntries)) {
    hash.update(
      `${entry.mount}\u0000${entry.path}\u0000${entry.kind}\u0000${entry.size}\u0000${
        entry.sha256 ?? ""
      }\n`,
    );
  }
  return hash.digest("hex");
}

async function confineToAllowedRoot(
  requested: unknown,
  allowedRoots: readonly string[] | undefined,
  label: string,
): Promise<ConfinedRoot> {
  if (typeof requested !== "string" || requested.length === 0) {
    invalid(`${label} 必须是非空路径字符串`);
  }
  if (!Array.isArray(allowedRoots) || allowedRoots.length === 0) {
    invalid("目录输入必须提供服务端配置的只读挂载根（allowedRoots）");
  }
  const resolvedPath = await fsCall(`${label} 解析`, () => realpath(resolve(requested)));
  let best: { configuredRoot: string; resolvedRoot: string } | undefined;
  for (const configuredRoot of allowedRoots) {
    if (typeof configuredRoot !== "string" || configuredRoot.length === 0) {
      invalid("allowedRoots 中包含无效路径");
    }
    let resolvedRoot: string;
    try {
      resolvedRoot = await realpath(resolve(configuredRoot));
    } catch {
      continue;
    }
    if (!isContained(resolvedRoot, resolvedPath)) continue;
    if (best === undefined || resolvedRoot.length > best.resolvedRoot.length) {
      best = { configuredRoot, resolvedRoot };
    }
  }
  if (best === undefined) {
    unsafePath(`${label} 不在允许的只读挂载根内`);
  }
  const info = await fsCall(`${label} 状态`, () => stat(resolvedPath));
  if (!info.isDirectory()) {
    invalid(`${label} 必须是目录`);
  }
  return {
    requested,
    configuredRoot: best.configuredRoot,
    resolvedRoot: best.resolvedRoot,
    resolvedPath,
    deviceId: info.dev,
  };
}

async function withVerifiedFile<T>(
  absolutePath: string,
  expected: { deviceId: number; inode: number; size: number },
  action: string,
  run: (handle: FileHandle) => Promise<T>,
): Promise<T> {
  const handle = await fsCall(`${action} 打开`, () =>
    open(
      absolutePath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    ),
  );
  try {
    const info = await fsCall(`${action} 校验`, () => handle.stat());
    if (!info.isFile()) {
      fail("SOURCE_CHANGED", `${action}：目标已不是普通文件`);
    }
    if (info.dev !== expected.deviceId || info.ino !== expected.inode) {
      fail("SOURCE_CHANGED", `${action}：文件在扫描后被替换`);
    }
    if (info.size !== expected.size) {
      fail("SOURCE_CHANGED", `${action}：文件大小在扫描后发生变化`);
    }
    return await run(handle);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function hashDirectoryFile(
  absolutePath: string,
  expected: { deviceId: number; inode: number; size: number },
  limits: SourceLimits,
): Promise<{ sha256: string; bytes: number }> {
  return withVerifiedFile(absolutePath, expected, "读取源文件", async (handle) => {
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(CHUNK_SIZE);
    let total = 0;
    while (true) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, expected.size - total) || buffer.length,
        total,
      );
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > expected.size || total > limits.maxEntryBytes) {
        fail("SOURCE_CHANGED", "读取源文件：文件在读取期间增长");
      }
      hash.update(buffer.subarray(0, bytesRead));
    }
    if (total !== expected.size) {
      fail("SOURCE_CHANGED", "读取源文件：文件在读取期间被截断");
    }
    return { sha256: hash.digest("hex"), bytes: total };
  });
}

async function readDirectoryRecord(
  record: DirectoryFileRecord,
  maxBytes: number,
): Promise<Buffer> {
  if (record.size > maxBytes) {
    quota(`条目超过本次读取上限 ${maxBytes} 字节：${record.path}`);
  }
  const canonical = await fsCall("读取源文件 解析", () =>
    realpath(record.absolutePath),
  );
  if (
    canonical !== record.absolutePath ||
    !isContained(record.rootResolved, canonical)
  ) {
    fail("SOURCE_CHANGED", `文件路径在扫描后发生变化：${record.path}`);
  }
  const result = await withVerifiedFile(
    record.absolutePath,
    record,
    "读取源文件",
    async (handle) => {
      const hash = createHash("sha256");
      const chunks: Buffer[] = [];
      let total = 0;
      while (total < record.size) {
        const buffer = Buffer.allocUnsafe(Math.min(CHUNK_SIZE, record.size - total));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, total);
        if (bytesRead === 0) break;
        total += bytesRead;
        hash.update(buffer.subarray(0, bytesRead));
        chunks.push(buffer.subarray(0, bytesRead));
      }
      if (total !== record.size) {
        fail("SOURCE_CHANGED", `文件在读取期间被截断：${record.path}`);
      }
      if (hash.digest("hex") !== record.sha256) {
        fail("HASH_MISMATCH", `文件内容与扫描哈希不一致：${record.path}`);
      }
      return Buffer.concat(chunks, total);
    },
  );
  return result;
}

async function scanDirectoryMount(
  id: "directory" | "workspace",
  root: ConfinedRoot,
  limits: SourceLimits,
  policy: SourcePolicy,
  warnings: SourceWarning[],
): Promise<{
  entries: SourceEntry[];
  records: Map<string, DirectoryFileRecord>;
  bytes: number;
}> {
  const entries: SourceEntry[] = [];
  const records = new Map<string, DirectoryFileRecord>();
  let bytes = 0;
  let count = 0;
  const pending: Array<{ absolute: string; relative: string }> = [
    { absolute: root.resolvedPath, relative: "" },
  ];
  while (pending.length > 0) {
    const directory = pending.pop() as { absolute: string; relative: string };
    const names = await fsCall("读取目录", () => readdir(directory.absolute));
    names.sort();
    for (const name of names) {
      validateEntryName(name);
      const relativePath = directory.relative
        ? `${directory.relative}/${name}`
        : name;
      assertEntryPathLimits(relativePath, limits);
      count += 1;
      if (count > limits.maxEntries) {
        quota(`条目总数超过 ${limits.maxEntries}`);
      }
      const absolutePath = resolve(directory.absolute, name);
      const info = await fsCall("检查条目", () => lstat(absolutePath));

      if (info.isSymbolicLink()) {
        if (policy.links === "reject") {
          fail("LINK_BLOCKED", `来源包含符号链接：${id}:${relativePath}`);
        }
        warnings.push({
          code: "symlink-skipped",
          mount: id,
          path: relativePath,
          detail: "符号链接不会被跟随或读取",
        });
        entries.push({
          mount: id,
          path: relativePath,
          kind: "symlink",
          size: 0,
          sha256: null,
        });
        continue;
      }

      if (info.isDirectory()) {
        const canonical = await fsCall("解析目录", () => realpath(absolutePath));
        if (!isContained(root.resolvedRoot, canonical)) {
          unsafePath(`目录条目越界：${id}:${relativePath}`);
        }
        const canonicalInfo = await fsCall("检查目录", () => stat(canonical));
        if (
          !canonicalInfo.isDirectory() ||
          canonicalInfo.dev !== info.dev ||
          canonicalInfo.ino !== info.ino
        ) {
          fail("SOURCE_CHANGED", `目录在扫描期间发生变化：${relativePath}`);
        }
        entries.push({
          mount: id,
          path: relativePath,
          kind: "directory",
          size: 0,
          sha256: null,
        });
        pending.push({ absolute: canonical, relative: relativePath });
        continue;
      }

      if (!info.isFile()) {
        warnings.push({
          code: "unsupported-entry",
          mount: id,
          path: relativePath,
          detail: "非普通文件条目已跳过",
        });
        entries.push({
          mount: id,
          path: relativePath,
          kind: "other",
          size: 0,
          sha256: null,
        });
        continue;
      }

      if (info.nlink > 1) {
        if (policy.links === "reject") {
          fail("LINK_BLOCKED", `来源包含硬链接：${id}:${relativePath}`);
        }
        warnings.push({
          code: "hard-link",
          mount: id,
          path: relativePath,
          detail: "该文件存在多个硬链接；内容按普通文件读取",
        });
      }
      if (info.size > limits.maxEntryBytes) {
        quota(
          `单个文件超过 ${limits.maxEntryBytes} 字节：${id}:${relativePath}`,
        );
      }
      bytes += info.size;
      if (bytes > limits.maxTotalBytes) {
        quota(`来源总字节数超过 ${limits.maxTotalBytes}`);
      }
      const canonical = await fsCall("解析文件", () => realpath(absolutePath));
      if (
        canonical !== absolutePath ||
        !isContained(root.resolvedRoot, canonical)
      ) {
        fail("SOURCE_CHANGED", `文件路径在扫描期间发生变化：${relativePath}`);
      }
      const digest = await hashDirectoryFile(
        canonical,
        { deviceId: info.dev, inode: info.ino, size: info.size },
        limits,
      );
      entries.push({
        mount: id,
        path: relativePath,
        kind: "file",
        size: digest.bytes,
        sha256: digest.sha256,
      });
      records.set(recordKey(id, relativePath), {
        mount: id,
        path: relativePath,
        kind: "file",
        size: digest.bytes,
        sha256: digest.sha256,
        absolutePath: canonical,
        rootResolved: root.resolvedRoot,
        deviceId: info.dev,
        inode: info.ino,
      });
    }
  }
  entries.sort(compareEntries);
  return { entries, records, bytes };
}

function unescapeMountField(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_match, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8)),
  );
}

/** 解析 Linux /proc/self/mountinfo，返回目标路径所在挂载点的只读证据。 */
export function parseMountInfoForPath(
  resolvedPath: string,
  mountInfo: string,
): ReadOnlyMountEvidence {
  let best:
    | { mountPoint: string; options: string; superOptions: string }
    | undefined;
  for (const line of mountInfo.split("\n")) {
    if (line.trim() === "") continue;
    const separator = line.indexOf(" - ");
    if (separator < 0) continue;
    const before = line.slice(0, separator).split(" ");
    const after = line.slice(separator + 3).split(" ");
    if (before.length < 6 || after.length < 3) continue;
    const mountPoint = unescapeMountField(before[4] as string);
    const options = before[5] as string;
    const superOptions = after[2] as string;
    const matches =
      resolvedPath === mountPoint ||
      mountPoint === "/" ||
      resolvedPath.startsWith(`${mountPoint}/`);
    if (!matches) continue;
    if (best === undefined || mountPoint.length > best.mountPoint.length) {
      best = { mountPoint, options, superOptions };
    }
  }
  if (best === undefined) {
    return {
      status: "unknown",
      source: "linux-mountinfo",
      detail: "挂载表中没有匹配的挂载点",
    };
  }
  const flags = new Set(best.options.split(","));
  const readOnly = flags.has("ro");
  return {
    status: readOnly ? "read-only" : "read-write",
    source: "linux-mountinfo",
    mountPoint: best.mountPoint,
    mountOptions: best.options,
    detail: readOnly
      ? "挂载选项包含 ro（只读）"
      : "挂载选项为 rw（可写）；本模块仍然只执行只读操作",
  };
}

/** 探测路径所在挂载点是否只读。非 Linux 且未注入读取器时返回 unknown。 */
export async function probeReadOnlyMount(
  resolvedPath: string,
  readMountInfo?: () => Promise<string>,
): Promise<ReadOnlyMountEvidence> {
  const provider =
    readMountInfo ??
    (process.platform === "linux"
      ? () => readFile("/proc/self/mountinfo", "utf8")
      : undefined);
  if (provider === undefined) {
    return {
      status: "unknown",
      source: "unavailable",
      detail: "当前平台没有可读取的挂载表，无法验证只读标志",
    };
  }
  let text: string;
  try {
    text = await provider();
  } catch {
    return {
      status: "unknown",
      source: "unavailable",
      detail: "读取挂载表失败，无法验证只读标志",
    };
  }
  return parseMountInfoForPath(resolvedPath, text);
}

function directoryMount(
  id: "directory" | "workspace",
  root: ConfinedRoot,
  evidence: ReadOnlyMountEvidence,
  entries: number,
  bytes: number,
): SourceMount {
  return {
    id,
    requestedPath: root.requested,
    configuredRoot: root.configuredRoot,
    resolvedPath: root.resolvedPath,
    resolvedRoot: root.resolvedRoot,
    deviceId: root.deviceId,
    containment: "realpath-inside-allowed-root",
    entries,
    bytes,
    readOnly: evidence,
  };
}

function findEndOfCentralDirectory(archive: Buffer): number {
  const lowest = Math.max(0, archive.length - 22 - 0xffff);
  for (let offset = archive.length - 22; offset >= lowest; offset -= 1) {
    if (archive.readUInt32LE(offset) !== EOCD_SIGNATURE) continue;
    const commentLength = archive.readUInt16LE(offset + 20);
    if (offset + 22 + commentLength === archive.length) return offset;
  }
  return unsupported("找不到 ZIP 中央目录结尾记录");
}

function decodeZipName(bytes: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return unsupported("ZIP 条目名不是有效 UTF-8");
  }
}

function classifyZipEntry(
  name: string,
  versionMadeBy: number,
  externalAttributes: number,
): SourceEntryKind {
  const host = versionMadeBy >>> 8;
  const mode = host === 3 ? (externalAttributes >>> 16) & 0xffff : 0;
  const type = mode & 0o170000;
  if (type === 0o120000) return "symlink";
  if (type === 0o040000) return "directory";
  if (type === 0o100000) return name.endsWith("/") ? "directory" : "file";
  if (type !== 0) return "other";
  return name.endsWith("/") ? "directory" : "file";
}

interface ParsedZipEntry {
  path: string;
  kind: SourceEntryKind;
  method: number;
  flags: number;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  dataStart: number;
}

function parseZipDirectory(
  archive: Buffer,
  limits: SourceLimits,
): ParsedZipEntry[] {
  if (archive.length < 22) {
    return unsupported("ZIP 文件过短");
  }
  const eocdOffset = findEndOfCentralDirectory(archive);
  const diskNumber = archive.readUInt16LE(eocdOffset + 4);
  const centralDisk = archive.readUInt16LE(eocdOffset + 6);
  const diskEntries = archive.readUInt16LE(eocdOffset + 8);
  const totalEntries = archive.readUInt16LE(eocdOffset + 10);
  const centralSize = archive.readUInt32LE(eocdOffset + 12);
  const centralOffset = archive.readUInt32LE(eocdOffset + 16);

  if (diskNumber !== 0 || centralDisk !== 0) {
    return unsupported("不支持分卷 ZIP");
  }
  if (diskEntries !== totalEntries) {
    return corrupt("ZIP 条目计数不一致");
  }
  if (
    totalEntries === ZIP64_COUNT_MARKER ||
    centralSize === ZIP64_MARKER ||
    centralOffset === ZIP64_MARKER
  ) {
    return unsupported("不支持 ZIP64 扩展格式");
  }
  if (totalEntries > limits.maxEntries) {
    quota(`ZIP 条目数超过 ${limits.maxEntries}`);
  }
  if (centralOffset + centralSize > eocdOffset) {
    return corrupt("ZIP 中央目录越界");
  }

  const entries: ParsedZipEntry[] = [];
  const seen = new Set<string>();
  const ranges: Array<{ start: number; end: number }> = [];
  let declaredTotal = 0;
  let cursor = centralOffset;

  for (let index = 0; index < totalEntries; index += 1) {
    if (cursor + 46 > eocdOffset) {
      return corrupt("ZIP 中央目录被截断");
    }
    if (archive.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      return corrupt("ZIP 中央目录签名错误");
    }
    const versionMadeBy = archive.readUInt16LE(cursor + 4);
    const flags = archive.readUInt16LE(cursor + 8);
    const method = archive.readUInt16LE(cursor + 10);
    const crc = archive.readUInt32LE(cursor + 16);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const uncompressedSize = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const diskStart = archive.readUInt16LE(cursor + 34);
    const externalAttributes = archive.readUInt32LE(cursor + 38);
    const localHeaderOffset = archive.readUInt32LE(cursor + 42);
    const entryEnd = cursor + 46 + nameLength + extraLength + commentLength;
    if (entryEnd > eocdOffset) {
      return corrupt("ZIP 中央目录条目越界");
    }
    if (
      compressedSize === ZIP64_MARKER ||
      uncompressedSize === ZIP64_MARKER ||
      localHeaderOffset === ZIP64_MARKER
    ) {
      return unsupported("不支持 ZIP64 扩展格式");
    }
    if (diskStart !== 0) {
      return unsupported("不支持分卷 ZIP");
    }
    if ((flags & 0x0001) !== 0 || (flags & 0x0040) !== 0) {
      return unsupported("不支持加密 ZIP 条目");
    }
    if (method !== 0 && method !== 8) {
      return unsupported(`不支持 ZIP 压缩方法 ${method}`);
    }

    const nameStart = cursor + 46;
    const nameBytes = archive.subarray(nameStart, nameStart + nameLength);
    const rawName = decodeZipName(nameBytes);
    const kind = classifyZipEntry(rawName, versionMadeBy, externalAttributes);
    const path = normalizeEntryPath(rawName);
    assertEntryPathLimits(path, limits);
    const duplicateKey = path.normalize("NFC");
    if (seen.has(duplicateKey)) {
      unsafePath(`ZIP 内存在重复路径：${path}`);
    }
    seen.add(duplicateKey);

    if (kind === "directory" && uncompressedSize !== 0) {
      return corrupt(`目录条目包含数据：${path}`);
    }
    if (method === 0 && compressedSize !== uncompressedSize) {
      return corrupt(`存储条目的压缩大小与声明不符：${path}`);
    }
    if (kind === "file") {
      if (uncompressedSize > limits.maxEntryBytes) {
        quota(
          `单个 ZIP 条目超过 ${limits.maxEntryBytes} 字节：${path}`,
        );
      }
      if (
        method === 8 &&
        uncompressedSize > RATIO_FLOOR_BYTES &&
        uncompressedSize > compressedSize * limits.maxCompressionRatio
      ) {
        quota(`ZIP 条目压缩比超过 ${limits.maxCompressionRatio}：${path}`);
      }
    }
    declaredTotal += uncompressedSize;
    if (declaredTotal > limits.maxTotalBytes) {
      quota(`ZIP 解压后总字节数超过 ${limits.maxTotalBytes}`);
    }

    if (localHeaderOffset + 30 > centralOffset) {
      return corrupt(`ZIP 本地文件头越界：${path}`);
    }
    if (archive.readUInt32LE(localHeaderOffset) !== LOCAL_SIGNATURE) {
      return corrupt(`ZIP 本地文件头签名错误：${path}`);
    }
    const localMethod = archive.readUInt16LE(localHeaderOffset + 8);
    const localNameLength = archive.readUInt16LE(localHeaderOffset + 26);
    const localExtraLength = archive.readUInt16LE(localHeaderOffset + 28);
    const localNameStart = localHeaderOffset + 30;
    if (localNameStart + localNameLength + localExtraLength > centralOffset) {
      return corrupt(`ZIP 本地文件头被截断：${path}`);
    }
    if (localMethod !== method) {
      return corrupt(`ZIP 本地与中央目录的压缩方法不一致：${path}`);
    }
    if (localNameLength !== nameLength) {
      return corrupt(`ZIP 本地与中央目录的文件名长度不一致：${path}`);
    }
    if (
      !archive
        .subarray(localNameStart, localNameStart + localNameLength)
        .equals(nameBytes)
    ) {
      return corrupt(`ZIP 本地与中央目录的文件名不一致：${path}`);
    }
    const dataStart = localNameStart + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > centralOffset) {
      return corrupt(`ZIP 条目数据区越界：${path}`);
    }
    ranges.push({ start: localHeaderOffset, end: dataEnd });

    entries.push({
      path,
      kind,
      method,
      flags,
      crc,
      compressedSize,
      uncompressedSize,
      dataStart,
    });
    cursor = entryEnd;
  }

  if (cursor !== centralOffset + centralSize) {
    return corrupt("ZIP 中央目录长度不一致");
  }
  ranges.sort((a, b) => a.start - b.start);
  for (let index = 1; index < ranges.length; index += 1) {
    const previous = ranges[index - 1] as { start: number; end: number };
    const current = ranges[index] as { start: number; end: number };
    if (current.start < previous.end) {
      return corrupt("ZIP 条目数据区重叠");
    }
  }
  return entries;
}

function validateZipPolicy(
  entries: ParsedZipEntry[],
  policy: SourcePolicy,
  warnings: SourceWarning[],
): void {
  for (const entry of entries) {
    if (entry.kind === "symlink") {
      if (policy.links === "reject") {
        fail("LINK_BLOCKED", `ZIP 包含符号链接：${entry.path}`);
      }
      warnings.push({
        code: "symlink-skipped",
        mount: "archive",
        path: entry.path,
        detail: "符号链接条目不会被解引用或读取",
      });
    } else if (entry.kind === "other") {
      warnings.push({
        code: "unsupported-entry",
        mount: "archive",
        path: entry.path,
        detail: "非普通文件条目已跳过",
      });
    }
  }
}

function* sliceChunks(
  archive: Buffer,
  start: number,
  length: number,
): Generator<Buffer> {
  for (let offset = 0; offset < length; offset += CHUNK_SIZE) {
    yield archive.subarray(
      start + offset,
      start + Math.min(offset + CHUNK_SIZE, length),
    );
  }
}

async function decodeZipEntry(
  archive: Buffer,
  record: ParsedZipEntry,
  maxBytes: number,
  capture: boolean,
): Promise<{ sha256: string; bytes: number; data?: Buffer }> {
  if (record.uncompressedSize > maxBytes) {
    quota(`ZIP 条目超过本次读取上限 ${maxBytes} 字节：${record.path}`);
  }
  if (record.method === 0) {
    const raw = archive.subarray(
      record.dataStart,
      record.dataStart + record.compressedSize,
    );
    if (raw.length !== record.uncompressedSize) {
      return corrupt(`ZIP 存储条目大小不一致：${record.path}`);
    }
    if (crc32(raw) !== record.crc) {
      return corrupt(`ZIP CRC32 校验失败：${record.path}`);
    }
    return {
      sha256: createHash("sha256").update(raw).digest("hex"),
      bytes: raw.length,
      data: capture ? Buffer.from(raw) : undefined,
    };
  }

  const hash = createHash("sha256");
  const chunks: Buffer[] = [];
  let total = 0;
  let runningCrc = 0;
  const source = Readable.from(
    sliceChunks(archive, record.dataStart, record.compressedSize),
  );
  const inflater = createInflateRaw();
  source.pipe(inflater);
  try {
    for await (const chunk of inflater) {
      const buffer = chunk as Buffer;
      total += buffer.length;
      if (total > record.uncompressedSize) {
        return corrupt(`ZIP 解压后大小超过声明：${record.path}`);
      }
      runningCrc = crc32(buffer, runningCrc);
      hash.update(buffer);
      if (capture) chunks.push(Buffer.from(buffer));
    }
  } catch (error) {
    inflater.destroy();
    source.destroy();
    if (error instanceof MigrationSourceError) throw error;
    return corrupt(`ZIP 解压失败：${record.path}`, error);
  }
  if (total !== record.uncompressedSize) {
    return corrupt(`ZIP 解压后大小与声明不符：${record.path}`);
  }
  if (runningCrc !== record.crc) {
    return corrupt(`ZIP CRC32 校验失败：${record.path}`);
  }
  return {
    sha256: hash.digest("hex"),
    bytes: total,
    data: capture ? Buffer.concat(chunks, total) : undefined,
  };
}

async function scanArchive(
  archive: Buffer,
  limits: SourceLimits,
  policy: SourcePolicy,
  warnings: SourceWarning[],
): Promise<{
  entries: SourceEntry[];
  records: Map<string, ZipFileRecord>;
  bytes: number;
}> {
  if (archive.length > limits.maxArchiveBytes) {
    quota(`ZIP 文件超过 ${limits.maxArchiveBytes} 字节`);
  }
  const parsed = parseZipDirectory(archive, limits);
  validateZipPolicy(parsed, policy, warnings);
  const entries: SourceEntry[] = [];
  const records = new Map<string, ZipFileRecord>();
  let bytes = 0;
  for (const item of [...parsed].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  )) {
    if (item.kind !== "file") {
      entries.push({
        mount: "archive",
        path: item.path,
        kind: item.kind,
        size: 0,
        sha256: null,
      });
      continue;
    }
    const digest = await decodeZipEntry(
      archive,
      item,
      limits.maxEntryBytes,
      false,
    );
    bytes += digest.bytes;
    if (bytes > limits.maxTotalBytes) {
      quota(`ZIP 解压后总字节数超过 ${limits.maxTotalBytes}`);
    }
    entries.push({
      mount: "archive",
      path: item.path,
      kind: "file",
      size: digest.bytes,
      sha256: digest.sha256,
    });
    records.set(recordKey("archive", item.path), {
      mount: "archive",
      path: item.path,
      kind: "file",
      size: digest.bytes,
      sha256: digest.sha256,
      method: item.method,
      flags: item.flags,
      crc: item.crc,
      compressedSize: item.compressedSize,
      uncompressedSize: item.uncompressedSize,
      dataStart: item.dataStart,
    });
  }
  entries.sort(compareEntries);
  return { entries, records, bytes };
}

function assembleSource(params: {
  kind: "directory" | "zip";
  mounts: SourceMount[];
  entries: SourceEntry[];
  warnings: SourceWarning[];
  totalBytes: number;
  limits: SourceLimits;
  records: Map<string, StoredFileRecord>;
  archive?: Buffer;
}): MigrationSource {
  const { kind, mounts, entries, warnings, totalBytes, limits, records } = params;
  const archive = params.archive;
  if (entries.length > limits.maxEntries) {
    quota(`条目总数超过 ${limits.maxEntries}`);
  }
  if (totalBytes > limits.maxTotalBytes) {
    quota(`来源总字节数超过 ${limits.maxTotalBytes}`);
  }
  const sortedEntries = [...entries].sort(compareEntries);
  const manifestHash = sourceManifestHash(sortedEntries);
  const frozenEntries = Object.freeze(
    sortedEntries.map((entry) => Object.freeze({ ...entry })),
  );
  const frozenMounts = Object.freeze(
    mounts.map((mount) => Object.freeze({ ...mount })),
  );
  const frozenWarnings = Object.freeze(
    warnings.map((warning) => Object.freeze({ ...warning })),
  );

  const lookup = (ref: SourceEntryRef): StoredFileRecord => {
    if (
      ref === null ||
      typeof ref !== "object" ||
      typeof ref.mount !== "string" ||
      typeof ref.path !== "string"
    ) {
      return invalid("条目引用必须包含 mount 与 path");
    }
    const record = records.get(recordKey(ref.mount, ref.path));
    if (record === undefined) {
      return invalid(`条目不在已验证清单中：${ref.mount}:${ref.path}`);
    }
    return record;
  };

  const resolveMaxBytes = (value: number | undefined, fallback: number): number => {
    if (value === undefined) return Math.min(fallback, limits.maxEntryBytes);
    if (!Number.isSafeInteger(value) || value < 1) {
      return invalid("maxBytes 必须是正整数");
    }
    return Math.min(value, limits.maxEntryBytes);
  };

  const read = async (
    ref: SourceEntryRef,
    options?: ReadEntryOptions,
  ): Promise<Buffer> => {
    const record = lookup(ref);
    const maxBytes = resolveMaxBytes(options?.maxBytes, limits.maxEntryBytes);
    if (record.size > maxBytes) {
      return quota(`条目超过本次读取上限 ${maxBytes} 字节：${record.path}`);
    }
    if (record.mount === "archive") {
      if (archive === undefined) {
        return invalid("ZIP 来源缺少归档数据");
      }
      const result = await decodeZipEntry(archive, record, maxBytes, true);
      if (result.sha256 !== record.sha256) {
        return fail(
          "HASH_MISMATCH",
          `ZIP 条目内容与扫描哈希不一致：${record.path}`,
        );
      }
      return result.data as Buffer;
    }
    return readDirectoryRecord(record, maxBytes);
  };

  const readText = async (
    ref: SourceEntryRef,
    options?: ReadEntryOptions,
  ): Promise<string> => {
    const maxBytes = resolveMaxBytes(
      options?.maxBytes,
      Math.min(limits.maxTextBytes, limits.maxEntryBytes),
    );
    const data = await read(ref, { maxBytes });
    if (data.includes(0)) {
      return invalid(`内容包含 NUL 字节，不是文本：${ref.mount}:${ref.path}`);
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(data);
    } catch {
      return invalid(`内容不是有效 UTF-8 文本：${ref.mount}:${ref.path}`);
    }
  };

  return Object.freeze({
    kind,
    mounts: frozenMounts,
    entries: frozenEntries,
    warnings: frozenWarnings,
    totalBytes,
    limits: Object.freeze({ ...limits }),
    manifestHash,
    read,
    readText,
  });
}

/** 打开 ZIP 上传包（内存中的 Buffer），不访问文件系统。 */
export async function openArchiveSource(
  archive: Buffer | Uint8Array,
  options: OpenSourceOptions = {},
): Promise<MigrationSource> {
  let buffer: Buffer;
  if (Buffer.isBuffer(archive)) {
    buffer = archive;
  } else if (archive instanceof Uint8Array) {
    buffer = Buffer.from(archive);
  } else {
    return invalid("archive 必须是 Buffer");
  }
  const limits = resolveLimits(options.limits);
  const policy = resolvePolicy(options.policy);
  const warnings: SourceWarning[] = [];
  const scan = await scanArchive(buffer, limits, policy, warnings);
  const mount: SourceMount = {
    id: "archive",
    requestedPath: null,
    configuredRoot: null,
    resolvedPath: null,
    resolvedRoot: null,
    deviceId: null,
    containment: "archive-paths-normalized",
    entries: scan.entries.length,
    bytes: scan.bytes,
    readOnly: {
      status: "not-applicable",
      source: "archive",
      detail: "内存中的 ZIP 上传包，不涉及文件系统挂载",
    },
  };
  return assembleSource({
    kind: "zip",
    mounts: [mount],
    entries: scan.entries,
    warnings,
    totalBytes: scan.bytes,
    limits,
    records: scan.records,
    archive: buffer,
  });
}

async function assertNoWritableNestedMounts(root:string, readMountInfo?:()=>Promise<string>):Promise<void> {
  const provider=readMountInfo??(process.platform==="linux"?()=>readFile("/proc/self/mountinfo","utf8"):undefined);
  if(!provider)fail("MOUNT_NOT_READ_ONLY", "无法验证嵌套挂载");
  let text:string;try{text=await provider();}catch{fail("MOUNT_NOT_READ_ONLY", "无法读取嵌套挂载表");}
  for(const line of text.split("\n")){const sep=line.indexOf(" - ");if(sep<0)continue;const fields=line.slice(0,sep).split(" ");if(fields.length<6)continue;const mount=unescapeMountField(fields[4]!);
    if(mount!==root&&isContained(root,mount)&&!new Set(fields[5]!.split(",")).has("ro"))fail("MOUNT_NOT_READ_ONLY", `来源包含可写嵌套挂载：${mount}`);}
}

/** 打开服务端允许根内的只读目录，可附带独立 workspace 目录。 */
export async function openDirectorySource(
  request: DirectorySourceRequest,
  options: OpenSourceOptions,
): Promise<MigrationSource> {
  if (request === null || typeof request !== "object") {
    return invalid("缺少目录输入");
  }
  const directory = await confineToAllowedRoot(
    request.directory,
    options.allowedRoots,
    "directory",
  );
  const directoryEvidence = await probeReadOnlyMount(
    directory.resolvedPath,
    options.readMountInfo,
  );
  if (options.requireReadOnlyMount === true && directoryEvidence.status !== "read-only") {
    fail(
      "MOUNT_NOT_READ_ONLY",
      `directory 未验证为只读挂载：${directoryEvidence.detail}`,
    );
  }
  if(options.requireReadOnlyMount === true)await assertNoWritableNestedMounts(directory.resolvedPath,options.readMountInfo);
  const limits = resolveLimits(options.limits);
  const policy = resolvePolicy(options.policy);
  const warnings: SourceWarning[] = [];
  const directoryScan = await scanDirectoryMount(
    "directory",
    directory,
    limits,
    policy,
    warnings,
  );

  const mounts: SourceMount[] = [
    directoryMount(
      "directory",
      directory,
      directoryEvidence,
      directoryScan.entries.length,
      directoryScan.bytes,
    ),
  ];
  const entries: SourceEntry[] = [...directoryScan.entries];
  const records = new Map<string, StoredFileRecord>(directoryScan.records);
  let totalBytes = directoryScan.bytes;

  if (request.workspace !== undefined) {
    const workspace = await confineToAllowedRoot(
      request.workspace,
      options.allowedRoots,
      "workspace",
    );
    if (
      isContained(directory.resolvedPath, workspace.resolvedPath) ||
      isContained(workspace.resolvedPath, directory.resolvedPath)
    ) {
      return invalid("workspace 不能与 directory 相同或互相嵌套");
    }
    const workspaceEvidence = await probeReadOnlyMount(
      workspace.resolvedPath,
      options.readMountInfo,
    );
    if (
      options.requireReadOnlyMount === true &&
      workspaceEvidence.status !== "read-only"
    ) {
      fail(
        "MOUNT_NOT_READ_ONLY",
        `workspace 未验证为只读挂载：${workspaceEvidence.detail}`,
      );
    }
    if(options.requireReadOnlyMount === true)await assertNoWritableNestedMounts(workspace.resolvedPath,options.readMountInfo);
    const workspaceScan = await scanDirectoryMount(
      "workspace",
      workspace,
      limits,
      policy,
      warnings,
    );
    mounts.push(
      directoryMount(
        "workspace",
        workspace,
        workspaceEvidence,
        workspaceScan.entries.length,
        workspaceScan.bytes,
      ),
    );
    entries.push(...workspaceScan.entries);
    for (const [key, value] of workspaceScan.records) {
      records.set(key, value);
    }
    totalBytes += workspaceScan.bytes;
  }

  return assembleSource({
    kind: "directory",
    mounts,
    entries,
    warnings,
    totalBytes,
    limits,
    records,
  });
}

/**
 * 统一入口：{archive: Buffer} 或 {directory, workspace?}。
 * 目录输入必须提供 allowedRoots，且所有路径都 realpath 后落在允许根内。
 */
export async function openMigrationSource(
  request: SourceRequest,
  options: OpenSourceOptions = {},
): Promise<MigrationSource> {
  if (request === null || typeof request !== "object") {
    return invalid("缺少迁移来源输入");
  }
  const hasArchive = "archive" in request && request.archive !== undefined;
  const hasDirectory = "directory" in request && request.directory !== undefined;
  if (hasArchive === hasDirectory) {
    return invalid("必须且只能提供 archive 或 directory 之一");
  }
  if (hasArchive) {
    return openArchiveSource((request as ArchiveSourceRequest).archive, options);
  }
  return openDirectorySource(request as DirectorySourceRequest, options);
}
