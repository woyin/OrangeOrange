import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

export type Config = {
  dataDir: string;
  socket: string;
  workspace: string;
  skillsDir: string;
  model: string;
  promptsDir: string;
  channelEnv: Record<string, string | undefined>;
  searchApiKey?: string;
};
export function config(env = process.env): Config {
  const dataDir = resolve(
    env.ORANGE_DATA_DIR ?? join(homedir(), ".orangeorange"),
  );
  return {
    dataDir,
    socket: join(dataDir, "daemon.sock"),
    workspace: resolve(env.ORANGE_WORKSPACE ?? process.cwd()),
    skillsDir: resolve(env.ORANGE_SKILLS_DIR ?? join(process.cwd(), "skills")),
    model: env.ORANGE_MODEL ?? "gpt-4.1-mini",
    searchApiKey: env.BRAVE_SEARCH_API_KEY,
    channelEnv: Object.fromEntries(
      Object.entries(env).filter(([key]) =>
        /^ORANGE_(TELEGRAM|WHATSAPP|WEIXIN)_/.test(key),
      ),
    ),
    promptsDir: resolve(
      env.ORANGE_PROMPTS_DIR ??
        fileURLToPath(new URL("../prompts", import.meta.url)),
    ),
  };
}
export function text(value: unknown, name: string, max = 10000): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new Error(`${name} 必须为 1–${max} 字符的文本`);
  return value;
}
export function id(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new Error("无效的记录 ID");
  return value;
}

export function parseTime(value: string): number {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.exec(
      value,
    );
  if (!match) throw new Error("时间必须为包含 Z 或 UTC 偏移的 ISO 时间");
  const [year, month, day, hour, minute, second] = match
    .slice(1)
    .map((v) => Number(v ?? 0));
  const calendar = new Date(0);
  calendar.setUTCFullYear(year!, month! - 1, day!);
  calendar.setUTCHours(hour!, minute!, second!, 0);
  if (
    calendar.getUTCFullYear() !== year ||
    calendar.getUTCMonth() + 1 !== month ||
    calendar.getUTCDate() !== day ||
    calendar.getUTCHours() !== hour ||
    calendar.getUTCMinutes() !== minute ||
    calendar.getUTCSeconds() !== second
  )
    throw new Error("无效的日历时间");
  const at = Date.parse(value);
  if (!Number.isFinite(at)) throw new Error("无效的提醒时间");
  return at;
}
