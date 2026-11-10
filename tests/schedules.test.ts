import { expect, test } from "vitest";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import {
  UsageDoc,
  type ConversationId,
  type SubmissionId,
} from "@earendil-works/pi-durable";
import { nextOccurrence, type Job, type Run } from "../src/schedules.js";
import { setup, until, worker } from "./helpers.js";
import { createWeb } from "../src/web.js";
import { openGateway } from "../src/gateway.js";

const later = () => new Date(Date.now() + 3600000).toISOString();
async function runs(app: Awaited<ReturnType<typeof setup>>, id: string) {
  return app.runtime.dispatch("schedule.runs", { id }) as Promise<Run[]>;
}

test("五段 cron 使用 IANA 时区，跳过周末并正确处理夏令时", () => {
  expect(
    new Date(
      nextOccurrence(
        "0 9 * * 1-5",
        "America/New_York",
        Date.parse("2025-03-07T15:00:00Z"),
      ),
    ).toISOString(),
  ).toBe("2025-03-10T13:00:00.000Z");
  expect(
    new Date(
      nextOccurrence(
        "0 8 * * *",
        "Asia/Shanghai",
        Date.parse("2025-01-01T00:00:00Z"),
      ),
    ).toISOString(),
  ).toBe("2025-01-02T00:00:00.000Z");
  expect(() => nextOccurrence("* * * * * *", "UTC", Date.now())).toThrow(
    "五段",
  );
  expect(() => nextOccurrence("0 8 * * *", "invalid", Date.now())).toThrow();
});

test("通用提示词运行真实工具循环，使用最新记忆，并把结果持久化到收件箱", async () => {
  const app = await setup();
  try {
    await writeFile(join(app.cfg.workspace, "project.txt"), "项目证据 9021");
    const job = (await app.runtime.dispatch("schedule.create", {
      name: "项目回顾",
      prompt: "读取 project.txt 并总结",
      at: later(),
      requestId: "create-1",
    })) as Job;
    expect(
      (
        (await app.runtime.dispatch("schedule.create", {
          name: "项目回顾",
          prompt: "读取 project.txt 并总结",
          at:
            job.rule.kind === "once" ? new Date(job.rule.at).toISOString() : "",
          requestId: "create-1",
        })) as Job
      ).id,
    ).toBe(job.id);
    await app.runtime.dispatch("memory.save", {
      id: "style",
      content: "简明回答",
      kind: "preference",
    });
    app.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("read_file", { path: "project.txt" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("项目证据 9021：已完成回顾"),
    ]);
    const command = { id: job.id, requestId: "run-1" };
    const admitted = (await app.runtime.dispatch("schedule.run", command)) as {
      id: string;
    };
    const result = await until(
      () => runs(app, job.id),
      (r) => r[0]?.status === "completed",
    );
    expect(result[0]?.result).toContain("9021");
    expect(result[0]?.conversationId).toBeGreaterThan(0);
    const c = (await app.runtime.dispatch("conversation.state", {
      id: result[0]!.conversationId,
    })) as any;
    expect(c.profile.memory[0].content).toBe("简明回答");
    expect(await app.runtime.dispatch("inbox.list")).toEqual([
      expect.objectContaining({
        id: `task:${admitted.id}`,
        kind: "task",
        text: expect.stringContaining("9021"),
      }),
    ]);
    expect(
      ((await app.runtime.dispatch("schedule.run", command)) as any).id,
    ).toBe(admitted.id);
    expect(app.faux.state.callCount).toBe(2);
    await app.reopen();
    expect((await runs(app, job.id))[0]?.result).toContain("9021");
    expect(await app.runtime.dispatch("inbox.list")).toHaveLength(1);
  } finally {
    await app.cleanup();
  }
});

