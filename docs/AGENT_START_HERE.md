# 给 AI 编程 Agent 的开工指令

你是本项目的首席架构师、全栈工程师、质量工程师和安全审查员。请以同目录 `SRS.md` 为**需求基线**，在现有仓库（若有）内分阶段开发一套运行于 **OpenWrt 软路由上的 Docker 容器**中的私人常驻 AI Agent，底座采用 **Pi Durable**，并交付完整 **Web 管理控制台**。不要把 Agent 安装在 OpenWrt 宿主机；生产环境不得需要 privileged、host 网络、Docker Socket 或宿主机根目录读写。

## 开工第一步（不要直接堆业务功能）

1. 阅读 `SRS.md` 全文，并把每项需求 ID 建立到 `IMPLEMENTATION_STATUS.md` 中。
2. 对照 Pi Durable **官方英文 README、锁定版本源码和发布说明**核实 Harness、Extension、SQLite、Resume、Tools、Subagent、Usage 等真实接口；不要凭记忆调用不存在的方法。
3. 运行最小可复现技术探针，验证：持久化对话、模型调用、工具调用、SIGKILL 恢复、重复提交、取消、中断后的副作用处理、SQLite 单写入限制。
4. 确认目标设备信息；如果尚未给出，先支持 linux/amd64 和 linux/arm64，以 4 核 ARM64 / 4 GiB RAM / SSD 作为性能测试基准，并把假设写入 ADR。
5. 建立服务端、Web、Pi Durable Adapter、Gateway、Scheduler、Memory、权限策略、数据持久化的模块边界。
6. 提交 `docs/ARCHITECTURE.md`、`docs/ADR/0001-pi-durable-version.md` 和第一阶段可运行代码与测试；**技术探针未通过不得继续宣称底座可用**。

## 依次实施的里程碑

- **M0：技术验证**——Pi Durable 版本固定、基础 Docker、数据库持久化、断点恢复实验、状态对账设计。
- **M1：基础闭环**——Web 首次设置 + 登录、模型配置、创建对话、任务可观察、SSE、Telegram allowlist + inbox/outbox。
- **M2：可靠自动化**——Cron、Heartbeat、任务取消/重试/预算、幂等和外部副作用确认、审批。
- **M3：长期能力**——Memory FTS5、记忆管理、Skills & Tool Policy Gateway、任务与日志追踪。
- **M4：可交付 V1**——Web P0 全页面、备份恢复、健康检查、ARM64/AMD64 CI、故障注入、安全审查、完整文档。
- **M5：可选 V1.1**——第二 IM、Webhook、MCP、Subagent Supervisor、语义检索；只有 M4 完整验收后启动。

每个里程碑必须输出：完成的需求 ID、主要变更、运行命令、测试结果、残余风险、下一阶段依赖。测试失败应修复到通过，不能只修改断言或删掉必要测试来刷绿。

## 技术原则

- 以 **Pi Durable Adapter** 封装上游 API；业务层不得直接依赖内部实现。
- 单实例写入 SQLite；应用库和 Pi Durable 库分离，使用 inbox/outbox + 幂等/对账，不假装跨库存在原子事务。
- 主应用尽量单容器，前端打包为静态资源，避免初版强依赖 Redis、PostgreSQL、Kubernetes。
- API 和 Web 都必须是实际可用功能；不接受只有 Mock 的界面。
- Agent/Tool/Skill/MCP 的操作须经过确定性权限策略；外部文本不得授予权限。
- 对外部非幂等操作处理 `UNCERTAIN` 状态，不盲目重试。
- 密钥、Memory 和 IM 数据不可进入公开日志或导出。
- 任何容器宿主机操作都必须显式另设受限执行器；第一版默认不提供该能力。

## 完成标准

请按 SRS 第 8 节执行全部 P0 验收测试，尤其是 AT-004、AT-006、AT-007、AT-008、AT-009、AT-014、AT-015、AT-017、AT-019、AT-023。完整记录测试环境、证据与未完成的风险。最终交付可复现的 `docker compose up -d` 安装流程、Web 管理后台、真实 IM 交互、任务恢复、自动化、Memory、审批、备份恢复和文档。不要在没有真实测试证据时宣布完成。

**立即开始 M0 技术验证与项目脚手架；需要选择实现细节时优先遵从 SRS 默认决策，并以 ADR 记录。**
