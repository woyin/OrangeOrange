# Control API 实施契约

所有路径以 `/api/v1` 为前缀。成功 `{data,requestId}`，失败 `{error:{code,message},requestId}`；列表 `data={items,nextCursor}`。当前实体列表无分页，nextCursor=null。历史消息最多100条，nextCursor为最老entry ID；尚未接入翻页参数。

## 鉴权与写入

GET setup/status -> `{initialized}`。POST setup `{username,password,timezone,provider?:{vendor,model,apiKey},telegram?:{token,allowedUsers}}`；POST auth/login `{username,password}`；两者返回 `{username,csrf}` 并设置 `hda_session` HttpOnly/SameSite=Strict Cookie。GET auth/session同字段。POST auth/logout `{}`；POST auth/password `{current,next}` 后所有旧session失效。密码最少12字符。

所有POST/PATCH/DELETE必须携带准确Origin。已登录写入还必须 `X-CSRF-Token` 和 `Idempotency-Key`。同一用户相同key及相同method/path/body重放原结果，内容不同409 IDEMPOTENCY_CONFLICT。未完成写入重启后返回409 IDEMPOTENCY_UNCERTAIN，禁止静默重放。setup/login无需预登录CSRF和幂等头，但受Origin与限流。所有PATCH只允许下列字段。未知字段400。

HTTP非Secure Cookie仅用于 localhost/127.0.0.1；LAN必须配置 HTTPS 的 HDA_PUBLIC_ORIGIN 并使用可信TLS反向代理。应用不信任任意X-Forwarded头。容器0.0.0.0监听不代表允许HTTP LAN管理访问。

## 实体与操作

