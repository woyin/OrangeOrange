import { expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { worker } from "./helpers.js";
import { acquireOwnership } from "../src/ownership.js";

test("操作系统锁排斥竞争者，SIGKILL 后自动释放同一 inode 的锁", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orange-lock-"));
  let child;
  try {
    child = await worker(dir, "lock");
    await expect(acquireOwnership(dir)).rejects.toThrow("另一个服务");
    await child.stop();
    const release = await acquireOwnership(dir);
    await release();
  } finally {
    await child?.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
