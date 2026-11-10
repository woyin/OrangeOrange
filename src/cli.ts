#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { pathToFileURL } from "node:url";
import { config } from "./config.js";
import { call, waitInput } from "./client.js";
import { startDaemon } from "./daemon.js";
import { backupData, restoreData } from "./backup.js";
import { acquireOwnership } from "./ownership.js";
import { loginWeixin } from "./channels/weixin.js";
import qrcode from "qrcode-terminal";

const help = `OrangeOrange — 本地个人代理

orange daemon                         前台启动服务（另开终端使用 CLI）
orange stop | status                   停止服务 / 查询状态与用量
orange new [会话名]                    在 ORANGE_WORKSPACE 创建会话
orange sessions                        列出会话
orange chat <会话ID>                    逐行对话，/exit 退出，/cancel 取消执行
orange ask <会话ID> <文本> [--request-id ID] [--wait]
orange input <输入ID> [--wait]          查询已提交输入
orange cancel <会话ID>                  取消当前运行与排队输入
orange history <会话ID> [--before ID] [--limit N]
orange search <关键词> | reindex
orange memory list | search <关键词> | save <文本> [--id ID] [--kind fact] | delete <ID>
                                      记忆命令支持 --scope（默认 local）
orange refresh-memory <会话ID>          空闲时刷新记忆快照
orange channels | deliveries          渠道配置 / 投递状态
orange delivery retry <ID> | discard <ID>
                                      unknown 投递重试可能产生重复消息
orange weixin login                    停止服务后扫码登录 iLink 机器人
orange schedule create <提示词> --name 名称 (--cron "0 8 * * *" | --at ISO) [--timezone Asia/Shanghai] [--conversation 会话ID]
orange schedule list | get <ID> | runs [ID]
orange schedule pause <ID> | resume <ID> | run <ID> | cancel <ID>
orange skills | skill <名称>
orange remind <含时区ISO时间> <文本> [--id ID] [--timezone Asia/Shanghai]
orange reminders | unremind <ID>
orange inbox [--all] | ack <通知ID>
orange backup <新目录>                  服务停止后备份
orange restore <备份目录>               恢复到不存在的 ORANGE_DATA_DIR

配置：ORANGE_DATA_DIR、ORANGE_WORKSPACE、ORANGE_SKILLS_DIR、ORANGE_MODEL。
模型凭据：在启动服务的终端设置 OPENAI_API_KEY。`;
function parse(argv: string[]) {
  const args: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const item = argv[i]!;
    if (!item.startsWith("--")) {
      args.push(item);
      continue;
    }
    const name = item.slice(2);
    if (["wait", "all"].includes(name)) flags[name] = true;
    else if (
      [
        "request-id",
        "id",
        "before",
        "limit",
        "timezone",
        "scope",
        "kind",
        "name",
        "cron",
        "at",
        "conversation",
        "max-turns",
        "timeout-seconds",
        "max-cost-usd",
      ].includes(name)
    ) {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new Error(`--${name} 缺少值`);
      flags[name] = value;
    } else throw new Error(`未知选项 --${name}`);
  }
  return { args, flags };
}
function numeric(value: string | undefined) {
  const number = Number(value);
  if (value === undefined || !Number.isSafeInteger(number) || number < 0)
    throw new Error("缺少有效的数字 ID");
  return number;
}
export async function main(argv = process.argv.slice(2)) {
  const { args, flags } = parse(argv);
  const [command, ...rest] = args;
  const cfg = config();
  const print = (value: unknown) =>
    stdout.write(JSON.stringify(value, null, 2) + "\n");
  const rpc = (method: string, params: Record<string, unknown> = {}) =>
    call<any>(cfg, method, params);
  async function ask(conversationId: number, content: string, wait: boolean) {
    const requestId =
      typeof flags["request-id"] === "string"
        ? flags["request-id"]
        : randomUUID();
    process.stderr.write(`requestId=${requestId}\n`);
    const admitted = await rpc("input.submit", {
      conversationId,
      content,
      requestId,
    });
    print(admitted);
    if (wait) {
      const result = await waitInput(cfg, admitted.id);
      print(result);
      if (result.status === "unanswered") process.exitCode = 1;
    }
  }
  switch (command) {
    case undefined:
    case "help":
      stdout.write(help + "\n");
      break;
    case "daemon": {
      const service = await startDaemon(cfg);
      const stop = () => {
        void service.stop().catch(() => {
          process.exitCode = 1;
        });
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      await service.closed;
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      break;
    }
    case "stop":
      print(await rpc("daemon.stop"));
      break;
    case "status":
      print(await rpc("status"));
      break;
    case "new":
      print(
        await rpc("conversation.create", {
          name: rest.join(" ") || "新会话",
          scope: flags.scope,
        }),
      );
      break;
    case "sessions":
      print(await rpc("conversation.list", { scope: flags.scope }));
      break;
    case "ask":
      await ask(numeric(rest[0]), rest.slice(1).join(" "), flags.wait === true);
      break;
    case "input":
      print(
        flags.wait
          ? await waitInput(cfg, numeric(rest[0]))
          : await rpc("input.get", { id: numeric(rest[0]) }),
      );
      break;
    case "cancel":
      print(await rpc("conversation.cancel", { id: numeric(rest[0]) }));
      break;
    case "history":
      print(
        await rpc("history.list", {
          id: numeric(rest[0]),
          ...(flags.before ? { before: numeric(String(flags.before)) } : {}),
          ...(flags.limit ? { limit: numeric(String(flags.limit)) } : {}),
        }),
      );
      break;
    case "search":
      print(
        await rpc("history.search", {
          query: rest.join(" "),
          scope: flags.scope,
        }),
      );
      break;
    case "reindex":
      print(await rpc("history.rebuild"));
      break;
    case "memory":
      if (rest[0] === "list")
        print(await rpc("memory.list", { scope: flags.scope }));
      else if (rest[0] === "search")
        print(
          await rpc("memory.search", {
            query: rest.slice(1).join(" "),
            scope: flags.scope,
          }),
        );
      else if (rest[0] === "save")
        print(
          await rpc("memory.save", {
            content: rest.slice(1).join(" "),
            id: flags.id,
            kind: flags.kind,
            scope: flags.scope,
          }),
        );
      else if (rest[0] === "delete")
        print(await rpc("memory.delete", { id: rest[1], scope: flags.scope }));
      else throw new Error("使用 memory list、search、save 或 delete");
      break;
    case "refresh-memory":
      print(await rpc("conversation.refresh-memory", { id: numeric(rest[0]) }));
      break;
    case "channels":
      print(await rpc("channels.status"));
      break;
    case "deliveries":
      print(await rpc("deliveries.list"));
      break;
    case "delivery":
      if (!["retry", "discard"].includes(rest[0] ?? ""))
        throw new Error("使用 delivery retry 或 discard");
      print(await rpc(`delivery.${rest[0]}`, { id: rest[1] }));
      break;
    case "weixin": {
      if (rest[0] !== "login") throw new Error("使用 weixin login");
      const release = await acquireOwnership(cfg.dataDir);
      const controller = new AbortController();
      const cancel = () => controller.abort();
      process.once("SIGINT", cancel);
      try {
        print(
          await loginWeixin(
            cfg.dataDir,
            (url) => {
              process.stderr.write("请使用微信扫描二维码，并在手机上确认。\n");
              qrcode.generate(url, { small: true }, (rendered) =>
                stdout.write(rendered + "\n"),
              );
              stdout.write(url + "\n");
            },
            controller.signal,
          ),
        );
      } finally {
        process.off("SIGINT", cancel);
        await release();
      }
      break;
    }
    case "schedule": {
      const action = rest[0];
      if (
        ![
          "create",
          "list",
          "get",
          "runs",
          "pause",
          "resume",
          "run",
          "cancel",
        ].includes(action ?? "")
      )
        throw new Error(
          "使用 schedule create/list/get/runs/pause/resume/run/cancel",
        );
      print(
        await rpc(`schedule.${action}`, {
          ...(action === "create"
            ? {
                prompt: rest.slice(1).join(" "),
                name: flags.name,
                cron: flags.cron,
                at: flags.at,
                timezone: flags.timezone,
                maxTurns: flags["max-turns"],
                timeoutSeconds: flags["timeout-seconds"],
                maxCostUsd: flags["max-cost-usd"],
              }
            : { id: rest[1] }),
          scope: flags.scope,
          ...(flags.conversation
            ? { conversationId: numeric(String(flags.conversation)) }
            : {}),
          requestId: flags["request-id"],
        }),
      );
      break;
    }
    case "skills":
      print(await rpc("skill.list"));
      break;
    case "skill":
      print(await rpc("skill.load", { name: rest[0] }));
      break;
    case "remind":
      print(
        await rpc("reminder.create", {
          at: rest[0],
          text: rest.slice(1).join(" "),
          id: flags.id,
          timezone: flags.timezone,
          scope: flags.scope,
        }),
      );
      break;
    case "reminders":
      print(await rpc("reminder.list", { scope: flags.scope }));
      break;
    case "unremind":
      print(await rpc("reminder.cancel", { id: rest[0], scope: flags.scope }));
      break;
    case "inbox":
      print(
        await rpc("inbox.list", {
          all: flags.all === true,
          scope: flags.scope,
        }),
      );
      break;
    case "ack":
      print(await rpc("inbox.ack", { id: rest[0], scope: flags.scope }));
      break;
    case "backup":
      if (!rest[0]) throw new Error("缺少备份目录");
      print(await backupData(cfg, rest[0]));
      break;
    case "restore":
      if (!rest[0]) throw new Error("缺少备份目录");
      print(await restoreData(cfg, rest[0]));
      break;
    case "chat": {
      const conversationId = numeric(rest[0]);
      await rpc("conversation.state", { id: conversationId });
      const rl = createInterface({ input: stdin, output: stdout });
      try {
        while (true) {
          let line: string;
          try {
            line = await rl.question("你> ");
          } catch {
            break;
          }
          if (line === "/exit") break;
          if (line === "/cancel") {
            print(await rpc("conversation.cancel", { id: conversationId }));
            continue;
          }
          if (!line.trim()) continue;
          try {
            await ask(conversationId, line, true);
          } catch (e) {
            process.stderr.write((e as Error).message + "\n");
          }
        }
      } finally {
        rl.close();
      }
      break;
    }
    default:
      throw new Error(`未知命令 ${command}；运行 orange help 查看用法`);
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((e) => {
    process.stderr.write(`错误：${(e as Error).message}\n`);
    process.exitCode = 1;
  });
}
