import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { acquireOwnership } from "../src/ownership.js";
import { config } from "../src/config.js";
import { openRuntime } from "../src/runtime.js";
import { installProbe } from "./probe.js";
import { openGateway } from "../src/gateway.js";
import type { Inbound } from "../src/channels/types.js";
const cfg = config();
const release = await acquireOwnership(cfg.dataDir);
if (process.env.WORKER_MODE === "lock") {
  process.send?.({ ready: true });
  setInterval(() => {}, 10000);
} else {
  const models = createModels();
  const faux = fauxProvider();
  models.setProvider(faux.provider);
  faux.setResponses(
    Array.from({ length: 100 }, () => async (context, options) => {
      process.send?.({ model: true, messages: context.messages });
      if (process.env.HANG_MODEL === "1")
        await new Promise<void>((resolve) =>
          options?.signal?.addEventListener("abort", () => resolve(), {
            once: true,
          }),
        );
      const last = context.messages.at(-1);
      if (
        last?.role === "user" &&
        typeof last.content === "string" &&
        last.content.startsWith("tool:")
      ) {
        const call = JSON.parse(last.content.slice(5));
        return fauxAssistantMessage(fauxToolCall(call.name, call.args), {
          stopReason: "toolUse",
        });
      }
      return fauxAssistantMessage("恢复后的回答");
    }),
  );
  const runtime = await openRuntime(
    { ...cfg, model: "faux-1" },
    { models, provider: "faux" },
  );
  const probe = installProbe(runtime);
  const gateway =
    process.env.GATEWAY_TEST === "1"
      ? await openGateway(runtime, [
          {
            platform: "telegram",
            account: "bot",
            allowedUsers: ["alice"],
            maxLength: 3500,
            send: async (_route, text, _id, signal) => {
              process.send?.({ externalSend: true, text });
              if (process.env.HANG_SEND === "1")
                await new Promise<void>((resolve) =>
                  signal.addEventListener("abort", () => resolve(), {
                    once: true,
                  }),
                );
              return { id: "test-remote" };
            },
          },
        ])
      : undefined;
  process.on("message", async (message: any) => {
    try {
      process.send?.({
        key: message.key,
        result:
          message.method === "probe.create"
            ? await probe()
            : message.method === "gateway.receive"
              ? await gateway!.receive(message.params as Inbound)
              : message.method === "deliveries.list"
                ? await gateway!.control(message.method, message.params)
                : await runtime.dispatch(message.method, message.params),
      });
    } catch (e) {
      process.send?.({ key: message.key, error: (e as Error).message });
    }
  });
  process.on("SIGTERM", () => {
    void (gateway?.close() ?? Promise.resolve())
      .then(() => runtime.close())
      .then(release)
      .then(() => process.exit(0));
  });
  process.send?.({ ready: true });
}
