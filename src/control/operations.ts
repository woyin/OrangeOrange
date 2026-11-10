import { backup, DatabaseSync } from "node:sqlite";
import {
  mkdir,
  readdir,
  readFile,
  writeFile,
  copyFile,
  rename,
  rm,
  realpath,
} from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { ControlStore } from "./store.js";
export type OperationsHooks = {
  quiesce: () => Promise<void>;
  resume: () => Promise<void>;
  piBackup: (destination: string) => Promise<void>;
  closeStores: () => Promise<void>;
  reopenStores: () => Promise<void>;
};
export type BackupManifest = {
  id: string;
  version: 1;
  createdAt: number;
  files: { name: string; sha256: string; bytes: number }[];
  secretsIncluded: false;
  masterKeyIncluded: false;
};
const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
function validId(id: string) {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("INVALID_BACKUP_ID");
  return id;
}
function checkDatabase(file: string) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    if (db.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok")
      throw new Error("BACKUP_INTEGRITY_FAILED");
  } finally {
    db.close();
  }
}
export async function recoverInterruptedRestore(
  dataDir: string,
): Promise<boolean> {
  const journal = join(dataDir, "restore-journal.json");
  let info: { version: number; rollback: string };
  try {
    info = JSON.parse(await readFile(journal, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new Error("RESTORE_JOURNAL_INVALID");
  }
  if (info.version !== 1 || !/^\.restore-[0-9a-f-]{36}$/.test(info.rollback))
    throw new Error("RESTORE_JOURNAL_INVALID");
  const rollback = join(dataDir, info.rollback);
  const targets = [
    { name: "app.sqlite", path: join(dataDir, "app.sqlite") },
    { name: "pi.sqlite", path: join(dataDir, "pi", "state.sqlite") },
  ];
  for (const target of targets) checkDatabase(join(rollback, target.name));
  for (const target of targets) {
    await rm(`${target.path}-wal`, { force: true });
    await rm(`${target.path}-shm`, { force: true });
    await copyFile(join(rollback, target.name), target.path);
  }
  await rm(journal);
  await rm(rollback, { recursive: true, force: true });
  return true;
}

/** HTTP调用方负责Owner再认证与确认。所有路径由服务器生成，不接收任意上传/磁盘路径。 */
export class OperationsService {
  private active = false;
  constructor(
    private getStore: () => ControlStore,
    readonly dataDir: string,
    private hooks: OperationsHooks,
  ) {}
  private get backupDir() {
    return join(this.dataDir, "backups");
  }
  private async exclusive<T>(fn: () => Promise<T>) {
    if (this.active) throw new Error("MAINTENANCE_BUSY");
    this.active = true;
    try {
      return await fn();
    } finally {
      this.active = false;
    }
  }
  async listBackups(): Promise<BackupManifest[]> {
    await mkdir(this.backupDir, { recursive: true, mode: 0o700 });
    const results: BackupManifest[] = [];
    for (const name of await readdir(this.backupDir)) {
      if (!/^[0-9a-f-]{36}$/.test(name)) continue;
      try {
        const data = JSON.parse(
          await readFile(join(this.backupDir, name, "manifest.json"), "utf8"),
        );
        if (data.id === name && data.version === 1) results.push(data);
      } catch {}
    }
    return results.sort((a, b) => b.createdAt - a.createdAt);
  }
  async createBackup(): Promise<BackupManifest> {
    return this.exclusive(async () => {
      await this.hooks.quiesce();
      try {
        return await this.snapshot();
      } finally {
        await this.hooks.resume();
      }
    });
  }
  private async snapshot(): Promise<BackupManifest> {
    const id = randomUUID(),
      directory = join(this.backupDir, id),
      staging = join(this.backupDir, `.${id}.tmp`);
    await mkdir(staging, { recursive: true, mode: 0o700 });
    try {
      const store = this.getStore();
      await backup(store.db, join(staging, "app.sqlite"));
      await this.hooks.piBackup(join(staging, "pi.sqlite"));
      checkDatabase(join(staging, "app.sqlite"));
      checkDatabase(join(staging, "pi.sqlite"));
      // A backup retains personal task/memory data, but deliberately excludes credentials and login sessions.
      const app = new DatabaseSync(join(staging, "app.sqlite"));
      try {
        app.exec(
          "PRAGMA secure_delete=ON; BEGIN; DELETE FROM secrets; DELETE FROM entities WHERE kind='sessions'; COMMIT; VACUUM; PRAGMA wal_checkpoint(TRUNCATE);",
        );
      } finally {
        app.close();
      }
      const files: BackupManifest["files"] = [];
      for (const name of ["app.sqlite", "pi.sqlite"]) {
        const bytes = await readFile(join(staging, name));
        files.push({ name, sha256: digest(bytes), bytes: bytes.length });
      }
      const manifest: BackupManifest = {
        id,
        version: 1,
        createdAt: Date.now(),
        files,
        secretsIncluded: false,
        masterKeyIncluded: false,
      };
      await writeFile(
        join(staging, "manifest.json"),
        JSON.stringify(manifest, null, 2),
        { mode: 0o600, flag: "wx" },
      );
      await rename(staging, directory);
      store.audit("owner", "backup.create", id, "completed");
      return manifest;
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
  }
  private async validate(id: string): Promise<BackupManifest> {
    validId(id);
    const directory = join(this.backupDir, id);
    const actual = await realpath(directory);
    const root = await realpath(this.dataDir);
    const expected = join(root, "backups", id);
    if (actual !== expected) throw new Error("INVALID_BACKUP_PATH");
    const manifest = JSON.parse(
      await readFile(join(directory, "manifest.json"), "utf8"),
    ) as BackupManifest;
    if (
      manifest.version !== 1 ||
      manifest.id !== id ||
      manifest.files.length !== 2 ||
      manifest.files
        .map((f) => f.name)
        .sort()
        .join(",") !== "app.sqlite,pi.sqlite"
    )
      throw new Error("INVALID_BACKUP_MANIFEST");
    for (const file of manifest.files) {
      const path = join(directory, file.name);
      if ((await realpath(path)) !== join(expected, file.name))
        throw new Error("INVALID_BACKUP_PATH");
      const bytes = await readFile(path);
      if (bytes.length !== file.bytes || digest(bytes) !== file.sha256)
        throw new Error("BACKUP_CHECKSUM_FAILED");
      checkDatabase(path);
    }
    const app = new DatabaseSync(join(directory, "app.sqlite"), {
      readOnly: true,
    });
    try {
      const version = Number(
        app.prepare("PRAGMA user_version").get()?.user_version,
      );
      if (version !== 1) throw new Error("BACKUP_SCHEMA_UNSUPPORTED");
    } finally {
      app.close();
    }
    return manifest;
  }
  async restore(id:string):Promise<{restored:string;rollbackId:string;credentialsRequired:true}>{
    return this.exclusive(async()=>{
      await this.validate(id);
      await this.hooks.quiesce();
      let safeToResume=true,closeAttempted=false,journalCreated=false;
      const journal=join(this.dataDir,"restore-journal.json");
      const rollback=join(this.dataDir,`.restore-${randomUUID()}`);
      const targets=[{name:"app.sqlite",path:join(this.dataDir,"app.sqlite")},{name:"pi.sqlite",path:join(this.dataDir,"pi","state.sqlite")}];
      try{
        const rollbackId=(await this.snapshot()).id;
        await mkdir(rollback,{mode:0o700});
        closeAttempted=true;safeToResume=false;
        await this.hooks.closeStores();
        for(const target of targets){
          await mkdir(dirname(target.path),{recursive:true});
          await copyFile(target.path,join(rollback,target.name));
          await copyFile(join(this.backupDir,id,target.name),`${target.path}.restore`);
        }
        for(const target of targets)checkDatabase(join(rollback,target.name));
        await writeFile(journal,JSON.stringify({version:1,rollback:basename(rollback)}),{mode:0o600,flag:"wx",flush:true});journalCreated=true;
        for(const target of targets){await rm(`${target.path}-wal`,{force:true});await rm(`${target.path}-shm`,{force:true});await rename(`${target.path}.restore`,target.path);}
        await this.hooks.reopenStores();
        safeToResume=true;
        await rm(journal);journalCreated=false;
        this.getStore().audit("owner","backup.restore",id,"completed");
        return{restored:id,rollbackId,credentialsRequired:true};
      }catch(error){
        if(closeAttempted&&!safeToResume){
          try{
            await this.hooks.closeStores();
            if(journalCreated){await recoverInterruptedRestore(this.dataDir);journalCreated=false;}
            await this.hooks.reopenStores();safeToResume=true;
          }catch{throw new Error("RESTORE_RECOVERY_REQUIRED");}
        }
        throw error;
      }finally{
        if(safeToResume){
          for(const target of targets)await rm(`${target.path}.restore`,{force:true});
          if(!journalCreated)await rm(rollback,{recursive:true,force:true});
          await this.hooks.resume();
        }
        // Failed rollback keeps the journal and rollback files, and deliberately stays quiesced.
      }
    });
  }
  diagnostics() {
    const store = this.getStore();
    return {
      schemaVersion: store.schemaVersion,
      maintenance: store.maintenance,
      maintenanceReason: store.maintenance ? "DATABASE_MAINTENANCE" : null,
      node: process.version,
      architecture: process.arch,
      platform: process.platform,
      rssBytes: process.memoryUsage().rss,
      counts: {
        tasks: store.list("tasks").length,
        inbox: store.list("inbox_events").length,
        outbox: store.list("outbox").length,
      },
      secretsIncluded: false,
      contentIncluded: false,
    };
  }
}
