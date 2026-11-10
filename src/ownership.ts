import { chmod, mkdir, open, realpath } from "node:fs/promises";
import { join } from "node:path";
import { flock } from "fs-ext";

export async function acquireOwnership(
  directory: string,
): Promise<() => Promise<void>> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const canonical = await realpath(directory);
  const handle = await open(join(canonical, "daemon.lock"), "a", 0o600);
  try {
    await new Promise<void>((resolve, reject) =>
      flock(handle.fd, "exnb", (error) => (error ? reject(error) : resolve())),
    );
  } catch {
    await handle.close();
    throw new Error("数据目录已由另一个服务持有；不能重复启动");
  }
  // Never unlink the lock inode: an existing contender may already have opened it.
  return async () => {
    await handle.close();
  };
}
