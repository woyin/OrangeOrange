import { expect, test } from "vitest";
import { createHmac } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { telegramAdapter } from "../src/channels/telegram.js";
import {
  whatsappAdapter,
  verifyWhatsApp,
  type WhatsAppConfig,
} from "../src/channels/whatsapp.js";
import { startWhatsAppWebhook } from "../src/channels/webhook.js";
import { weixinAdapter, loginWeixin, ILINK } from "../src/channels/weixin.js";
import {
  chunks,
  type Fetch,
  type Inbound,
  type Route,
} from "../src/channels/types.js";
const signal = new AbortController().signal;
function transport(responses: (object | Error | Response)[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher = (async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    const value = responses.shift();
    if (value instanceof Error) throw value;
    if (value === undefined) throw new Error("unexpected network request");
    return value instanceof Response
      ? value
      : new Response(JSON.stringify(value));
  }) as Fetch;
  return { fetcher, calls };
}
const route: Route = {
  key: "r",
  platform: "telegram",
  account: "123",
  chat: "alice",
  user: "alice",
  scope: "private",
  conversationId: 1,
  contextToken: "context-one",
  lastInboundAt: Date.now(),
};
const wa: WhatsAppConfig = {
  token: "test-token",
  phoneId: "111",
  version: "v23.0",
  appSecret: "test-app-secret",
  verifyToken: "verify-me",
  port: 0,
  allowedUsers: ["alice"],
};

test("Telegram 报文：私聊文本、offset、纯文本回复及错误分类", async () => {
  const t = transport([
    {
      ok: true,
      result: [
        {
          update_id: 10,
          message: {
            from: { id: 42 },
            chat: { id: 42, type: "private" },
            date: 100,
            text: "你好",
          },
        },
        {
          update_id: 11,
          message: {
            from: { id: 42 },
            chat: { id: -1, type: "group" },
            text: "群聊",
          },
        },
        {
          update_id: 12,
          message: {
            from: { id: 42 },
            chat: { id: 42, type: "private" },
            photo: [],
          },
        },
      ],
    },
    { ok: true, result: { message_id: 99 } },
    new Error("https://secret-token.invalid"),
    new Response("", { status: 429, headers: { "retry-after": "2" } }),
  ]);
  const adapter = telegramAdapter("123:testing", ["42"], undefined, t.fetcher);
  const batch = await adapter.poll!("10", signal);
  expect(batch.cursor).toBe("13");
  expect(batch.messages).toHaveLength(1);
  expect(batch.messages[0]).toMatchObject({
    user: "42",
    text: "你好",
    id: "10",
  });
  expect(JSON.parse(t.calls[0]!.init.body as string)).toMatchObject({
    offset: 10,
    timeout: 25,
  });
  expect(
    await adapter.send(route, "<不会被当成 HTML>", "operation", signal),
  ).toEqual({ id: "99" });
  expect(JSON.parse(t.calls[1]!.init.body as string)).not.toHaveProperty(
    "parse_mode",
  );
  await expect(
    adapter.send(route, "hello", "operation2", signal),
  ).rejects.toMatchObject({ kind: "unknown", code: "network_result_unknown" });
  await expect(
    adapter.send(route, "hello", "operation3", signal),
  ).rejects.toMatchObject({ kind: "rate_limited", retryAfterMs: 2000 });
  expect(chunks("你好🙂世界", 3)).toEqual(["你好🙂", "世界"]);
});

test("WhatsApp 验签与本地回调：挑战验证、伪造拒绝、状态回执忽略和持久化失败返回 503", async () => {
  const received: Inbound[] = [];
  let fail = false;
  const server = await startWhatsAppWebhook(wa, {
    receive: async (event) => {
      if (fail) throw new Error("storage failed");
      received.push(event);
      return { accepted: true };
    },
  });
  const url = `http://127.0.0.1:${server.port}/webhooks/whatsapp`;
  try {
    expect(
      await (
        await fetch(
          url +
            "?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=challenge",
        )
      ).text(),
    ).toBe("challenge");
    expect(
      (await fetch(url + "?hub.mode=subscribe&hub.verify_token=wrong")).status,
    ).toBe(403);
    const payload = {
      object: "whatsapp_business_account",
      entry: [
        {
          changes: [
            {
              field: "messages",
              value: {
                metadata: { phone_number_id: "111" },
                messages: [
                  {
                    type: "text",
                    id: "wamid.1",
                    from: "alice",
                    timestamp: String(Math.floor(Date.now() / 1000)),
                    text: { body: "你好" },
                  },
                ],
              },
            },
          ],
        },
      ],
    };
    const body = JSON.stringify(payload);
    const signature =
      "sha256=" + createHmac("sha256", wa.appSecret).update(body).digest("hex");
    expect(verifyWhatsApp(Buffer.from(body), signature, wa.appSecret)).toBe(
      true,
    );
    expect(
      verifyWhatsApp(Buffer.from(body + " "), signature, wa.appSecret),
    ).toBe(false);
    expect(
      (
        await fetch(url, {
          method: "POST",
          body,
          headers: { "x-hub-signature-256": "bad" },
        })
      ).status,
    ).toBe(403);
    expect(received).toHaveLength(0);
    expect(
      (
        await fetch(url, {
          method: "POST",
          body,
          headers: { "x-hub-signature-256": signature },
        })
      ).status,
    ).toBe(200);
    expect(received[0]).toMatchObject({
      platform: "whatsapp",
      account: "111",
      user: "alice",
      id: "wamid.1",
    });
    fail = true;
    expect(
      (
        await fetch(url, {
          method: "POST",
          body,
          headers: { "x-hub-signature-256": signature },
        })
      ).status,
    ).toBe(503);
  } finally {
    await server.close();
  }
});

