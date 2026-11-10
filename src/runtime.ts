import { createHash, randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels, type Models } from "@earendil-works/pi-ai/models";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import {
  createRegistry,
  defineExtension,
  defineTool as sdkDefineTool,
  defineDoc,
  configure,
  UsageDoc,
  AgentDoc,
  ProviderDoc,
  type ToolRegistration,
  section,
  Harness,
  GenerationTask,
  hook,
  ROOT_CONVERSATION_ID,
  type ConversationId,
  type EntryId,
  type SubmissionId,
  type HarnessOptions,
  type Tx,
  LiveDoc,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { obj, opt, str } from "@earendil-works/pi-schema";
import { type Config, id, text, parseTime } from "./config.js";
import { AppState, Profile } from "./state.js";
import { saveMemory, deleteMemory, selectMemories } from "./memory.js";
import { loadPrompts, memoryPrompt } from "./prompts.js";
import {
  ReminderTask,
  createReminder,
  cancelReminder,
  presentReminder,
} from "./reminders.js";
import { scanSkills, loadSkill } from "./skills.js";
import { readWorkspace } from "./workspace.js";
import { History, messageText } from "./history.js";
import {
  createScheduler,
  ScheduleState,
  ScheduledContext,
} from "./schedules.js";
import { createWeb } from "./web.js";

const ExternalConversations = defineDoc<{ids:Record<string,number>}>({kind:"hda.external-conversations",version:1,scope:"session",initial:()=>({ids:{}}),checkpointWhen:()=>true});
const SkillPolicy = defineDoc<{disabled:string[]}>({kind:"hda.skill-policy",version:1,scope:"session",initial:()=>({disabled:[]}),checkpointWhen:()=>true});
class ExistingConversation extends Error { constructor(readonly conversationId:ConversationId) { super("已有会话"); } }

export type RuntimeOptions = {
  models?: Models;
  provider?: string;
  now?: () => number;
  setTimer?: HarnessOptions["setTimer"];
  onReport?: HarnessOptions["onReport"];
  web?: ReturnType<typeof createWeb>;
  privatePaths?: string[];
  disableLegacyAutomation?: boolean;
  /** 同步持久化预留/拒绝；抛错发生在调用 Models 请求前。计量与价格上界由调用方提供。 */
  modelAdmission?: (request:{method:string;model:unknown;context:unknown;options:unknown;conversationId:number})=>{maxTokens?:number}|void;
  /** 在每次模型发送前等待持久化暂停屏障，不消耗预算或调用供应商。 */
  /** 控制面接管供应商错误重试；返回固定错误码，不把原响应存入审计。 */
  modelFailure?: (request:{conversationId:number;code:string;retryable:boolean})=>void;
  modelGate?: (request:{conversationId:number;signal?:AbortSignal})=>Promise<void>;
  toolGateway?: (call: {name:string; args:unknown; scope:string; conversationId:number; taskId:number; requestIds:string[]; callId:string; signal?:AbortSignal}, execute:()=>Promise<any>)=>Promise<any>;
};
export async function openRuntime(
  config: Config,
  options: RuntimeOptions = {},
) {
  const providerConversations = new Map<string,number>();
  const disabledSkills = new Set<string>();
  const baseModels = options.models ?? createModels();
  const requestMethods = new Set(["stream","streamSimple","streamDeferred","complete","completeSimple","fetchDeferred"]);
  const models = new Proxy(baseModels,{get(target,key) {
    const value = Reflect.get(target,key);
    if (typeof value !== "function") return value;
    if ((!options.modelAdmission && !options.modelGate && !options.modelFailure) || !requestMethods.has(String(key))) return value.bind(target);
    return (...args:unknown[]) => {
      const requestOptions = args[2] as {sessionId?:string;signal?:AbortSignal} | undefined;
      const conversationId = requestOptions?.sessionId ? providerConversations.get(requestOptions.sessionId) : undefined;
      if (conversationId === undefined) throw new Error("模型请求缺少已知会话，拒绝预算旁路");
      const invoke = () => {
        const admitted = options.modelAdmission?.({method:String(key),model:args[0],context:args[1],options:args[2],conversationId});
        if (admitted?.maxTokens !== undefined) {
          if (!Number.isSafeInteger(admitted.maxTokens) || admitted.maxTokens < 1) throw new Error("模型输出预算无效");
          args[2] = {...(args[2] as object ?? {}),maxTokens:admitted.maxTokens};
        }
        return value.apply(target,args);
      };
      const complete = (message:any) => {
        if (options.modelFailure && message?.stopReason === "error" && !requestOptions?.signal?.aborted) {
          const error = String(message.errorMessage ?? "");
          const code = /\b429\b/.test(error) ? "MODEL_RATE_LIMITED" : /\b5\d\d\b/.test(error) ? "MODEL_SERVER_ERROR" : /timeout|timed out/i.test(error) ? "MODEL_TIMEOUT" : "MODEL_ERROR";
          options.modelFailure({conversationId,code,retryable:code !== "MODEL_ERROR"});
          return {...message,errorMessage:"CONTROL_MODEL_ERROR"};
        }
        return message;
      };
      if (!options.modelGate && !options.modelFailure) return invoke();
      const ready = (options.modelGate?.({conversationId,signal:requestOptions?.signal}) ?? Promise.resolve()).then(invoke);
      if (!String(key).startsWith("stream")) return ready.then(complete);
      return {
        async *[Symbol.asyncIterator]() { yield* await ready; },
        result: async () => complete(await (await ready).result()),
      };
    };
  }});
  if (!options.models)
    (models as ReturnType<typeof createModels>).setProvider(openaiProvider());
  const provider = options.provider ?? "openai";
  if (!models.getModel(provider, config.model))
    throw new Error(`模型不存在：${provider}/${config.model}`);
  const skills = await scanSkills(config.skillsDir);
  const prompts = await loadPrompts(config.promptsDir);
  const registry = createRegistry();
  const now = options.now ?? Date.now;
  const storage = await openNodeSqliteStorage(
    join(config.dataDir, "state.sqlite"),
  );
  let harness: Harness;
  let history: History;
  const result = (value: unknown) => ({
    output: [{ type: "text" as const, text: JSON.stringify(value) }],
  });
  const web = options.web ?? createWeb(config.searchApiKey);
  const scheduler = createScheduler({
    harness: () => harness,
    storage,
    now,
    createConversation,
    authenticated: async () => !!(await models.getAuth(provider)),
  });
  if (!options.disableLegacyAutomation) registry.install(scheduler.extension);
  const toolDescriptors: ToolRegistration[] = [];
  const defineTool: typeof sdkDefineTool = (definition) => {
    toolDescriptors.push(definition);
    return sdkDefineTool({ ...definition, execute: async (args, api, context) => {
      if (definition.name === "skill_load" && disabledSkills.has((args as {name:string}).name)) throw new Error("技能已禁用");
      const execute = async () => {
        if (definition.name === "skill_load" && disabledSkills.has((args as {name:string}).name)) throw new Error("技能已禁用");
        if (options.disableLegacyAutomation && /^(schedule_|reminder_)/.test(definition.name)) throw new Error("生产模式禁用旧自动化工具");
        return definition.execute(args, api, context);
      };
      if (!options.toolGateway) return execute();
      const profile = await api.snapshot(Profile, api.conversationId, context);
      const live = await api.snapshot(LiveDoc,api.conversationId,context);
      const submissions = await Promise.all((live?.run?.inputs ?? []).map(sid=>storage.submission(sid,context)));
      const requestIds = submissions.flatMap(s=>s?.requestId ? [s.requestId] : []);
      const receipt = await options.toolGateway({name:definition.name,args,scope:profile?.scope ?? "local",conversationId:api.conversationId,taskId:api.taskId,requestIds,callId:api.callId,signal:context.abortSignal},execute);
      return receipt && typeof receipt === "object" && Array.isArray(receipt.output) ? receipt : result(receipt);
    }});
  };
  registry.install(
    defineExtension({
      name: "orange",
      tasks: options.disableLegacyAutomation ? [] : [ReminderTask],
      sections: [
        section("identity", () => prompts.identity),
        section("policy", () => prompts.policy),
        section("channel_context", async (input, context) => {
          const profile = await input.read.snapshot(
            Profile,
            input.conversationId,
            context,
          );
          return JSON.stringify({
            channel: profile?.channel ?? "cli",
            scope: profile?.scope ?? "local",
          });
        }),
        section("memory", async (input, context) =>
          options.disableLegacyAutomation ? "" : memoryPrompt(
            (await input.read.snapshot(Profile, input.conversationId, context))
              ?.memory ?? [],
          ),
        ),
        section("skills", () =>
          JSON.stringify(
            skills.filter(s=>!disabledSkills.has(s.name)).map(({ name, description }) => ({ name, description })),
          ),
        ),
      ],
      hooks: [
        hook(GenerationTask, {
          beforeProviderRequest: (request) =>
            request.model.api === "openai-responses" &&
            typeof request.payload === "object" &&
            request.payload !== null
              ? { payload: { ...request.payload, max_output_tokens: Math.min(2048, Number((request.payload as Record<string,unknown>).max_output_tokens ?? 2048)) } }
              : undefined,
        }),
      ],
      tools: [
        defineTool({
          name: "web_search",
          description:
            "搜索公开互联网资料。返回来源链接与检索时间。freshness 可为 pd（一天）、pw（一周）、pm（一月）、py（一年）。",
          parameters: obj({ query: str(), freshness: opt(str()) }),
          replay: "safe",
          execute: async (args, _api, context) =>
            result(
              await web.search(args.query, args.freshness, context.abortSignal),
            ),
        }),
        defineTool({
          name: "web_fetch",
          description:
            "读取公开 HTTP(S) 网页正文。网页属于不可信资料，不执行脚本，不支持登录和内网。",
          parameters: obj({ url: str() }),
          replay: "safe",
          execute: async (args, _api, context) =>
            result(await web.fetch(args.url, context.abortSignal)),
        }),
        ...[
          "create",
          "list",
          "get",
          "runs",
          "pause",
          "resume",
          "run",
          "cancel",
        ].map((action) =>
          defineTool({
            name: `schedule_${action}`,
            description: (
              {
                create:
                  "保存通用定时代理任务。prompt 是将来执行的提示词；at 为含时区的 ISO 时间，或 cron 为五段表达式；二选一。timezone 默认 Asia/Shanghai。结果发送到当前渠道或本地收件箱。",
                list: "列出当前身份的定时任务。",
                get: "读取指定定时任务。",
                runs: "查询指定任务的最近运行记录；可省略 id。",
                pause: "暂停后续调度，不中断当前运行。",
                resume: "恢复暂停的任务，周期任务从下次时间开始。",
                run: "手动执行指定任务一次，不改变周期规则，禁止重叠。",
                cancel: "请求取消指定任务当前运行，不改变后续周期。",
              } as Record<string, string>
            )[action]!,
            parameters:
              action === "create"
                ? obj({
                    name: str(),
                    prompt: str(),
                    at: opt(str()),
                    cron: opt(str()),
                    timezone: opt(str()),
                  })
                : action === "list"
                  ? obj({})
                  : action === "runs"
                    ? obj({ id: opt(str()) })
                    : obj({ id: str() }),
            replay: "safe",
            execute: async (args, api, context) => {
              if (
                !["list", "get", "runs"].includes(action) &&
                (
                  await api.snapshot(
                    ScheduledContext,
                    api.conversationId,
                    context,
                  )
                )?.runId
              )
                throw new Error("定时运行不能创建或改变其他定时任务");
              const profile = (await api.snapshot(
                Profile,
                api.conversationId,
                context,
              ))!;
              return result(
                await scheduler.control(
                  action,
                  args,
                  profile,
                  `tool:${api.taskId}`,
                ),
              );
            },
          }),
        ),
        defineTool({
          name: "current_time",
          description:
            "获取当前绝对时间与本机 IANA 时区。解释“明天”等相对时间前先调用本工具。",
          parameters: obj({}),
          replay: "safe",
          execute: async () =>
            result({
              now: new Date(now()).toISOString(),
              timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            }),
        }),
        defineTool({
          name: "read_file",
          description:
            "读取会话工作区内 UTF-8 文本（最多 128 KiB），返回路径与正文。",
          parameters: obj({ path: str() }),
          replay: "safe",
          execute: async (args, api, context) => {
            const profile = await api.snapshot(
              Profile,
              api.conversationId,
              context,
            );
            return result(
              await readWorkspace(profile!.workspace, args.path, [
                config.dataDir,
                ...(options.privatePaths ?? []),
              ]),
            );
          },
        }),
        defineTool({
          name: "memory_list",
          description: "列出当前身份的实时长期记忆。",
          parameters: obj({}),
          replay: "safe",
          execute: async (_args, api, context) =>
            result(
              selectMemories(
                (await api.snapshot(AppState, context))?.memories ?? [],
                (await api.snapshot(Profile, api.conversationId, context))!
                  .scope,
              ),
            ),
        }),
        defineTool({
          name: "memory_search",
          description: "在当前身份的实时记忆中按关键词查找。",
          parameters: obj({ query: str() }),
          replay: "safe",
          execute: async (args, api, context) =>
            result(
              selectMemories(
                (await api.snapshot(AppState, context))?.memories ?? [],
                (await api.snapshot(Profile, api.conversationId, context))!
                  .scope,
                text(args.query, "记忆查询", 200),
              ),
            ),
        }),
        defineTool({
          name: "memory_save",
          description:
            "保存当前身份的长期记忆；用已有 id 更新；kind 为 preference、fact 或 project。",
          parameters: obj({ content: str(), id: opt(str()), kind: opt(str()) }),
          replay: "safe",
          execute: async (args, api, context) => {
            const profile = (await api.snapshot(
              Profile,
              api.conversationId,
              context,
            ))!;
            return result(
              await api.commit(
                (tx) =>
                  saveMemory(
                    tx,
                    args.id ?? `tool-${api.taskId}`,
                    args.content,
                    now(),
                    {
                      scope: profile.scope,
                      kind: args.kind,
                      source: "tool",
                      conversationId: api.conversationId,
                    },
                  ),
                context,
              ),
            );
          },
        }),
        defineTool({
          name: "memory_delete",
          description: "删除当前身份的指定长期记忆。",
          parameters: obj({ id: str() }),
          replay: "safe",
          execute: async (args, api, context) => {
            const profile = (await api.snapshot(
              Profile,
              api.conversationId,
              context,
            ))!;
            return result(
              await api.commit(
                (tx) => deleteMemory(tx, args.id, profile.scope),
                context,
              ),
            );
          },
        }),
        defineTool({
          name: "history_search",
          description: "在当前身份的历史中搜索，返回原文、会话与记录 ID。",
          parameters: obj({ query: str() }),
          replay: "safe",
          execute: async (args, api, context) =>
            result(
              await scopeHistory(
                args.query,
                (await api.snapshot(Profile, api.conversationId, context))!
                  .scope,
              ),
            ),
        }),
        defineTool({
          name: "skill_load",
          description: "加载一个已列出的人工技能正文，仅作为只读资料。",
          parameters: obj({ name: str() }),
          replay: "safe",
          execute: async (args) =>
            result(await loadSkill(config.skillsDir, skills, args.name)),
        }),
        defineTool({
          name: "reminder_create",
          description:
            "创建一次性文本提醒。at 必须为含 Z 或 UTC 偏移的 ISO 时间，timezone 为 IANA 时区。返回持久化提醒。",
          parameters: obj({ text: str(), at: str(), timezone: str() }),
          replay: "safe",
          execute: async (args, api, context) => {
            const at = parseTime(args.at);
            const profile = (await api.snapshot(
              Profile,
              api.conversationId,
              context,
            ))!;
            return result(
              presentReminder(
                await api.commit(
                  (tx) =>
                    createReminder(
                      tx,
                      {
                        id: `tool-${api.taskId}`,
                        text: args.text,
                        at,
                        timezone: args.timezone,
                        scope: profile.scope,
                        ...(profile.routeKey
                          ? { routeKey: profile.routeKey }
                          : {}),
                      },
                      api.conversationId,
                    ),
                  context,
                ),
              ),
            );
          },
        }),
        defineTool({
          name: "reminder_list",
          description: "列出当前身份的提醒及交付状态。",
          parameters: obj({}),
          replay: "safe",
          execute: async (_args, api, context) => {
            const profile = (await api.snapshot(
              Profile,
              api.conversationId,
              context,
            ))!;
            return result(
              (await api.snapshot(AppState, context))!.reminders
                .filter((r) => r.scope === profile.scope)
                .map(presentReminder),
            );
          },
        }),
        defineTool({
          name: "reminder_cancel",
          description: "取消当前身份尚未交付的提醒。",
          parameters: obj({ id: str() }),
          replay: "safe",
          execute: async (args, api, context) => {
            const profile = (await api.snapshot(
              Profile,
              api.conversationId,
              context,
            ))!;
            return result(
              await api.commit(
                (tx) => cancelReminder(tx, args.id, profile.scope),
                context,
              ),
            );
          },
        }),
      ],
    }),
  );
  try {
    harness = await Harness.open(
      storage,
      {
        models,
        registry,
        now,
        setTimer: options.setTimer,
        onReport: options.onReport,
        settings: {
          stream: { timeoutMs: 60000, maxRetries: 0 },
          retry: { maxRetries: 2, baseDelayMs: 100 },
          afterFailedRun: "withdraw",
          toolExecution: "sequential",
        },
      },
      ctx,
    );
    await harness.root(ctx);
    await harness.commit(async (tx) => {
      await tx.doc(AppState);
      await tx.doc(ScheduleState);
    }, ctx);
    history = new History(storage, join(config.dataDir, "history.sqlite"));
    await history.sync();
  } catch (e) {
    if (history!) await history.close();
    if (harness!) await harness.close(ctx);
    else await storage.close(ctx);
    throw e;
  }
  let indexError: string | undefined;
  const observation = harness.observeCommits({
    advance: (publication) => {
      if (
        publication.changes.some(
          (c) => c.type === "entry" || c.type === "conversation",
        )
      )
        queueMicrotask(() => {
          void history.sync().then(
            () => {
              indexError = undefined;
            },
            () => {
              indexError = "历史索引更新失败；可重建索引";
            },
          );
        });
    },
    end: () => {},
  });
  for (const name of (await harness.snapshot(SkillPolicy,ctx))?.disabled ?? []) disabledSkills.add(name);
  let providerCursor;
  do {
    const page = await storage.scanConversations({order:"ascending"},100,providerCursor,ctx);
    for (const record of page.items) {
      let providerState = await harness.snapshot(ProviderDoc,record.id,ctx);
      if (!providerState) {
        const c = await harness.conversation(record.id,ctx);
        await c!.commit(async tx=>{ await tx.doc(ProviderDoc,record.id); },ctx);
        providerState = await harness.snapshot(ProviderDoc,record.id,ctx);
      }
      if (providerState) providerConversations.set(providerState.sessionId,record.id);
    }
    providerCursor = page.next;
  } while (providerCursor);
  harness.resume();

  async function conversation(value: unknown) {
    const found = await harness.conversation(id(value) as ConversationId, ctx);
    if (!found || !(await harness.snapshot(Profile, found.id, ctx)))
      throw new Error("会话不存在");
    return found;
  }
  async function createConversation(
    params: Record<string, unknown> = {},
    initialize?: (tx: Tx, cid: ConversationId) => Promise<void>,
  ) {
    const name = text(params.name ?? "新会话", "会话名", 100);
    const scope = text(params.scope ?? "local", "身份作用域", 200);
    const channel = text(params.channel ?? "cli", "渠道", 40);
    const workspace = await realpath(
      text(params.workspace ?? config.workspace, "工作区"),
    );
    if (!(await stat(workspace)).isDirectory())
      throw new Error("工作区必须为目录");
    const externalId = params.externalId === undefined ? undefined : text(params.externalId,"externalId",200);
    try {
    const created = await harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: {
          model: { provider: typeof params.provider === "string" ? params.provider : provider, modelId: typeof params.model === "string" ? params.model : config.model },
          ...(params.systemPrompt === undefined ? {} : {instructions:text(params.systemPrompt,"系统提示",32000)}),
          maxTurns:
            params.maxTurns === undefined ? 12 : validTurns(params.maxTurns),
        },
        init: async (tx, cid) => {
          if (externalId) {
            const mapping = await tx.doc(ExternalConversations);
            const key = `external:${externalId}`;
            if (mapping.ids[key] !== undefined) throw new ExistingConversation(mapping.ids[key]! as ConversationId);
            mapping.ids[key] = cid;
          }
          await tx.doc(ProviderDoc,cid);
          const state = await tx.doc(AppState);
          const profile = await tx.doc(Profile, cid);
          profile.name = name;
          profile.workspace = workspace;
          profile.scope = scope;
          profile.channel = channel;
          profile.routeKey =
            typeof params.routeKey === "string" ? params.routeKey : "";
          profile.memory = selectMemories(state.memories, scope);
          await initialize?.(tx, cid);
        },
      },
      ctx,
    );
    const providerState = await harness.snapshot(ProviderDoc,created.id,ctx);
    if (providerState) providerConversations.set(providerState.sessionId,created.id);
    return { id: created.id, name, workspace, scope, channel };
    } catch (error) {
      if (error instanceof ExistingConversation) {
        const providerState = await harness.snapshot(ProviderDoc,error.conversationId,ctx);
        if (providerState) providerConversations.set(providerState.sessionId,error.conversationId);
        return {id:error.conversationId,name,workspace,scope,channel};
      }
      throw error;
    }
  }
  async function scopeHistory(query: string, scope: string) {
    const ids: number[] = [];
    let cursor;
    do {
      const page = await storage.scanConversations(
        { order: "ascending" },
        100,
        cursor,
        ctx,
      );
      for (const c of page.items)
        if ((await harness.snapshot(Profile, c.id, ctx))?.scope === scope)
          ids.push(c.id);
      cursor = page.next;
    } while (cursor);
    return history.search(query, ids);
  }

  async function dispatch(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<unknown> {
    if (options.disableLegacyAutomation && /^(schedule|reminder)\./.test(method))
      throw new Error("生产模式禁用旧自动化入口");
    if (method.startsWith("schedule.")) {
      const owner =
        params.conversationId === undefined
          ? {
              scope: text(params.scope ?? "local", "身份作用域", 200),
              channel: "cli",
              workspace: config.workspace,
              routeKey: "",
            }
          : (await harness.snapshot(
              Profile,
              (await conversation(params.conversationId)).id,
              ctx,
            ))!;
      return scheduler.control(
        method.slice("schedule.".length),
        params,
        owner,
        params.requestId === undefined
          ? undefined
          : `cli:${text(params.requestId, "requestId", 160)}`,
      );
    }
    switch (method) {
      case "status":
        return {
          status: "ready",
          capabilities: {
            schedules: !options.disableLegacyAutomation,
            webFetch: true,
            webSearchConfigured: !!config.searchApiKey,
          },
          provider,
          model: config.model,
          indexError,
          wake: harness.wake(),
          work: await harness.inspect(ctx),
          usage: await harness.usage(ctx),
          priceSource: "Pi 模型目录；目录缺失价格时费用未知",
        };
      case "conversation.create":
        return createConversation(params);
      case "conversation.list": {
        const page = await storage.scanConversations(
          { order: "descending" },
          100,
          undefined,
          ctx,
        );
        const items = await Promise.all(
          page.items.map(async (c) => ({
            id: c.id,
            profile: await harness.snapshot(Profile, c.id, ctx),
          })),
        );
        return items.filter(
          (c) => c.profile?.scope === (params.scope ?? "local"),
        );
      }
      case "conversation.live": {
        const c = await conversation(params.id);
        return {id:c.id,live:await harness.snapshot(LiveDoc,c.id,ctx),usage:await harness.snapshot(UsageDoc,c.id,ctx),provider:await harness.snapshot(ProviderDoc,c.id,ctx)};
      }
      case "conversation.configure": {
        const c = await conversation(params.id);
        return c.commit(async tx => {
          if ((await tx.doc(LiveDoc,c.id)).run) throw new Error("运行中不能切换模型");
          const agent = await tx.doc(AgentDoc,c.id);
          await configure(tx,c.id,{...(params.systemPrompt === undefined ? {} : {instructions:text(params.systemPrompt,"系统提示",32000)}),...(params.model === undefined && params.provider === undefined ? {} : {model:{provider:text(params.provider ?? agent.model?.provider ?? provider,"供应商",100),modelId:text(params.model ?? agent.model?.modelId ?? config.model,"模型",100)}}),...(params.maxTurns === undefined ? {} : {maxTurns:validTurns(params.maxTurns)})});
          return {configured:c.id};
        },ctx);
      }
      case "conversation.state": {
        const c = await conversation(params.id);
        return {
          id: c.id,
          profile: await harness.snapshot(Profile, c.id, ctx),
          context: await c.context(ctx),
        };
      }
      case "conversation.cancel": {
        const c = await conversation(params.id);
        await c.abort(ctx);
        return { cancelled: c.id };
      }
      case "input.submit": {
        const c = await conversation(params.conversationId);
        const requestId = text(params.requestId, "requestId", 200);
        const content = text(params.content, "输入", 32000);
        const existing = await storage.submissionByRequest(
          c.id,
          requestId,
          ctx,
        );
        if (existing)
          return { id: existing.id, requestId, status: existing.status };
        const agent = await harness.snapshot(AgentDoc,c.id,ctx);
        if (!(await models.getAuth(agent?.model?.provider ?? provider)))
          throw new Error("缺少模型凭据；请为服务配置 OPENAI_API_KEY");
        const submitted = await c.submit(
          { type: "input", content, requestId },
          ctx,
        );
        return { id: submitted.id, requestId };
      }
      case "input.get": {
        const submitted = await harness.submission(
          id(params.id) as SubmissionId,
          ctx,
        );
        if (!submitted) throw new Error("输入不存在");
        const record = await submitted.status(ctx);
        const answer =
          record.status === "done" && record.type === "input"
            ? await storage.entry(record.answer, ctx)
            : undefined;
        return {
          ...record,
          answerText: answer ? messageText(answer.entry) : undefined,
        };
      }
      case "history.list": {
        const c = await conversation(params.id);
        const limit = params.limit === undefined ? 20 : id(params.limit);
        if (limit < 1 || limit > 100) throw new Error("limit 必须为 1–100");
        const before =
          params.before === undefined ? undefined : id(params.before);
        const page = await c.entries(
          {
            order: "descending",
            ...(before === undefined
              ? {}
              : { maxEntryId: (before - 1) as EntryId }),
          },
          limit,
          undefined,
          ctx,
        );
        return { items: page.items, before: page.items.at(-1)?.id };
      }
      case "history.search":
        return scopeHistory(
          text(params.query, "查询", 200),
          text(params.scope ?? "local", "身份作用域", 200),
        );
      case "history.rebuild":
        return history.rebuild();
      case "memory.list":
        return selectMemories(
          (await harness.snapshot(AppState, ctx))!.memories,
          text(params.scope ?? "local", "身份作用域", 200),
        );
      case "memory.search":
        return selectMemories(
          (await harness.snapshot(AppState, ctx))!.memories,
          text(params.scope ?? "local", "身份作用域", 200),
          text(params.query, "查询", 200),
        );
      case "memory.save":
        return harness.commit(
          (tx) =>
            saveMemory(
              tx,
              text(params.id ?? randomUUID(), "记忆 ID", 200),
              text(params.content, "记忆", 2000),
              now(),
              {
                scope: text(params.scope ?? "local", "身份作用域", 200),
                kind: params.kind,
              },
            ),
          ctx,
        );
      case "memory.delete":
        return harness.commit(
          (tx) =>
            deleteMemory(
              tx,
              text(params.id, "记忆 ID", 200),
              text(params.scope ?? "local", "身份作用域", 200),
            ),
          ctx,
        );
      case "conversation.refresh-memory": {
        const c = await conversation(params.id);
        return c.commit(async (tx) => {
          const live = await tx.doc(LiveDoc, c.id);
          if (live.run)
            throw new Error("运行中不能刷新记忆；请等待完成或先取消");
          const state = await tx.doc(AppState);
          const profile = await tx.doc(Profile, c.id);
          profile.memory = selectMemories(state.memories, profile.scope);
          return { refreshed: c.id, count: profile.memory.length };
        }, ctx);
      }
      case "skill.toggle": {
        const name = text(params.name,"技能名",64);
        if (!skills.some(s=>s.name===name)) throw new Error("技能不存在");
        if (typeof params.enabled !== "boolean") throw new Error("enabled必须为boolean");
        await harness.commit(async tx=>{
          const policy = await tx.doc(SkillPolicy);
          policy.disabled = params.enabled ? policy.disabled.filter(n=>n!==name) : [...new Set([...policy.disabled,name])];
        },ctx);
        if (params.enabled) disabledSkills.delete(name); else disabledSkills.add(name);
        return {name,enabled:params.enabled};
      }
      case "skill.list":
        return Promise.all(skills.map(async skill=>{
          const loaded = await loadSkill(config.skillsDir,skills,skill.name);
          return {...skill,content:loaded.content,version:createHash("sha256").update(loaded.content).digest("hex"),permissions:["skill_load"],enabled:!disabledSkills.has(skill.name)};
        }));
      case "skill.load":
        if (disabledSkills.has(String(params.name))) throw new Error("技能已禁用");
        return loadSkill(
          config.skillsDir,
          skills,
          text(params.name, "技能名", 64),
        );
      case "reminder.create":
        return presentReminder(
          await harness.commit(
            (tx) =>
              createReminder(
                tx,
                {
                  id: text(params.id ?? randomUUID(), "提醒 ID", 200),
                  text: text(params.text, "提醒正文", 2000),
                  at: parseTime(text(params.at, "提醒时间", 100)),
                  scope: text(params.scope ?? "local", "身份作用域", 200),
                  timezone: text(
                    params.timezone ??
                      Intl.DateTimeFormat().resolvedOptions().timeZone,
                    "时区",
                    100,
                  ),
                },
                ROOT_CONVERSATION_ID,
              ),
            ctx,
          ),
        );
      case "reminder.list":
        return (await harness.snapshot(AppState, ctx))!.reminders
          .filter((r) => r.scope === (params.scope ?? "local"))
          .map(presentReminder);
      case "reminder.cancel":
        return harness.commit(
          (tx) =>
            cancelReminder(
              tx,
              text(params.id, "提醒 ID", 200),
              text(params.scope ?? "local", "身份作用域", 200),
            ),
          ctx,
        );
      case "inbox.list":
        return (await harness.snapshot(AppState, ctx))!.notices.filter(
          (n) =>
            n.scope === (params.scope ?? "local") &&
            (params.all === true || n.status === "unread"),
        );
      case "inbox.ack":
        return harness.commit(async (tx) => {
          const state = await tx.doc(AppState);
          const notice = state.notices.find(
            (n) =>
              n.id === text(params.id, "通知 ID", 200) &&
              n.scope === (params.scope ?? "local"),
          );
          if (!notice) throw new Error("通知不存在");
          notice.status = "read";
          return { read: notice.id };
        }, ctx);
      default:
        throw new Error("未知方法");
    }
  }
  return {
    harness,
    storage,
    registry,
    toolDescriptors,
    createConversation,
    dispatch,
    async close() {
      observation.detach();
      try { await harness.close(ctx); } finally { await history.close(); }
    },
  };
}
function validTurns(value: unknown) {
  const n = id(value);
  if (n < 1 || n > 12) throw new Error("工具轮数必须为 1–12");
  return n;
}
export { parseTime } from "./config.js";
export type Runtime = Awaited<ReturnType<typeof openRuntime>>;
