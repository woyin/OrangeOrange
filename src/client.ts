import { request } from "node:http";
import type { Config } from "./config.js";
export async function call<T = unknown>(
  config: Pick<Config, "socket">,
  method: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const req = request(
      {
        socketPath: config.socket,
        path: "/rpc",
        method: "POST",
        headers: { "Content-Type": "application/json" },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk) => {
          size += chunk.length;
          if (size > 4 * 1024 * 1024) {
            response.destroy(new Error("响应超过 4 MiB"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("error", reject);
        response.on("end", () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            if (body.error) reject(new Error(body.error));
            else resolve(body.result);
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.setTimeout(15000, () => req.destroy(new Error("本地服务请求超时")));
    req.on("error", (e) => {
      const code = (e as NodeJS.ErrnoException).code;
      reject(
        new Error(
          code === "ENOENT" || code === "ECONNREFUSED"
            ? "服务未启动；先运行 orange daemon"
            : e.message,
        ),
      );
    });
    req.end(JSON.stringify({ method, params }));
  });
}
export type InputResult = {
  id: number;
  status: string;
  answerText?: string;
  reason?: string;
};
export async function waitInput(
  config: Pick<Config, "socket">,
  submissionId: number,
  signal?: AbortSignal,
): Promise<InputResult> {
  const deadline = Date.now() + 180000;
  while (!signal?.aborted) {
    const result = await call<InputResult>(config, "input.get", {
      id: submissionId,
    });
    if (result.status === "done" || result.status === "unanswered")
      return result;
    if (Date.now() > deadline)
      throw new Error(
        `等待超时；任务仍在服务中。使用 orange input ${submissionId} 查询`,
      );
    await new Promise<void>((resolve) => {
      const timer = setTimeout(finish, 250);
      function finish() {
        clearTimeout(timer);
        signal?.removeEventListener("abort", finish);
        resolve();
      }
      signal?.addEventListener("abort", finish, { once: true });
    });
  }
  throw new Error(
    `已停止等待；任务仍在服务中。使用 orange input ${submissionId} 查询`,
  );
}
