import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { config } from "../src/config.js";
import { startDaemon } from "../src/daemon.js";
import { call } from "../src/client.js";

// Deliberately no credential discovery outside the service's documented environment.
if (!process.env.OPENAI_API_KEY) {
  console.error(
    "BLOCKED：未设置 OPENAI_API_KEY。真实模型验收未执行；这不等于验收通过。",
  );
  process.exitCode = 2;
} else {
  const dir = await mkdtemp(join(tmpdir(), "orange-live-"));
  const exec = promisify(execFile);
  const cfg = config({
    ...process.env,
    ORANGE_DATA_DIR: join(dir, "data"),
    ORANGE_WORKSPACE: dir,
  });
  let service: Awaited<ReturnType<typeof startDaemon>> | undefined;
  const env = {
    ...process.env,
    ORANGE_DATA_DIR: cfg.dataDir,
    ORANGE_WORKSPACE: dir,
  };
  const cli = async (...args: string[]) =>
    JSON.parse(
      (
        await exec(process.execPath, ["dist/cli.js", ...args], {
          env,
          timeout: 200000,
          maxBuffer: 4 * 1024 * 1024,
        })
      ).stdout,
    );
  async function ask(cid: number, prompt: string) {
    const admitted = await cli("ask", String(cid), prompt);
    const answer = await cli("input", String(admitted.id), "--wait");
    assert.equal(answer.status, "done");
    return answer;
  }
  try {
    const nonce = `发布验收 ${randomUUID()}`;
    await writeFile(join(dir, "acceptance.md"), nonce);
    service = await startDaemon(cfg, { adapters: [] });
    const a = await cli("new", "真实模型记忆验收");
    await ask(
      a.id,
      '请调用 memory_save，参数为 {"id":"smoke-preference","content":"我偏好先给结果再给证据"}。不要仅口头确认。',
    );
    assert(
      (await call<any[]>(cfg, "memory.list")).some(
        (m) =>
          m.id === "smoke-preference" && m.content === "我偏好先给结果再给证据",
      ),
    );
    const b = await cli("new", "真实模型资料验收");
    assert(
      (
        await call<any>(cfg, "conversation.state", { id: b.id })
      ).profile.memory.some((m: any) => m.id === "smoke-preference"),
    );
    await ask(
      b.id,
      "请调用 read_file 读取 acceptance.md，引用路径并逐字报告内容。",
    );
    const history = await cli("history", String(b.id), "--limit", "100");
    assert(
      history.items.some(
        (entry: any) =>
          entry.kind === "pi.tool-result" &&
          JSON.stringify(entry).includes(nonce),
      ),
    );
    const c = await cli("new", "真实模型历史验收");
    await ask(c.id, "请调用 history_search 搜索 发布验收，报告原文与会话 ID。");
    const recalled = await cli("history", String(c.id), "--limit", "100");
    assert(
      recalled.items.some(
        (entry: any) =>
          entry.kind === "pi.tool-result" &&
          JSON.stringify(entry).includes(nonce),
      ),
    );
    const at = new Date(Date.now() + 15000).toISOString();
    await ask(
      c.id,
      `请调用 reminder_create 创建一次性提醒，text 为 smoke-check，at 为 ${at}，timezone 为 UTC。`,
    );
    const reminders = await cli("reminders");
    const reminder = reminders.find((r: any) => r.text === "smoke-check");
    assert(reminder);
    await service.stop();
    service = await startDaemon(cfg, { adapters: [] });
    const deadline = Date.now() + 20000;
    while (true) {
      const inbox = await cli("inbox");
      if (inbox.some((n: any) => n.id === reminder.id)) break;
      assert(Date.now() < deadline, "提醒未补交付");
      await new Promise((r) => setTimeout(r, 250));
    }
    assert(
      (await cli("memory", "list")).some(
        (m: any) => m.id === "smoke-preference",
      ),
    );
    await cli("ack", reminder.id);
    console.log(
      "PASS：真实模型工具调用、跨会话记忆、文件读取、历史搜索、重启后提醒和显式已读。",
    );
  } finally {
    await service?.stop();
    await rm(dir, { recursive: true, force: true });
  }
}
