import { expect, test } from "vitest";
import { setup, until, worker } from "./helpers.js";
import { openGateway } from "../src/gateway.js";
import { GatewayState } from "../src/gateway-state.js";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import {
  SendFailure,
  type Adapter,
  type Inbound,
} from "../src/channels/types.js";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
const event = (user = "alice", id = "one"): Inbound => ({
  platform: "telegram",
  account: "bot",
  user,
  chat: user,
  id,
  text: "请回答",
  timestamp: Date.now(),
});
function adapter(send: Adapter["send"], maxLength = 3500): Adapter {
  return {
    platform: "telegram",
    account: "bot",
    allowedUsers: ["alice", "bob"],
    maxLength,
    send,
  };
}

test("渠道接收去重、授权、隔离路由和 /new 快照", async () => {
  const app = await setup();
  const sent: { chat: string; text: string }[] = [];
  const gateway = await openGateway(app.runtime, [
    adapter(async (route, text) => {
      sent.push({ chat: route.chat, text });
      return { id: String(sent.length) };
    }),
  ]);
  try {
    await app.runtime.dispatch("memory.save", {
      id: "private",
      scope: "telegram:bot:alice",
      content: "AliceSecret",
    });
    expect(await gateway.receive(event("mallory"))).toEqual({
      accepted: false,
    });
    const admitted = await gateway.receive(event());
    expect(await gateway.receive(event())).toMatchObject({
      accepted: true,
      duplicate: true,
      id: admitted.id,
    });
    await until(
      () => gateway.control("deliveries.list") as Promise<any[]>,
      (rows) => rows.length === 1 && rows[0].status === "sent",
    );
    expect(sent).toHaveLength(1);
    expect(app.faux.state.callCount).toBe(1);
    await gateway.receive(event("bob"));
    await until(
      () => gateway.control("deliveries.list") as Promise<any[]>,
      (rows) => rows.length === 2 && rows.every((r) => r.status === "sent"),
    );
    const state = (await app.runtime.harness.snapshot(GatewayState, ctx))!;
    const alice = Object.values(state.routes).find((r) => r.user === "alice")!;
    const bob = Object.values(state.routes).find((r) => r.user === "bob")!;
    expect(alice.conversationId).not.toBe(bob.conversationId);
    expect(
      (
        (await app.runtime.dispatch("conversation.state", {
          id: alice.conversationId,
        })) as any
      ).profile.memory[0].content,
    ).toBe("AliceSecret");
    expect(
      (
        (await app.runtime.dispatch("conversation.state", {
          id: bob.conversationId,
        })) as any
      ).profile.memory,
    ).toEqual([]);
    await app.runtime.dispatch("memory.save", {
      id: "new",
      scope: alice.scope,
      content: "更新偏好",
    });
    await gateway.receive({ ...event("alice", "new-session"), text: "/new" });
    const next = (await app.runtime.harness.snapshot(GatewayState, ctx))!
      .routes[alice.key]!;
    expect(next.conversationId).not.toBe(alice.conversationId);
    expect(
      (
        (await app.runtime.dispatch("conversation.state", {
          id: next.conversationId,
        })) as any
      ).profile.memory,
    ).toHaveLength(2);
    expect(app.faux.state.callCount).toBe(2);
  } finally {
    await gateway.close();
    await app.cleanup();
  }
});

test("分段投递结果未知时不自动重发，重启后人工重试只发送未确认段", async () => {
  const app = await setup();
  app.faux.setResponses([fauxAssistantMessage("abcdef")]);
  const sent: string[] = [];
  let uncertain = true;
  const transport = adapter(async (_route, text) => {
    sent.push(text);
    if (text === "def" && uncertain)
      throw new SendFailure("unknown", "network_result_unknown");
    return { id: `remote-${sent.length}` };
  }, 3);
  let gateway = await openGateway(app.runtime, [transport]);
  try {
    const accepted = await gateway.receive(event());
    const deliveries = await until(
      () => gateway.control("deliveries.list") as Promise<any[]>,
      (r) => r[0]?.status === "unknown",
    );
    expect(deliveries[0].part).toBe(1);
    expect(sent).toEqual(["abc", "def"]);
    await gateway.close();
    await app.reopen();
    gateway = await openGateway(app.runtime, [transport]);
    expect(
      ((await gateway.control("deliveries.list")) as any[])[0].status,
    ).toBe("unknown");
    expect(sent).toEqual(["abc", "def"]);
    uncertain = false;
    await gateway.control("delivery.retry", { id: accepted.id });
    await until(
      () => gateway.control("deliveries.list") as Promise<any[]>,
      (r) => r[0]?.status === "sent",
    );
    expect(sent).toEqual(["abc", "def", "def"]);
    expect(app.faux.state.callCount).toBe(1);
    await expect(
      gateway.control("delivery.retry", { id: accepted.id }),
    ).rejects.toThrow("只能");
  } finally {
    await gateway.close();
    await app.cleanup();
  }
});

