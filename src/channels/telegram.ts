import type { ChannelAdapter, Fetch, Inbound } from "./types.js";
import { pause, SendFailure } from "./types.js";
import { jsonRequest } from "./http.js";

export function telegramAdapter(
  token: string,
  allowedUsers: string[],
  sharedScope?: string,
  fetcher: Fetch = fetch,
  includeGroups = false,
): ChannelAdapter {
  const account = token.split(":")[0]!;
  const base = `https://api.telegram.org/bot${token}/`;
  const stopped = new AbortController();
  let nextSendAt = 0;
  const maxLength = 3500;
  const positiveId = (value: unknown): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value > 0;
  const reference = (value: string) => {
    if (typeof value !== "string" || !/^[1-9]\d*$/.test(value) || !positiveId(Number(value)))
      throw new SendFailure("rejected", "telegram_invalid_message_id");
    return Number(value);
  };
  const checkText = (text: string) => {
    if (typeof text !== "string" || !text.length || text.length > maxLength * 2 || Array.from(text).length > maxLength)
      throw new SendFailure("rejected", "telegram_invalid_text");
  };
  const request = async (
    method: string,
    payload: unknown,
    signal: AbortSignal,
    timeout?: number,
  ) => {
    const activeSignal = AbortSignal.any([signal, stopped.signal]);
    if (activeSignal.aborted) throw new SendFailure("unknown", "interrupted");
    const result = await jsonRequest(
      fetcher,
      base + method,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
      activeSignal,
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
  const pace = async (signal: AbortSignal) => {
    const activeSignal = AbortSignal.any([signal, stopped.signal]);
    if (activeSignal.aborted) throw new SendFailure("unknown", "interrupted");
    const now = Date.now();
    const slot = Math.max(now, nextSendAt);
    nextSendAt = slot + 35;
    if (slot > now) await pause(slot - now, activeSignal);
    if (activeSignal.aborted) throw new SendFailure("unknown", "interrupted");
  };
  const normalizeInbound = (update: unknown): Inbound | null => {
    if (!update || typeof update !== "object") return null;
    const event = update as Record<string, any>;
    const m = event.message;
    if (!Number.isSafeInteger(event.update_id) || event.update_id < 0 ||
        !m || typeof m !== "object" ||
        !(includeGroups ? ["private", "group", "supergroup"] : ["private"]).includes(m.chat?.type) ||
        !Number.isSafeInteger(m.chat?.id) || m.chat.id === 0 ||
        !positiveId(m.from?.id) || (m.from.is_bot !== undefined && m.from.is_bot !== false) ||
        !Number.isSafeInteger(m.date) || m.date < 0 || !Number.isSafeInteger(m.date * 1000) ||
        typeof m.text !== "string" || !m.text.length || m.text.length > 8192 || Array.from(m.text).length > 4096 ||
        (m.message_id !== undefined && !positiveId(m.message_id)) ||
        (m.message_thread_id !== undefined && !positiveId(m.message_thread_id)) ||
        ["photo", "document", "audio", "video", "animation", "voice", "video_note", "sticker", "contact", "location", "venue", "poll", "dice"].some((key) => key in m)) return null;
    return {
      platform: "telegram", account, user: String(m.from.id), chat: String(m.chat.id),
      id: String(event.update_id), text: m.text, timestamp: m.date * 1000,
      ...(m.message_thread_id !== undefined ? { messageThreadId: String(m.message_thread_id) } : {}),
      ...(m.message_id !== undefined ? { messageId: String(m.message_id) } : {}),
    };
  };
  const getMe = async (signal: AbortSignal) => {
    const me = await request("getMe", {}, signal);
    if (!positiveId(me?.id) || me.is_bot !== true) throw new Error("telegram_invalid_identity");
  };
  return {
    platform: "telegram",
    account,
    allowedUsers,
    sharedScope,
    maxLength,
    connect: getMe,
    health: async (signal) => {
      try { await getMe(signal); return true; }
      catch (error) {
        if (signal.aborted || stopped.signal.aborted) throw error;
        return false;
      }
    },
    normalizeInbound,
    stop: () => stopped.abort(),
    poll: async (cursor, signal) => {
      const updates = await request(
        "getUpdates",
        { offset: Number(cursor || 0), timeout: 25, allowed_updates: ["message"] },
        signal,
        35000,
      );
      if (!Array.isArray(updates)) throw new Error("telegram_invalid_updates");
      const messages: Inbound[] = [];
      let offset = Number(cursor || 0);
      for (const update of updates) {
        if (!Number.isSafeInteger(update?.update_id) || update.update_id < 0 || update.update_id >= Number.MAX_SAFE_INTEGER) continue;
        offset = Math.max(offset, update.update_id + 1);
        const message = normalizeInbound(update);
        if (message) messages.push(message);
      }
      return { messages, cursor: String(offset) };
    },
    send: async (route, text, _operationId, signal) => {
      checkText(text);
      const thread = route.messageThreadId === undefined ? undefined : reference(route.messageThreadId);
      const reply = route.replyToMessageId === undefined ? undefined : reference(route.replyToMessageId);
      await pace(signal);
      const sent = await request("sendMessage", {
        chat_id: route.chat, text,
        ...(thread !== undefined ? { message_thread_id: thread } : {}),
        ...(reply !== undefined ? { reply_parameters: { message_id: reply, allow_sending_without_reply: true } } : {}),
      }, signal);
      if (!positiveId(sent?.message_id)) throw new SendFailure("unknown", "telegram_missing_receipt");
      return { id: String(sent.message_id) };
    },
    edit: async (route, messageId, text, signal) => {
      checkText(text);
      const id = reference(messageId);
      await pace(signal);
      const edited = await request("editMessageText", { chat_id: route.chat, message_id: id, text }, signal);
      if (edited !== true && !positiveId(edited?.message_id)) throw new SendFailure("unknown", "telegram_missing_receipt");
      return { id: edited === true ? messageId : String(edited.message_id) };
    },
  };
}
