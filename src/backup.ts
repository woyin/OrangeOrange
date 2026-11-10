import { backup, DatabaseSync } from "node:sqlite";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { acquireOwnership } from "./ownership.js";
import type { Config } from "./config.js";
export async function backupData(config: Config, destination: string) {
  const target = resolve(destination);
  const rel = relative(config.dataDir, target);
  if (!rel || (!rel.startsWith(`..${sep}`) && rel !== ".."))
    throw new Error("备份目录必须位于数据目录之外");
  const release = await acquireOwnership(config.dataDir);
  try {
    await mkdir(target, { mode: 0o700 });
    const db = new DatabaseSync(join(config.dataDir, "state.sqlite"), {
      readOnly: true,
    });
    try {
      await backup(db, join(target, "state.sqlite"));
    } finally {
      db.close();
    }
    await writeFile(
      join(target, "manifest.json"),
      JSON.stringify({
        app: "orangeorange",
        version: 1,
        durable: "1.5.0",
        createdAt: new Date().toISOString(),
      }),
      { mode: 0o600 },
    );
    return { backup: target };
  } finally {
    await release();
  }
}
export async function restoreData(config: Config, source: string) {
  const manifest = JSON.parse(
    await readFile(join(resolve(source), "manifest.json"), "utf8"),
  );
  if (
    manifest.app !== "orangeorange" ||
    manifest.version !== 1 ||
    manifest.durable !== "1.5.0"
  )
    throw new Error("备份格式或版本不兼容");
  await mkdir(config.dataDir, { mode: 0o700 }); // Never overwrite an existing data directory.
  const release = await acquireOwnership(config.dataDir);
  try {
    await copyFile(
      join(resolve(source), "state.sqlite"),
      join(config.dataDir, "state.sqlite"),
    );
    return { restored: config.dataDir };
  } finally {
    await release();
  }
}