test("消息平台提醒保留来源路由，进入独立投递状态，已读不自动变化", async () => {
  const app = await setup();
  const sent: string[] = [];
  const gateway = await openGateway(app.runtime, [
    adapter(async (_r, text) => {
      sent.push(text);
      return { id: String(sent.length) };
    }),
  ]);
  try {
    await gateway.receive(event());
    await until(
      () => gateway.control("deliveries.list") as Promise<any[]>,
      (r) => r[0]?.status === "sent",
    );
    const route = Object.values(
      (await app.runtime.harness.snapshot(GatewayState, ctx))!.routes,
    )[0]!;
    await app.runtime.harness.commit(async (tx) => {
      const { AppState } = await import("../src/state.js");
      (await tx.doc(AppState)).notices.push({
        id: "notice",
        text: "检查发布",
        scope: route.scope,
        routeKey: route.key,
        at: Date.now(),
        status: "unread",
      });
    }, ctx);
    await gateway.syncNotices();
    await gateway.syncNotices();
    await until(
      () => gateway.control("deliveries.list") as Promise<any[]>,
      (r) => r.length === 2 && r.every((d) => d.status === "sent"),
    );
    expect(sent.filter((t) => t === "提醒：检查发布")).toHaveLength(1);
    expect(
      await app.runtime.dispatch("inbox.list", { scope: route.scope }),
    ).toHaveLength(1);
    expect(await app.runtime.dispatch("inbox.list")).toHaveLength(0);
  } finally {
    await gateway.close();
    await app.cleanup();
  }
});

test("发送进行中 SIGKILL 后标为 unknown，不重新调用发送接口或模型", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orange-send-"));
  let child: Awaited<ReturnType<typeof worker>> | undefined;
  try {
    child = await worker(dir, "runtime", { GATEWAY_TEST: "1", HANG_SEND: "1" });
    const accepted = await child.call("gateway.receive", event());
    await until(
      async () => child!.messages.some((m) => m.externalSend),
      Boolean,
    );
    await child.stop();
    child = await worker(dir, "runtime", { GATEWAY_TEST: "1" });
    const rows = await until(
      () => child!.call("deliveries.list"),
      (r) => r[0]?.status === "unknown",
    );
    expect(rows[0].id).toBe(accepted.id);
    expect(child.messages.some((m) => m.externalSend || m.model)).toBe(false);
  } finally {
    await child?.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("同一会话的分段回复保持顺序，不与后续回复交错", async () => {
  const app = await setup();
  app.faux.setResponses([
    fauxAssistantMessage("abcdef"),
    fauxAssistantMessage("uvwxyz"),
  ]);
  const sent: string[] = [];
  const gateway = await openGateway(app.runtime, [
    adapter(async (_route, text) => {
      sent.push(text);
      return { id: String(sent.length) };
    }, 3),
  ]);
  try {
    await gateway.receive(event("alice", "first"));
    await gateway.receive(event("alice", "second"));
    await until(
      () => gateway.control("deliveries.list") as Promise<any[]>,
      (rows) => rows.length === 2 && rows.every((r) => r.status === "sent"),
    );
    expect(sent).toEqual(["abc", "def", "uvw", "xyz"]);
  } finally {
    await gateway.close();
    await app.cleanup();
  }
});

test("轮询游标只在消息持久化后推进，重启后恢复游标且不重复模型执行", async () => {
  const app = await setup();
  let seen: string[] = [];
  const transport: Adapter = {
    ...adapter(async () => ({ id: "remote" })),
    poll: async (cursor, signal) => {
      seen.push(cursor);
      if (seen.length === 1)
        return { messages: [event()], cursor: "checkpoint" };
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return { messages: [], cursor };
    },
  };
  let gateway = await openGateway(app.runtime, [transport]);
  try {
    gateway.start();
    await until(async () => seen.includes("checkpoint"), Boolean);
    await until(
      () => gateway.control("deliveries.list") as Promise<any[]>,
      (r) => r[0]?.status === "sent",
    );
    expect(app.faux.state.callCount).toBe(1);
    await gateway.close();
    await app.reopen();
    seen = [];
    gateway = await openGateway(app.runtime, [transport]);
    gateway.start();
    await until(async () => seen.length >= 2, Boolean);
    expect(seen[0]).toBe("checkpoint");
    expect(app.faux.state.callCount).toBe(1);
  } finally {
    await gateway.close();
    await app.cleanup();
  }
});

test("移除授权后，不向该用户发送已经排队的回复", async () => {
  const app = await setup();
  let release!: () => void;
  let started = false;
  let sends = 0;
  app.faux.setResponses([
    async () => {
      started = true;
      await new Promise<void>((resolve) => (release = resolve));
      return fauxAssistantMessage("私有内容");
    },
  ]);
  const transport = adapter(async () => {
    sends++;
    return { id: "remote" };
  });
  const gateway = await openGateway(app.runtime, [transport]);
  try {
    await gateway.receive(event());
    await until(async () => started, Boolean);
    transport.allowedUsers = ["bob"];
    release();
    const rows = await until(
      () => gateway.control("deliveries.list") as Promise<any[]>,
      (r) => r[0]?.status === "failed",
    );
    expect(rows[0].error).toBe("recipient_not_authorized");
    expect(sends).toBe(0);
  } finally {
    release?.();
    await gateway.close();
    await app.cleanup();
  }
});

test("明确限流响应只进行有限重试，失败后等待人工处理", async () => {
  const app = await setup();
  let attempts = 0;
  const gateway = await openGateway(app.runtime, [
    adapter(async () => {
      attempts++;
      throw new SendFailure("rate_limited", "rate_limited", 1);
    }),
  ]);
  try {
    await gateway.receive(event());
    const rows = await until(
      () => gateway.control("deliveries.list") as Promise<any[]>,
      (r) => r[0]?.status === "failed",
    );
    expect(attempts).toBe(3);
    expect(rows[0].attempts).toBe(3);
  } finally {
    await gateway.close();
    await app.cleanup();
  }
});
