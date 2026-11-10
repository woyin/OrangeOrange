import { expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
  createRegistry,
  defineDoc,
  defineExtension,
  defineTask,
  Harness,
  ROOT_CONVERSATION_ID,
  type SubmissionId,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { config } from "../src/config.js";
import { openRuntime } from "../src/runtime.js";
import { setup, until } from "./helpers.js";

test("不同身份的记忆、模型工具、历史和提醒相互隔离", async () => {
  const app = await setup();
  try {
    await app.runtime.dispatch("memory.save", {
      scope: "alice",
      id: "same",
      content: "AliceSecret",
      kind: "preference",
    });
    await app.runtime.dispatch("memory.save", {
      scope: "bob",
      id: "same",
      content: "BobPreference",
      kind: "project",
    });
    const a = (await app.runtime.dispatch("conversation.create", {
      scope: "alice",
    })) as { id: number };
    const b = (await app.runtime.dispatch("conversation.create", {
      scope: "bob",
    })) as { id: number };
    app.faux.setResponses([
      fauxAssistantMessage("私有回答"),
      fauxAssistantMessage(fauxToolCall("memory_list", {}), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("Bob 回答"),
    ]);
    for (const [cid, requestId, content] of [
      [a.id, "a", "AliceSecret 数据"],
      [b.id, "b", "我的记忆"],
    ] as const) {
      const input = (await app.runtime.dispatch("input.submit", {
        conversationId: cid,
        requestId,
        content,
      })) as { id: number };
      await (await app.runtime.harness.submission(
        input.id as SubmissionId,
        ctx,
      ))!.wait(ctx);
    }
    const history = await app.runtime.dispatch("history.list", {
      id: b.id,
      limit: 100,
    });
    expect(JSON.stringify(history)).toContain("BobPreference");
    expect(JSON.stringify(history)).not.toContain("AliceSecret");
    expect(
      await app.runtime.dispatch("history.search", {
        scope: "bob",
        query: "AliceSecret",
      }),
    ).toEqual([]);
    expect(
      await app.runtime.dispatch("history.search", {
        scope: "alice",
        query: "AliceSecret",
      }),
    ).toHaveLength(1);
    expect(
      await app.runtime.dispatch("memory.search", {
        scope: "bob",
        query: "Preference",
      }),
    ).toEqual([
      expect.objectContaining({ id: "same", kind: "project", source: "cli" }),
    ]);
    await app.runtime.dispatch("memory.delete", { scope: "bob", id: "same" });
    expect(
      await app.runtime.dispatch("memory.list", { scope: "alice" }),
    ).toHaveLength(1);
    expect(await app.runtime.dispatch("memory.list", { scope: "bob" })).toEqual(
      [],
    );
    await app.runtime.dispatch("reminder.create", {
      scope: "alice",
      id: "private-reminder",
      text: "私有提醒",
      at: new Date(Date.now() + 60000).toISOString(),
      timezone: "UTC",
    });
    expect(
      await app.runtime.dispatch("reminder.list", { scope: "bob" }),
    ).toEqual([]);
    await expect(
      app.runtime.dispatch("reminder.cancel", {
        scope: "bob",
        id: "private-reminder",
      }),
    ).rejects.toThrow("不存在");
  } finally {
    await app.cleanup();
  }
});

test("重复记忆合并，显式刷新只影响空闲会话，提示词包含渠道和证据约束", async () => {
  const app = await setup();
  try {
    const a = (await app.runtime.dispatch("conversation.create", {
      channel: "telegram",
    })) as { id: number };
    await app.runtime.dispatch("memory.save", {
      id: "one",
      content: "偏好先给结论",
      kind: "preference",
    });
    const duplicate = (await app.runtime.dispatch("memory.save", {
      id: "two",
      content: "偏好先给结论",
      kind: "preference",
    })) as any;
    expect(duplicate.id).toBe("one");
    expect(await app.runtime.dispatch("memory.list")).toHaveLength(1);
    await app.runtime.dispatch("conversation.refresh-memory", { id: a.id });
    let request = "";
    let release!: () => void;
    app.faux.setResponses([
      async (context) => {
        request = JSON.stringify(context.messages);
        await new Promise<void>((resolve) => (release = resolve));
        return fauxAssistantMessage("完成");
      },
    ]);
    const input = (await app.runtime.dispatch("input.submit", {
      conversationId: a.id,
      requestId: "refresh",
      content: "测试提示词",
    })) as { id: number };
    await until(async () => Boolean(request), Boolean);
    expect(request).toContain("偏好先给结论");
    expect(request).toContain("telegram");
    expect(request).toContain("资料");
    await expect(
      app.runtime.dispatch("conversation.refresh-memory", { id: a.id }),
    ).rejects.toThrow("运行中");
    release();
    await (await app.runtime.harness.submission(
      input.id as SubmissionId,
      ctx,
    ))!.wait(ctx);
    await app.runtime.dispatch("memory.delete", { id: "one" });
    await app.runtime.dispatch("conversation.refresh-memory", { id: a.id });
    expect(
      ((await app.runtime.dispatch("conversation.state", { id: a.id })) as any)
        .profile.memory,
    ).toEqual([]);
  } finally {
    await app.cleanup();
  }
});

test("真实 v1 SQLite 的记忆、会话和休眠提醒迁移到 v2 后继续交付", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orange-v1-"));
  const models = createModels();
  const faux = fauxProvider();
  models.setProvider(faux.provider);
  const cfg = config({
    ORANGE_DATA_DIR: dir,
    ORANGE_WORKSPACE: dir,
    ORANGE_MODEL: "faux-1",
  });
  const oldApp = defineDoc<{
    memories: { id: string; content: string; updatedAt: number }[];
    reminders: {
      id: string;
      text: string;
      at: number;
      timezone: string;
      status: "scheduled";
      taskId: number;
    }[];
    notices: [];
  }>({
    kind: "orange.app",
    version: 1,
    scope: "session",
    initial: () => ({ memories: [], reminders: [], notices: [] }),
    checkpointWhen: () => true,
  });
  const oldProfile = defineDoc<{
    name: string;
    workspace: string;
    memory: { id: string; content: string; updatedAt: number }[];
  }>({
    kind: "orange.profile",
    version: 1,
    scope: "conversation",
    history: "latest",
    fork: "initial",
    initial: () => ({ name: "旧会话", workspace: dir, memory: [] }),
    checkpointWhen: () => true,
  });
  const oldTask = defineTask<
    { id: string; at: number },
    { phase: "wait" } | { phase: "deliver" },
    null
  >({
    name: "orange.reminder",
    version: 1,
    initial: () => ({ phase: "wait" }),
    phases: {
      wait: (task, api, context) =>
        api.sleepUntil(task.input.at, { phase: "deliver" }, context),
      deliver: (_task, api, context) =>
        api.commit(
          () => ({
            status: "terminal",
            outcome: { status: "completed", result: null },
          }),
          context,
        ),
    },
    abort: (_task, api, context) =>
      api.commit(
        () => ({ status: "terminal", outcome: { status: "aborted" } }),
        context,
      ),
  });
  let current: Awaited<ReturnType<typeof openRuntime>> | undefined;
  const registry = createRegistry();
  registry.install(defineExtension({ name: "orange", tasks: [oldTask] }));
  const legacy = await Harness.open(
    await openNodeSqliteStorage(join(dir, "state.sqlite")),
    { models, registry },
    ctx,
  );
  try {
    await legacy.root(ctx);
    const memory = { id: "legacy", content: "已有偏好", updatedAt: 123 };
    const c = await legacy.createConversation(
      {
        ownership: { kind: "ownerless" },
        init: async (tx, cid) => {
          const profile = await tx.doc(oldProfile, cid);
          profile.memory.push(memory);
        },
      },
      ctx,
    );
    await legacy.commit(async (tx) => {
      const state = await tx.doc(oldApp);
      state.memories.push(memory);
      const at = Date.now() + 100;
      const taskId = await tx.createTask(
        oldTask,
        { id: "legacy-reminder", at },
        {
          conversationId: ROOT_CONVERSATION_ID,
          ownership: { kind: "conversation" },
          background: true,
        },
      );
      state.reminders.push({
        id: "legacy-reminder",
        text: "旧提醒",
        at,
        timezone: "UTC",
        status: "scheduled",
        taskId,
      });
    }, ctx);
    legacy.resume();
    await legacy.close(ctx);
    current = await openRuntime(cfg, { models, provider: "faux" });
    expect(await current.dispatch("memory.list")).toEqual([
      expect.objectContaining({
        id: "legacy",
        scope: "local",
        kind: "fact",
        source: "legacy",
        createdAt: 123,
      }),
    ]);
    expect(
      ((await current.dispatch("conversation.state", { id: c.id })) as any)
        .profile,
    ).toMatchObject({
      scope: "local",
      channel: "cli",
      memory: [expect.objectContaining({ content: "已有偏好" })],
    });
    const runtime = current;
    expect(
      await until(
        () => runtime.dispatch("inbox.list") as Promise<any[]>,
        (n) => n.length === 1,
      ),
    ).toEqual([expect.objectContaining({ text: "旧提醒", scope: "local" })]);
  } finally {
    await current?.close();
    await legacy.close(ctx);
    await rm(dir, { recursive: true, force: true });
  }
});
