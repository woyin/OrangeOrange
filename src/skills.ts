import { readdir } from "node:fs/promises";
import { readWorkspace } from "./workspace.js";
export type Skill = { name: string; description: string; path: string };
export async function scanSkills(directory: string): Promise<Skill[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const result: Skill[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(entry.name))
      continue;
    const path = `${entry.name}/SKILL.md`;
    try {
      const { content } = await readWorkspace(directory, path);
      const metadata = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(
        content,
      )?.[1];
      const description = metadata
        ?.split(/\r?\n/)
        .find((line) => line.startsWith("description:"))
        ?.slice(12)
        .trim()
        .replace(/^(['"])(.*)\1$/, "$2");
      if (!description || description.length > 300)
        throw new Error(`技能 ${entry.name} 缺少有效 description`);
      result.push({ name: entry.name, description, path });
    } catch (e) {
      throw new Error(`无法加载技能 ${entry.name}: ${(e as Error).message}`);
    }
  }
  return result;
}
export async function loadSkill(
  directory: string,
  skills: Skill[],
  name: string,
) {
  const skill = skills.find((s) => s.name === name);
  if (!skill) throw new Error("技能不存在");
  return readWorkspace(directory, skill.path);
}
