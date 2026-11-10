# 已知限制

当前按docs/SRS.md实施，逐项状态见IMPLEMENTATION_STATUS.md。旧CLI测试、ARM64底座探针和模块单测不能代替完整Web、真实IM与目标设备验收。

- Pi Durable 1.5.0为Experimental。升级前重新验证适配器与恢复。WAL/NORMAL的断电语义不同于SIGKILL，不承诺断电零丢失。
- 实际OpenWrt硬件未提供。开发Docker VM为2核约2GiB ARM64，低于SRS4核4GiB/SSD基准。AMD64生产镜像、72h、真实模型和Telegram仍需独立证据。
- 外部发送不保证无条件exactly-once。确认丢失进入UNCERTAIN，人工重试仍可能重复。
- P0必验Telegram。旧CLI微信/WhatsApp不自动纳入新控制平面权限模型。P1/P2在M4验收前不新增。
- 不提供shell、Docker管理、宿主机网络管理、本地大模型、浏览器或远程执行器。
- 网页工具不支持登录、PDF、脚本渲染和HTTP_PROXY；Fake-IP DNS可能触发保留地址拒绝。
- 费用预留与usage估算不等于最终账单。不能把事后监控称硬预算。
- 备份排除应用密钥和session，但仍含私人transcript/Memory。旧备份不会因删除当前记录自动清除。恢复需要重新提供凭据。
- 数据迁移只支持已测试schema，禁止旧程序直接打开新数据。恢复前备份并校验，恢复journal在数据库打开前处理。
- UI、CI或文档存在不代表验收通过。发布门禁缺证据时保持失败。
