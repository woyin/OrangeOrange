import { defineDoc } from "@earendil-works/pi-durable";
export type MemoryKind = "preference" | "fact" | "project";
export type Memory = {
  id: string;
  content: string;
  scope: string;
  kind: MemoryKind;
  source: string;
  createdAt: number;
  updatedAt: number;
  conversationId?: number;
};
export type Reminder = {
  id: string;
  text: string;
  at: number;
  timezone: string;
  scope: string;
  status: "scheduled" | "delivered" | "cancelled";
  taskId: number;
  routeKey?: string;
};
export type Notice = {
  kind?: "task";
  id: string;
  text: string;
  at: number;
  scope: string;
  status: "unread" | "read";
  routeKey?: string;
};
export function migrateMemory(value: unknown): Memory {
  const m = value as Memory;
  return {
    ...m,
    scope: m.scope ?? "local",
    kind: m.kind ?? "fact",
    source: m.source ?? "legacy",
    createdAt: m.createdAt ?? m.updatedAt,
  };
}
export const AppState = defineDoc<{
  memories: Memory[];
  reminders: Reminder[];
  notices: Notice[];
}>({
  kind: "orange.app",
  version: 2,
  scope: "session",
  initial: () => ({ memories: [], reminders: [], notices: [] }),
  migrate: (value, from) => {
    if (from !== 1) throw new Error("不支持的应用状态版本");
    return {
      memories: (value.memories as unknown as Memory[]).map(migrateMemory),
      reminders: (value.reminders as unknown as Reminder[]).map((r) => ({
        ...r,
        scope: r.scope ?? "local",
      })),
      notices: (value.notices as unknown as Notice[]).map((n) => ({
        ...n,
        scope: n.scope ?? "local",
      })),
    };
  },
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 50,
});
export type ConversationProfile = {
  name: string;
  workspace: string;
  memory: Memory[];
  scope: string;
  channel: string;
  routeKey: string;
};
export const Profile = defineDoc<ConversationProfile>({
  kind: "orange.profile",
  version: 2,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({
    name: "",
    workspace: "",
    memory: [],
    scope: "local",
    channel: "cli",
    routeKey: "",
  }),
  migrate: (value, from) => {
    if (from !== 1) throw new Error("不支持的会话版本");
    return {
      name: String(value.name),
      workspace: String(value.workspace),
      memory: (value.memory as unknown as Memory[]).map(migrateMemory),
      scope: "local",
      channel: "cli",
      routeKey: "",
    };
  },
  checkpointWhen: () => true,
});