test("暂停阻止到期执行，恢复可执行一次性任务；身份隔离且拒绝重叠", async () => {
  let clock = Date.now();
  const wall = Date.now();
  const app = await setup({ now: () => clock + Date.now() - wall });
  let release: () => void = () => {};
  try {
    const job = (await app.runtime.dispatch("schedule.create", {
      name: "测试",
      prompt: "回答",
      at: new Date(clock + 60000).toISOString(),
      scope: "alice",
    })) as Job;
    expect(
      await app.runtime.dispatch("schedule.list", { scope: "bob" }),
    ).toEqual([]);
    await expect(
      app.runtime.dispatch("schedule.run", { id: job.id, scope: "bob" }),
    ).rejects.toThrow("不存在");
    await app.runtime.dispatch("schedule.pause", {
      id: job.id,
      scope: "alice",
    });
    clock += 120000;
    await app.reopen();
    expect(
      await app.runtime.dispatch("schedule.runs", {
        id: job.id,
        scope: "alice",
      }),
    ).toEqual([]);
    app.faux.setResponses([
      async () => {
        await new Promise<void>((resolve) => (release = resolve));
        return fauxAssistantMessage("结束");
      },
    ]);
    await app.runtime.dispatch("schedule.resume", {
      id: job.id,
      scope: "alice",
    });
    await until(
      () =>
        app.runtime.dispatch("schedule.runs", {
          id: job.id,
          scope: "alice",
        }) as Promise<Run[]>,
      (r) => r[0]?.status === "running",
    );
    await expect(
      app.runtime.dispatch("schedule.run", { id: job.id, scope: "alice" }),
    ).rejects.toThrow("重叠");
    await app.runtime.dispatch("schedule.cancel", {
      id: job.id,
      scope: "alice",
    });
    release();
    const results = await until(
      () =>
        app.runtime.dispatch("schedule.runs", {
          id: job.id,
          scope: "alice",
        }) as Promise<Run[]>,
      (r) => r[0]?.status === "cancelled",
    );
    expect(results[0]?.error).toBe("用户取消");
  } finally {
    release();
    await app.cleanup();
  }
});

test("停机错过多个周期只补跑一次，下一次在当前时间之后", async () => {
  let clock = Date.parse("2025-01-01T07:59:00Z");
  const wall = Date.now();
  const app = await setup({ now: () => clock + Date.now() - wall });
  try {
    const job = (await app.runtime.dispatch("schedule.create", {
      name: "每日",
      prompt: "回答",
      cron: "0 8 * * *",
      timezone: "UTC",
    })) as Job;
    clock = Date.parse("2025-01-04T09:00:00Z");
    await app.reopen();
    const result = await until(
      () => runs(app, job.id),
      (r) => r[0]?.status === "completed",
    );
    expect(result).toHaveLength(1);
    const updated = (await app.runtime.dispatch("schedule.get", {
      id: job.id,
    })) as Job;
    expect(new Date(updated.nextAt).toISOString()).toBe(
      "2025-01-05T08:00:00.000Z",
    );
    expect(app.faux.state.callCount).toBe(1);
    await app.reopen();
    expect(await runs(app, job.id)).toHaveLength(1);
    expect(app.faux.state.callCount).toBe(1);
  } finally {
    await app.cleanup();
  }
});

test("运行超时会中止模型并释放重叠锁", async () => {
  let offset = 0;
  const app = await setup({ now: () => Date.now() + offset });
  let started = false;
  try {
    app.faux.setResponses([
      async (_context, options) => {
        started = true;
        await new Promise<void>((resolve) =>
          options?.signal?.addEventListener("abort", () => resolve(), {
            once: true,
          }),
        );
        return fauxAssistantMessage("已终止");
      },
    ]);
    const job = (await app.runtime.dispatch("schedule.create", {
      name: "超时",
      prompt: "回答",
      at: later(),
      timeoutSeconds: 10,
    })) as Job;
    await app.runtime.dispatch("schedule.run", { id: job.id });
    await until(async () => started, Boolean);
    offset = 11000;
    const result = await until(
      () => runs(app, job.id),
      (r) => r[0]?.status === "failed",
    );
    expect(result[0]?.error).toBe("执行超时");
    expect(
      ((await app.runtime.dispatch("schedule.get", { id: job.id })) as Job)
        .activeRunId,
    ).toBe("");
  } finally {
    await app.cleanup();
  }
});

test("已报告模型费用达到阈值时中止运行", async () => {
  const app = await setup();
  let started = false;
  try {
    app.faux.setResponses([
      async (_context, options) => {
        started = true;
        await new Promise<void>((resolve) =>
          options?.signal?.addEventListener("abort", () => resolve(), {
            once: true,
          }),
        );
        return fauxAssistantMessage("已终止");
      },
      fauxAssistantMessage("不应调用"),
    ]);
    const job = (await app.runtime.dispatch("schedule.create", {
      name: "费用",
      prompt: "回答",
      at: later(),
      maxCostUsd: 0.01,
    })) as Job;
    await app.runtime.dispatch("schedule.run", { id: job.id });
    await until(async () => started, Boolean);
    const run = (await runs(app, job.id))[0]!;
    await app.runtime.harness.commit(async (tx) => {
      const usage = await tx.doc(
        UsageDoc,
        run.conversationId as ConversationId,
      );
      usage.models["faux/faux-1"] = {
        input: 100,
        output: 10,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 110,
        cost: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, total: 1 },
      };
    }, ctx);
    const result = await until(
      () => runs(app, job.id),
      (r) => r[0]?.status === "failed",
    );
    expect(result[0]!.costUsd).toBe(1);
    expect(result[0]!.error).toContain("费用阈值");
    expect(app.faux.state.callCount).toBe(1);
  } finally {
    await app.cleanup();
  }
});

