import { expect, test } from "vitest";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxProvider,
  fauxAssistantMessage,
} from "@earendil-works/pi-ai/providers/faux";
import { startDaemon } from "../src/daemon.js";
import { call, waitInput } from "../src/client.js";
import { config } from "../src/config.js";
import { backupData, restoreData } from "../src/backup.js";
import { until } from "./helpers.js";
const exec = promisify(execFile);

test("实际 CLI 与 socket：断线重连、取消、互斥、优雅退出和备份恢复", async () => {
  const parent = await mkdtemp(join(tmpdir(), "orange-cli-"));
  const dir = join(parent, "data");
  const cfg = config({
    ORANGE_DATA_DIR: dir,
    ORANGE_WORKSPACE: parent,
    ORANGE_MODEL: "faux-1",
    ORANGE_SKILLS_DIR: join(parent, "skills"),
  });
  const models = createModels();
  const faux = fauxProvider();
  models.setProvider(faux.provider);
  faux.setResponses([
    async (_c, options) => {
      await new Promise<void>((resolve) =>
        options?.signal?.addEventListener("abort", () => resolve(), {
          once: true,
        }),
      );
      return fauxAssistantMessage("已取消");
    },
    fauxAssistantMessage("客户端重连后回答"),
  ]);
  let service = await startDaemon(cfg, { models, provider: "faux" });
  const env = { ...process.env, ORANGE_DATA_DIR: dir };
  try {
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(cfg.socket)).mode & 0o777).toBe(0o600);
    await expect(
      startDaemon(cfg, { models, provider: "faux" }),
    ).rejects.toThrow("另一个服务");
    const created = JSON.parse(
      (
        await exec(
          process.execPath,
          ["--import", "tsx", "src/cli.ts", "new", "CLI验收"],
          { env },
        )
      ).stdout,
    );
    const input = await call<any>(cfg, "input.submit", {
      conversationId: created.id,
      requestId: "disconnected",
      content: "可取消任务",
    });
    await until(
      async () => faux.state.callCount,
      (n) => n === 1,
    );
    await call(cfg, "conversation.cancel", { id: created.id });
    expect((await call<any>(cfg, "input.get", { id: input.id })).status).toBe(
      "unanswered",
    );
    const second = await call<any>(cfg, "input.submit", {
      conversationId: created.id,
      requestId: "second",
      content: "断线后完成",
    });
    const answered = await waitInput(cfg, second.id);
    expect(answered.answerText).toBe("客户端重连后回答");
    const queried = JSON.parse(
      (
        await exec(
          process.execPath,
          ["--import", "tsx", "src/cli.ts", "input", String(second.id)],
          { env },
        )
      ).stdout,
    );
    expect(queried.status).toBe("done");
    await call(cfg, "memory.save", {
      id: "backup-memory",
      content: "备份恢复偏好",
    });
    await call(cfg, "reminder.create", {
      id: "backup-reminder",
      at: new Date(Date.now() + 86400000).toISOString(),
      text: "恢复后的提醒",
      timezone: "UTC",
    });
    const scheduled = await call<any>(cfg, "schedule.create", {
      name: "备份调度",
      prompt: "恢复后执行",
      cron: "0 8 * * *",
      timezone: "Asia/Shanghai",
    });
    await expect(backupData(cfg, join(parent, "busy-backup"))).rejects.toThrow(
      "另一个服务",
    );
    await call(cfg, "daemon.stop");
    await service.closed;
    await backupData(cfg, join(parent, "backup"));
    const restored = {
      ...cfg,
      dataDir: join(parent, "restored"),
      socket: join(parent, "restored", "daemon.sock"),
    };
    await restoreData(restored, join(parent, "backup"));
    await expect(
      restoreData(restored, join(parent, "backup")),
    ).rejects.toThrow();
    service = await startDaemon(restored, { models, provider: "faux" });
    expect(await call(restored, "memory.list")).toEqual([
      expect.objectContaining({ content: "备份恢复偏好" }),
    ]);
    expect(await call(restored, "schedule.list")).toEqual([
      expect.objectContaining({ id: scheduled.id, prompt: "恢复后执行" }),
    ]);
    expect(await call(restored, "reminder.list")).toEqual([
      expect.objectContaining({ id: "backup-reminder", status: "scheduled" }),
    ]);
    expect(
      (await call<any>(restored, "input.get", { id: second.id })).answerText,
    ).toBe("客户端重连后回答");
  } finally {
    await service.stop();
    await rm(parent, { recursive: true, force: true });
  }
});

