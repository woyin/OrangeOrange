export type Platform = "telegram" | "whatsapp" | "weixin";
export type Inbound = {
  platform: Platform;
  account: string;
  user: string;
  chat: string;
  id: string;
  text: string;
  timestamp: number;
  contextToken?: string;
  messageThreadId?: string;
  messageId?: string;
};
export type Route = {
  key: string;
  platform: Platform;
  account: string;
  chat: string;
  user: string;
  scope: string;
  conversationId: number;
  contextToken: string;
  lastInboundAt: number;
  messageThreadId?: string;
  replyToMessageId?: string;
};
export type SendResult = { id: string };
export type Adapter = {
  platform: Platform;
  account: string;
  allowedUsers: string[];
  sharedScope?: string;
  maxLength: number;
  poll?: (
    cursor: string,
    signal: AbortSignal,
  ) => Promise<{ messages: Inbound[]; cursor: string }>;
  send: (
    route: Route,
    text: string,
    operationId: string,
    signal: AbortSignal,
  ) => Promise<SendResult>;
};
export type ChannelAdapter = Adapter & {
  connect: (signal: AbortSignal) => Promise<void>;
  health: (signal: AbortSignal) => Promise<boolean>;
  normalizeInbound: (update: unknown) => Inbound | null;
  edit: (route: Route, messageId: string, text: string, signal: AbortSignal) => Promise<SendResult>;
  stop: () => void;
};
export class SendFailure extends Error {
  constructor(
    public kind: "rejected" | "rate_limited" | "unknown",
    public code: string,
    public retryAfterMs = 1000,
  ) {
    super(code);
  }
}
export type Fetch = typeof globalThis.fetch;
export async function pause(ms: number, signal: AbortSignal) {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}
export function chunks(text: string, maxLength: number) {
  const points = Array.from(text);
  const result: string[] = [];
  for (let i = 0; i < points.length; i += maxLength)
    result.push(points.slice(i, i + maxLength).join(""));
  return result.length ? result : ["处理完成。"];
}
