# 维护模块契约

`MaintenanceService(getStore: () => ControlStore, dataDir: string, hooks?: MaintenanceHooks)` 可由 service 直接构造。模块只依赖应用 ControlStore，不依赖 Pi SDK。

- `retention(now = Date.now()): RetentionResult` 同步事务清理。service 在可写且未执行恢复时按小时调用。读取 settings `retentionDays`，兼容 `config.retentionDays`，默认 30。只接受 1–3650 整数天。
- `metrics(): Promise<ResourceMetrics>` 读取 RSS、进程累计 CPU 微秒、uptime、应用 SQLite/WAL/SHM 大小及持久化任务/队列/失败计数。CPU 是累计用量，不是利用率。failureRate 是当前保留终态任务中的失败比例。没有观测来源的 IM 延迟为 null。modelErrors 是 model_usage 已记录失败数，不代表上游全部失败。
- `hooks.diskProbe(path)` 可注入磁盘探针。默认使用 statfs。不可用返回 disk=null 并保护。小于 64 MiB 或 5% 空闲进入保护。`hooks.onProtection(boolean)` 由 service 接入暂停新任务及大量写入；模块不修改数据库迁移维护状态。
- `exportConfig()` 仅导出数值预算/保留策略、验证后的时区/语言、枚举 provider vendor、channel type、tool policy metadata。任意名称、模型名、端点、提示词、身份列表和所有秘密字段均不导出，避免把秘密注入自由文本。该安全投影不是完整可恢复备份。
- `diagnostics()` 返回上述投影、metrics、schemaVersion 和安全日志。`logs(limit=100)` 只读 events 表，最多 1000 条，只提供固定 code、数值序号/时间与 UUID 关联 ID，不返回 payload、任意事件 type 或任意文件。
- `rotateAudit()` 在本地固定 `audit-snapshots/` 写入 0600、独占创建的全量审计快照；目录为 0700，拒绝数据目录或快照目录符号链接。快照保留连续原始 seq。数据库审计 append-only，轮转不删除原表或旧快照。快照不是公开诊断包，下载必须单独认证。该实现要求 dataDir 及其祖先由可信部署方控制；不承诺防止本机管理员路径竞态。

清理仅删除过期登录 session、保留窗口外 events、过期终态 tasks 及其 steps/operations/outbox/model_usage。待批、运行步骤、未知 operation 状态、SENDING/UNCERTAIN 与待投递/DELIVERY_UNCERTAIN 会保护所属任务。活跃 tasks 永不按年龄删除。无主子记录因无法证明安全而保留。入站与 API 幂等记录永久保留其去重唯一键；模块不清除 inbox 正文，后续可在不改变原调用方读取契约的前提下做独立 tombstone 迁移。

过期 active Memory 转为 expired 并通过 ControlStore 同事务移除 FTS，新增 revision。不自动删除 memory_revisions、approvals、audit_events。审计和修订物理删除需要明确独立策略。附件及 Pi transcript 物理清理未实现：必须由 adapter 提供受支持的删除能力，不能直接修改 Pi 私有 SQLite 表。

`RetentionResult.eventFloor` 及 settings `eventRetentionFloor` 给出最早可重放序号；若事件为空则为最后已分配序号+1。service SSE 对早于窗口的 cursor 应显式要求全量重新拉取。events 以时间窗口有限保留，不承诺固定条数上限。HTTP 鉴权、下载二次确认、tick 调度、保护模式执行和附件配额由 service 接入。

验证命令：`npx vitest run tests/control-maintenance.test.ts`。测试使用真实临时磁盘 SQLite，覆盖重开后保留、活跃/待批/uncertain 保护、入站去重、Memory FTS 失效、审计不可删、秘密注入和低磁盘/探针失败。
