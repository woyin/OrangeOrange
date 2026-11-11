import { afterEach, expect, test } from "vitest";
import { createHash } from "node:crypto";
import {
  link,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
import {
  DEFAULT_SOURCE_LIMITS,
  MigrationSourceError,
  normalizeEntryPath,
  openArchiveSource,
  openDirectorySource,
  openMigrationSource,
  parseMountInfoForPath,
  probeReadOnlyMount,
  sourceManifestHash,
} from "../src/migrations/source.js";

const FILE_ATTRS = (0o100644 << 16) >>> 0;
const DIRECTORY_ATTRS = (0o040755 << 16) >>> 0;
const SYMLINK_ATTRS = (0o120777 << 16) >>> 0;
const FIFO_ATTRS = (0o010644 << 16) >>> 0;

interface ZipEntrySpec {
  name: string;
  data?: Buffer;
  method?: number;
  flags?: number;
  externalAttrs?: number;
  versionMadeBy?: number;
  declaredUncompressed?: number;
  declaredCompressed?: number;
  declaredCrc?: number;
}

function buildZip(specs: ZipEntrySpec[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const spec of specs) {
    const raw = spec.data ?? Buffer.alloc(0);
    const method = spec.method ?? 0;
    const payload = method === 8 ? deflateRawSync(raw) : raw;
    const name = Buffer.from(spec.name, "utf8");
    const flags = spec.flags ?? 0x0800;
    const crc = spec.declaredCrc ?? crc32(raw);
    const uncompressed = spec.declaredUncompressed ?? raw.length;
    const compressed = spec.declaredCompressed ?? payload.length;

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed, 18);
    local.writeUInt32LE(uncompressed, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);
    localParts.push(local, payload);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(spec.versionMadeBy ?? 0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed, 20);
    central.writeUInt32LE(uncompressed, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(spec.externalAttrs ?? FILE_ATTRS, 38);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centralParts.push(central);

    offset += local.length + payload.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(specs.length, 8);
  eocd.writeUInt16LE(specs.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDirectory, eocd]);
}

const tempDirs: string[] = [];

async function tempRoot(prefix = "migrations-source-"): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(directory);
  return directory;
}

async function stateTree(): Promise<{ allowed: string; directory: string }> {
  const allowed = await tempRoot();
  const directory = join(allowed, "state");
  await mkdir(directory);
  return { allowed, directory };
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop() as string, { recursive: true, force: true });
  }
});

test("ZIP：清单、SHA-256、读取与文本解码", async () => {
  const archive = buildZip([
    { name: "config.yaml", data: Buffer.from("model: demo\n") },
    { name: "memories/MEMORY.md", data: Buffer.from("记忆内容"), method: 8 },
    { name: "empty/", data: Buffer.alloc(0), externalAttrs: DIRECTORY_ATTRS },
    { name: "说明.txt", data: Buffer.from("中文") },
  ]);
  const source = await openMigrationSource({ archive });
  expect(source.kind).toBe("zip");
  expect(source.entries.map((entry) => `${entry.mount}:${entry.path}:${entry.kind}`)).toEqual([
    "archive:config.yaml:file",
    "archive:empty:directory",
    "archive:memories/MEMORY.md:file",
    "archive:说明.txt:file",
  ]);
  const memory = source.entries.find((entry) => entry.path === "memories/MEMORY.md");
  expect(memory).toMatchObject({
    mount: "archive",
    kind: "file",
    size: Buffer.byteLength("记忆内容"),
    sha256: createHash("sha256").update("记忆内容").digest("hex"),
  });
  expect(await source.readText(memory as never)).toBe("记忆内容");
  expect((await source.read(memory as never)).toString("utf8")).toBe("记忆内容");
  const directory = source.entries.find((entry) => entry.path === "empty");
  await expect(source.read(directory as never)).rejects.toMatchObject({
    code: "INVALID_INPUT",
  });
  expect(source.totalBytes).toBe(
    Buffer.byteLength("model: demo\n") +
      Buffer.byteLength("记忆内容") +
      Buffer.byteLength("中文"),
  );
  expect(source.mounts[0]).toMatchObject({
    id: "archive",
    containment: "archive-paths-normalized",
    readOnly: { status: "not-applicable" },
  });
  expect(source.limits.maxEntries).toBe(DEFAULT_SOURCE_LIMITS.maxEntries);
  const small = source.entries.find((entry) => entry.path === "config.yaml");
  await expect(source.read(small as never, { maxBytes: 2 })).rejects.toMatchObject({
    code: "QUOTA_EXCEEDED",
  });
});

