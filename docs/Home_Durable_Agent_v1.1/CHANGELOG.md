# 需求变更记录

## v1.1 — 2026-11-10

在 v1.0 的可靠 Agent、IM、Cron/Heartbeat、Memory、Skills/MCP、Pi Durable、Web Console、Docker 安全与恢复基础上，新增：

- `MIG-001..018`：OpenClaw 与 Hermes 离线迁移、数据兼容等级、Preview/Plan/Stage/Apply/Verify/Rollback、版本适配、历史消息续聊与单向增量计划。
- `CONN-001..011`：独立 App Connector 层、OAuth、最小权限、动作审批和第三方副作用登记。
- `GML-001..012`：Gmail 首发发送、`gmail.send` 最小 scope、真实邮件审批、发送结果不确定状态；P1 收件箱和草稿功能。
- `CUA-001..016`：类似 Grok Bot 的持久计算机/浏览器工具，P0 预留接口、P1 独立 Browser Worker、P2 Desktop Worker。
- `BOT-001..008`：Bot Profiles、Routines、多 Bot 委派、监督与工作看板。
- `WEB-017..021`：迁移中心、App Center/Gmail 审批、Computer Use、Bot 工作看板。
- `NFR-021..027`：导入安全、敏感凭据、Browser Worker 隔离和资源测量。
- `MT-001..006`, `GM-001..005`, `CU-001..005`, `BT-001..002`：新增的可执行验收门槛。

**发布策略调整**：迁移与 Gmail 发送列为 v1.1 P0；Browser Worker 与多 Bot 为 P1。保留 v1.0 已有需求 ID；技术实现时须记录无法兼容的来源版本，不用虚假的“100% 无缝迁移”掩盖差异。
