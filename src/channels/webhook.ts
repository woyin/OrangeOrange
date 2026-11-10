import { createServer } from "node:http";
import { once } from "node:events";
import { timingSafeEqual } from "node:crypto";
import type { Gateway } from "../gateway.js";
import {
  verifyWhatsApp,
  whatsappMessages,
  type WhatsAppConfig,
} from "./whatsapp.js";
function equals(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
export async function startWhatsAppWebhook(
  config: WhatsAppConfig,
  gateway: Pick<Gateway, "receive">,
) {
  const sockets = new Set<import("node:net").Socket>();
  const server = createServer(async (request, response) => {
    const send = (code: number, body: string) => {
      response.writeHead(code, { "Content-Type": "text/plain; charset=utf-8" });
      response.end(body);
    };
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname !== "/webhooks/whatsapp") return send(404, "not found");
    if (request.method === "GET") {
      if (
        url.searchParams.get("hub.mode") !== "subscribe" ||
        !equals(
          url.searchParams.get("hub.verify_token") ?? "",
          config.verifyToken,
        )
      )
        return send(403, "forbidden");
      return send(200, url.searchParams.get("hub.challenge") ?? "");
    }
    if (request.method !== "POST") return send(405, "method not allowed");
    try {
      let length = 0;
      const parts: Buffer[] = [];
      for await (const chunk of request) {
        length += chunk.length;
        if (length > 256 * 1024) return send(413, "too large");
        parts.push(chunk);
      }
      const body = Buffer.concat(parts);
      const signature = request.headers["x-hub-signature-256"];
      if (
        typeof signature !== "string" ||
        !verifyWhatsApp(body, signature, config.appSecret)
      )
        return send(403, "forbidden");
      let payload;
      try {
        payload = JSON.parse(body.toString("utf8"));
      } catch {
        return send(400, "invalid json");
      }
      for (const message of whatsappMessages(payload, config.phoneId))
        await gateway.receive(message);
      send(200, "ok"); // Only acknowledge once admission and reply tracking have committed.
    } catch {
      if (!response.writableEnded) send(503, "retry later");
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.listen(config.port, "127.0.0.1");
  await once(server, "listening");
  return {
    port: (server.address() as import("node:net").AddressInfo).port,
    async close() {
      const closed = new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
      server.closeIdleConnections();
      const timer = setTimeout(() => {
        for (const socket of sockets) socket.destroy();
      }, 5000);
      timer.unref();
      try {
        await closed;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
