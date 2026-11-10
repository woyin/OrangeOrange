import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import {
  defineDoc,
  defineTask,
  defineExtension,
  ROOT_CONVERSATION_ID,
  UsageDoc,
  type Harness,
  type Storage,
  type Tx,
  type ConversationId,
  type SubmissionId,
} from "@earendil-works/pi-durable";
import { CronExpressionParser } from "cron-parser";
import { AppState } from "./state.js";
import { text, parseTime } from "./config.js";
import { messageText } from "./history.js";
export type Rule =
  | { kind: "once"; at: number }
  | { kind: "cron"; expression: string; timezone: string };
export type Job = {
  id: string;
  name: string;
  prompt: string;
  scope: string;
  channel: string;
  workspace: string;
  routeKey: string;
  rule: Rule;
  status: "active" | "paused" | "completed";
  nextAt: number;
  tickId: number;
  activeRunId: string;
  maxTurns: number;
  timeoutMs: number;
  maxCostUsd: number;
  createdAt: number;
};
export type Run = {
  id: string;
  jobId: string;
  dueAt: number;
  startedAt: number;
  finishedAt: number;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  conversationId: number;
  submissionId: number;
  taskId: number;
  result: string;
  error: string;
  costUsd: number;
  cancelRequested: boolean;
};
export const ScheduleState = defineDoc<{
  jobs: Record<string, Job>;
  runs: Record<string, Run>;
  operations: Record<
    string,
    { action: string; jobId: string; runId: string; request: string }
  >;
}>({
  kind: "orange.schedules",
  version: 1,
  scope: "session",
  initial: () => ({ jobs: {}, runs: {}, operations: {} }),
  checkpointWhen: (_v, _o, i) => i.deltasSinceBase >= 50,
});
export const ScheduledContext = defineDoc<{ runId: string }>({
  kind: "orange.scheduled-context",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ runId: "" }),
  checkpointWhen: () => true,
});
const copyJob = (job: Job): Job => ({ ...job, rule: { ...job.rule } });
const done = () => ({
  status: "terminal" as const,
  outcome: { status: "completed" as const, result: null },
});
export function nextOccurrence(
  expression: string,
  timezone: string,
  after: number,
) {
  if (expression.trim().split(/\s+/).length !== 5)
    throw new Error("cron 必须为五段：分 时 日 月 周");
  new Intl.DateTimeFormat("zh-CN", { timeZone: timezone }).format(after);
  return CronExpressionParser.parse(expression, {
    currentDate: new Date(after),
    tz: timezone,
  })
    .next()
    .getTime();
}
function bounded(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
  label: string,
  integer = true,
) {
  const n = value === undefined ? fallback : Number(value);
  if (
    !Number.isFinite(n) ||
    n < min ||
    n > max ||
    (integer && !Number.isInteger(n))
  )
    throw new Error(`${label} 必须在 ${min}–${max} 之间`);
  return n;
}
export type Owner = {
  scope: string;
  channel: string;
  workspace: string;
  routeKey: string;
};
type Host = {
  harness: () => Harness;
  storage: Storage;
  now: () => number;
  createConversation: (
    params: Record<string, unknown>,
    initialize?: (tx: Tx, cid: ConversationId) => Promise<void>,
  ) => Promise<{ id: ConversationId }>;
  authenticated: () => Promise<boolean>;
};
export function createScheduler(host: Host) {
  const { now } = host;
  async function finish(
    runId: string,
    status: Run["status"],
    result: string,
    error: string,
    costUsd = 0,
  ) {
    await host.harness().commit(async (tx) => {
      const state = await tx.doc(ScheduleState);
      const run = state.runs[runId]!;
      if (!["queued", "running"].includes(run.status)) return;
      run.status = status;
      run.result = result;
      run.error = error;
      run.costUsd = costUsd;
      run.finishedAt = now();
      const job = state.jobs[run.jobId]!;
      if (job.activeRunId === runId) job.activeRunId = "";
      const app = await tx.doc(AppState);
      const id = `task:${runId}`;
      if (!app.notices.some((n) => n.id === id && n.scope === job.scope))
        app.notices.push({
          id,
          scope: job.scope,
          text: `任务「${job.name}」${status === "completed" ? "完成" : "未完成"}\n${status === "completed" ? result : error}`,
          at: now(),
          status: "unread",
          kind: "task",
          ...(job.routeKey ? { routeKey: job.routeKey } : {}),
        });
    }, ctx);
  }
  const RunTask = defineTask<
    { id: string },
    { phase: "start" } | { phase: "watch" },
    null
  >({
    name: "orange.scheduled-run",
    version: 1,
    initial: () => ({ phase: "start" }),
    phases: {
      start: async (task, api, context) => {
        const state = (await api.snapshot(ScheduleState, context))!;
        const run = state.runs[task.input.id]!;
        const job = state.jobs[run.jobId]!;
        if (!["queued", "running"].includes(run.status)) {
          await api.commit(() => done(), context);
          return;
        }
        if (run.cancelRequested) {
          await finish(run.id, "cancelled", "", "用户取消");
          await api.commit(() => done(), context);
          return;
        }
        if (now() - run.startedAt >= job.timeoutMs) {
          await finish(run.id, "failed", "", "执行超时");
          await api.commit(() => done(), context);
          return;
        }
        if (!(await host.authenticated())) {
          await finish(run.id, "failed", "", "缺少模型凭据");
          await api.commit(() => done(), context);
          return;
        }
        let cid = run.conversationId;
        try {
          if (!cid)
            cid = (
              await host.createConversation(
                {
                  name: `定时：${job.name}`,
                  scope: job.scope,
                  channel: job.channel,
                  workspace: job.workspace,
                  routeKey: job.routeKey,
                  maxTurns: job.maxTurns,
                },
                async (tx, id) => {
                  const current = (await tx.doc(ScheduleState)).runs[run.id]!;
                  if (current.status !== "queued")
                    throw new Error("任务已取消");
                  current.conversationId = id;
                  (await tx.doc(ScheduledContext, id)).runId = run.id;
                },
              )
            ).id;
          const conversation = (await host
            .harness()
            .conversation(cid as ConversationId, context))!;
          await api.commit(async (tx) => {
            const current = (await tx.doc(ScheduleState)).runs[run.id]!;
            if (current.cancelRequested)
              return {
                status: "sleeping" as const,
                until: now(),
                checkpoint: { phase: "watch" as const },
              };
            if (current.status !== "queued")
              return current.status === "running"
                ? {
                    status: "sleeping" as const,
                    until: now(),
                    checkpoint: { phase: "watch" as const },
                  }
                : done();
            current.submissionId = await conversation.submit(tx, {
              type: "input",
              requestId: `scheduled:${run.id}`,
              content: `这是定时任务「${job.name}」的一次执行。原定时间：${new Date(run.dueAt).toISOString()}；实际执行时间：${new Date(now()).toISOString()}。完成下面的任务；只报告工具支持的结果，引用来源。\n\n${job.prompt}`,
            });
            current.status = "running";
            return {
              status: "sleeping" as const,
              until: now(),
              checkpoint: { phase: "watch" as const },
            };
          }, context);
        } catch {
          const cancelled = (await api.snapshot(ScheduleState, context))?.runs[
            run.id
          ]?.cancelRequested;
          await finish(
            run.id,
            cancelled ? "cancelled" : "failed",
            "",
            cancelled ? "用户取消" : "无法创建或提交任务会话",
          );
          await api.commit(() => done(), context);
        }
      },
      watch: async (task, api, context) => {
        const state = (await api.snapshot(ScheduleState, context))!;
        const run = state.runs[task.input.id]!;
        const job = state.jobs[run.jobId]!;
        if (run.cancelRequested && ["queued", "running"].includes(run.status)) {
          if (run.conversationId)
            await (await host
              .harness()
              .conversation(
                run.conversationId as ConversationId,
                context,
              ))!.abort(context);
          await finish(run.id, "cancelled", "", "用户取消");
          await api.commit(() => done(), context);
          return;
        }
        if (run.status !== "running") {
          await api.commit(() => done(), context);
          return;
        }
        const usage = await api.snapshot(
          UsageDoc,
          run.conversationId as ConversationId,
          context,
        );
        const cost = Object.values(usage?.models ?? {}).reduce(
          (sum, u) => sum + (u.cost?.total ?? 0),
          0,
        );
        const submission = await host
          .harness()
          .submission(run.submissionId as SubmissionId, context);
        const status = await submission?.status(context);
        if (status?.status === "done" && status.type === "input") {
          const answer = await host.storage.entry(status.answer, context);
          await finish(
            run.id,
            "completed",
            answer ? messageText(answer.entry) : "",
            "",
            cost,
          );
          await api.commit(() => done(), context);
          return;
        }
        const reason =
          now() - run.startedAt >= job.timeoutMs
            ? "执行超时"
            : cost >= job.maxCostUsd
              ? "达到已报告模型费用阈值"
              : status?.status === "queued" || status?.status === "placed"
                ? ""
                : "模型执行未完成";
        if (reason) {
          await (await host
            .harness()
            .conversation(
              run.conversationId as ConversationId,
              context,
            ))!.abort(context);
          await finish(run.id, "failed", "", reason, cost);
          await api.commit(() => done(), context);
          return;
        }
        await api.sleepUntil(now() + 250, { phase: "watch" }, context);
      },
    },
    abort: (_task, api, context) => api.commit(() => done(), context),
  });
  async function startRun(tx: Tx, job: Job, dueAt: number) {
    if (job.activeRunId) throw new Error("该任务已有运行，不能重叠执行");
    const state = await tx.doc(ScheduleState);
    const id = randomUUID();
    const taskId = await tx.createTask(
      RunTask,
      { id },
      {
        conversationId: ROOT_CONVERSATION_ID,
        ownership: { kind: "conversation" },
        background: true,
      },
    );
    state.runs[id] = {
      id,
      jobId: job.id,
      dueAt,
      startedAt: now(),
      finishedAt: 0,
      status: "queued",
      conversationId: 0,
      submissionId: 0,
      taskId,
      result: "",
      error: "",
      costUsd: 0,
      cancelRequested: false,
    };
    job.activeRunId = id;
    return id;
  }
  const TickTask = defineTask<
    { id: string },
    { phase: "wait" } | { phase: "fire" },
    null
  >({
    name: "orange.schedule",
    version: 1,
    initial: () => ({ phase: "wait" }),
    phases: {
      wait: async (task, api, context) => {
        const job = (await api.snapshot(ScheduleState, context))!.jobs[
          task.input.id
        ]!;
        if (job.status !== "active" || job.tickId !== task.id) {
          await api.commit(() => done(), context);
          return;
        }
        await api.sleepUntil(job.nextAt, { phase: "fire" }, context);
      },
      fire: async (task, api, context) =>
        api.commit(async (tx) => {
          const job = (await tx.doc(ScheduleState)).jobs[task.input.id]!;
          if (job.status !== "active" || job.tickId !== task.id) return done();
          if (job.nextAt > now())
            return {
              status: "sleeping" as const,
              until: job.nextAt,
              checkpoint: { phase: "fire" as const },
            };
          if (!job.activeRunId) await startRun(tx, job, job.nextAt);
          if (job.rule.kind === "once") {
            job.status = "completed";
            return done();
          }
          job.nextAt = nextOccurrence(
            job.rule.expression,
            job.rule.timezone,
            now(),
          );
          return {
            status: "sleeping" as const,
            until: job.nextAt,
            checkpoint: { phase: "fire" as const },
          };
        }, context),
    },
    abort: (_task, api, context) => api.commit(() => done(), context),
  });
  async function create(
    params: Record<string, unknown>,
    owner: Owner,
    key?: string,
    signature = "",
  ) {
    const existing = key
      ? (await host.harness().snapshot(ScheduleState, ctx))?.operations[key]
      : undefined;
    if (existing) {
      if (existing.request !== signature)
        throw new Error("操作 ID 已用于不同内容");
      return copyJob(
        (await host.harness().snapshot(ScheduleState, ctx))!.jobs[
          existing.jobId
        ]!,
      );
    }
    const timezone = text(params.timezone ?? "Asia/Shanghai", "时区", 100);
    let rule: Rule;
    let nextAt: number;
    if ((params.at === undefined) === (params.cron === undefined))
      throw new Error("必须且只能指定 at 或 cron");
    if (params.at !== undefined) {
      const at = text(params.at, "执行时间", 100);
      nextAt = parseTime(at);
      if (nextAt <= now()) throw new Error("一次性时间必须在未来");
      rule = { kind: "once", at: nextAt };
    } else {
      const expression = text(params.cron, "cron", 100);
      nextAt = nextOccurrence(expression, timezone, now());
      rule = { kind: "cron", expression, timezone };
    }
    const name = text(params.name ?? "定时任务", "任务名", 100),
      prompt = text(params.prompt, "任务提示词", 8000);
    const maxTurns = bounded(params.maxTurns, 8, 1, 12, "工具轮数"),
      timeoutMs =
        bounded(params.timeoutSeconds, 300, 10, 1800, "运行秒数") * 1000,
      maxCostUsd = bounded(params.maxCostUsd, 0.5, 0.01, 10, "费用阈值", false);
    return host.harness().commit(async (tx) => {
      const state = await tx.doc(ScheduleState);
      if (key && state.operations[key]) {
        if (state.operations[key]!.request !== signature)
          throw new Error("操作 ID 已用于不同内容");
        return copyJob(state.jobs[state.operations[key]!.jobId]!);
      }
      if (
        Object.values(state.jobs).filter((j) => j.scope === owner.scope)
          .length >= 50
      )
        throw new Error("每个身份最多 50 个定时任务");
      const id = randomUUID();
      const tickId = await tx.createTask(
        TickTask,
        { id },
        {
          conversationId: ROOT_CONVERSATION_ID,
          ownership: { kind: "conversation" },
          background: true,
        },
      );
      const job: Job = {
        id,
        name,
        prompt,
        scope: owner.scope,
        channel: owner.channel,
        workspace: owner.workspace,
        routeKey: owner.routeKey,
        rule,
        status: "active",
        nextAt,
        tickId,
        activeRunId: "",
        maxTurns,
        timeoutMs,
        maxCostUsd,
        createdAt: now(),
      };
      state.jobs[id] = job;
      if (key)
        state.operations[key] = {
          action: "create",
          jobId: id,
          runId: "",
          request: signature,
        };
      return job;
    }, ctx);
  }
  async function control(
    action: string,
    params: Record<string, unknown>,
    owner: Owner,
    operationKey?: string,
  ): Promise<unknown> {
    const key = operationKey
      ? JSON.stringify([owner.scope, text(operationKey, "操作 ID", 200)])
      : undefined;
    const signature = JSON.stringify([action, params]);
    function replay(state: {
      operations: Record<
        string,
        { action: string; jobId: string; runId: string; request: string }
      >;
      jobs: Record<string, Job>;
    }) {
      const previous = key ? state.operations[key] : undefined;
      if (!previous) return undefined;
      if (previous.request !== signature)
        throw new Error("操作 ID 已用于不同内容");
      if (action === "create") return copyJob(state.jobs[previous.jobId]!);
      return action === "run"
        ? { id: previous.runId }
        : { id: previous.jobId, applied: true };
    }
    const snapshot = (await host.harness().snapshot(ScheduleState, ctx))!;
    const previous = replay(snapshot);
    if (previous !== undefined) return previous;
    if (action === "create") return create(params, owner, key, signature);
    if (action === "list")
      return Object.values(snapshot.jobs).filter(
        (j) => j.scope === owner.scope,
      );
    if (action === "runs")
      return Object.values(snapshot.runs)
        .filter(
          (r) =>
            snapshot.jobs[r.jobId]?.scope === owner.scope &&
            (params.id === undefined || r.jobId === params.id),
        )
        .sort((a, b) => b.startedAt - a.startedAt)
        .slice(0, 100);
    const id = text(params.id, "任务 ID", 200);
    return host.harness().commit(async (tx) => {
      const state = await tx.doc(ScheduleState);
      const repeated = replay(state);
      if (repeated !== undefined) return repeated;
      const job = state.jobs[id];
      if (!job || job.scope !== owner.scope) throw new Error("任务不存在");
      const applied = (runId = "") => {
        if (key)
          state.operations[key] = {
            action,
            jobId: id,
            runId,
            request: signature,
          };
      };
      if (action === "get") return copyJob(job);
      if (action === "run") {
        const runId = await startRun(tx, job, now());
        applied(runId);
        return { id: runId };
      }
      if (action === "cancel") {
        const run = state.runs[job.activeRunId];
        if (!run) throw new Error("没有正在运行的任务");
        run.cancelRequested = true;
        applied(run.id);
        return { cancelRequested: run.id };
      }
      if (action === "pause") {
        if (job.status === "active") job.status = "paused";
        applied();
        return copyJob(job);
      }
      if (action === "resume") {
        if (job.status === "completed")
          throw new Error("一次性任务已结束，请使用 run 手动重跑");
        if (job.status !== "active") {
          job.status = "active";
          job.nextAt =
            job.rule.kind === "once"
              ? Math.max(now(), job.rule.at)
              : nextOccurrence(job.rule.expression, job.rule.timezone, now());
          job.tickId = await tx.createTask(
            TickTask,
            { id },
            {
              conversationId: ROOT_CONVERSATION_ID,
              ownership: { kind: "conversation" },
              background: true,
            },
          );
        }
        applied();
        return copyJob(job);
      }
      throw new Error("未知定时任务操作");
    }, ctx);
  }
  return {
    extension: defineExtension({
      name: "scheduler",
      tasks: [TickTask, RunTask],
    }),
    control,
  };
}