test("ZIP：拒绝路径穿越、盘符、反斜杠、控制字符与重复路径", async () => {
  const unsafeNames = [
    "../evil.txt",
    "/etc/passwd",
    "C:evil.txt",
    "C:\\evil.txt",
    "a\\b.txt",
    "a//b.txt",
    "a/../b.txt",
    "bad\u0000name.txt",
  ];
  for (const name of unsafeNames) {
    await expect(
      openMigrationSource({
        archive: buildZip([{ name, data: Buffer.from("x") }]),
      }),
    ).rejects.toMatchObject({ code: "PATH_UNSAFE" });
  }
  await expect(
    openMigrationSource({
      archive: buildZip([
        { name: "a.txt", data: Buffer.from("1") },
        { name: "./a.txt", data: Buffer.from("2") },
      ]),
    }),
  ).rejects.toMatchObject({ code: "PATH_UNSAFE" });
  await expect(
    openMigrationSource({
      archive: buildZip([
        { name: "é.txt", data: Buffer.from("1") },
        { name: "e\u0301.txt", data: Buffer.from("2") },
      ]),
    }),
  ).rejects.toMatchObject({ code: "PATH_UNSAFE" });
});

test("ZIP：配额覆盖条目数、单条大小、总量、压缩比、路径与归档大小", async () => {
  const twoFiles = (): Buffer =>
    buildZip([
      { name: "a.txt", data: Buffer.from("12345") },
      { name: "b.txt", data: Buffer.from("67890") },
    ]);
  await expect(
    openMigrationSource({ archive: twoFiles() }, { limits: { maxEntries: 1 } }),
  ).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
  await expect(
    openMigrationSource(
      { archive: twoFiles() },
      { limits: { maxArchiveBytes: 10 } },
    ),
  ).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
  await expect(
    openMigrationSource(
      { archive: twoFiles() },
      { limits: { maxEntryBytes: 4 } },
    ),
  ).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
  await expect(
    openMigrationSource(
      { archive: twoFiles() },
      { limits: { maxTotalBytes: 9 } },
    ),
  ).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
  await expect(
    openMigrationSource(
      {
        archive: buildZip([
          { name: "a-very-long-name.txt", data: Buffer.from("x") },
        ]),
      },
      { limits: { maxPathLength: 10 } },
    ),
  ).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
  await expect(
    openMigrationSource(
      { archive: buildZip([{ name: "a/b/c.txt", data: Buffer.from("x") }]) },
      { limits: { maxDepth: 2 } },
    ),
  ).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
  const bomb = buildZip([
    { name: "bomb.bin", data: Buffer.alloc(2 * 1024 * 1024), method: 8 },
  ]);
  await expect(
    openMigrationSource({ archive: bomb }, { limits: { maxCompressionRatio: 10 } }),
  ).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
});

test("ZIP：损坏、加密、未知压缩方法、ZIP64 与虚假声明被拒绝", async () => {
  await expect(
    openMigrationSource({
      archive: buildZip([
        { name: "a.txt", data: Buffer.from("abc"), declaredCrc: 0 },
      ]),
    }),
  ).rejects.toMatchObject({ code: "CORRUPT_ARCHIVE" });
  await expect(
    openMigrationSource({
      archive: buildZip([
        {
          name: "a.txt",
          data: Buffer.from("x".repeat(5000)),
          method: 8,
          declaredUncompressed: 100,
        },
      ]),
    }),
  ).rejects.toMatchObject({ code: "CORRUPT_ARCHIVE" });
  await expect(
    openMigrationSource({
      archive: buildZip([{ name: "a.txt", data: Buffer.from("x"), flags: 1 }]),
    }),
  ).rejects.toMatchObject({ code: "UNSUPPORTED_FORMAT" });
  await expect(
    openMigrationSource({
      archive: buildZip([
        { name: "a.txt", data: Buffer.from("x"), method: 12 },
      ]),
    }),
  ).rejects.toMatchObject({ code: "UNSUPPORTED_FORMAT" });
  await expect(
    openMigrationSource({
      archive: buildZip([
        {
          name: "a.txt",
          data: Buffer.from("x"),
          declaredUncompressed: 0xffffffff,
        },
      ]),
    }),
  ).rejects.toMatchObject({ code: "UNSUPPORTED_FORMAT" });
  await expect(
    openMigrationSource({ archive: Buffer.from("not a zip") }),
  ).rejects.toMatchObject({ code: "UNSUPPORTED_FORMAT" });
});

