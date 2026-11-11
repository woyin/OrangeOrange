# 给编程 Agent 的实施指令——Home Durable Agent v1.1

> **读完本文件再开始开发。** `SRS.md` 是总需求基线；`MIGRATION_DESIGN.md`、`APP_CONNECTORS_GMAIL.md`、`COMPUTER_USE_DESIGN.md` 是专项补充，出现冲突时记录 ADR 并以安全更严格、P0 可验证的约束为准。

你是一名负责本项目完整交付的工程 Agent。目标是在 **OpenWrt 软路由 Docker 容器**内实现可持续运行的私人 AI Agent，底座固定为通过技术探针验证后的 **Pi Durable**。交付必须具备完整 Web 管理界面、稳定的任务执行与恢复、IM、Cron/Heartbeat、Memory、OpenClaw/Hermes 数据迁移、Gmail 连接器与安全外发，P1 扩展类 Grok Bot 的远端浏览器操作和 Bot Profiles。

## 一、绝对禁止

1. **禁止**在 OpenWrt 宿主机原生运行本项目 Agent 服务，不默认使用 privileged、host network、Docker Socket、宿主机根目录挂载或无限制 shell。
2. **禁止**自动执行从 OpenClaw/Hermes 导入的 Skill、Cron、第三方代码或 MCP。导入后默认禁用，人工审核后才允许启用。
3. **禁止**把外部运行中的会话/工具执行状态伪装成 Pi Durable 的原生可恢复 checkpoint。历史可归档，继续聊天应新建原生会话。
4. **禁止**把 `gmail.send` 权限误当成“能读邮箱”，更不能借 Gmail Web UI 绕开权限确认。默认所有外发先预览和批准。
5. **禁止**遇到邮件/消息发送结果不确定就无条件重试；必须有 `SEND_UNCERTAIN` / `DELIVERY_UNCERTAIN` 状态。
6. **禁止**把 Chromium/图形桌面直接塞进主 Agent 容器，或让浏览器默认访问 OpenWrt/LuCI/家庭 LAN。
7. **禁止**把 Mock 页面、示例输出或自动化测试的假 API 成功报告为“生产功能已经完成”。
8. **禁止**为消除测试失败而删除必要测试或放宽安全策略。

## 二、开工检查——先看现有仓库，不要直接重写

1. 若已有仓库，先读代码、`README`、架构、DB schema、Docker Compose、已有测试及 `.env.example`。识别已有模块与本规范差异，**保留既有可靠功能**。无仓库时创建 monorepo。
2. 查阅 Pi Durable 锁定版本的英文 README 和源码，完成 `Harness`, `Storage`, `resume`, `events`, `tools`, `usage` 的真实 API 探针。API 变更必须封装在 Adapter 层。
3. 查阅 OpenClaw/Hermes 的官方英文迁移说明及对应版本源码/fixtures，**不要假定**某个路径或 SQLite 列名永远存在。
4. 对照 Google Gmail 官方英文文档核实 `users.messages.send`、`gmail.send`、OAuth 客户端和 redirect URI 要求。公开版和私人自用验证条件不能混淆。
5. 确认 Docker 目标硬件；尚未给出时，按 arm64/amd64、4核/4GiB/SSD 作基准假设，并把它写进 ADR。
6. 建立 `IMPLEMENTATION_STATUS.md`：每个 SRS 需求 ID 对应状态、源码、测试、阻塞、版本；所有未交付功能必须明确标 `TODO`。

## 三、阶段次序及发布门槛

### M0：底座验证与安全边界

- 完成 Pi Durable API/SQLite/恢复/外部工具副作用的技术探针；固定版本与 lockfile。
- 开发只读/写操作分类、ActionIntent、确定性 Policy Gateway 原型。
- 交付最小非特权 Docker 镜像、multi-arch CI、健康检查和挂载目录说明。
- 验收：崩溃恢复、重复事件、外部动作不确定、容器隔离与基本 API 探针。

### M1：平台基础闭环

- Web 初始化、登录、Chat、Tasks、Channels、Providers、Approvals、System。
- Telegram allowlist、inbox/outbox、Pi Durable 对话映射、消息投递状态、成本及通知。
- 验收原始 SRS 的 `AT-001..008`、`AT-011..012`、`AT-014..018`。

### M2：可靠自动化与记忆

