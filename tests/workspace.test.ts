import { expect, test } from "vitest";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readWorkspace } from "../src/workspace.js";
test("工作区支持中文 UTF-8，拒绝目录穿越、绝对越界、符号链接、二进制和大文件", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orange-files-"));
  const root = join(dir, "workspace");
  await mkdir(root);
  try {
    await writeFile(join(root, "说明.md"), "发布检查资料");
    await writeFile(join(dir, "outside"), "外部资料");
    expect(await readWorkspace(root, "说明.md")).toEqual({
      path: "说明.md",
      content: "发布检查资料",
    });
    await expect(readWorkspace(root, "说明.md", [root])).rejects.toThrow(
      "私有数据",
    );
    await expect(readWorkspace(root, "../outside")).rejects.toThrow("工作区");
    await expect(readWorkspace(root, join(dir, "outside"))).rejects.toThrow(
      "工作区",
    );
    await symlink(join(dir, "outside"), join(root, "link"));
    await expect(readWorkspace(root, "link")).rejects.toThrow("符号链接");
    await symlink(dir, join(root, "linked-dir"));
    await expect(readWorkspace(root, "linked-dir/outside")).rejects.toThrow(
      "符号链接",
    );
    await writeFile(join(root, "binary"), Buffer.from([0, 1]));
    await expect(readWorkspace(root, "binary")).rejects.toThrow("二进制");
    await writeFile(join(root, "large"), "x".repeat(131073));
    await expect(readWorkspace(root, "large")).rejects.toThrow("限制");
    await expect(readWorkspace(root, ".")).rejects.toThrow("普通文件");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
