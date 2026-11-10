import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export async function readWorkspace(
  root: string,
  requested: string,
  excluded: string[] = [],
): Promise<{ path: string; content: string }> {
  if (!requested || requested.includes("\0")) throw new Error("无效的文件路径");
  const base = await realpath(root);
  const candidate = resolve(base, requested);
  const inside = (path: string) => {
    const rel = relative(base, path);
    return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  };
  if (!inside(candidate)) throw new Error("文件超出工作区");
  const actual = await realpath(candidate);
  if (!inside(actual)) throw new Error("符号链接超出工作区");
  for (const directory of excluded) {
    const privateRoot = await realpath(directory);
    const rel = relative(privateRoot, actual);
    if (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`))
      throw new Error("不能读取代理私有数据目录");
  }
  const file = await open(
    actual,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error("只允许读取普通文件");
    if (stat.size > 128 * 1024) throw new Error("文件超过 128 KiB 限制");
    // A bounded read also limits growth after stat().
    const buffer = Buffer.alloc(128 * 1024 + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const chunk = await file.read(
        buffer,
        bytesRead,
        buffer.length - bytesRead,
        bytesRead,
      );
      if (chunk.bytesRead === 0) break;
      bytesRead += chunk.bytesRead;
    }
    if (bytesRead > 128 * 1024) throw new Error("文件超过 128 KiB 限制");
    const bytes = buffer.subarray(0, bytesRead);
    if (bytes.includes(0)) throw new Error("不支持二进制文件");
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error("文件必须为 UTF-8 文本");
    }
    return { path: relative(base, actual), content };
  } finally {
    await file.close();
  }
}