- GET system/summary 或 system：真实ready/保护状态、runningTasks/queueDepth/pendingApprovals/providers/rss/schemaVersion/lastError。
- GET/POST conversations。POST `{name?,model?}`，返回 `{id,name,status,piConversationId,createdAt}`。PATCH `conversations/:id` `{name?,status?:active|archived}`，不接收workspace。
- GET `conversations/:id/messages`：Pi真实history entries。POST同路径 `{content}`：返回持久Task。GET `conversations/:id/live` 返回真实Pi `{id,live,usage}`，供流式内容/步骤补拉。
- GET tasks 支持status/source查询。GET tasks/:id含steps/operations/deliveries。POST tasks/:id/actions `{action:pause|resume|cancel|retry}`。QUEUED可PAUSED再QUEUED；RUNNING/WAITING_APPROVAL暂停持久化PAUSED，在后续模型/工具边界等待，已经在途的步骤可完成。resume恢复原submission及先前状态，不重新提交输入。暂停期间占用原并发槽；任务总时限仍按实际经过时间计。retry建立关联retryOf的新任务，UNCERTAIN操作拒绝重试。全局队列最多100、并发最多2、同会话最多1。
- GET/POST schedules；PATCH/DELETE schedules/:id。字段 `{name,expression,timezone,prompt,misfirePolicy:skip|coalesce|catch-up-one,overlapPolicy:skip_if_running|queue_one,conversationId?,channelId?,threadId?,onlyOnChange?,enabled?}`。无conversationId时创建独立会话。GET schedules/preview?expression=&timezone= 返回 `data={items:ISO时间字符串[5],nextCursor:null}`。POST schedules/:id/actions `{action:pause|resume|run}`。GET schedules/:id/history。
- GET/POST heartbeats；PATCH/DELETE heartbeats/:id。字段 `{conversationId,intervalSeconds:10..31536000,prompt,onlyOnChange?,enabled?,channelId?,threadId?}`。仅会话空闲时创建任务，忙时合并pending一次。
- GET/POST memories；PATCH/DELETE memories/:id。字段 `{kind:working|episodic|semantic|procedural,scope,content,source,confidence:0..1,expiresAt?:ISO,status?:active|blocked|expired|deleted}`。内部时间created_at/updated_at/expires_at为毫秒。GET memories?q=&scope= 使用FTS；GET memories/:id/revisions 返回hash修订。删除软删除；blocked/expired不召回。
- GET/POST providers；PATCH/DELETE providers/:id。字段 `{name?,vendor:openai,model,apiKey?,priority?,dailyBudget?,taskBudget?}`。GET只含metadata/configured与状态，密钥不回显。POST providers/:id/test `{}` 真实验证供应商models端点；未测状态unverified，未配密钥不显示online。
- GET/POST channels；PATCH/DELETE channels/:id。字段 `{name,type:telegram,token?,allowedUsers:数字ID字符串[],enabled?}`。POST channels/:id/test `{}` 真实getMe。POST channels/:id/outbox/:deliveryId/confirm `{confirm:true,delivered:boolean,externalId?}` 只人工确认DELIVERY_UNCERTAIN，不自动重新发送。
- GET tools；PATCH tools/:name `{enabled:boolean}`，高危默认拒绝。GET skills为adapter真实可信目录清单。PATCH skills/:name `{enabled:boolean}` 调用真实adapter启停并持久化；停用后新加载被拒绝。
- GET approvals；POST approvals/:id/decisions `{decision:APPROVED|REJECTED|REVOKED,operationHash}`，hash不匹配409。审批只消费一次；SENDING恢复为UNCERTAIN，不重新审批重发。
- GET/PATCH settings：`{timezone,language,notifications,dailyBudget,taskBudget,retentionDays,systemPrompt,tokenBudget}`。prompt_revisions保存历史。systemPrompt在新任务创建时保存版本快照并注入执行；retentionDays必须为1–3650整数，小时worker清理终态历史并保护活动/待批/UNCERTAIN，失效Memory移除FTS，入站去重键保留。已清理任务的重复入站返回410 TASK_HISTORY_EXPIRED。
- GET system/audit、system/logs。审计为真实append-only hash元数据；日志仅安全投影。GET system/metrics返回真实进程/磁盘/队列指标；GET system/diagnostics、config/export返回严格脱敏白名单投影，不含任意提示词、个人正文或密钥。
- GET backups；POST backup `{password,confirm:true}`：协调停止新写入，关闭Pi宿主并保留持久检查点，对应用与Pi执行SQLite快照，完成后重开并对账。支持模型inflight/等待审批任务；不撤销已发生副作用。返回manifest `{id,version,createdAt,files,secretsIncluded:false,masterKeyIncluded:false}`。副本清除secret/session并执行secure_delete/VACUUM；仍包含私人记忆/IM/会话，须认证保护。
- POST restore `{password,confirm:true,backupId}`：验证固定路径、sha256、schema/integrity，先保存当前快照和回滚文件，再关闭两库替换并重开；失败完整回滚或保持维护与journal。返回 `{restored,rollbackId,credentialsRequired:true}`。旧cookie失效，需要重新登录和补凭据。启动取得外层独占锁后先恢复journal，再打开业务数据库。
- 备份/恢复期间API返回503 MAINTENANCE_BUSY，SSE暂停拉取。部分Pi关闭失败时保持维护，不启用不完整实例。

## SSE

GET events/stream?cursor= 或 Last-Event-ID。每条 `id: 单调seq`、`event: message`、data=`{event_id,type,entity_id,occurred_at,payload:{hash}}`。正文/工具步骤通过认证资源API补拉。cursor早于保留窗口时发送 `event: reset` / `{reason:CURSOR_EXPIRED}`；客户端全量补拉后继续。事件按retentionDays清理，过期cursor必须reset并补拉；不存在伪造流式正文。

## 限制与验证

测试入口为 `npm run test:all`，新增备份HTTP/运行恢复/真实进程SIGKILL/权限矩阵/桌面及390px浏览器测试。详见TESTING.md。真实模型、Telegram、双架构最终镜像、72h按实际证据单独验收。模型预算依赖adapter发送前同步admission映射；无法归属或无价格时fail-closed。后续验证和缺口以任务result为准，本文不表示所有SRS已验收。
