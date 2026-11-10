import { expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { worker, until } from "./helpers.js";

test("模型请求中 SIGKILL 后重试；输入 ID 跨重启去重", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orange-recover-"));
  let child: Awaited<ReturnType<typeof worker>> | undefined;
  try {
    child = await worker(dir, "runtime", { HANG_MODEL: "1" });
    const conversation = await child.call("conversation.create", {
      name: "恢复测试",
    });
    const input = {
      conversationId: conversation.id,
      requestId: "stable-input",
      content: "恢复验证",
    };
    const submitted = await child.call("input.submit", input);
    await until(async () => child!.messages.some((m) => m.model), Boolean);
    await child.stop();
    child = await worker(dir);
    expect((await child.call("input.submit", input)).id).toBe(submitted.id);
    const answer = await until(
      () => child!.call("input.get", { id: submitted.id }),
      (r) => r.status === "done",
    );
    expect(answer.answerText).toBe("恢复后的回答");
    const history = await child.call("history.list", {
      id: conversation.id,
      limit: 100,
    });
    expect(history.items.filter((e: any) => e.kind === "pi.user")).toHaveLength(
      1,
    );
    await child.stop("SIGTERM");
  } finally {
    await child?.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("休眠任务经 SIGKILL 恢复后交付一次；交付后再崩溃不重复", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orange-remind-"));
  let child: Awaited<ReturnType<typeof worker>> | undefined;
  try {
    child = await worker(dir);
    await child.call("reminder.create", {
      id: "restart-reminder",
      text: "检查发布",
      at: new Date(Date.now() + 400).toISOString(),
      timezone: "Asia/Shanghai",
    });
    await child.stop();
    child = await worker(dir);
    const inbox = await until(
      () => child!.call("inbox.list"),
      (r) => r.length === 1,
    );
    expect(inbox[0].text).toBe("检查发布");
    await child.stop();
    child = await worker(dir);
    expect(await child.call("inbox.list")).toHaveLength(1);
    await child.call("inbox.ack", { id: "restart-reminder" });
    await child.stop();
    child = await worker(dir);
    expect(await child.call("inbox.list")).toHaveLength(0);
    expect(await child.call("inbox.list", { all: true })).toHaveLength(1);
  } finally {
    await child?.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("任务阶段中 SIGKILL：保留检查点，升级定义后迁移并只提交一次结果", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orange-phase-"));
  let child: Awaited<ReturnType<typeof worker>> | undefined;
  try {
    child = await worker(dir, "runtime", {
      HANG_TASK: "1",
      PROBE_VERSION: "1",
    });
    await child.call("probe.create");
    await until(
      async () => child!.messages.some((m) => m.phase === "work"),
      Boolean,
    );
    await child.stop();
    child = await worker(dir, "runtime", { PROBE_VERSION: "2" });
    const memories = await until(
      () => child!.call("memory.list"),
      (r) => r.length === 1,
    );
    expect(memories[0]).toMatchObject({
      id: "checkpoint-result",
      content: "completed-v2",
    });
    expect(child.messages.some((m) => m.migrated)).toBe(true);
    await child.stop();
    child = await worker(dir, "runtime", { PROBE_VERSION: "2" });
    expect(await child.call("memory.list")).toHaveLength(1);
  } finally {
    await child?.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
