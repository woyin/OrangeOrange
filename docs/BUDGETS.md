# 预算服务与接入

`BudgetService` 使用 `ControlStore`，不改变任务状态。所有方法同步，所有检查和计量更新在同一个 store 事务中完成。ControlService 已替换原 `admitModel` 计量并接入 provider 硬限额与软阈值。Runtime 为每次模型调用传递 reservationId，并在单次完整响应的 modelSettled 中结算；没有使用整个会话累计用量。

```ts
const budgets = new BudgetService(store);
const result = budgets.reserve({ taskId, providerId, reservationId, reservedTokens, reservedCost });
// 仅新建的 reserved 记录允许对应的模型调用发送。
budgets.settle(result.reservationId, { actualTokens, actualCost });
// 未取得可信用量时：
budgets.settle(result.reservationId, { unknown: true });
```

- `reservationId` 可选；建议在每次独立 generation 前由 Main 生成并持久关联到该 generation。重复传同一 ID 和同一参数不会再次计量；参数不同抛出 `BUDGET_RESERVATION_CONFLICT`。结果含 `reservationId` 和 `state`。重复调用可能返回 `unknown` 或 `settled`，绝不能据此重新发送。`reserved` 也可能是重复返回；调用方必须通过自己持久化的发送状态区分新请求与重试，不能仅凭该值保证恰好一次发送。未知发送结果不能重新发送，除非另建 reservation 并接受额外计费。
- 硬限额超出抛 `BUDGET_EXHAUSTED`。软限额达到或超出抛 `BUDGET_SOFT_LIMIT`。两者均无写入。Main 应在软限额时安全暂停并通知 Owner；本服务不提供确认绕过。Owner 可修改阈值后重试，硬限额仍生效。
- `task.budget.maxTokens/maxCost` 为任务上限；provider 的 `dailyBudget/taskBudget` 为成本上限；`config.global` 的 `dailyBudget/softDailyBudget/softTaskBudget` 为全局每日和任务成本限额。兼容当前扁平 `config`。缺省每日硬限额为 10，其余未配置限额不限制。显式 0 保留为 0；软阈值为 0 时任何请求均暂停。无效限额拒绝请求。
- 成本使用现有币种和 `cost:YYYY-MM-DD`，日期为 UTC。provider 的每日和任务计数保存在 `budget_counters`；reservation 保存在 `budget_reservations`。任务 `usage.reservedTokens/reservedCost` 是已知实际使用量加尚未确定用量的预留，`modelCalls` 只在新预留时加一。实际超出预留也完整入账，后续预留会被限额阻止。
- `settle` 只有收到正的有限 `actualTokens` 和 `actualCost` 才结算。缺失、0、无效或 `{unknown:true}` 均标记 unknown，保守保留全部预留；后续可以用可信正值结算。已结算的相同数据幂等，其他数据抛 `BUDGET_SETTLEMENT_CONFLICT`。结算调整原 reservation 的 UTC 日期、provider 和任务，即使结算时日期或当前 provider 已变。清理任务前须保留尚未结算的任务和计量记录。
- 取消任务时，对可能已发送或发送状态不明的 reservation 调用 `settle(id, {unknown:true})` 并保留预留。即使取消发生在发送前，也不能仅凭任务状态假定未发送。当前 API 没有释放未知预留的操作；可靠的逐次 usage 可在稍后结算。主流程必须保存 reservation ID，异常、取消和进程重启后都要保守处理未结算记录。

## runtime 接入和用量来源

当前 `runtime.ts` 的 `modelAdmission` 在 `Models` 的 stream/complete 等方法调用前同步执行，只接收 model、context、options、conversationId，返回 `maxTokens`。Main 需要通过 model 的 `provider` 和 `id` 查找唯一的控制面 provider ID；找不到或映射不唯一时拒绝发送。每次 generation 独立生成 reservation ID，按该次输入和输出上界以及已验证价格计算正的预留。保留现有 maxTurns、duration 和输出上界检查。对 `BUDGET_SOFT_LIMIT` 暂停，对硬限额和其他固定错误执行 Main 的状态策略，不能在本服务内调用 transitions。

在 runtime 模型代理中把 reservation ID 绑定到该次调用，并为完整响应或 stream 的最终 `result()` 只处理一次结算。成功且响应的 `usage.totalTokens`、`usage.cost.total` 是可信正数时结算；缺失、零、错误、取消、断流或无法确认响应时标记 unknown。`usage.cost.totalFromProvider` 区分供应商实际账单与目录估算：若需要实际账单，必须要求该标记为 true，否则保留 unknown；若接受目录价格估算，Main 应明确选择并验证价格。不要把流事件和 `result()` 重复记账。重启后的未决请求继续保留，不假设请求未发送。

Pi Durable 1.5 的 `UsageDoc` 是 conversation 累计结构 `{models: Record<'provider/modelId', Usage>, tools: Record<toolName, Usage>}`。`Usage` 包含 `input/output/cacheRead/cacheWrite/totalTokens` 和 `cost.total`；`reasoning` 是 output 子集。它还包括 summarization attempts，工具 usage 没有模型身份。不能把完整累计值用于每次 reservation。若无法取得单次模型结果，可在任务开始和结束时保存同一 conversation 的快照，只有在独占且能排除并发、工具和额外 summarization 影响，并能把差额唯一分配到 reservation 时才能结算；否则保留 unknown。模型重试和跨 provider 调用应各自独立预留、独立结算。

## 现有数据和部署限制

当前旧 admission 只在任务和每日累计中保存预留，没有 provider 明细及 reservation。启用前必须停止任务，制定旧记录迁移或保守隔离策略，并核实每日和任务余额；不能从旧累计准确反推 provider 用量。不要直接把已有用量清零。配置更新接口和任务状态接入不在本模块范围内；在 Main 完成这些工作前，本模块不会自动执行预算限制。
