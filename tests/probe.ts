import {
  defineExtension,
  defineTask,
  ROOT_CONVERSATION_ID,
} from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { AppState } from "../src/state.js";
import type { Runtime } from "../src/runtime.js";
export function installProbe(runtime: Runtime) {
  const version = Number(process.env.PROBE_VERSION ?? "1");
  const task = defineTask<
    { id: string },
    { phase: "start" } | { phase: "work" },
    null
  >({
    name: "test.checkpoint",
    version,
    initial: () => ({ phase: "start" }),
    migrate: (input, checkpoint, fromVersion) => {
      if (fromVersion !== 1 || version !== 2)
        throw new Error("不支持的测试迁移");
      process.send?.({ migrated: true });
      return {
        input: input as { id: string },
        checkpoint: checkpoint as { phase: "work" },
      };
    },
    phases: {
      start: async (_task, api, context) =>
        api.sleepUntil(api.now(), { phase: "work" }, context),
      work: async (task, api, context) => {
        process.send?.({ phase: "work", taskId: task.id });
        if (process.env.HANG_TASK === "1")
          await new Promise<void>((resolve) =>
            api.signal.addEventListener("abort", () => resolve(), {
              once: true,
            }),
          );
        await api.commit(async (tx) => {
          const state = await tx.doc(AppState);
          if (!state.memories.some((m) => m.id === task.input.id))
            state.memories.push({
              id: task.input.id,
              content: `completed-v${version}`,
              updatedAt: api.now(),
              createdAt: api.now(),
              scope: "local",
              kind: "fact",
              source: "test",
            });
          return {
            status: "terminal",
            outcome: { status: "completed", result: null },
          };
        }, context);
      },
    },
    abort: (_task, api, context) =>
      api.commit(
        () => ({ status: "terminal", outcome: { status: "aborted" } }),
        context,
      ),
  });
  runtime.registry.install(defineExtension({ name: "probe", tasks: [task] }));
  return () =>
    runtime.harness.commit(
      (tx) =>
        tx.createTask(
          task,
          { id: "checkpoint-result" },
          {
            conversationId: ROOT_CONVERSATION_ID,
            ownership: { kind: "conversation" },
            background: true,
          },
        ),
      ctx,
    );
}
