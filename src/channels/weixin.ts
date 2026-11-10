import { randomBytes } from "node:crypto";
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Adapter, Fetch, Inbound } from "./types.js";
import { SendFailure, pause } from "./types.js";
import { jsonRequest } from "./http.js";
export const ILINK = "https://ilinkai.weixin.qq.com";
const headers = () => ({
  "Content-Type": "application/json",
  AuthorizationType: "ilink_bot_token",
  "X-WECHAT-UIN": Buffer.from(String(randomBytes(4).readUInt32BE())).toString(
    "base64",
  ),
  "iLink-App-Id": "bot",
  "iLink-App-ClientVersion": String((2 << 16) | (2 << 8)),
});
export function weixinBase(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    !url.hostname.endsWith(".weixin.qq.com") ||
    url.username ||
    url.password ||
    url.port ||
    url.pathname !== "/"
  )
    throw new Error("无效的微信 API 地址");
  return url.origin;
}
export type WeixinCredentials = {
  account: string;
  token: string;
  base: string;
  user: string;
};
export function weixinAdapter(
  credentials: WeixinCredentials,
  allowedUsers: string[],
  sharedScope?: string,
  fetcher: Fetch = fetch,
): Adapter {
  const base = weixinBase(credentials.base);
  const request = async (
    method: string,
    payload: unknown,
    signal: AbortSignal,
    timeout?: number,
  ) => {
    const result = await jsonRequest(
      fetcher,
      `${base}/ilink/bot/${method}`,
      {
        method: "POST",
        headers: { ...headers(), Authorization: `Bearer ${credentials.token}` },
        body: JSON.stringify({
          ...(payload as object),
          base_info: { channel_version: "2.2.0" },
        }),
      },
      signal,
      timeout,
    );
    const code =
      Number(result.errcode ?? 0) !== 0
        ? Number(result.errcode)
        : Number(result.ret ?? 0);
    if (
      code !== 0 ||
      (result.errcode !== undefined && Number(result.errcode) !== 0)
    )
      throw new SendFailure(
        code === -2 &&
        result.errmsg !== "prepare failed" &&
        result.errmsg !== "unknown error"
          ? "rate_limited"
          : "rejected",
        `weixin_${code}`,
      );
    return result;
  };
  return {
    platform: "weixin",
    account: credentials.account,
    allowedUsers,
    sharedScope,
    maxLength: 1800,
    poll: async (cursor, signal) => {
      const result = await request(
        "getupdates",
        { get_updates_buf: cursor },
        signal,
        40000,
      );
      const messages: Inbound[] = [];
      for (const m of result.msgs ?? []) {
        if (
          m.message_type !== 1 ||
          typeof m.from_user_id !== "string" ||
          m.from_user_id.includes("@chatroom") ||
          m.group_id ||
          m.chatroom_id ||
          m.chat_type === "group"
        )
          continue;
        const text = (m.item_list ?? [])
          .filter(
            (i: any) => i.type === 1 && typeof i.text_item?.text === "string",
          )
          .map((i: any) => i.text_item.text)
          .join("\n");
        if (!text || m.message_id === undefined) continue;
        messages.push({
          platform: "weixin",
          account: credentials.account,
          user: m.from_user_id,
          chat: m.from_user_id,
          id: String(m.message_id),
          text,
          timestamp: Number(m.create_time_ms ?? Date.now()),
          ...(typeof m.context_token === "string"
            ? { contextToken: m.context_token }
            : {}),
        });
      }
      return { messages, cursor: String(result.get_updates_buf ?? cursor) };
    },
    send: async (route, text, operationId, signal) => {
      if (!route.contextToken)
        throw new SendFailure("rejected", "weixin_missing_context_token");
      await request(
        "sendmessage",
        {
          msg: {
            from_user_id: "",
            to_user_id: route.chat,
            client_id: operationId,
            message_type: 2,
            message_state: 2,
            context_token: route.contextToken,
            item_list: [{ type: 1, text_item: { text } }],
          },
        },
        signal,
      );
      return { id: operationId };
    },
  };
}
export async function loginWeixin(
  dataDir: string,
  show: (url: string) => void,
  signal: AbortSignal,
  fetcher: Fetch = fetch,
) {
  const get = (base: string, endpoint: string) =>
    jsonRequest(
      fetcher,
      `${base}/ilink/bot/${endpoint}`,
      { headers: headers() },
      signal,
      40000,
    );
  const qr = await get(ILINK, "get_bot_qrcode?bot_type=3");
  if (
    typeof qr.qrcode !== "string" ||
    typeof qr.qrcode_img_content !== "string"
  )
    throw new Error("微信二维码响应无效");
  show(qr.qrcode_img_content);
  let base = ILINK;
  const deadline = Date.now() + 240000;
  while (!signal.aborted && Date.now() < deadline) {
    const status = await get(
      base,
      `get_qrcode_status?qrcode=${encodeURIComponent(qr.qrcode)}`,
    );
    if (status.status === "confirmed") {
      if (
        typeof status.bot_token !== "string" ||
        typeof status.ilink_bot_id !== "string" ||
        typeof status.ilink_user_id !== "string"
      )
        throw new Error("微信凭据不完整");
      const credentials: WeixinCredentials = {
        account: status.ilink_bot_id,
        token: status.bot_token,
        user: status.ilink_user_id,
        base: weixinBase(status.baseurl ?? ILINK),
      };
      await mkdir(dataDir, { recursive: true, mode: 0o700 });
      await chmod(dataDir, 0o700);
      const temporary = join(
        dataDir,
        `weixin-${randomBytes(8).toString("hex")}.tmp`,
      );
      await writeFile(temporary, JSON.stringify(credentials), { mode: 0o600 });
      await rename(temporary, join(dataDir, "weixin-credentials.json"));
      return {
        account: credentials.account,
        user: credentials.user,
        saved: true,
      };
    }
    if (status.status === "expired")
      throw new Error("微信二维码已过期，请重新登录");
    if (status.status === "scaned_but_redirect" && status.redirect_host)
      base = weixinBase(`https://${status.redirect_host}`);
    await pause(1000, signal);
  }
  throw new Error("微信登录取消或超时");
}
