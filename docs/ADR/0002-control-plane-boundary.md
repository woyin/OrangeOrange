# ADR 0002：增量建立容器控制平面

状态：采用。基线：SRS v1.0；Pi 版本决策另见 ADR 0001。

现有 OrangeOrange 提供 CLI、持久对话、工具、渠道、调度和恢复测试，但应用状态与 Pi 文档耦合，缺少 Web 与独立应用数据库。直接把 CLI RPC 暴露为 Web 会绕过新要求的身份、策略和两库对账。

选择：保留已验证 CLI 代码，建立 src/control 与唯一 src/pi-adapter 边界；新应用事实进入 app.sqlite，Pi 在 pi/state.sqlite。前端使用独立 apps/web package，静态构建后由同一主容器提供；不强行重排全仓为 monorepo，减少回归范围。

首次初始化和普通配置存应用库，秘密单独加密，环境/挂载主密钥不公开。P0 使用原生 scrypt 密码哈希，减少 ARM64 上额外原生依赖；参数、随机盐与测试由 security 模块固定。明文 localhost HTTP 的 Cookie 与 LAN TLS 行为须在安全说明中明确，不把 HTTP 伪装成 TLS。

任务不能跨 SQLite 假定原子。应用 inbox + 稳定 task/request ID、Pi 侧创建映射，以及启动对账共同填补提交间隙。外部未确认副作用维持 UNCERTAIN，重试要求显式人工处理。

风险：两套入口同时使用同一资源会形成权限旁路。生产主入口只启动控制平面，不启动旧 CLI daemon；adapter 的工具 middleware 将生产 Memory/调度映射到控制平面，旧自主工具不得绕过策略。既有 CLI 测试继续运行，旧数据迁移需另有显式流程，不自动推测用户数据布局。

待外部验证：真实 OpenWrt、目标 SSD、AMD64 镜像、真实模型/Telegram 和 72 小时 soak。缺失这些证据不得把 M4 标为完整验收。
