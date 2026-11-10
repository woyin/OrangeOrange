import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fork } from "node:child_process";
import { once } from "node:events";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxProvider,
  fauxAssistantMessage,
} from "@earendil-works/pi-ai/providers/faux";
import { config } from "../src/config.js";
import { openRuntime, type RuntimeOptions } from "../src/runtime.js";

export async function setup(options: RuntimeOptions = {}) {
  const dir = await mkdtemp(join(tmpdir(), "orange-"));
  await mkdir(join(dir, "workspace"));
  await mkdir(join(dir, "data"));
  const cfg = config({
    ORANGE_DATA_DIR: join(dir, "data"),
    ORANGE_MODEL: "faux-1",
    ORANGE_WORKSPACE: join(dir, "workspace"),
    ORANGE_SKILLS_DIR: join(dir, "skills"),
  });
  const models = createModels();
  const faux = fauxProvider();
  models.setProvider(faux.provider);
  faux.setResponses(
    Array.from({ length: 30 }, () => fauxAssistantMessage("测试回答")),
  );
  let runtime = await openRuntime(cfg, {
    models,
    provider: "faux",
    ...options,
  });
  return {
    dir,
    cfg,
    faux,
    models,
    get runtime() {
      return runtime;
    },
    async reopen(dropIndex = false) {
      await runtime.close();
      if (dropIndex)
        await rm(join(cfg.dataDir, "history.sqlite"), { force: true });
      runtime = await openRuntime(cfg, {
        models,
        provider: "faux",
        ...options,
      });
      return runtime;
    },
    async cleanup() {
      await runtime.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
export async function until<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  timeout = 8000,
): Promise<T> {
  const deadline = Date.now() + timeout;
  while (true) {
    const value = await read();
    if (accept(value)) return value;
    if (Date.now() > deadline)
      throw new Error(`等待条件超时: ${JSON.stringify(value)}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
export async function worker(
  dir: string,
  mode = "runtime",
  extra: Record<string, string> = {},
) {
  const child = fork(new URL("./worker.ts", import.meta.url), [], {
    execArgv: ["--import", "tsx"],
    env: {
      ...process.env,
      ORANGE_DATA_DIR: dir,
      ORANGE_WORKSPACE: dir,
      ...extra,
      WORKER_MODE: mode,
    },
    silent: true,
  });
  let logs = "";
  child.stderr!.on("data", (b) => {
    logs += b;
  });
  const messages: any[] = [];
  child.on("message", (m) => messages.push(m));
  await Promise.race([
    until(async () => messages.find((m) => m.ready), Boolean),
    once(child, "exit").then(([code]) => {
      throw new Error(`worker exited ${code}: ${logs}`);
    }),
  ]);
  let seq = 0;
  return {
    child,
    messages,
    async call(method: string, params: Record<string, unknown> = {}) {
      const key = ++seq;
      const response = new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => {
          child.off("message", listener);
          reject(new Error(`IPC timeout ${method}: ${logs}`));
        }, 8000);
        function listener(m: any) {
          if (m.key !== key) return;
          clearTimeout(timer);
          child.off("message", listener);
          if (m.error) reject(new Error(m.error));
          else resolve(m.result);
        }
        child.on("message", listener);
      });
      child.send({ key, method, params });
      return response;
    },
    async stop(signal: NodeJS.Signals = "SIGKILL") {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const ended = once(child, "exit");
      child.kill(signal);
      await ended;
    },
  };
}
