import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
const exec = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "orange-install-"));
let daemon;
try {
  for (const name of [
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "tsconfig.build.json",
    "src",
    "skills",
    "prompts",
  ])
    await cp(name, join(root, name), { recursive: true });
  await exec("npm", ["ci", "--no-audit", "--no-fund"], {
    cwd: root,
    timeout: 180000,
    maxBuffer: 4 * 1024 * 1024,
  });
  await exec("npm", ["run", "build"], { cwd: root, timeout: 60000 });
  const env = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !/^ORANGE_(TELEGRAM|WHATSAPP|WEIXIN)_/.test(key),
      ),
    ),
    OPENAI_API_KEY: "",
    ORANGE_DATA_DIR: join(root, "data"),
    ORANGE_WORKSPACE: root,
    ORANGE_SKILLS_DIR: join(root, "skills"),
    ORANGE_MODEL: "gpt-4.1-mini",
  };
  const run = async (...args) =>
    JSON.parse(
      (
        await exec(process.execPath, ["dist/cli.js", ...args], {
          cwd: root,
          env,
          timeout: 15000,
        })
      ).stdout,
    );
  const help = await exec(process.execPath, ["dist/cli.js", "help"], {
    cwd: root,
    env,
  });
  assert(help.stdout.includes("OrangeOrange"));
  daemon = spawn(process.execPath, ["dist/cli.js", "daemon"], {
    cwd: root,
    env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let logs = "";
  daemon.stderr.on("data", (chunk) => (logs += chunk));
  const deadline = Date.now() + 15000;
  while (true) {
    try {
      assert.equal((await run("status")).status, "ready");
      break;
    } catch (e) {
      if (daemon.exitCode !== null || Date.now() > deadline)
        throw new Error(`安装冒烟服务未启动：${logs}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  const conversation = await run("new", "干净安装验收");
  assert(Number.isInteger(conversation.id));
  await run("memory", "save", "干净安装偏好", "--id", "install-check");
  assert.equal((await run("memory", "list"))[0].content, "干净安装偏好");
  assert.equal((await run("skills"))[0].name, "document-review");
  const scheduled = await run("schedule", "create", "执行安装验证提示词", "--name", "安装调度", "--cron", "0 8 * * 1-5", "--timezone", "Asia/Shanghai");
  assert.equal((await run("schedule", "list"))[0].id, scheduled.id);
  assert.equal((await run("schedule", "pause", scheduled.id)).status, "paused");
  assert.equal((await run("schedule", "resume", scheduled.id)).status, "active");
  const ended = once(daemon, "exit");
  await run("stop");
  assert.equal((await ended)[0], 0);
  daemon = undefined;
  console.log(
    "PASS：干净目录 npm ci、本地原生锁依赖编译、构建、编译后 CLI、socket 服务、记忆、技能与通用调度。",
  );
} finally {
  if (daemon && daemon.exitCode === null) {
    const ended = once(daemon, "exit");
    daemon.kill("SIGKILL");
    await ended;
  }
  await rm(root, { recursive: true, force: true });
}
