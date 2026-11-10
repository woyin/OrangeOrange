import { createServer } from "node:http";
import { chmod, rm } from "node:fs/promises";
import { once } from "node:events";
import type { Config } from "./config.js";
import { acquireOwnership } from "./ownership.js";
import { openRuntime, type RuntimeOptions } from "./runtime.js";
import { loadChannels } from "./channels/config.js";
import { openGateway, type Gateway } from "./gateway.js";
import { startWhatsAppWebhook } from "./channels/webhook.js";
import type { Adapter } from "./channels/types.js";
import type { WhatsAppConfig } from "./channels/whatsapp.js";

export async function startDaemon(
  config: Config,
  options: RuntimeOptions & {
    adapters?: Adapter[];
    whatsapp?: WhatsAppConfig;
  } = {},
) {
  const release = await acquireOwnership(config.dataDir);
  let runtime: Awaited<ReturnType<typeof openRuntime>> | undefined;
  let gateway: Gateway | undefined;
  let webhook: Awaited<ReturnType<typeof startWhatsAppWebhook>> | undefined;
  const sockets = new Set<import("node:net").Socket>();
  let closing = false;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const log = (event: string, fields: Record<string, unknown> = {}) =>
    process.stderr.write(
      JSON.stringify({ time: new Date().toISOString(), event, ...fields }) +
        "\n",
    );
  const server = createServer(async (request, response) => {
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    const send = (status: number, value: unknown) => {
      response.writeHead(status);
      response.end(JSON.stringify(value));
    };
    if (closing) return send(503, { error: "服务正在关闭" });
    if (request.method !== "POST" || request.url !== "/rpc")
      return send(404, { error: "未知接口" });
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 64 * 1024) {
          send(413, { error: "请求超过 64 KiB" });
          return;
        }
        chunks.push(chunk);
      }
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (
        !body ||
        typeof body !== "object" ||
        !("method" in body) ||
        typeof body.method !== "string"
      )
        throw new Error("请求格式错误");
      const params = "params" in body ? body.params : {};
      if (!params || typeof params !== "object" || Array.isArray(params))
        throw new Error("params 必须为对象");
      if (body.method === "daemon.stop") {
        send(200, { result: { stopping: true } });
        setImmediate(() => {
          void stop().catch(() => {
            process.exitCode = 1;
            log("stop_failed");
          });
        });
        return;
      }
      if (
        [
          "channels.status",
          "deliveries.list",
          "delivery.retry",
          "delivery.discard",
        ].includes(body.method)
      ) {
        send(200, {
          result: await gateway!.control(
            body.method,
            params as Record<string, unknown>,
          ),
        });
        return;
      }
      const result = await runtime!.dispatch(
        body.method,
        params as Record<string, unknown>,
      );
      send(200, { result });
    } catch (e) {
      if (!response.writableEnded) send(400, { error: (e as Error).message });
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 1000;
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  async function stop() {
    if (closing) return closed;
    closing = true;
    log("stopping");
    try {
      if (server.listening) {
        const stopped = new Promise<void>((resolve, reject) =>
          server.close((e) => (e ? reject(e) : resolve())),
        );
        server.closeIdleConnections();
        // A local client must not prevent orderly shutdown indefinitely.
        const timer = setTimeout(() => {
          for (const socket of sockets) socket.destroy();
        }, 5000);
        timer.unref();
        try {
          await stopped;
        } finally {
          clearTimeout(timer);
        }
      }
      try {
        await webhook?.close();
      } finally {
        try {
          await gateway?.close();
        } finally {
          await runtime?.close();
        }
      }
      await rm(config.socket, { force: true });
      log("stopped");
    } finally {
      await release();
      resolveClosed();
    }
  }
  try {
    runtime = await openRuntime(config, {
      ...options,
      onReport: (report) => {
        log("runtime_report", { kind: report.kind });
        options.onReport?.(report);
      },
    });
    const channels = options.adapters
      ? { adapters: options.adapters, whatsapp: options.whatsapp }
      : await loadChannels(config);
    gateway = await openGateway(runtime, channels.adapters, log);
    if (channels.whatsapp)
      webhook = await startWhatsAppWebhook(channels.whatsapp, gateway);
    await rm(config.socket, { force: true });
    server.listen(config.socket);
    await once(server, "listening");
    await chmod(config.socket, 0o600);
    gateway.start();
    log("ready", { pid: process.pid });
    void runtime.harness.closed.then((end) => {
      if (!closing) {
        log("runtime_closed", { kind: end.kind });
        void stop().catch(() => {
          process.exitCode = 1;
          log("stop_failed");
        });
      }
    });
    return { runtime, stop, closed };
  } catch (e) {
    await stop();
    throw e;
  }
}
