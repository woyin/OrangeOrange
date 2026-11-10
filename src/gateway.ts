import { createHash } from "node:crypto";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import {
  defineExtension,
  defineTask,
  ROOT_CONVERSATION_ID,
  type SubmissionId,
  type ConversationId,
  type Tx,
} from "@earendil-works/pi-durable";
import type { Runtime } from "./runtime.js";
import { GatewayState } from "./gateway-state.js";
import { AppState } from "./state.js";
import { messageText } from "./history.js";
import {
  chunks,
  pause,
  SendFailure,
  type Adapter,
  type Inbound,
  type Route,
} from "./channels/types.js";
const key = (...parts: string[]) =>
  createHash("sha256").update(JSON.stringify(parts)).digest("hex");
const completed = () => ({
  status: "terminal" as const,
  outcome: { status: "completed" as const, result: null },
});
export async function openGateway(
  runtime: Runtime,
  adapters: Adapter[],
  report: (event: string, fields?: Record<string, unknown>) => void = () => {},
) {
  for (const adapter of adapters) {
    if (!adapter.allowedUsers.length)
      throw new Error(`${adapter.platform} 必须配置允许的用户`);
    if (adapter.sharedScope && adapter.allowedUsers.length !== 1)
      throw new Error("共享记忆作用域只允许绑定一个明确用户");
  }
  if (
    new Set(adapters.map((a) => `${a.platform}:${a.account}`)).size !==
    adapters.length
  )
    throw new Error("渠道账号重复");
  const controller = new AbortController();
  const adapterFor = (route: Route) =>
    adapters.find(
      (a) => a.platform === route.platform && a.account === route.account,
    );
  const DeliveryTask = defineTask<
    { id: string },
    { phase: "wait" } | { phase: "send" },
    null
  >({
    name: "orange.delivery",
    version: 1,
    initial: () => ({ phase: "wait" }),
    phases: {
      wait: async (task, api, context) => {
        const delivery = (await api.snapshot(GatewayState, context))
          ?.deliveries[task.input.id];
        if (
          !delivery ||
          ["sent", "discarded", "failed", "unknown"].includes(delivery.status)
        ) {
          await api.commit(() => completed(), context);
          return;
        }
        let text = "";
        if (delivery.status === "waiting") {
          const submission = await runtime.harness.submission(
            delivery.submissionId! as SubmissionId,
            context,
          );
          const status = await submission?.status(context);
          if (status?.status === "queued" || status?.status === "placed") {
            await api.sleepUntil(api.now() + 250, { phase: "wait" }, context);
            return;
          }
          if (status?.status === "done" && status.type === "input") {
            const answer = await runtime.storage.entry(status.answer, context);
            text = answer ? messageText(answer.entry) : "";
          } else text = "本次处理未完成。请稍后重试，或在本地查询任务状态。";
        }
        await api.commit(async (tx) => {
          const state = await tx.doc(GatewayState);
          const current = state.deliveries[task.input.id]!;
          const route = state.routes[current.routeKey]!;
          const adapter = adapterFor(route);
          if (!adapter) {
            current.status = "failed";
            current.error = "channel_unavailable";
            return completed();
          }
          if (current.status === "waiting") {
            current.parts = chunks(text, adapter.maxLength);
            current.status = "ready";
          }
          return {
            status: "sleeping",
            until: api.now(),
            checkpoint: { phase: "send" },
          };
        }, context);
      },
      send: async (task, api, context) => {
        const state = await api.snapshot(GatewayState, context);
        const delivery = state?.deliveries[task.input.id];
        if (!delivery) {
          await api.commit(() => completed(), context);
          return;
        }
        if (delivery.status === "sending") {
          await api.commit(async (tx) => {
            const d = (await tx.doc(GatewayState)).deliveries[task.input.id]!;
            d.status = "unknown";
            d.error = "interrupted_during_send";
            return completed();
          }, context);
          return;
        }
        if (delivery.status !== "ready") {
          await api.commit(() => completed(), context);
          return;
        }
        if (
          Object.values(state!.deliveries).some(
            (other) =>
              other.routeKey === delivery.routeKey &&
              other.taskId < delivery.taskId &&
              ["waiting", "ready", "sending"].includes(other.status),
          )
        ) {
          await api.sleepUntil(api.now() + 250, { phase: "send" }, context);
          return;
        }
        const route = state!.routes[delivery.routeKey]!;
        const adapter = adapterFor(route);
        if (!adapter) {
          await api.commit(async (tx) => {
            const d = (await tx.doc(GatewayState)).deliveries[task.input.id]!;
            d.status = "failed";
            d.error = "channel_unavailable";
            return completed();
          }, context);
          return;
        }
        if (!adapter.allowedUsers.includes(route.user)) {
          await api.commit(async (tx) => {
            const d = (await tx.doc(GatewayState)).deliveries[task.input.id]!;
            d.status = "failed";
            d.error = "recipient_not_authorized";
            return completed();
          }, context);
          return;
        }
        await api.commit(async (tx) => {
          const d = (await tx.doc(GatewayState)).deliveries[task.input.id]!;
          d.status = "sending";
          d.attempts++;
          return undefined;
        }, context);
        try {
          const receipt = await adapter.send(
            route,
            delivery.parts[delivery.part]!,
            `${delivery.id}-${delivery.part}`,
            api.signal,
          );
          await api.commit(async (tx) => {
            const d = (await tx.doc(GatewayState)).deliveries[task.input.id]!;
            d.remoteIds.push(receipt.id);
            d.part++;
            d.attempts = 0;
            d.error = "";
            d.status = d.part === d.parts.length ? "sent" : "ready";
            return d.status === "sent"
              ? completed()
              : {
                  status: "sleeping",
                  until: api.now() + 350,
                  checkpoint: { phase: "send" },
                };
          }, context);
        } catch (error) {
          const failure =
            error instanceof SendFailure
              ? error
              : new SendFailure("unknown", "send_result_unknown");
          await api.commit(async (tx) => {
            const d = (await tx.doc(GatewayState)).deliveries[task.input.id]!;
            d.error = failure.code;
            if (failure.kind === "rate_limited" && d.attempts < 3) {
              d.status = "ready";
              return {
                status: "sleeping",
                until: api.now() + Math.max(1000, failure.retryAfterMs),
                checkpoint: { phase: "send" },
              };
            }
            d.status = failure.kind === "unknown" ? "unknown" : "failed";
            return completed();
          }, context);
        }
      },
    },
    abort: (_task, api, context) =>
      api.commit(
        () => ({ status: "terminal", outcome: { status: "aborted" } }),
        context,
      ),
  });
  runtime.registry.install(
    defineExtension({ name: "channels", tasks: [DeliveryTask] }),
  );
  await runtime.harness.commit(async (tx) => {
    await tx.doc(GatewayState);
  }, ctx);
  async function enqueue(
    tx: Tx,
    id: string,
    routeKey: string,
    submissionId: number | null,
    text: string | null,
  ) {
    const state = await tx.doc(GatewayState);
    if (state.deliveries[id]) return;
    const route = state.routes[routeKey]!;
    const adapter = adapterFor(route)!;
    const taskId = await tx.createTask(
      DeliveryTask,
      { id },
      {
        conversationId: ROOT_CONVERSATION_ID,
        ownership: { kind: "conversation" },
        background: true,
      },
    );
    state.deliveries[id] = {
      id,
      routeKey,
      submissionId,
      parts: text === null ? [] : chunks(text, adapter.maxLength),
      part: 0,
      remoteIds: [],
      status: text === null ? "waiting" : "ready",
      attempts: 0,
      error: "",
      taskId,
      createdAt: Date.now(),
    };
  }
  // One mutation admission line also keeps first-route creation and /new ordered per process.
  let admissions: Promise<unknown> = Promise.resolve();
  async function accept(event: Inbound) {
    const adapter = adapters.find(
      (a) => a.platform === event.platform && a.account === event.account,
    );
    if (!adapter || !adapter.allowedUsers.includes(event.user))
      return { accepted: false };
    if (
      typeof event.text !== "string" ||
      !event.text.trim() ||
      event.text.length > 32000 ||
      !Number.isFinite(event.timestamp)
    )
      return { accepted: false };
    const id = key(event.platform, event.account, event.chat, event.id);
    const routeKey = key(event.platform, event.account, event.chat, event.user);
    const state = (await runtime.harness.snapshot(GatewayState, ctx))!;
    if (state.deliveries[id]) return { accepted: true, id, duplicate: true };
    const scope =
      adapter.sharedScope ?? `${event.platform}:${event.account}:${event.user}`;
    let route = state.routes[routeKey];
    const fresh = event.text.trim() === "/new";
    if (!route || route.scope !== scope || fresh) {
      await runtime.createConversation(
        {
          name: `${event.platform} 私聊`,
          scope,
          channel: event.platform,
          routeKey,
        },
        async (tx, cid) => {
          const gateway = await tx.doc(GatewayState);
          gateway.routes[routeKey] = {
            key: routeKey,
            platform: event.platform,
            account: event.account,
            user: event.user,
            chat: event.chat,
            scope,
            conversationId: cid,
            contextToken: event.contextToken ?? "",
            lastInboundAt: event.timestamp,
          };
        },
      );
      route = (await runtime.harness.snapshot(GatewayState, ctx))!.routes[
        routeKey
      ]!;
    }
    const conversation = (await runtime.harness.conversation(
      route.conversationId as ConversationId,
      ctx,
    ))!;
    await runtime.harness.commit(async (tx) => {
      const state = await tx.doc(GatewayState);
      if (state.deliveries[id]) return;
      const current = state.routes[routeKey]!;
      if (event.timestamp >= current.lastInboundAt) {
        current.lastInboundAt = event.timestamp;
        if (event.contextToken) current.contextToken = event.contextToken;
      }
      const submissionId = fresh
        ? null
        : await conversation.submit(tx, {
            type: "input",
            requestId: id,
            content: event.text,
          });
      await enqueue(
        tx,
        id,
        routeKey,
        submissionId,
        fresh ? "已开启新会话，并加载最新记忆。" : null,
      );
    }, ctx);
    return { accepted: true, id, duplicate: false };
  }
  function receive(event: Inbound) {
    const next = admissions.catch(() => {}).then(() => accept(event));
    admissions = next;
    return next;
  }
  async function syncNotices() {
    await runtime.harness.commit(async (tx) => {
      const app = await tx.doc(AppState);
      const state = await tx.doc(GatewayState);
      for (const notice of app.notices)
        if (
          notice.routeKey &&
          state.routes[notice.routeKey] &&
          adapterFor(state.routes[notice.routeKey]!)
        ) {
          await enqueue(
            tx,
            `notice-${key(notice.scope, notice.id)}`,
            notice.routeKey,
            null,
            notice.kind === "task" ? notice.text : `提醒：${notice.text}`,
          );
        }
    }, ctx);
  }
  async function control(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<unknown> {
    const state = (await runtime.harness.snapshot(GatewayState, ctx))!;
    if (method === "channels.status")
      return adapters.map((a) => ({
        platform: a.platform,
        account: a.account,
        allowedUsers: a.allowedUsers,
        sharedScope: a.sharedScope ?? null,
        transport: a.poll ? "poll" : "webhook",
      }));
    if (method === "deliveries.list")
      return Object.values(state.deliveries).map(({ parts, ...d }) => ({
        ...d,
        parts: parts.length,
      }));
    if (method !== "delivery.retry" && method !== "delivery.discard")
      throw new Error("未知渠道方法");
    if (typeof params.id !== "string") throw new Error("缺少投递 ID");
    return runtime.harness.commit(async (tx) => {
      const state = await tx.doc(GatewayState);
      const d = state.deliveries[params.id as string];
      if (!d || !["unknown", "failed"].includes(d.status))
        throw new Error("只能处理 failed 或 unknown 投递");
      if (method === "delivery.discard") {
        d.status = "discarded";
        return { id: d.id, status: d.status };
      }
      d.status = "ready";
      d.attempts = 0;
      d.error = "";
      d.taskId = await tx.createTask(
        DeliveryTask,
        { id: d.id },
        {
          conversationId: ROOT_CONVERSATION_ID,
          ownership: { kind: "conversation" },
          background: true,
        },
      );
      return { id: d.id, status: d.status };
    }, ctx);
  }
  const loops: Promise<void>[] = [];
  function start() {
    if (!adapters.length) return;
    if (loops.length) throw new Error("渠道已启动");
    for (const adapter of adapters)
      if (adapter.poll)
        loops.push(
          (async () => {
            let failures = 0;
            const cursorKey = key(adapter.platform, adapter.account);
            while (!controller.signal.aborted) {
              try {
                const cursor =
                  (await runtime.harness.snapshot(GatewayState, ctx))!.cursors[
                    cursorKey
                  ] ?? "";
                const batch = await adapter.poll!(cursor, controller.signal);
                for (const event of batch.messages) {
                  if (controller.signal.aborted) break;
                  await receive(event);
                }
                if (controller.signal.aborted) break;
                await runtime.harness.commit(async (tx) => {
                  (await tx.doc(GatewayState)).cursors[cursorKey] =
                    batch.cursor;
                }, ctx);
                failures = 0;
                await pause(100, controller.signal);
              } catch {
                if (!controller.signal.aborted) {
                  report("channel_poll_failed", { platform: adapter.platform });
                  await pause(
                    Math.min(30000, 1000 * 2 ** Math.min(failures++, 5)),
                    controller.signal,
                  );
                }
              }
            }
          })(),
        );
    loops.push(
      (async () => {
        while (!controller.signal.aborted) {
          try {
            await syncNotices();
          } catch {
            if (!controller.signal.aborted) report("notice_queue_failed");
          }
          await pause(1000, controller.signal);
        }
      })(),
    );
  }
  return {
    receive,
    control,
    syncNotices,
    start,
    async close() {
      controller.abort();
      await Promise.allSettled(loops);
      await admissions.catch(() => {});
    },
  };
}
export type Gateway = Awaited<ReturnType<typeof openGateway>>;
