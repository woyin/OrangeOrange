import type { Tx } from "@earendil-works/pi-durable";
import { AppState, type Memory, type MemoryKind } from "./state.js";
import { text } from "./config.js";
export function memoryKind(value: unknown): MemoryKind {
  if (value === undefined) return "fact";
  if (value !== "preference" && value !== "fact" && value !== "project")
    throw new Error("记忆类型必须为 preference、fact 或 project");
  return value;
}
export function selectMemories(
  memories: readonly Memory[],
  scope: string,
  query?: string,
): Memory[] {
  const q = query?.normalize("NFKC").toLowerCase();
  return memories
    .filter(
      (m) =>
        m.scope === scope &&
        (!q || m.content.normalize("NFKC").toLowerCase().includes(q)),
    )
    .map((m) => ({ ...m }));
}
export async function saveMemory(
  tx: Tx,
  memoryId: string,
  content: string,
  now: number,
  options: {
    scope?: string;
    kind?: unknown;
    source?: string;
    conversationId?: number;
  } = {},
) {
  text(memoryId, "记忆 ID", 200);
  text(content, "记忆", 2000);
  const scope = text(options.scope ?? "local", "记忆作用域", 200);
  const state = await tx.doc(AppState);
  const own = state.memories.filter((m) => m.scope === scope);
  const old = own.find((m) => m.id === memoryId);
  const kind = memoryKind(options.kind ?? old?.kind);
  const duplicate = own.find(
    (m) => m.id !== memoryId && m.content === content && m.kind === kind,
  );
  if (!old && duplicate) return { ...duplicate };
  const candidate = own.filter((m) => m.id !== memoryId);
  if (
    candidate.length >= 50 ||
    candidate.reduce((sum, m) => sum + m.content.length, 0) + content.length >
      6000
  )
    throw new Error("记忆容量已满（每个作用域最多 50 条、6000 字符）");
  const saved: Memory = {
    id: memoryId,
    content,
    scope,
    kind,
    source: options.source ?? "cli",
    createdAt: old?.createdAt ?? now,
    updatedAt: now,
    ...(options.conversationId === undefined
      ? {}
      : { conversationId: options.conversationId }),
  };
  if (old) Object.assign(old, saved);
  else state.memories.push(saved);
  return saved;
}
export async function deleteMemory(tx: Tx, memoryId: string, scope = "local") {
  const state = await tx.doc(AppState);
  state.memories = state.memories.filter(
    (m) => m.id !== memoryId || m.scope !== scope,
  );
  return { deleted: memoryId, scope };
}
