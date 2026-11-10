import { expect, test } from "vitest";
import { mkdtemp, mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { ControlStore } from "../src/control/store.js";
import {
  OperationsService,
  recoverInterruptedRestore,
} from "../src/control/operations.js";
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "hda-ops-"));
  await mkdir(join(dir, "pi"));
  let store = new ControlStore(dir),
    pi = new DatabaseSync(join(dir, "pi", "state.sqlite")),
    closed = false;
  pi.exec(
    "CREATE TABLE probe(value TEXT); INSERT INTO probe VALUES('original');",
  );
  let paused = false,
    fail = false;
  const service = new OperationsService(() => store, dir, {
    quiesce: async () => {
      paused = true;
    },
    resume: async () => {
      paused = false;
    },
    piBackup: async (path) => {
      expect(paused).toBe(true);
      await backup(pi, path);
    },
    closeStores: async () => {
      if (!closed) {
        store.close();
        pi.close();
        closed = true;
      }
    },
    reopenStores: async () => {
      if (fail) {
        fail = false;
        throw new Error("SIMULATED_REOPEN_FAILURE");
      }
      store = new ControlStore(dir);
      pi = new DatabaseSync(join(dir, "pi", "state.sqlite"));
      closed = false;
    },
  });
  return {
    dir,
    service,
    get store() {
      return store;
    },
    get pi() {
      return pi;
    },
    get paused() {
      return paused;
    },
    failReopen() {
      fail = true;
    },
    async close() {
      if (!closed) {
        store.close();
        pi.close();
      }
      await rm(dir, { recursive: true, force: true });
    },
  };
}
test("活动app和Pi数据库通过SQLite在线快照保存，凭据及会话不进入备份", async () => {
  const app = await fixture();
  try {
    app.store.put("tasks", "t", {
      id: "t",
      status: "RUNNING",
      goal: "private task",
    });
    app.store.setSecret("provider", "test-secret-never-export");
    app.store.put("sessions", "s", { tokenHash: "secret-session" });
    const manifest = await app.service.createBackup();
    expect(app.paused).toBe(false);
    expect(manifest.files.map((f) => f.name).sort()).toEqual([
      "app.sqlite",
      "pi.sqlite",
    ]);
    const db = new DatabaseSync(
      join(app.dir, "backups", manifest.id, "app.sqlite"),
      { readOnly: true },
    );
    expect(db.prepare("PRAGMA integrity_check").get()?.integrity_check).toBe(
      "ok",
    );
    expect(db.prepare("SELECT count(*) n FROM secrets").get()?.n).toBe(0);
    expect(
      db.prepare("SELECT count(*) n FROM entities WHERE kind='sessions'").get()
        ?.n,
    ).toBe(0);
    db.close();
    expect(app.store.getSecret("provider")).toBe("test-secret-never-export");
    expect(await app.service.listBackups()).toHaveLength(1);
    const diag = JSON.stringify(app.service.diagnostics());
    expect(diag).not.toContain("private task");
    expect(diag).not.toContain("test-secret-never-export");
  } finally {
    await app.close();
  }
});
test("恢复前生成快照并恢复两库，损坏校验拒绝且保留当前状态", async () => {
  const app = await fixture();
  try {
    app.store.put("tasks", "t", { id: "t", status: "QUEUED" });
    const original = await app.service.createBackup();
    app.store.put("tasks", "t", { id: "t", status: "SUCCEEDED" });
    app.pi.exec("UPDATE probe SET value='new';");
    const result = await app.service.restore(original.id);
    expect(result.rollbackId).not.toBe(original.id);
    expect(app.store.get("tasks", "t")).toMatchObject({ status: "QUEUED" });
    expect(app.pi.prepare("SELECT value FROM probe").get()?.value).toBe(
      "original",
    );
    expect(app.paused).toBe(false);
    const bytes = await readFile(
      join(app.dir, "backups", original.id, "app.sqlite"),
    );
    await writeFile(
      join(app.dir, "backups", original.id, "app.sqlite"),
      Buffer.concat([bytes, Buffer.from("corrupt")]),
    );
    await expect(app.service.restore(original.id)).rejects.toThrow("CHECKSUM");
    expect(app.store.get("tasks", "t")).toMatchObject({ status: "QUEUED" });
    await expect(app.service.restore("../../etc")).rejects.toThrow(
      "INVALID_BACKUP_ID",
    );
  } finally {
    await app.close();
  }
});
test("恢复后的reopen失败会回滚原两库并重新恢复worker", async () => {
  const app = await fixture();
  try {
    app.store.put("tasks", "t", { status: "QUEUED" });
    const original = await app.service.createBackup();
    app.store.put("tasks", "t", { status: "SUCCEEDED" });
    app.pi.exec("UPDATE probe SET value='new';");
    app.failReopen();
    await expect(app.service.restore(original.id)).rejects.toThrow(
      "SIMULATED_REOPEN_FAILURE",
    );
    expect(app.store.get("tasks", "t")).toMatchObject({ status: "SUCCEEDED" });
    expect(app.pi.prepare("SELECT value FROM probe").get()?.value).toBe("new");
    expect(app.paused).toBe(false);
  } finally {
    await app.close();
  }
});

test("替换数据库中途进程退出后，启动恢复使用持久journal回滚两库", async () => {
  const app = await fixture();
  let closed = false;
  try {
    app.store.put("tasks", "t", { status: "RUNNING" });
    const backupDir = join(
      app.dir,
      ".restore-11111111-1111-4111-8111-111111111111",
    );
    await mkdir(backupDir);
    await backup(app.store.db, join(backupDir, "app.sqlite"));
    await backup(app.pi, join(backupDir, "pi.sqlite"));
    app.store.put("tasks", "t", { status: "BROKEN_MIXED" });
    app.pi.exec("UPDATE probe SET value='mixed';");
    await writeFile(
      join(app.dir, "restore-journal.json"),
      JSON.stringify({
        version: 1,
        rollback: ".restore-11111111-1111-4111-8111-111111111111",
      }),
    );
    app.store.close();
    app.pi.close();
    closed = true;
    expect(await recoverInterruptedRestore(app.dir)).toBe(true);
    const store = new ControlStore(app.dir),
      pi = new DatabaseSync(join(app.dir, "pi", "state.sqlite"));
    try {
      expect(store.get("tasks", "t")).toMatchObject({ status: "RUNNING" });
      expect(pi.prepare("SELECT value FROM probe").get()?.value).toBe(
        "original",
      );
    } finally {
      store.close();
      pi.close();
    }
    expect(await recoverInterruptedRestore(app.dir)).toBe(false);
  } finally {
    if (closed) await rm(app.dir, { recursive: true, force: true });
    else await app.close();
  }
});
