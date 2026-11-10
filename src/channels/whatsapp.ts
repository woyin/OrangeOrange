import { createHmac, timingSafeEqual } from "node:crypto";
import type { Adapter, Fetch, Inbound } from "./types.js";
import { SendFailure } from "./types.js";
import { jsonRequest } from "./http.js";
export type WhatsAppConfig = {
  token: string;
  phoneId: string;
  version: string;
  appSecret: string;
  verifyToken: string;
  port: number;
  allowedUsers: string[];
  sharedScope?: string;
};
export function verifyWhatsApp(
  body: Buffer,
  signature: string,
  secret: string,
): boolean {
  if (!/^sha256=[a-f0-9]{64}$/.test(signature)) return false;
  const expected = createHmac("sha256", secret).update(body).digest();
  return timingSafeEqual(expected, Buffer.from(signature.slice(7), "hex"));
}
export function whatsappMessages(payload: any, phoneId: string): Inbound[] {
  if (payload?.object !== "whatsapp_business_account") return [];
  const result: Inbound[] = [];
  for (const entry of payload.entry ?? [])
    for (const change of entry.changes ?? []) {
      const v = change.value;
      if (
        change.field !== "messages" ||
        String(v?.metadata?.phone_number_id) !== phoneId
      )
        continue;
      for (const m of v.messages ?? [])
        if (
          m.type === "text" &&
          typeof m.text?.body === "string" &&
          typeof m.from === "string" &&
          typeof m.id === "string"
        ) {
          const timestamp = Number(m.timestamp) * 1000;
          if (
            !Number.isFinite(timestamp) ||
            timestamp <= 0 ||
            timestamp > Date.now() + 300000
          )
            continue;
          result.push({
            platform: "whatsapp",
            account: phoneId,
            user: m.from,
            chat: m.from,
            id: m.id,
            text: m.text.body,
            timestamp,
          });
        }
    }
  return result;
}
export function whatsappAdapter(
  config: WhatsAppConfig,
  fetcher: Fetch = fetch,
  now = Date.now,
): Adapter {
  return {
    platform: "whatsapp",
    account: config.phoneId,
    allowedUsers: config.allowedUsers,
    sharedScope: config.sharedScope,
    maxLength: 3500,
    send: async (route, text, _operationId, signal) => {
      if (now() - route.lastInboundAt >= 24 * 3600000)
        throw new SendFailure("rejected", "whatsapp_session_window_expired");
      const result = await jsonRequest(
        fetcher,
        `https://graph.facebook.com/${config.version}/${config.phoneId}/messages`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            messaging_product: "whatsapp",
            recipient_type: "individual",
            to: route.chat,
            type: "text",
            text: { body: text },
          }),
        },
        signal,
      );
      if (result.error)
        throw new SendFailure("rejected", "whatsapp_api_rejected");
      const id = result.messages?.[0]?.id;
      if (typeof id !== "string")
        throw new SendFailure("unknown", "whatsapp_missing_receipt");
      return { id };
    },
  };
}
