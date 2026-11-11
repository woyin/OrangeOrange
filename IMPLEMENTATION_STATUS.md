# SRS 实施追踪

当前基线为 [v1.1 SRS](docs/Home_Durable_Agent_v1.1/SRS.md)。**当前不是正式发布完成状态。** 测试通过、代码实现和真实账号/设备验收分别记录。

## 需求与证据

- [全部 208 条需求的结构化追踪](docs/V1.1-REQUIREMENTS-EVIDENCE.json)：141 条 P0 逐项对应静态审计；58 条 P1、9 条 P2 保留 TODO。修复后的覆盖在 `postAuditChange` 单独记录，不抹去同条其他限制。
- [67 条功能 P0 审计](docs/P0-FUNCTIONAL-AUDIT.md)：SYS/GW/CHAT/TASK/AUTO/MEM/MODEL/EXT/WEB。
- [74 条安全及运维 P0 审计](docs/P0-SECURITY-AUDIT.md)：SEC/OPS/MIG/CONN/GML/CUA/NFR。
- [42 项验收记录](docs/acceptance-results.json)与[本轮运行证据](docs/P0-VERIFICATION.md)。静态审计中的“未在本次运行”指审计子任务自身；统一门禁执行结果以运行证据为准。

旧版 v1.0 状态表及原始测试数字保存在 Git `37e7720:IMPLEMENTATION_STATUS.md` 和 [WORKLOG](docs/WORKLOG.md)，不再用其标签判断当前版本。

## 本轮实施

健康检查修复已提交为 `47814f6`。之后新增首次设置事务、通知抑制终态、Telegram 话题及发送者隔离、适配器生命周期与文本节流、审批文本通知、真实 IM 延迟、SourceImporter/AppConnector 契约、迁移 Cron 元数据、聊天取消、Heartbeat 手动操作和历史、记忆导出、指令历史、总览用量及版本/诊断下载。具体路径与测试见结构化追踪和运行证据。

最新本地 `npm run test:all` 已通过：62 个后端文件、315 项测试，22 项浏览器测试，3 项事件测试，HTTP 客户端契约、类型检查与前后端构建通过。后续本地初始化修复补充了短密码提示、失败后保留输入与退出后刷新隔离，并以真实 Chromium 操作生产 Compose 容器验证设置、重启和重新登录；范围见验证记录。模型、Google 和 Telegram 为可控传输；真实 SQLite/Pi/HTTP 与子进程 SIGKILL 均在对应测试中执行。

## 未验收与明确限制

容器安全复扫仍失败：两架构各34个HIGH和1个CRITICAL包/CVE匹配，当前发行版未给出修复版本，未接受风险。详细见 [容器安全结果](docs/container-security-results.json)。

- 真实 OpenWrt、真实模型/Telegram/Gmail 及真实 OpenClaw/Hermes 完整备份尚未验收。
- 72 小时稳定性实验尚未完成；短跑不能代替它。
- AMD64 使用 ARM64 宿主仿真执行，不能称为原生 AMD64 硬件或 CI 验收。
- 迁移只承诺兼容文档中固定版本/格式范围；源产品版本无法识别时明确为未知。外部历史不是 Pi 可恢复 checkpoint。
- 自动记忆候选依赖模型调用及明确 key 的冲突规则；分类不能理解所有隐含语义。多级作用域继承、所有 provider 支持、通用不确定副作用人工核验和更完整的界面/日志覆盖，仍须依逐项审计继续完成，不能据综合测试推定全部满足。
- M6 Browser Worker、M7 Bot Profiles/Routines/Supervisor 属未交付 P1；P2 也未宣称实现。

## 操作入口

[交付与部署](docs/V1.1-DELIVERY.md)、[运维恢复](docs/OPERATIONS.md)、[管理员密码恢复](docs/ADMIN-RECOVERY.md)、[迁移兼容](docs/MIGRATION-COMPATIBILITY.md)、[Gmail](docs/GMAIL.md)。发布门禁为 `npm run release:check`；缺少必要证据时必须失败。
