import { expect, test } from "vitest";
import { mkdtemp, mkdir, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { ControlStore } from "../src/control/store.js";
import { OperationsService, recoverInterruptedRestore } from "../src/control/operations.js";

type Fault = "none" | "partial-close-once" | "partial-close-persistent" | "missing-rollback";
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "hda-ops-faults-"));
  await mkdir(join(dir, "pi"));
  let store = new ControlStore(dir);
  let pi = new DatabaseSync(join(dir, "pi", "state.sqlite"));
  const handles: Array<{ close(): void }> = [store, pi];
  pi.exec("CREATE TABLE probe(value TEXT); INSERT INTO probe VALUES('old');");
  let fault: Fault = "none", fired = false, paused = false, resumes = 0, reopens = 0;
  const service = new OperationsService(() => store, dir, {
    quiesce: async () => { paused = true; },
    resume: async () => { paused = false; resumes++; },
    piBackup: async (destination) => { await backup(pi, destination); },
    closeStores: async () => {
      store.close();
      if (fault === "partial-close-persistent" || (fault === "partial-close-once" && !fired)) {
        fired = true;
        throw new Error("PARTIAL_CLOSE");
      }
      try { pi.close(); } catch { /* A previous close may have completed. */ }
    },
    reopenStores: async () => {
      reopens++;
      if (fault === "missing-rollback" && !fired) {
        fired = true;
        const journal = JSON.parse(await readFile(join(dir, "restore-journal.json"), "utf8"));
        await rm(join(dir, journal.rollback, "app.sqlite"));
        throw new Error("REOPEN_FAILURE");
      }
      store = new ControlStore(dir);
      handles.push(store);
      pi = new DatabaseSync(join(dir, "pi", "state.sqlite"));
      handles.push(pi);
    },
  });
  return {
    dir, service,
    get store() { return store; },
    get pi() { return pi; },
    get paused() { return paused; },
    get resumes() { return resumes; },
    get reopens() { return reopens; },
    arm(next: Fault) { fault = next; fired = false; },
    async close() {
      for (const handle of handles) try { handle.close(); } catch {}
      await rm(dir, { recursive: true, force: true });
    },
  };
}

for (const fault of ["partial-close-once", "partial-close-persistent"] as const) {
  test(`恢复关闭一半后抛错：${fault} 只能完整恢复或保持停写`, async () => {
    const app = await fixture();
    try {
      app.store.put("tasks", "t", { state: "old" });
      const original = await app.service.createBackup();
      app.store.put("tasks", "t", { state: "current" });
      app.pi.exec("UPDATE probe SET value='current';");
      const resumes = app.resumes;
      app.arm(fault);
      await expect(app.service.restore(original.id)).rejects.toThrow(
        fault === "partial-close-once" ? "PARTIAL_CLOSE" : "RESTORE_RECOVERY_REQUIRED",
      );
      if (fault === "partial-close-once") {
        expect(app.paused).toBe(false);
        expect(app.resumes).toBe(resumes + 1);
        expect(app.reopens).toBe(1);
        expect(app.store.get("tasks", "t")).toEqual({ state: "current" });
        expect(app.pi.prepare("SELECT value FROM probe").get()?.value).toBe("current");
      } else {
        expect(app.paused).toBe(true);
        expect(app.resumes).toBe(resumes);
        expect(app.reopens).toBe(0);
      }
    } finally { await app.close(); }
  });
}

test("回滚副本缺失时保留journal及其余副本，不重开数据库或恢复worker", async () => {
  const app = await fixture();
  try {
    app.store.put("tasks", "t", { state: "old" });
    const original = await app.service.createBackup();
    app.store.put("tasks", "t", { state: "current" });
    app.pi.exec("UPDATE probe SET value='current';");
    const resumes = app.resumes;
    app.arm("missing-rollback");
    await expect(app.service.restore(original.id)).rejects.toThrow("RESTORE_RECOVERY_REQUIRED");
    expect(app.paused).toBe(true);
    expect(app.resumes).toBe(resumes);
    expect(app.reopens).toBe(1);
    const journalPath = join(app.dir, "restore-journal.json");
    const journalText = await readFile(journalPath, "utf8");
    const journal = JSON.parse(journalText);
    expect(await readdir(join(app.dir, journal.rollback))).toContain("pi.sqlite");
    // A restart must also refuse an incomplete rollback before it modifies either target.
    const appBefore = await readFile(join(app.dir, "app.sqlite"));
    const piBefore = await readFile(join(app.dir, "pi", "state.sqlite"));
    await expect(recoverInterruptedRestore(app.dir)).rejects.toThrow();
    expect(await readFile(journalPath, "utf8")).toBe(journalText);
    expect(await readFile(join(app.dir, "app.sqlite"))).toEqual(appBefore);
    expect(await readFile(join(app.dir, "pi", "state.sqlite"))).toEqual(piBefore);
  } finally { await app.close(); }
});

test("备份删除session时同时清除SQLite文件中的旧页正文", async () => {
  const app = await fixture();
  const marker = "REVIEW_SESSION_MARKER_1234567890";
  try {
    app.store.put("sessions", "session", { csrf: marker, padding: marker.repeat(400) });
    app.store.setSecret("provider", "test-provider-secret");
    app.store.put("tasks", "t", { state: "preserved" });
    app.store.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    expect((await readFile(app.store.dbPath)).includes(Buffer.from(marker))).toBe(true);
    const manifest = await app.service.createBackup();
    const path = join(app.dir, "backups", manifest.id, "app.sqlite");
    expect((await readFile(path)).includes(Buffer.from(marker))).toBe(false);
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      expect(db.prepare("PRAGMA integrity_check").get()?.integrity_check).toBe("ok");
      expect(db.prepare("SELECT count(*) AS n FROM entities WHERE kind='sessions'").get()?.n).toBe(0);
      expect(db.prepare("SELECT count(*) AS n FROM secrets").get()?.n).toBe(0);
      expect(db.prepare("SELECT value FROM entities WHERE kind='tasks' AND id='t'").get()?.value).toBe(JSON.stringify({ state: "preserved" }));
    } finally { db.close(); }
    expect(app.store.get<{ csrf: string }>("sessions", "session")?.csrf).toBe(marker);
    expect(app.store.getSecret("provider")).toBe("test-provider-secret");
  } finally { await app.close(); }
});
