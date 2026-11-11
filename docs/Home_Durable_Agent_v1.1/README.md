# Home Durable Agent — v1.1 开发需求包

这份资料供 AI 编程 Agent 实施一个常驻于 **OpenWrt Docker 容器**中的个人 AI Agent。底层运行时为 **Pi Durable**；产品参考 OpenClaw、Hermes Agent 和 Grok Bot，但不依赖这些产品的私有运行状态。

## 阅读顺序

1. **`AGENT_START_HERE.md`**：给 AI 编程 Agent 的开工指令、开发阶段与约束。
2. **`SRS.md`**：完整的 v1.1 软件需求规格说明书，保留 v1.0 功能并新增 MIG/CONN/GML/CUA/BOT 的编号需求与验收用例。
3. **`MIGRATION_DESIGN.md`**：OpenClaw/Hermes 数据发现、映射、兼容、冲突、审查、回滚与历史对话续聊。
4. **`APP_CONNECTORS_GMAIL.md`**：统一应用连接器、Gmail 最小权限 OAuth、审批发送、失败恢复和未来扩展。
5. **`COMPUTER_USE_DESIGN.md`**：类 Grok Bot 的 Browser Worker、Bot Profiles、Routines、人工接管和安全隔离。
6. **`IMPLEMENTATION_CHECKLIST.md`**：需求追踪清单（开发 Agent 更新实现状态、代码位置和测试证据）。

## 版本范围

| 发布段 | 必须交付 | 说明 |
|---|---|---|
| P0 / V1.1 | Pi Durable + Web + Telegram + Cron/Heartbeat + Memory + 安全审批 + OpenClaw/Hermes 离线迁移 + Gmail 发送 | 只有真实验收通过才宣告完成 |
| P1 / 后续 | OpenClaw/Hermes 单向增量同步、浏览器 Computer Use Worker、Bot Profiles、Routine、Subagent | 必须单独的里程碑与验收 |
| P2 / 远期 | 完整 Desktop Worker、Vault/跨设备自动化等 | 不阻碍 P0 发布 |

## 最重要的边界

- 运行在 Docker 中，**不是**在 OpenWrt 宿主直接运行；容器没有宿主机绝对安全豁免。
- 不直接迁移第三方运行中的 checkpoint；历史可完整归档但原生续跑不被保证。
- 不自动复制 OAuth、IM Token；重新授权和源任务激活需要明确操作。
- Gmail 发送前默认审批；发送确认丢失不盲目重试。
- 主容器不包含浏览器运行时；Computer Use 由独立 Worker 执行。
- 只依据英文官方资料建立事实边界，具体上游格式实施时按锁定版本源码核实。

## 资料性质

这是一套 **待实现的软件设计与验收规范**，不是已完成的程序，也不表示已经通过真实 Gmail/OAuth、OpenClaw/Hermes 导入或 Browser Worker E2E 测试。需求里的资源、性能和兼容指标需要在实际设备上测量。