test("无凭据时提交明确失败，离线记忆与提醒仍可使用", async () => {
  const parent = await mkdtemp(join(tmpdir(), "orange-auth-"));
  const cfg = config({
    ORANGE_DATA_DIR: join(parent, "data"),
    ORANGE_WORKSPACE: parent,
  });
  const previous = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  let service;
  try {
    service = await startDaemon(cfg);
    const c = await call<any>(cfg, "conversation.create");
    await expect(
      call(cfg, "input.submit", {
        conversationId: c.id,
        requestId: "no-key",
        content: "你好",
      }),
    ).rejects.toThrow("凭据");
    await call(cfg, "memory.save", { id: "offline", content: "无需网络" });
    expect(await call(cfg, "memory.list")).toHaveLength(1);
  } finally {
    if (previous !== undefined) process.env.OPENAI_API_KEY = previous;
    await service?.stop();
    await rm(parent, { recursive: true, force: true });
  }
});

test("索引损坏导致启动失败后释放锁，移走可重建索引后能重新启动", async () => {
  const parent = await mkdtemp(join(tmpdir(), "orange-corrupt-"));
  const cfg = config({
    ORANGE_DATA_DIR: join(parent, "data"),
    ORANGE_WORKSPACE: parent,
  });
  let service: Awaited<ReturnType<typeof startDaemon>> | undefined;
  try {
    service = await startDaemon(cfg);
    await call(cfg, "memory.save", {
      id: "preserved",
      content: "原始状态保留",
    });
    await service.stop();
    await writeFile(join(cfg.dataDir, "history.sqlite"), "not a database");
    await expect(startDaemon(cfg)).rejects.toThrow();
    await rm(join(cfg.dataDir, "history.sqlite"));
    service = await startDaemon(cfg);
    expect(await call(cfg, "memory.list")).toEqual([
      expect.objectContaining({ id: "preserved" }),
    ]);
  } finally {
    await service?.stop();
    await rm(parent, { recursive: true, force: true });
  }
});

test("实际 CLI 创建、查询、暂停、手动执行和恢复通用任务", async () => {
  const parent = await mkdtemp(join(tmpdir(), "orange-cli-schedules-"));
  const cfg = config({
    ORANGE_DATA_DIR: join(parent, "data"),
    ORANGE_WORKSPACE: parent,
    ORANGE_MODEL: "faux-1",
    ORANGE_SKILLS_DIR: join(parent, "skills"),
  });
  const models = createModels();
  const faux = fauxProvider();
  models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage("CLI 定时执行结果")]);
  const service = await startDaemon(cfg, {
    models,
    provider: "faux",
    adapters: [],
  });
  const cli = async (...args: string[]) =>
    JSON.parse(
      (
        await exec(
          process.execPath,
          ["--import", "tsx", "src/cli.ts", ...args],
          { env: { ...process.env, ORANGE_DATA_DIR: cfg.dataDir } },
        )
      ).stdout,
    );
  try {
    const args = [
      "schedule",
      "create",
      "请执行自定义提示词",
      "--name",
      "自定义任务",
      "--cron",
      "0 8 * * 1-5",
      "--timezone",
      "Asia/Shanghai",
      "--request-id",
      "create-cli",
    ];
    const job = await cli(...args);
    expect((await cli(...args)).id).toBe(job.id);
    expect(await cli("schedule", "list")).toHaveLength(1);
    expect((await cli("schedule", "pause", job.id)).status).toBe("paused");
    const run = await cli("schedule", "run", job.id, "--request-id", "run-cli");
    await until(
      () => call<any[]>(cfg, "schedule.runs", { id: job.id }),
      (r) => r[0]?.status === "completed",
    );
    expect((await cli("schedule", "runs", job.id))[0]).toMatchObject({
      id: run.id,
      result: "CLI 定时执行结果",
    });
    expect(
      (await cli("schedule", "run", job.id, "--request-id", "run-cli")).id,
    ).toBe(run.id);
    expect(faux.state.callCount).toBe(1);
    expect((await cli("schedule", "resume", job.id)).status).toBe("active");
  } finally {
    await service.stop();
    await rm(parent, { recursive: true, force: true });
  }
});
