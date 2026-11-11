import { expect, test, vi } from "vitest";
import { telegramAdapter } from "../src/channels/telegram.js";
import type { ChannelAdapter, Fetch, Route } from "../src/channels/types.js";

const signal = new AbortController().signal;
const route: Route = { key: "r", platform: "telegram", account: "123", chat: "-100", user: "42", scope: "private", conversationId: 1, contextToken: "", lastInboundAt: 0, messageThreadId: "9", replyToMessageId: "7" };
const update = { update_id: 1, message: { message_id: 7, message_thread_id: 9, chat: { id: -100, type: "supergroup" }, from: { id: 42, is_bot: false }, date: 1, text: "hello" } };

test("Telegram 实现统一契约，校验 getMe、发送及编辑报文", async () => {
  const calls: { method: string; body: any }[] = [];
  const fetcher: Fetch = async (url, init) => {
    const method = String(url).split("/").pop()!;
    calls.push({ method, body: JSON.parse(String(init?.body)) });
    return Response.json({ ok: true, result: method === "getMe" ? { id: 123, is_bot: true } : { message_id: 11 } });
  };
  const adapter: ChannelAdapter = telegramAdapter("123:test", ["42"], undefined, fetcher, true);
  await adapter.connect(signal);
  expect(await adapter.health(signal)).toBe(true);
  expect(adapter.normalizeInbound(update)).toMatchObject({ messageThreadId: "9", messageId: "7", user: "42", chat: "-100" });
  expect(await adapter.send(route, "text", "op", signal)).toEqual({ id: "11" });
  expect(await adapter.edit(route, "11", "edit", signal)).toEqual({ id: "11" });
  expect(calls.map((c) => c.method)).toEqual(["getMe", "getMe", "sendMessage", "editMessageText"]);
  expect(calls[2]!.body).toEqual({ chat_id: "-100", text: "text", message_thread_id: 9, reply_parameters: { message_id: 7, allow_sending_without_reply: true } });
  expect(calls[3]!.body).toEqual({ chat_id: "-100", message_id: 11, text: "edit" });
  adapter.stop();
});

test("入站只接受有效纯文本，拒绝伪造字段及附件", () => {
  const adapter = telegramAdapter("123:test", [], undefined, fetch, true);
  expect(adapter.normalizeInbound(update)).not.toBeNull();
  for (const message of [
    { ...update.message, from: { id: 42, is_bot: "false" } },
    { ...update.message, from: { id: "42" } },
    { ...update.message, chat: { id: {}, type: "supergroup" } },
    { ...update.message, date: "1" },
    { ...update.message, message_thread_id: -1 },
    { ...update.message, message_id: 1.5 },
    { ...update.message, photo: [] },
    { ...update.message, document: {} },
    { ...update.message, text: "x".repeat(4097) },
  ]) expect(adapter.normalizeInbound({ ...update, message })).toBeNull();
  expect(adapter.normalizeInbound(null)).toBeNull();
  expect(telegramAdapter("123:test", []).normalizeInbound(update)).toBeNull();
});

test("非法引用、过长文本和无效编辑 ID 在网络请求前拒绝", async () => {
  const fetcher = vi.fn() as unknown as Fetch;
  const adapter = telegramAdapter("123:test", [], undefined, fetcher);
  for (const bad of ["0", "-1", "1.5", "1e2", "9007199254740992", "x"]) {
    await expect(adapter.send({ ...route, messageThreadId: bad }, "a", "op", signal)).rejects.toMatchObject({ kind: "rejected" });
    await expect(adapter.send({ ...route, replyToMessageId: bad }, "a", "op", signal)).rejects.toMatchObject({ kind: "rejected" });
    await expect(adapter.edit(route, bad, "a", signal)).rejects.toMatchObject({ kind: "rejected" });
  }
  await expect(adapter.send(route, "x".repeat(3501), "op", signal)).rejects.toMatchObject({ kind: "rejected" });
  await expect(adapter.edit(route, "1", "x".repeat(3501), signal)).rejects.toMatchObject({ kind: "rejected" });
  expect(fetcher).not.toHaveBeenCalled();
});

test("stop 中断轮询及等待中的发送；调用者 abort 也能中断", async () => {
  const fetcher: Fetch = (_url, init) => new Promise((_resolve, reject) => {
    const s = init!.signal!;
    if (s.aborted) reject(new Error("aborted"));
    else s.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
  const adapter = telegramAdapter("123:test", [], undefined, fetcher);
  const controller = new AbortController();
  const poll = adapter.poll!("0", signal);
  const send = adapter.send(route, "a", "op", controller.signal);
  const results = Promise.allSettled([poll, send]);
  adapter.stop();
  expect((await results).every((r) => r.status === "rejected")).toBe(true);
  await expect(adapter.send(route, "a", "op", signal)).rejects.toMatchObject({ code: "interrupted" });
  const second = telegramAdapter("123:test", [], undefined, fetcher);
  const pending = second.poll!("0", controller.signal);
  controller.abort();
  await expect(pending).rejects.toMatchObject({ code: "interrupted" });
});

test("健康检查反映 API 失败，停止会中断节流等待", async () => {
  const bad: Fetch = async () => Response.json({ ok: false, error_code: 401 });
  const unhealthy = telegramAdapter("123:test", [], undefined, bad);
  expect(await unhealthy.health(signal)).toBe(false);
  await expect(unhealthy.connect(signal)).rejects.toMatchObject({ kind: "rejected" });

  vi.useFakeTimers();
  try {
    const fetcher = vi.fn(async () => Response.json({ ok: true, result: { message_id: 1 } })) as unknown as Fetch;
    const adapter = telegramAdapter("123:test", [], undefined, fetcher);
    await adapter.send(route, "a", "1", signal);
    const waiting = adapter.send(route, "b", "2", signal);
    adapter.stop();
    await expect(waiting).rejects.toMatchObject({ code: "interrupted" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  } finally { vi.useRealTimers(); }
});

test("并发发送主动限速", async () => {
  vi.useFakeTimers();
  try {
    const fetcher = vi.fn(async () => Response.json({ ok: true, result: { message_id: 1 } })) as unknown as Fetch;
    const adapter = telegramAdapter("123:test", [], undefined, fetcher);
    const first = adapter.send(route, "a", "1", signal);
    const second = adapter.send(route, "b", "2", signal);
    await first;
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(35);
    await second;
    expect(fetcher).toHaveBeenCalledTimes(2);
  } finally { vi.useRealTimers(); }
});
