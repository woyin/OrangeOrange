# HTTP API

机器可读契约：[OpenAPI 3.1](openapi.json)。准确字段、状态与当前已知缺口：[实施接口契约](CONTROL-API-CONTRACT.md)。实现开发中，接口存在不表示SRS验收通过。

默认路径/api/v1；成功返回data/requestId，失败返回error.code/error.message/requestId。列表data含items/nextCursor。认证使用HttpOnly Cookie；Owner写入需要Origin、X-CSRF-Token和Idempotency-Key，冲突请求409。setup/login无需预先登录，但受Origin与限流限制。

首次GET setup/status，未初始化时POST setup。Owner初始化仅一次。登录POST auth/login后使用GET auth/session取得csrf。SSE GET events/stream使用cursor或Last-Event-ID补偿，reset触发全量拉取。事件仅提供安全元数据，正文与工具进度从认证会话live/messages API读取。

管理入口包含会话/任务、Cron/Heartbeat、Memory及修订、Provider密钥状态、Telegram通道、Tools/Skills、审批、系统健康、审计日志、设置和备份恢复。所有写入均由后端验证，不接受前端声称的角色、状态或权限。

备份恢复需要当前Owner密码再认证、confirm=true，恢复仅接受服务器生成的备份ID。备份包含私人内容，应保护存放；主密钥、供应商凭据和session不作为普通配置导出。

生产仅提供/health/live和/health/ready健康结果，不因外部模型不可用使live失效。非健康数据必须认证。
