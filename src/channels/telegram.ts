import type { Adapter, Fetch, Inbound } from "./types.js";
import { SendFailure } from "./types.js";
import { jsonRequest } from "./http.js";
export function telegramAdapter(
  token: string,
  allowedUsers: string[],
  sharedScope?: string,
  fetcher: Fetch = fetch,
): Adapter {
  const account = token.split(":")[0]!;
  const base = `https://api.telegram.org/bot${token}/`;
  const request = async (
    method: string,
    payload: unknown,
    signal: AbortSignal,
    timeout?: number,
  ) => {
    const result = await jsonRequest(
      fetcher,
      base + method,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
      signal,
      timeout,
    );
    if (!result.ok)
      throw new SendFailure(
        result.error_code === 429 ? "rate_limited" : "rejected",
        `telegram_${result.error_code ?? "error"}`,
        Math.min(Number(result.parameters?.retry_after ?? 1) * 1000, 3600000),
      );
    return result.result;
  };
  return {
    platform: "telegram",
    account,
    allowedUsers,
    sharedScope,
    maxLength: 3500,
    poll: async (cursor, signal) => {
      const updates = await request(
        "getUpdates",
        {
          offset: Number(cursor || 0),
          timeout: 25,
          allowed_updates: ["message"],
        },
        signal,
        35000,
      );
      if (!Array.isArray(updates)) throw new Error("telegram_invalid_updates");
      const messages: Inbound[] = [];
      let offset = Number(cursor || 0);
      for (const update of updates) {
        if (!Number.isSafeInteger(update.update_id)) continue;
        offset = Math.max(offset, update.update_id + 1);
        const m = update.message;
        if (
          m?.chat?.type !== "private" ||
          typeof m.text !== "string" ||
          m.from?.is_bot ||
          !m.from?.id
        )
          continue;
        messages.push({
          platform: "telegram",
          account,
          user: String(m.from.id),
          chat: String(m.chat.id),
          id: String(update.update_id),
          text: m.text,
          timestamp: Number(m.date) * 1000,
        });
      }
      return { messages, cursor: String(offset) };
    },
    send: async (route, text, _operationId, signal) => {
      const sent = await request(
        "sendMessage",
        { chat_id: route.chat, text },
        signal,
      );
      if (sent?.message_id === undefined)
        throw new SendFailure("unknown", "telegram_missing_receipt");
      return { id: String(sent.message_id) };
    },
  };
}