test("ZIP：符号链接与非普通文件只记录不读取", async () => {
  const archive = buildZip([
    {
      name: "link",
      data: Buffer.from("../outside"),
      externalAttrs: SYMLINK_ATTRS,
    },
    {
      name: "pipe",
      data: Buffer.alloc(0),
      externalAttrs: FIFO_ATTRS,
    },
  ]);
  const source = await openMigrationSource({ archive });
  expect(source.entries.map((entry) => entry.kind)).toEqual(["symlink", "other"]);
  expect(source.warnings).toContainEqual(
    expect.objectContaining({ code: "symlink-skipped", path: "link" }),
  );
  expect(source.warnings).toContainEqual(
    expect.objectContaining({ code: "unsupported-entry", path: "pipe" }),
  );
  await expect(source.read(source.entries[0] as never)).rejects.toMatchObject({
    code: "INVALID_INPUT",
  });
  await expect(
    openMigrationSource({ archive }, { policy: { links: "reject" } }),
  ).rejects.toMatchObject({ code: "LINK_BLOCKED" });
});

test("目录：限定允许根，realpath 防越界，支持独立 workspace", async () => {
  const allowed = await tempRoot();
  const outside = await tempRoot("migrations-outside-");
  const state = join(allowed, "state");
  const workspace = join(allowed, "workspace");
  await mkdir(join(state, "memories"), { recursive: true });
  await mkdir(workspace);
  await writeFile(join(state, "config.yaml"), "model: demo\n");
  await writeFile(join(state, "memories", "MEMORY.md"), "记忆");
  await writeFile(join(workspace, "AGENTS.md"), "规则");
  await writeFile(join(outside, "secret.txt"), "secret");

  const source = await openMigrationSource(
    { directory: state, workspace },
    { allowedRoots: [allowed] },
  );
  expect(source.mounts.map((mount) => mount.id)).toEqual(["directory", "workspace"]);
  expect(source.mounts[0]).toMatchObject({
    containment: "realpath-inside-allowed-root",
    configuredRoot: allowed,
    resolvedRoot: await realpath(allowed),
    resolvedPath: await realpath(state),
  });
  const memory = source.entries.find(
    (entry) => entry.mount === "directory" && entry.path === "memories/MEMORY.md",
  );
  expect(await source.readText(memory as never)).toBe("记忆");
  const agents = source.entries.find(
    (entry) => entry.mount === "workspace" && entry.path === "AGENTS.md",
  );
  expect(await source.readText(agents as never)).toBe("规则");

  await expect(
    openMigrationSource({ directory: outside }, { allowedRoots: [allowed] }),
  ).rejects.toMatchObject({ code: "PATH_UNSAFE" });
  await symlink(outside, join(allowed, "escape"));
  await expect(
    openMigrationSource(
      { directory: join(allowed, "escape") },
      { allowedRoots: [allowed] },
    ),
  ).rejects.toMatchObject({ code: "PATH_UNSAFE" });
  await expect(openMigrationSource({ directory: state })).rejects.toMatchObject({
    code: "INVALID_INPUT",
  });
  await expect(
    openMigrationSource(
      { directory: state, workspace: join(state, "memories") },
      { allowedRoots: [allowed] },
    ),
  ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  await expect(
    openMigrationSource(
      { directory: state, workspace: outside },
      { allowedRoots: [allowed] },
    ),
  ).rejects.toMatchObject({ code: "PATH_UNSAFE" });
});

test("严格策略拒绝硬链接", async () => {
  const root = await tempRoot();
  await writeFile(join(root, "a"), "secret");
  await link(join(root, "a"), join(root, "b"));
  await expect(openDirectorySource({directory:root}, {allowedRoots:[root], policy:{links:"reject"}})).rejects.toMatchObject({code:"LINK_BLOCKED"});
});

test("目录：符号链接不跟随，硬链接告警，读取复核哈希", async () => {
  const allowed = await tempRoot();
  const outside = await tempRoot("migrations-outside-");
  const directory = join(allowed, "state");
  await mkdir(directory);
  await writeFile(join(directory, "a.txt"), "1234567");
  await writeFile(join(directory, "binary.bin"), Buffer.from([0, 1]));
  await writeFile(join(outside, "secret.txt"), "secret");
  await symlink(join(outside, "secret.txt"), join(directory, "link.txt"));
  await symlink(outside, join(directory, "linked-dir"));
  await link(join(directory, "a.txt"), join(directory, "hard.txt"));

  const source = await openMigrationSource({ directory }, { allowedRoots: [allowed] });
  expect(source.entries.map((entry) => `${entry.path}:${entry.kind}`)).toEqual([
    "a.txt:file",
    "binary.bin:file",
    "hard.txt:file",
    "link.txt:symlink",
    "linked-dir:symlink",
  ]);
  expect(source.entries.some((entry) => entry.path.startsWith("linked-dir/"))).toBe(false);
  expect(source.warnings).toContainEqual(
    expect.objectContaining({ code: "hard-link", path: "hard.txt" }),
  );
  expect(source.warnings.filter((warning) => warning.code === "symlink-skipped")).toHaveLength(2);
  const binary = source.entries.find((entry) => entry.path === "binary.bin");
  expect((await source.read(binary as never)).length).toBe(2);
  await expect(source.readText(binary as never)).rejects.toMatchObject({
    code: "INVALID_INPUT",
  });
  await expect(
    openMigrationSource({ directory }, { allowedRoots: [allowed], policy: { links: "reject" } }),
  ).rejects.toMatchObject({ code: "LINK_BLOCKED" });

  const entry = source.entries.find((item) => item.path === "a.txt");
  await writeFile(join(directory, "a.txt"), "7654321");
  await expect(source.read(entry as never)).rejects.toMatchObject({
    code: "HASH_MISMATCH",
  });
});

test("目录：配额覆盖条目数、单条大小、总量、深度与路径长度", async () => {
  {
    const { allowed, directory } = await stateTree();
    await writeFile(join(directory, "a.txt"), "a");
    await writeFile(join(directory, "b.txt"), "b");
    await writeFile(join(directory, "c.txt"), "c");
    await expect(
      openMigrationSource({ directory }, { allowedRoots: [allowed], limits: { maxEntries: 2 } }),
    ).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
  }
  {
    const { allowed, directory } = await stateTree();
    await writeFile(join(directory, "a.txt"), "123456");
    await expect(
      openMigrationSource(
        { directory },
        { allowedRoots: [allowed], limits: { maxEntryBytes: 5 } },
      ),
    ).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
  }
  {
    const { allowed, directory } = await stateTree();
    await writeFile(join(directory, "a.txt"), "1234");
    await writeFile(join(directory, "b.txt"), "5678");
    await expect(
      openMigrationSource(
        { directory },
        { allowedRoots: [allowed], limits: { maxTotalBytes: 6 } },
      ),
    ).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
  }
  {
    const { allowed, directory } = await stateTree();
    await mkdir(join(directory, "a", "b"), { recursive: true });
    await writeFile(join(directory, "a", "b", "c.txt"), "x");
    await expect(
      openMigrationSource({ directory }, { allowedRoots: [allowed], limits: { maxDepth: 2 } }),
    ).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
  }
  {
    const { allowed, directory } = await stateTree();
    await writeFile(join(directory, "a-very-long-name.txt"), "x");
    await expect(
      openMigrationSource(
        { directory },
        { allowedRoots: [allowed], limits: { maxPathLength: 10 } },
      ),
    ).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
  }
  {
    const { allowed, directory } = await stateTree();
    await writeFile(join(directory, "a.txt"), "abc");
    const source = await openMigrationSource(
      { directory },
      { allowedRoots: [allowed], limits: { maxTextBytes: 1 } },
    );
    const entry = source.entries.find((item) => item.path === "a.txt");
    await expect(source.readText(entry as never)).rejects.toMatchObject({
      code: "QUOTA_EXCEEDED",
    });
    expect(await source.readText(entry as never, { maxBytes: 3 })).toBe("abc");
  }
});

test("只读根下的可写嵌套挂载会被拒绝", async () => {
  const root=await tempRoot();await mkdir(join(root,"nested"));
  const mounts=`1 1 8:1 / ${root} ro,relatime - ext4 /dev/a rw\n2 1 8:2 / ${root}/nested rw,relatime - ext4 /dev/b ro\n`;
  expect(parseMountInfoForPath(join(root,"nested"),mounts).status).toBe("read-write");
  await expect(openDirectorySource({directory:root},{allowedRoots:[root],requireReadOnlyMount:true,readMountInfo:async()=>mounts})).rejects.toMatchObject({code:"MOUNT_NOT_READ_ONLY"});
});

test("只读挂载证据：mountinfo 解析、探测注入与强制只读", async () => {
  const mountInfo =
    "1 1 8:1 / /mnt/data\\040set ro,relatime - ext4 /dev/sda1 ro\n" +
    "2 2 8:2 / /mnt/other rw,relatime - ext4 /dev/sdb1 rw\n";
  expect(parseMountInfoForPath("/mnt/data set/a", mountInfo)).toMatchObject({
    status: "read-only",
    source: "linux-mountinfo",
    mountPoint: "/mnt/data set",
  });
  expect(parseMountInfoForPath("/mnt/other/x", mountInfo)).toMatchObject({
    status: "read-write",
  });
  expect(parseMountInfoForPath("/opt/x", mountInfo)).toMatchObject({
    status: "unknown",
  });
  const nested =
    mountInfo +
    "3 3 8:3 / /mnt/data\\040set/inner ro,relatime - ext4 /dev/sda1 ro\n";
  expect(parseMountInfoForPath("/mnt/data set/inner/x", nested).mountPoint).toBe(
    "/mnt/data set/inner",
  );
  expect(await probeReadOnlyMount("/mnt/other/x", async () => mountInfo)).toMatchObject({
    status: "read-write",
  });

  const allowed = await tempRoot();
  const directory = join(allowed, "state");
  await mkdir(directory);
  await writeFile(join(directory, "a.txt"), "a");
  const resolved = await realpath(directory);
  const readOnly = `36 35 8:1 / ${resolved} ro,relatime - apfs /dev/disk1 ro\n`;
  const readWrite = `36 35 8:1 / ${resolved} rw,relatime - apfs /dev/disk1 rw\n`;

  const strict = await openMigrationSource(
    { directory },
    {
      allowedRoots: [allowed],
      requireReadOnlyMount: true,
      readMountInfo: async () => readOnly,
    },
  );
  expect(strict.mounts[0]?.readOnly).toMatchObject({
    status: "read-only",
    mountPoint: resolved,
  });
  await expect(
    openMigrationSource(
      { directory },
      {
        allowedRoots: [allowed],
        requireReadOnlyMount: true,
        readMountInfo: async () => readWrite,
      },
    ),
  ).rejects.toMatchObject({ code: "MOUNT_NOT_READ_ONLY" });
  const relaxed = await openMigrationSource(
    { directory },
    { allowedRoots: [allowed], readMountInfo: async () => readWrite },
  );
  expect(relaxed.mounts[0]?.readOnly.status).toBe("read-write");
});

test("清单哈希稳定，读取只接受已核验条目", async () => {
  const archive = buildZip([{ name: "a.txt", data: Buffer.from("a") }]);
  const first = await openMigrationSource({ archive });
  const second = await openMigrationSource({ archive });
  expect(first.manifestHash).toBe(second.manifestHash);
  expect(first.manifestHash).toMatch(/^[0-9a-f]{64}$/);
  expect(sourceManifestHash(first.entries)).toBe(first.manifestHash);
  expect(Object.isFrozen(first.entries)).toBe(true);
  expect(Object.isFrozen(first.mounts)).toBe(true);
  const changed = await openMigrationSource({
    archive: buildZip([{ name: "a.txt", data: Buffer.from("b") }]),
  });
  expect(changed.manifestHash).not.toBe(first.manifestHash);
  await expect(
    first.read({ mount: "archive", path: "missing.txt" }),
  ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  await expect(
    first.read({ mount: "directory", path: "a.txt" }),
  ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  expect(() => normalizeEntryPath("../a")).toThrow(MigrationSourceError);
  expect(normalizeEntryPath("./a/b/")).toBe("a/b");
  expect(normalizeEntryPath("a/./b")).toBe("a/b");
});

test("输入与配额校验：来源互斥、非法参数与空包", async () => {
  await expect(openMigrationSource({} as never)).rejects.toMatchObject({
    code: "INVALID_INPUT",
  });
  await expect(
    openMigrationSource({ archive: Buffer.alloc(0), directory: "/tmp" } as never),
  ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  await expect(
    openMigrationSource({ archive: "not-a-buffer" } as never),
  ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  await expect(
    openMigrationSource(
      { archive: buildZip([]) },
      { limits: { maxEntries: 0 } },
    ),
  ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  await expect(
    openMigrationSource(
      { archive: buildZip([]) },
      { policy: { links: "nope" as never } },
    ),
  ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  await expect(openArchiveSource(Buffer.alloc(0))).rejects.toMatchObject({
    code: "UNSUPPORTED_FORMAT",
  });
  await expect(
    openDirectorySource({ directory: "/tmp" }, {}),
  ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  const empty = await openMigrationSource({ archive: buildZip([]) });
  expect(empty.entries).toEqual([]);
  expect(empty.totalBytes).toBe(0);
  expect(new MigrationSourceError("INVALID_INPUT", "x")).toBeInstanceOf(Error);
});
