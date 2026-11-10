# 架构与交付边界

本文是 SRS v1.0 的实施架构。具体完成状态以根目录 IMPLEMENTATION_STATUS.md 和测试证据为准，不把设计描述当成已验收结果。

## 部署

生产仅运行一个非 root Node 容器，提供 HTTP API、静态 Vue 管理台、Telegram 接入、调度和执行。OpenWrt 仅提供 Docker，不运行本机 Agent 业务进程。容器只允许持久数据卷和受限工作区挂载，不需要 privileged、host network、Docker Socket 或宿主机根目录。

默认宿主机端口为 127.0.0.1:8787。LAN/VPN 访问须由 Owner 显式配置公开 origin 和可信 TLS 反向代理。API 登录态、CSRF 和策略均在后端验证，前端不会授予权限。

基准假设为 4 核 ARM64、4 GiB RAM、SSD。当前开发机为 macOS ARM64，Docker 服务端为 Colima Linux ARM64。此环境不能代替真实 OpenWrt、AMD64 或 72 小时稳定性证据。

## 模块

| 模块 | 入口 | 责任 |
|---|---|---|
| Web | apps/web | 中文控制台，真实 API，SSE 后拉取最终状态 |
| HTTP/Auth | src/control/server.ts、security.ts | 初始化、Cookie、CSRF、验证、限流、幂等响应 |
| 业务控制 | src/control/service.ts | Task 状态机、并发/预算、Cron、Heartbeat、对账、IM inbox/outbox |
| 应用持久化 | src/control/store.ts | app.sqlite、schema、实体、唯一键、FTS5、事件和审计、加密秘密 |
| 权限 | src/control/policy.ts | 工具描述符、确定性权限、操作哈希审批、默认拒绝高危 |
| Pi Adapter | src/pi-adapter.ts | 业务访问 Pi 的唯一入口，稳定 conversation 映射、提交、取消、恢复、usage、模型配置 |
| 运行时 | src/runtime.ts 等 | 锁定 Pi Durable 1.5.0 的宿主实现，保留原 CLI 兼容 |
| 部署 | deploy、Dockerfile、compose.yml | 构建、容器隔离、资源、健康检查、持久卷 |

上表是模块契约，不要求按 monorepo 重写现有可工作代码。旧 CLI 及其故障测试保留作为底座；新 Web 控制平面不直接访问 Pi 私有实现。

## 两库一致性

app.sqlite 为应用事实来源。Pi 数据位于独立 pi/state.sqlite。应用侧先持久化 inbox 与任务 ID，再向 adapter 创建或找到对应 conversation；Pi 侧 externalId 映射和 conversation 初始化在同一次 Pi 提交中完成。

输入使用稳定 requestId 重放补齐。应用记录 submission ID；若记录前崩溃，恢复时以同一 requestId 查询已有输入。不存在跨文件全局事务。

执行成功只表示模型/工具运行结束。投递独立记录待发、发送、确认和 UNCERTAIN。发送前保存意图；恢复时遇到发送中且缺少确认的操作，不自动再次发出。

## 自动化

Cron 与 Heartbeat 的规则和 next_fire 时间都必须存入应用库，进程计时器只用来唤醒检查。Cron tick 产生独立业务任务；Heartbeat 绑定已有会话，仅在空闲时执行，忙碌时最多合并一个待触发项。每次状态变更与来源/关联 ID 可追踪。

队列默认最多 100，运行最多 2；P0 无子代理。预算按模型轮数、工具调用、时长、Token 和金额记录。费用估算、预留与真实报告分别标明；不能把实验性钩子抛错当作预算硬拦截。

## 记忆与权限

长期 Memory 属于应用库，独立于 transcript，包含来源、置信度、状态、过期与修订。只检索有效且授权范围内的记录；删除/失效后需避免从旧快照重新注入。

工具从统一 gateway 进入。外部消息、网页、Skill 与模型输出不能修改 enabled、permission、approval。高危宿主机管理没有执行器，批准也不能创造未实现的能力。审批须绑定规范化参数哈希、任务与过期时间，并持久化决策与消费。

## 事件与备份

SSE 只是应用持久事件的传输，事件序号单调，断线按 cursor 补齐；超出保留窗口提示全量重拉。事件和诊断默认仅含关联 ID 与安全元数据。

在线备份需要协调写入并采用 SQLite 一致备份能力，不能复制活跃 WAL 主文件冒充备份。恢复前再认证、确认覆盖范围、备份当前状态，验证 schema/integrity 后切换；失败可回滚。加密凭据的主密钥不与明文配置导出一起公开。

Pi SQLite 默认 WAL/NORMAL 的断电语义与应用库配置分开记录。SIGKILL 恢复测试不证明断电零丢失。
