import { defineTask, type Tx } from "@earendil-works/pi-durable";
import { AppState } from "./state.js";
import { text } from "./config.js";

export const ReminderTask = defineTask<
  { id: string; at: number; scope: string },
  { phase: "wait" } | { phase: "deliver" },
  null
>({
  name: "orange.reminder",
  version: 2,
  migrate: (input, checkpoint, from) => {
    if (from !== 1) throw new Error("不支持的提醒任务版本");
    const legacy = input as { id: string; at: number };
    return {
      input: { ...legacy, scope: "local" },
      checkpoint: checkpoint as { phase: "wait" } | { phase: "deliver" },
    };
  },
  initial: () => ({ phase: "wait" }),
  phases: {
    wait: (task, runtime, ctx) =>
      runtime.sleepUntil(task.input.at, { phase: "deliver" }, ctx),
    deliver: async (task, runtime, ctx) => {
      await runtime.commit(async (tx) => {
        const state = await tx.doc(AppState);
        const reminder = state.reminders.find(
          (r) => r.id === task.input.id && r.scope === task.input.scope,
        );
        if (reminder?.status === "scheduled") {
          if (
            !state.notices.some(
              (n) => n.id === reminder.id && n.scope === reminder.scope,
            )
          )
            state.notices.push({
              id: reminder.id,
              text: reminder.text,
              at: runtime.now(),
              status: "unread",
              scope: reminder.scope,
              ...(reminder.routeKey ? { routeKey: reminder.routeKey } : {}),
            });
          reminder.status = "delivered";
        }
        return {
          status: "terminal",
          outcome: { status: "completed", result: null },
        };
      }, ctx);
    },
  },
  abort: (_task, runtime, ctx) =>
    runtime.commit(
      () => ({ status: "terminal", outcome: { status: "aborted" } }),
      ctx,
    ),
});

export async function createReminder(
  tx: Tx,
  input: {
    id: string;
    text: string;
    at: number;
    timezone: string;
    scope?: string;
    routeKey?: string;
  },
  conversationId: Parameters<Tx["conversation"]>[0],
) {
  text(input.id, "提醒 ID", 200);
  text(input.text, "提醒正文", 2000);
  if (!Number.isFinite(input.at) || input.at < 0 || input.at > 8.64e15)
    throw new Error("无效的提醒时间");
  new Intl.DateTimeFormat("zh-CN", { timeZone: input.timezone }).format(
    input.at,
  );
  const state = await tx.doc(AppState);
  const scope = input.scope ?? "local";
  const existing = state.reminders.find(
    (r) => r.id === input.id && r.scope === scope,
  );
  if (existing) {
    if (
      existing.text !== input.text ||
      existing.at !== input.at ||
      existing.timezone !== input.timezone
    )
      throw new Error("提醒 ID 已被不同内容使用");
    return { ...existing };
  }
  const taskId = await tx.createTask(
    ReminderTask,
    { id: input.id, at: input.at, scope },
    { conversationId, ownership: { kind: "conversation" }, background: true },
  );
  const reminder = { ...input, scope, status: "scheduled" as const, taskId };
  state.reminders.push(reminder);
  return reminder;
}

export async function cancelReminder(
  tx: Tx,
  reminderId: string,
  scope = "local",
) {
  const state = await tx.doc(AppState);
  const reminder = state.reminders.find(
    (r) => r.id === reminderId && r.scope === scope,
  );
  if (!reminder) throw new Error("提醒不存在");
  if (reminder.status === "scheduled") reminder.status = "cancelled";
  return { ...reminder };
}

export function presentReminder(reminder: import("./state.js").Reminder) {
  return {
    ...reminder,
    atISO: new Date(reminder.at).toISOString(),
    localTime: new Intl.DateTimeFormat("zh-CN", {
      timeZone: reminder.timezone,
      dateStyle: "full",
      timeStyle: "long",
      hour12: false,
    }).format(reminder.at),
  };
}