test("模型在普通对话中创建任务；定时运行不能递归创建其他任务", async () => {
  const app = await setup();
  try {
    app.faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("schedule_create", {
          name: "任务名",
          prompt: "回答",
          cron: "0 8 * * *",
          timezone: "Asia/Shanghai",
        }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("保存成功"),
      fauxAssistantMessage(
        fauxToolCall("schedule_create", {
          name: "递归",
          prompt: "再次创建",
          cron: "* * * * *",
        }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("不能递归创建"),
    ]);
    const c = await app.runtime.createConversation({ name: "原始对话名" });
    const input = (await app.runtime.dispatch("input.submit", {
      conversationId: c.id,
      requestId: "create",
      content: "每天八点执行任务",
    })) as { id: number };
    await (await app.runtime.harness.submission(
      input.id as SubmissionId,
      ctx,
    ))!.wait(ctx);
    const jobs = (await app.runtime.dispatch("schedule.list")) as Job[];
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.name).toBe("任务名");
    await app.runtime.dispatch("schedule.run", { id: jobs[0]!.id });
    const result = await until(
      () => runs(app, jobs[0]!.id),
      (r) => r[0]?.status === "completed",
    );
    expect(await app.runtime.dispatch("schedule.list")).toHaveLength(1);
    const history = await app.runtime.dispatch("history.list", {
      id: result[0]!.conversationId,
      limit: 100,
    });
    expect(JSON.stringify(history)).toContain("定时运行不能创建或改变");
  } finally {
    await app.cleanup();
  }
});

