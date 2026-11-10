import { expect, test } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanSkills, loadSkill } from "../src/skills.js";
test("技能描述扫描与正文按需加载；不加载目录外技能", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orange-skills-"));
  try {
    await mkdir(join(dir, "review"));
    await writeFile(
      join(dir, "review", "SKILL.md"),
      "---\nname: review\ndescription: 只读资料审阅\n---\n使用 read_file 读取资料并引用路径。",
    );
    const skills = await scanSkills(dir);
    expect(skills).toEqual([
      { name: "review", description: "只读资料审阅", path: "review/SKILL.md" },
    ]);
    expect((await loadSkill(dir, skills, "review")).content).toContain(
      "read_file",
    );
    await expect(loadSkill(dir, skills, "../missing")).rejects.toThrow(
      "不存在",
    );
    await symlink(tmpdir(), join(dir, "outside"));
    expect(await scanSkills(dir)).toHaveLength(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
