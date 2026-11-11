# 执行后端 P0 接口

`src/execution/index.ts` 提供 `ExecutionBackend`、`ExecutionCoordinator`、`ToolExecutorBackend` 及相关类型。模块不加载浏览器。真实浏览器、远端认证和隔离属于 P1。

## 信任边界

协调器是受信任进程内接口。调用方必须先认证用户，并确定任务、主体、租户与可授权的能力；不能把模型输出或未认证请求直接传给 `issueGrant`。后端实例和 `ControlStore` 也只能交给受信任代码，不能通过直接调用后端绕过协调器。`issueGrant` 返回的随机字符串是持有者凭证，应像密码一样保护，不应记录或发送给模型。`revokeGrant` 撤销凭证并通知其会话中的操作取消。

授权包含 `taskId`、`principalId`、`tenantId`、`methods`、`tools` 和 `expiresAt`（Unix 毫秒，最多 24 小时）。协调器校验任务记录和后端能力声明。未设置 `tenantId` 的现有任务使用 `default`；调用方不能用此默认值跨租户映射任务。启动和执行要求任务为 `RUNNING` 或 `WAITING_APPROVAL`。停止和清理允许终态任务，但仍要求有效授权和匹配的任务身份。

凭证在每次调用时校验。到期、撤销、`stop`、`cleanup` 或传入的 `AbortSignal` 会通知相关操作取消。后端必须配合信号；已经发生的外部副作用无法撤回。到期凭证不能用于清理，P1 的真实后端必须自行实现租约到期回收。授权只覆盖本进程内的执行调用，不是远端 Worker 的认证协议。

## 生命周期和接入

1. 注册现有 `PolicyGateway` 工具描述，并保存具有正确主体和租户的任务。
2. 创建后端和 `ExecutionCoordinator(store, policy, backend)`。`ExecutionBackend.capabilities` 显式声明可用方法和工具。
3. 可信调用方执行 `issueGrant(grant)`，然后依次调用 `provision(token)`、`start(token, sessionId)`。
4. 运行时按需要调用 `observe`、`checkpoint` 和 `act`；结束时调用 `stop`、`cleanup`。这些调用都使用同一凭证和会话。
5. 对需要审批的动作，先调用 `policyCall(token, sessionId, operationId, action)`，将返回值交给 `PolicyGateway.requestApproval`。批准后将审批 ID 传入 `act` 的 `options.approvalId`。`act` 在记录发送状态的同一事务中消费审批。

普通工具的可执行接入示例，`store`、`policy`、任务及工具描述由现有控制面提供：

```ts
import { ExecutionCoordinator, ToolExecutorBackend } from '../src/execution/index.js';

const backend = new ToolExecutorBackend({
  lookup: async (args, context) => lookup(args, context.signal),
});
const execution = new ExecutionCoordinator(store, policy, backend);
const token = execution.issueGrant({
  taskId, principalId, tenantId: 'default',
  methods: ['provision', 'start', 'act', 'stop', 'cleanup'],
  tools: ['lookup'], expiresAt: Date.now() + 60_000,
});
const sessionId = await execution.provision(token);
await execution.start(token, sessionId);
const result = await execution.act(token, sessionId, callId, {
  name: 'lookup', args: { query: 'example' },
}, { signal });
await execution.stop(token, sessionId);
await execution.cleanup(token, sessionId);
```

`lookup` 是调用方已有的普通异步工具函数。`args` 和返回值必须是有限数值组成的 JSON 值，不能包含 `undefined`、循环引用或类实例。`operationId` 由调用方为一次逻辑操作稳定分配；同一任务和租户内不能复用它执行不同操作。调用方应在 `finally` 中安排停止和清理，并处理授权过期或后端故障。示例省略了调用方的身份认证、任务创建和错误处理。

现有 `RuntimeOptions.toolGateway` 收到 `call` 和 `execute` 回调。主流程可以在可信适配层中根据 `call.requestIds` 查找任务，再把 `call.callId`、`call.name`、`call.args` 和 `call.signal` 映射到上述接口；具体工具回调由调用方注册。现有 `ControlService.tool` 也有预算、审批等待、记忆专用处理和任务状态逻辑，接入时必须继续保留这些检查，不能直接用本模块替换。此任务没有修改现有主流程，因此该映射尚未接线。

## 操作与恢复

`policyCall` 的哈希覆盖工具名、完整参数、任务、主体、租户、会话和操作编号。修改任一字段都需要重新审批。协调器在调用后端前持久化 `SENDING`，成功后写入 `CONFIRMED` 和 JSON 回执；失败、取消、过期或结果不可序列化时写入 `UNCERTAIN`。进程崩溃留下的 `SENDING` 也按不确定处理。同一操作编号返回已确认回执，不确定操作及同任务、主体、租户、工具和参数的相同意图不会自动重放，即使换会话或操作编号。不同参数是不同意图，调用方仍须在人工核实外部状态后决定后续操作。

会话属于创建它的协调器实例；重启后不会假装恢复外部会话或 checkpoint。新实例可创建新会话，但持久化的不确定记录仍阻止相同意图。`checkpoint` 只是后端返回的数据，不是 Pi Durable 原生 checkpoint。P0 没有提供不确定操作的人工核销接口，也没有对旧会话进行远端回收；这些需要后续设计。

## 验证范围

`tests/execution.test.ts` 使用真实 `ControlStore` 和 `PolicyGateway`，以及确定性 FakeBackend、故障注入和真实进程内工具回调。它验证接口组合，不代表真实浏览器、远端 Worker、网络隔离或外部服务通过验收。