test("SIGKILL 后恢复同一个定时运行、会话与输入，只保存一次结果", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orange-schedule-recover-"));
  let child: Awaited<ReturnType<typeof worker>> | undefined;
  try {
    child = await worker(dir, "runtime", { HANG_MODEL: "1" });
    const job = (await child.call("schedule.create", {
      name: "恢复",
      prompt: "回答",
      at: later(),
    })) as Job;
    const admitted = await child.call("schedule.run", { id: job.id });
    await until(async () => child!.messages.some((m) => m.model), Boolean);
    const before = (await child.call("schedule.runs", { id: job.id }))[0];
    await child.stop();
    child = await worker(dir);
    const result = await until(
      () => child!.call("schedule.runs", { id: job.id }),
      (r) => r[0]?.status === "completed",
    );
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(admitted.id);
    expect(result[0].conversationId).toBe(before.conversationId);
    expect(result[0].submissionId).toBe(before.submissionId);
    const history = await child.call("history.list", {
      id: before.conversationId,
      limit: 100,
    });
    expect(history.items.filter((e: any) => e.kind === "pi.user")).toHaveLength(
      1,
    );
    expect(await child.call("inbox.list")).toHaveLength(1);
    await child.stop();
    child = await worker(dir);
    expect(await child.call("inbox.list")).toHaveLength(1);
  } finally {
    await child?.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("定时提示词可组合在线搜索和网页读取工具，保存来源证据", async () => {
  const visited: string[] = [];
  const web = createWeb("search-test-key", async (url) => {
    visited.push(url);
    return url.startsWith("https://api.search.brave.com/")
      ? {
          url,
          body: JSON.stringify({
            web: {
              results: [
                {
                  title: "科技消息",
                  url: "https://example.com/news",
                  description: "最新消息",
                },
              ],
            },
          }),
          type: "application/json",
        }
      : {
          url,
          body: "<article>技术发布证据 market-317</article>",
          type: "text/html",
        };
  });
  const app = await setup({ web });
  try {
    app.faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("web_search", { query: "科技最新消息", freshness: "pd" }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(
        fauxToolCall("web_fetch", { url: "https://example.com/news" }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(
        "技术发布 market-317，来源：https://example.com/news",
      ),
    ]);
    const job = (await app.runtime.dispatch("schedule.create", {
      name: "任何主题",
      prompt: "搜索并读取来源",
      at: later(),
    })) as Job;
    await app.runtime.dispatch("schedule.run", { id: job.id });
    const result = await until(
      () => runs(app, job.id),
      (r) => r[0]?.status === "completed",
    );
    expect(visited).toHaveLength(2);
    expect(result[0]?.result).toContain("market-317");
    const history = JSON.stringify(
      await app.runtime.dispatch("history.list", {
        id: result[0]!.conversationId,
        limit: 100,
      }),
    );
    expect(history).toContain("retrievedAt");
    expect(history).toContain("market-317");
    expect(history).not.toContain("search-test-key");
  } finally {
    await app.cleanup();
  }
});

test("指定来源会话的任务完成后向原私聊投递一次", async () => {
  const app = await setup();
  const sent: { chat: string; text: string }[] = [];
  const gateway = await openGateway(app.runtime, [
    {
      platform: "telegram",
      account: "bot",
      allowedUsers: ["alice", "bob"],
      maxLength: 3500,
      send: async (route, text) => {
        sent.push({ chat: route.chat, text });
        return { id: String(sent.length) };
      },
    },
  ]);
  try {
    await gateway.receive({
      platform: "telegram",
      account: "bot",
      user: "alice",
      chat: "alice",
      id: "new",
      text: "/new",
      timestamp: Date.now(),
    });
    await until(
      async () => sent.length,
      (n) => n === 1,
    );
    sent.length = 0;
    const conversations = (await app.runtime.dispatch("conversation.list", {
      scope: "telegram:bot:alice",
    })) as any[];
    const job = (await app.runtime.dispatch("schedule.create", {
      name: "渠道任务",
      prompt: "回答",
      at: later(),
      conversationId: conversations[0].id,
    })) as Job;
    app.faux.setResponses([fauxAssistantMessage("定时结果发送验证")]);
    await app.runtime.dispatch("schedule.run", {
      id: job.id,
      scope: job.scope,
    });
    await until(
      () =>
        app.runtime.dispatch("schedule.runs", {
          id: job.id,
          scope: job.scope,
        }) as Promise<Run[]>,
      (r) => r[0]?.status === "completed",
    );
    await gateway.syncNotices();
    await gateway.syncNotices();
    await until(
      async () => sent.length,
      (n) => n === 1,
    );
    expect(sent[0]).toEqual({
      chat: "alice",
      text: expect.stringContaining("定时结果发送验证"),
    });
    expect(sent[0]!.text.startsWith("提醒：")).toBe(false);
    expect((await gateway.control("deliveries.list")) as any[]).toHaveLength(2);
  } finally {
    await gateway.close();
    await app.cleanup();
  }
});

test("无效时间、冲突规则和预算被拒绝；并发相同操作 ID 不重复创建", async () => {
  const app = await setup();
  try {
    await expect(
      app.runtime.dispatch("schedule.create", {
        prompt: "测试",
        at: "2027-02-30T08:00:00Z",
      }),
    ).rejects.toThrow("日历");
    await expect(
      app.runtime.dispatch("schedule.create", {
        prompt: "测试",
        at: "2027-01-01T08:00:00",
      }),
    ).rejects.toThrow("ISO");
    await expect(
      app.runtime.dispatch("schedule.create", {
        prompt: "测试",
        cron: "0 8 * * *",
        at: later(),
      }),
    ).rejects.toThrow("只能");
    await expect(
      app.runtime.dispatch("schedule.create", {
        prompt: "测试",
        cron: "0 8 * * *",
        maxTurns: 0,
      }),
    ).rejects.toThrow("工具轮数");
    await expect(
      app.runtime.dispatch("schedule.create", {
        prompt: "测试",
        cron: "0 8 * * *",
        maxCostUsd: 100,
      }),
    ).rejects.toThrow("费用阈值");
    const params = {
      prompt: "同一任务",
      cron: "0 8 * * *",
      requestId: "concurrent",
    };
    const jobs = (await Promise.all([
      app.runtime.dispatch("schedule.create", params),
      app.runtime.dispatch("schedule.create", params),
    ])) as Job[];
    expect(jobs[0]!.id).toBe(jobs[1]!.id);
    expect(await app.runtime.dispatch("schedule.list")).toHaveLength(1);
    await expect(
      app.runtime.dispatch("schedule.create", {
        ...params,
        prompt: "不同提示词",
      }),
    ).rejects.toThrow("不同内容");
  } finally {
    await app.cleanup();
  }
});