test("WhatsApp Cloud API 限制 24 小时文本窗口，校验发送回执", async () => {
  const t = transport([{ messages: [{ id: "wamid.reply" }] }, {}]);
  const adapter = whatsappAdapter(wa, t.fetcher, () => 1000000000);
  const live = {
    ...route,
    platform: "whatsapp" as const,
    lastInboundAt: 1000000000,
  };
  expect(await adapter.send(live, "回复", "op", signal)).toEqual({
    id: "wamid.reply",
  });
  expect(t.calls[0]!.url).toBe("https://graph.facebook.com/v23.0/111/messages");
  expect(JSON.parse(t.calls[0]!.init.body as string)).toMatchObject({
    messaging_product: "whatsapp",
    to: "alice",
    text: { body: "回复" },
  });
  await expect(
    adapter.send({ ...live, lastInboundAt: 0 }, "过期", "op2", signal),
  ).rejects.toMatchObject({
    kind: "rejected",
    code: "whatsapp_session_window_expired",
  });
  await expect(
    adapter.send(live, "无回执", "op3", signal),
  ).rejects.toMatchObject({ kind: "unknown" });
});

test("微信 iLink：同步游标、私聊文本、context_token 与稳定 client_id", async () => {
  const t = transport([
    {
      ret: 0,
      get_updates_buf: "next-cursor",
      msgs: [
        {
          message_id: 123,
          message_type: 1,
          from_user_id: "alice",
          context_token: "latest",
          item_list: [{ type: 1, text_item: { text: "微信消息" } }],
        },
        {
          message_id: 124,
          message_type: 2,
          from_user_id: "alice",
          item_list: [{ type: 1, text_item: { text: "忽略机器人" } }],
        },
      ],
    },
    { ret: 0 },
  ]);
  const adapter = weixinAdapter(
    { account: "bot", token: "secret", base: ILINK, user: "alice" },
    ["alice"],
    undefined,
    t.fetcher,
  );
  const batch = await adapter.poll!("old-cursor", signal);
  expect(batch.cursor).toBe("next-cursor");
  expect(batch.messages).toHaveLength(1);
  expect(batch.messages[0]!.contextToken).toBe("latest");
  expect(JSON.parse(t.calls[0]!.init.body as string)).toMatchObject({
    get_updates_buf: "old-cursor",
    base_info: { channel_version: "2.2.0" },
  });
  expect(
    await adapter.send(
      { ...route, contextToken: "latest" },
      "微信回复",
      "stable-op",
      signal,
    ),
  ).toEqual({ id: "stable-op" });
  expect(JSON.parse(t.calls[1]!.init.body as string).msg).toMatchObject({
    context_token: "latest",
    client_id: "stable-op",
    message_type: 2,
    message_state: 2,
    item_list: [{ type: 1, text_item: { text: "微信回复" } }],
  });
  await expect(
    adapter.send({ ...route, contextToken: "" }, "不发送", "missing", signal),
  ).rejects.toMatchObject({
    kind: "rejected",
    code: "weixin_missing_context_token",
  });
});

test("微信扫码凭据以 0600 保存，返回值不含 token，拒绝外部重定向地址", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orange-login-"));
  const shown: string[] = [];
  try {
    const t = transport([
      {
        qrcode: "qr-value",
        qrcode_img_content: "https://weixin.qq.com/qr-test",
      },
      {
        status: "confirmed",
        bot_token: "secret-token",
        ilink_bot_id: "bot-id",
        ilink_user_id: "alice",
        baseurl: ILINK,
      },
    ]);
    const result = await loginWeixin(
      dir,
      (url) => shown.push(url),
      signal,
      t.fetcher,
    );
    expect(result).toEqual({ account: "bot-id", user: "alice", saved: true });
    expect(shown).toEqual(["https://weixin.qq.com/qr-test"]);
    expect(
      (await stat(join(dir, "weixin-credentials.json"))).mode & 0o777,
    ).toBe(0o600);
    expect(
      JSON.parse(await readFile(join(dir, "weixin-credentials.json"), "utf8"))
        .token,
    ).toBe("secret-token");
    const bad = transport([
      { qrcode: "qr", qrcode_img_content: "qr-url" },
      { status: "scaned_but_redirect", redirect_host: "attacker.invalid" },
    ]);
    await expect(
      loginWeixin(dir, () => {}, signal, bad.fetcher),
    ).rejects.toThrow("微信 API");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