- Cron、Heartbeat、Memory、Skills（仅受审启用）、备份/恢复、资源监控、日志审计。
- 验收原始 SRS 其余 P0 测试 `AT-009..024` 与 72h 稳定性要求。

### M3：OpenClaw/Hermes 数据迁移（本次新增 P0）

- 完成两个 `SourceImporter` 与完整只读数据扫描；设计 source fixtures 和 schema 兼容表。
- 迁移向导（预览、分类、冲突、提交、可回滚、重新授权提示）。
- 历史会话只读归档，以及“基于旧会话新建 Pi Durable 会话”。
- 验收 `MT-001..006`。真实来源数据若缺失，不得伪造版本兼容，必须给出 fixture 支持范围。

### M4：应用连接器与 Gmail 发送（本次新增 P0）

- 完成 AppConnector、OAuth 秘密库、最小 Gmail `gmail.send`、邮件草稿与审批、发送不确定处理。
- 完成 Web 应用连接中心、发送审批与历史、发送规则和撤销。
- 验收 `GM-001..005`；**真实 Gmail 账号授权和发送测试必须单独标记**，用户尚未提供凭据时不得把此项判为通过。

### M5：V1.1 P0 硬化和正式交付

- P0 所有功能：Web/API 文档、DB migrations、双架构、备份恢复、容器资源测量、安全审查、模型/IM 离线和 Token 失效的故障注入。
- 发布附带**功能矩阵**、**兼容版本矩阵**、**测试证据**、**未实现/已知风险**。
- 只有全部 P0 测试通过才宣布 v1.1 P0 完成。

### M6：Computer Use / Browser Worker（P1，独立里程碑）

- 独立 Worker 的身份认证与配对；默认主镜像无浏览器；可配置远程 Worker。
- Playwright DOM/截图工具、操作日志、资源限制、网络白名单、用户接管/停止、敏感操作审批与不确定处理。
- 验收 `CU-001..005`，包括阻止访问家庭路由器管理网段。

### M7：Bot Profiles + Routines + 多 Agent Supervisor（P1）

- Bot 权限/模型/Memory/预算分层，委派子任务与失败恢复。
- Routine 草稿→审核→启用→Cron/Webhook 触发。
- Gmail API + Browser Worker 混合场景的完整演示；通过 `BT-001..002`。

## 四、必须开发的代码边界

```text
apps/
  api/                    # Fastify/Hono + OpenAPI + policy
  web/                    # Vue/React；真实后台，不是 demo
packages/
  pi-durable-adapter/     # 仅此层引用上游 Pi Durable 特定 API
  task-core/              # Durable business task / inbox / outbox
  policy/                 # Identity, scopes, action permissions, approval
  migrations/             # SourceImporter API + OpenClaw/Hermes adapters
  app-connectors/         # AppConnector API, action journaling
  connectors-gmail/       # OAuth + Gmail API + email payload validation
  browser-worker-contract/# Remote Worker RPC + auth + screenshot refs
  memory/                 # Provenance-aware memory
  gateway/                # IM adapters
  automation/             # Cron + Heartbeat + event triggers
workers/
  browser/                # P1 独立镜像/远端服务，非主容器
infra/
  compose/                # 生产配置、资源与权限约束
  migrations/             # DB migrations
  tests/                  # Integration + fault injection
```

目录是建议的模块边界，不强制逐字实现；有成熟仓库时保留现有布局并用 ADR 解释。

## 五、每次任务的交付记录

在每个里程碑输出以下固定报告：

```markdown
## Milestone Mx report
- Commit / version:
- Requirements implemented: ...
- Requirements still missing: ...
- Files changed: ...
- Build command / result: ...
- Unit / integration / e2e / fault-injection: ...
- Security implications: ...
- Remaining risks & follow-up: ...
- Reproduction steps: ...
```

**重要**：如果运行环境暂时没有真实 OpenClaw/Hermes 备份、Gmail OAuth 账号或 Browser Worker 硬件，先实现具可验证 fixtures 的功能；明确未做真实集成验证，**不能**因为缺外部条件就擅自跳过所有开发，也**不能**以 Mock 代替真实验收。

**现在执行 M0：阅读全部规范，盘查现有项目，输出差距矩阵并做技术探针。技术探针未通过不要直接进入业务模块。**
