# P0 功能逐项审计（指定范围）

范围：`docs/Home_Durable_Agent_v1.1/IMPLEMENTATION_CHECKLIST.md` 的 SYS、GW、CHAT、TASK、AUTO、MEM、MODEL、EXT、WEB 中全部 P0，共 67 项；其他前缀由其他审查负责。依据本次源码和测试静态阅读，不沿用 `IMPLEMENTATION_STATUS.md`。未运行测试；表中测试是现有测试证据，不代表本次通过。工作区存在并行修改，结论基于审查时看到的文件，合并修复后须复核。

状态含义：**已实现**表示静态证据覆盖该条主要要求，不表示已验收；**部分**表示已有相关能力但存在明确缺口或关键验证不足；**未实现**表示未找到该要求的实现。表中 `service`、`server`、`store` 分别指 `src/control/service.ts`、`src/control/server.ts`、`src/control/store.ts`；测试路径均在 `tests/` 下。仅列与本条有关的具体测试，不将一个综合测试视为整条通过。

| ID | 核对内容 | 状态 | 实际代码和测试 | 具体缺口或验证限制 |
|---|---|---|---|---|
| SYS-001 | Compose 安装/升级，不需宿主 Node/Python | 部分 | `deploy/Dockerfile`、`deploy/compose.yml`、`scripts/smoke-install.mjs`，`README.md` | 本次未运行最新镜像安装、持久数据升级和回滚；需实际容器验证。 |
| SYS-002 | 首启向导：管理员、时区、模型、可跳过 Telegram、数据目录检测 | 部分 | `server` setup，`apps/web/src/App.vue` 登录表单；`browser/console.spec.ts` 首次配置 | 未见数据目录检测；setup 先提交管理员，再配置 provider/channel，后者失败可能留下已初始化状态。Main 正在修复，须复核并测失败恢复。 |
| SYS-003 | 数据库版本检查、可回滚迁移，失败只读且拒绝任务 | 部分 | `store` 检查 `user_version`、事务回滚、`query_only`；`service.requireWrite` | 目前 schema 仅版本 1，无实际跨版本升级及回滚验证；其他初始化失败可能直接退出，不能一概视为只读维护。 |
| SYS-004 | Pi Durable 恢复入口、重建任务索引和处理 outbox | 部分 | `src/runtime.ts` 的 `harness.resume()`；`service.reconcile`；`control-api.test.ts` 稳定 requestId 重开、发送不确定恢复 | 有恢复路径；未见覆盖所有中断点和真实平台确认的完整验收。 |
| SYS-005 | live/ready 分离，ready 检查数据库、适配器、调度器 | 部分 | `server` 健康端点、`service.ready`；工作区新增 `control-health.test.ts` 针对数据库故障 | 实现及测试正在并行修改；本次未运行，须确认最终状态下适配器和调度器异常也能使 ready 失败。 |
| SYS-006 | 无密钥配置导出及默认脱敏诊断包 | 已实现 | `control/maintenance.ts` 的 `exportConfig`/`diagnostics`；`control-maintenance-http.test.ts` 检查认证与脱敏 | 测试未在本次运行；脱敏覆盖依赖已知字段和模式。 |
| GW-001 | ChannelAdapter 的 connect/health/normalizeInbound/send/edit/stop | 部分 | `src/channels/types.ts` 定义 `Adapter` 的 poll/send；`channel-adapters.test.ts` | 现有接口没有规定的 connect、health、normalizeInbound、edit、stop 契约。 |
| GW-002 | Telegram 接收、文本分段、引用/线程、错误重试 | 部分 | `channels/telegram.ts`、`service` outbox；`channel-adapters.test.ts` 私聊文本与错误分类，`control-api.test.ts` 响应丢失 | 当前 adapter 仅接收私聊；未实现群组话题、引用关联。429 有重试，未知发送结果转不确定而不盲重试。 |
| GW-003 | platform + tenant/bot + sender 唯一识别，未知默认拒绝 | 已实现 | `service.inbound` 以 `telegram:${account}:${user}` 构造 principal，检查 `allowedUsers`；`control-api.test.ts` allowlist | 本次只核对 control Telegram 路径；其他 legacy adapter 不等于本路径。 |
| GW-004 | platform + external_event_id 数据库去重 | 已实现 | `service.inbound` 以 `telegram:${account}:${id}` 作为 inbox key；`store` 唯一键；`control-api.test.ts` 十次 update 去重 | 测试针对 Telegram；account 一并纳入键。 |
| GW-005 | 线程到会话持久映射，可显式新建/归档 | 部分 | `service.inbound` 保存 `threadKey`；`server` 会话创建和 archived 状态 | 当前 Telegram 只接收私聊，未支持群组话题；未见将同一 IM 线程显式切换到新会话的控制路径。 |
| GW-006 | outbox 持久待发、发送确认或重试 | 已实现 | `service.enqueueOutbox`/`channels`；`control-api.test.ts` 丢失响应后不重发与人工确认路径 | 不确定投递需人工核验，不能当作已送达。 |
| GW-007 | 每通道节流、消息大小、附件白名单及上限 | 部分 | `channels/types.ts` 长度、`service.inbound` 文本限制和 outbox 429 退避；`channel-adapters.test.ts` 429 | 未见每通道完整主动节流配置、附件类型白名单及尺寸限制；Telegram control 入站目前仅文本。 |
| GW-008 | 平台不支持功能降级文本，如短期审批链接 | 未实现 | `service` 文本出站与 `policy` 审批；未见关联测试 | 未找到通道审批通知、短期 Web 链接或能力降级实现。 |
| CHAT-001 | 多会话创建、归档、恢复、搜索、更名，IM 线程隔离 | 部分 | `server` 创建/PATCH 会话；`App.vue` 会话列表；`control-api.test.ts` 同会话串行 | 私聊按 chat 映射；群组话题隔离缺失。UI 搜索只过滤已加载记录，未见消息全文搜索；线程显式新建见 GW-005。 |
| CHAT-002 | 模型调用、工具步骤、进度、最终答复事件流 | 部分 | `service.observe` 发 `conversation.changed`；`App.vue` 重新读取 live/history，显示工具折叠；`control-api.test.ts` SSE 恢复 | 事件仅通知会话变化，未见逐模型调用/工具步骤的完整结构化事件验证。 |
| CHAT-003 | 忙时追加入队，不打断不可取消工具 | 部分 | `service.createTask` 排队、同会话串行；`control-api.test.ts` 同会话串行 | 未见真实不可取消工具执行期间追加消息并验证无中断的专门测试。 |
| CHAT-004 | 暂停和取消运行，说明不能撤销外部动作 | 已实现 | `service.taskAction`；`control-runtime-extended.test.ts` 真实 pause/resume 与 cancel；`App.vue` 操作确认说明 | 聊天页自身取消入口问题另见 WEB-003；任务中心提供操作。 |
| CHAT-005 | 系统指令/角色编辑、token 预算、版本历史 | 部分 | `server` 设置 `systemPrompt`、`tokenBudget`、写入 `prompt_revisions`；`App.vue` 设置表单 | 未见 UI 展示或比较历史版本；token 预算不是编辑器中的实际 token 计数。 |
| TASK-001 | IM/Cron/Web 统一创建含 ID、来源、所有者、目标、预算、状态的任务 | 已实现 | `service.createTask`；`server` Web、`inbound` Telegram、`automate` Cron 调用；`control-api.test.ts` 任务与 Telegram | 本次未运行三入口端到端验证。 |
| TASK-002 | Task 与 Pi Durable Conversation/Task 显式关联并恢复 | 部分 | `service` 记录 `piConversationId`/`piSubmissionId`；`control-api.test.ts` 跨库重开对账 | 有 conversation 和 submission 关联；未见明确持久化 Pi Durable task ID 与独立重开验证。 |
| TASK-003 | 有限重试、指数退避抖动、错误分类 | 部分 | `service.finishTasks` 针对模型 429/5xx/timeout 最多两次和抖动；`control-runtime-extended.test.ts` 已写入后不重放 | 仅覆盖特定模型失败，未建立通用可重试/不可重试/需审批分类及全部路径测试。 |
| TASK-004 | 工具只读、幂等写、非幂等写、高危分类 | 已实现 | `control/policy.ts` 的 `ToolDescriptor.sideEffect` 和 `PolicyGateway`；`control-policy.test.ts` | 高危默认拒绝；分类是否与每个实际执行器副作用一致需随工具变更复核。 |
| TASK-005 | 非幂等 operation key、请求、确认和不确定核验 | 部分 | `service.tool` 持久化 operationHash、状态和 receipt；`control-api.test.ts` 崩溃转 UNCERTAIN；Gmail 意图另存快照 | 通用 operation 记录哈希，不保存完整请求快照；不确定后禁止重试，但未见通用核验/人工解决工作流。 |
| TASK-006 | 取消、暂停、继续、重试、失败原因和权限 | 部分 | `server` 认证路由和 `service.taskAction`；`control-runtime-extended.test.ts` 暂停、取消 | owner 权限路径存在；未见独立多主体权限矩阵测试，操作错误原因部分归为通用错误。 |
| TASK-007 | 每任务最大时长、模型轮次、工具数、token/金额 | 已实现 | `service.createTask`、`admitModel`、`tool`、`finishTasks`；`control-runtime-extended.test.ts` 预算和时限 | 已有默认值和内部预算字段；边界效果依赖现有测试，未在本次执行。 |
| TASK-008 | 队列长度和运行并发上限，超限反馈 | 已实现 | `service.createTask` 的 `QUEUE_FULL` 与调度并发限制；`control-api.test.ts` 队列及并发，`control-settings-v11.test.ts` 配置上下限 | 本次未运行测试。 |
| TASK-009 | Agent 完成和消息 delivery 独立状态 | 部分 | `service.finishTasks` 与 outbox 聚合状态；`control-api.test.ts` 不确定投递 | 关闭通知或 `onlyOnChange` 抑制结果时先写 PENDING 而不创建 outbox，后续无法更新，状态可能永久待投递。 |
| AUTO-001 | 标准 cron、IANA 时区、预览 5 次 | 已实现 | `service.preview` 使用 cron-parser 与时区；`control-api.test.ts` preview 5/DST | 本次未运行测试。 |
| AUTO-002 | 调度创建、编辑、暂停、恢复、手动执行、删除、历史 | 已实现 | `server` schedules CRUD/actions/history；`App.vue` 自动化页面；`control-api.test.ts` 创建调度 | 已有代码；未见一项覆盖全部操作和历史的专门测试。 |
| AUTO-003 | 每 Cron tick 独立 task/run，skip/coalesce/catch-up-one 漏跑策略 | 部分 | `service.automate` 以计划时间构造 key，接受三种策略；`control-api.test.ts` queue_one 和 skip | coalesce 与 catch-up-one 当前走相同行为。清单未定义二者差别，不能仅据此判 bug；需结合规范明确语义，补重启、多次漏跑、各策略测试。 |
| AUTO-004 | skip_if_running 或 queue_one，默认前者 | 已实现 | `service.schedule` 默认策略、`automate` 的 pending；`control-api.test.ts` queue_one 忙时合并 | 本次未运行测试；还应覆盖默认策略。 |
| AUTO-005 | Heartbeat 绑定上下文，空闲触发，不插入模型回合 | 已实现 | `service.heartbeat`/`automate` 检查同会话未终结任务；`control-api.test.ts` 忙时合并一次 | 本次未运行测试。 |
| AUTO-006 | 指定通道/线程投递，仅变化时通知 | 部分 | `service` 保存 channelId/threadId 和 `lastResultHash`；`control-settings-v11.test.ts` 关闭通知 | 抑制消息时状态永久 PENDING，见 TASK-009；未见只变化时通知的端到端测试。 |
| MEM-001 | 显式 schema 含 id/kind/scope/content/source/confidence/时间/状态 | 部分 | `service.memory` 校验字段；`memory-policy.ts` 创建记录；`store` entities JSON | 记录在通用 JSON entities 中而非带字段约束的显式数据库 schema；候选写入也可不含 expires_at。 |
| MEM-002 | 主动记住、纠正、删除、禁止记住类别 | 已实现 | `service.memory`、`server` memories 与 memory-policy；`control-memory-policy-http.test.ts` 禁记及修改策略 | 通过 API/UI 操作；自然语言各意图识别没有独立验收证据。 |
| MEM-003 | 自动提取、去重、冲突、写入策略，敏感默认确认 | 部分 | `control/memory-policy.ts` 的 submit、去重、key 冲突、敏感候选；`control-memory-policy-http.test.ts` | 模型可提交候选，但未见从对话自动提取的独立流水线及端到端测试；冲突依赖显式 key。 |
| MEM-004 | 非秘密 FTS5，全球/用户/项目/会话作用域 | 部分 | `store` 的 `memory_fts` 和 scope 过滤；`control-runtime-extended.test.ts` owner/Telegram 隔离 | scope 是自由字符串，未见 global/user/project/session 层次及继承规则的完整实现和测试。 |
| MEM-005 | 编辑、软删除、导出、修订历史 | 部分 | `store.put/remove` 记录 revision 和软删除；`server` 修订查询；`control-api.test.ts` 修订 | 未找到记忆单独导出 API/UI；配置导出不能等同于记忆导出。 |
| MEM-006 | 过期自动失效，检索显示时间来源，防旧覆盖新 | 部分 | `store` 索引与搜索排除过期；`control/maintenance.ts` 过期清理；记录含 source/时间 | 未见基于时间的新旧事实冲突解决规则；没有专门覆盖旧事实覆盖新事实的测试。 |
| MODEL-001 | Pi AI/Pi Durable provider 配置、连通测试、默认模型 | 部分 | `service.provider/configureProviders`；`server` OpenAI models 连通测试；`App.vue` 表单 | control 路径明确只接受 `openai`；未实现 Pi 支持的其他 provider 配置，连通测试也不验证所选模型可用。 |
| MODEL-002 | 主备模型及超时/限流/5xx 切换 | 部分 | `service.finishTasks` 依据 priority 重试；`runtime.ts` 错误分类；`control-runtime-extended.test.ts` 写入后禁止切换 | 未见所有三种失败到备用模型的端到端覆盖；已有副作用时刻意禁止重放。 |
| MODEL-003 | 按任务、会话、模型、日期聚合 token/估算成本 | 部分 | `service.finishTasks` 写 `model_usage`；`control/budgets.ts` 按 provider/task/day 预留结算；`control-budgets.test.ts` 跨 provider/日期 | `model_usage` 记录任务、会话和时间，但未见按具体模型/会话/日期聚合接口；会话 live usage 需验证不会跨任务重复计数。 |
| MODEL-004 | 每任务、每日软硬支出限额 | 已实现 | `control/budgets.ts`、`service.admitModel`；`control-budgets.test.ts` 软硬阈值，`control-budgets-http.test.ts` 暂停后继续 | 本次未运行测试；未知成本按预留保守处理。 |
| MODEL-005 | 密钥新增、轮换、删除、测试，UI 不回显 | 已实现 | `service.provider` 与 `server` 测试/删除，`store` secret；`browser/console.spec.ts` 密钥不回显；`control-api.test.ts` 秘密边界 | 连通测试局限 OpenAI，见 MODEL-001。 |
| EXT-001 | ToolDescriptor 的名称、版本、schema、副作用、权限、超时、幂等、执行器 | 已实现 | `control/policy.ts` 的接口和注册校验；`control-policy.test.ts` | 需确保新增工具实际遵守描述符，注册校验本身不能证明执行行为。 |
| EXT-002 | 所有工具统一 Policy Gateway，不可信文档不能覆盖策略 | 已实现 | `runtime.ts` toolGateway 和 `service.tool`；`control-boundary.test.ts` 越界读拒绝、禁用工具生效 | 此结论针对 control runtime；legacy 独立运行模式并非同一网关部署路径。 |
| EXT-003 | 时间、受限 HTTP、记忆、任务查询、受限文件操作等最小工具 | 部分 | `runtime.ts` 注册 current_time、web_fetch、memory_search、文件工具；`control-boundary.test.ts` 越界拒绝 | 未找到 control 任务查询工具的明确实现；各工具权限与 HTTP 边界需分别验证。 |
| EXT-004 | 可信目录安装 Skill、启停、内容、版本、权限声明 | 部分 | `skills.ts` 扫描可信目录；`runtime.ts` 列表/内容/版本/启停；`skills.test.ts` 禁止目录外加载 | 没有从可信目录安装的管理工作流；普通本地 Skill 的 permissions 固定为 `skill_load`，不是实际声明的工具权限清单。 |
| EXT-005 | 通用 Markdown/元信息 Skill，执行映射显式注册工具 | 部分 | `skills.ts` 加载 Markdown；`service` 迁移 Skill 的 requiredTools/toolMap；`control/policy.ts` 注册工具 | 显式依赖映射针对已审查导入 Skill；普通可信目录 Skill 未见等价权限元信息及映射验证。 |
| WEB-001 | 首次向导、权限说明、连接自检 | 部分 | `App.vue` 首次配置表单和权限文字；`browser/console.spec.ts` 首次配置 | 未见首次向导中模型/IM 连接自检和数据目录检测；setup 失败原子性见 SYS-002。 |
| WEB-002 | Dashboard 状态、模型/IM、任务、审批、今日成本、错误 | 部分 | `App.vue` dashboard 读取 `system/summary`；`service.summary` 返回运行数、审批数、provider 状态和错误 | summary 未返回 IM 连接详情、今日 token/成本；未见专门 dashboard 字段测试。 |
| WEB-003 | Chat 列表搜索、消息流、折叠工具、运行/取消、模型、附件 | 部分 | `App.vue` 会话、消息、工具折叠及模型选择；`browser/console.spec.ts` 聊天 | 取消按钮依赖 `selected.activeTaskId`，当前会话返回未提供该字段；附件仅显示已有状态；搜索仅当前已加载项。 |
| WEB-004 | Task Center 筛选、时间线、步骤、错误、成本、重试、审批、交付 | 部分 | `App.vue` 筛选/详情、`server` task 详情；`control-api.test.ts` 任务状态 | task 详情返回 steps、operations、deliveries、actionIntents，但 UI 读取 `selected.approvals`，后端未返回该字段；成本未提供明确聚合展示。 |
| WEB-005 | Cron/Heartbeat 清单、表达式、预览、暂停/立即执行、历史 | 部分 | `App.vue` 自动化及 Cron 预览，`server` schedules actions/history；`control-api.test.ts` cron/heartbeat | Heartbeat 未见立即执行或历史 API；页面的自动化统一暂停按钮对 heartbeat PATCH 依赖表单校验，须专项验证。 |
| WEB-006 | Memory 搜索、类型/作用域、来源、编辑、失效、删除、冲突 | 部分 | `App.vue` 过滤及详情、`MemoryPolicy.vue`；`browser/v11-flows.spec.ts` 敏感候选审查 | 候选冲突审查能力存在，但普通记忆列表未见明确冲突提示；需验证失效状态操作及过滤。 |
| WEB-007 | Providers 模型、密钥增删测、优先级、预算 | 部分 | `App.vue` Providers 和 `forms.ts`；`server` provider CRUD/test；`control-budgets-http.test.ts` 预算 | 供应商仅 OpenAI；未见针对全部路由优先级和成本预算 UI 的完整测试。 |
| WEB-008 | Telegram 凭据测试、allowlist、最近错误、投递状态 | 部分 | `App.vue` channels 列表、测试和错误；`service.channels` 保存 outbox；`control-api.test.ts` 不确定投递 | 投递状态显示在任务详情而非通道页面；未见通道页集中展示送达状态。 |
| WEB-009 | 查看/启停工具、权限和 Skill 内容 | 已实现 | `App.vue` 工具/Skill 列表和启停；`server` tools/skills；`control-boundary.test.ts` 禁用后拒绝 | 本次未运行浏览器及后端测试。 |
| WEB-010 | 审批清单、风险、批准/拒绝、时限、历史 | 已实现 | `App.vue` 审批列表及操作；`server` 决策；`control-api.test.ts` 哈希绑定 | Gmail 审批由应用中心单独展示；本次未运行浏览器测试。 |
| WEB-011 | System 版本、资源、日志、审计、备份恢复、诊断包、升级提示 | 部分 | `App.vue` system/日志/审计/备份恢复；`server` diagnostics；`control-operations.test.ts` 恢复 | 系统页未见诊断包下载和升级提示；未见完整版本信息。 |
| WEB-012 | 时区、语言、通知、预算、保留、改密码、注销 | 已实现 | `App.vue` 设置、密码和注销；`server` settings/auth；`control-settings-v11.test.ts` 通知配置 | 具体语言与保留策略的实际生效范围未做完整 UI 验收。 |
| WEB-013 | SSE 单调序号、重连恢复，断线不丢最终状态 | 已实现 | `store` events 自增、`server` cursor/reset、`apps/web/src/events.ts`；`control-api.test.ts` cursor/reset，`apps/web/src/events.check.ts` | 本次未执行重连测试；保留窗口外通过 reset 重新读取状态。 |
| WEB-014 | 空/错误/loading/权限/危险确认及键盘无障碍 | 部分 | `App.vue` 空状态、错误、loading、确认、跳转链接；`browser/v11.spec.ts` 应用中心键盘/窄屏 | 未见覆盖全部关键页面与权限错误的键盘及无障碍检查；不能由一个页面测试推断全部符合。 |
| WEB-017 | 迁移中心来源、离线包/只读路径、预览、映射、冲突、回滚 | 部分 | `v11/MigrationCenter.vue` 扫描、计划、冲突、审核、回滚；`browser/v11-flows.spec.ts` 真实迁移批次 | 页面具流程，具体来源兼容、安全和回滚完整性属迁移组另审；本次未运行端到端测试。 |
| WEB-018 | 应用连接 OAuth、状态、权限、测试、断开、历史 | 部分 | `v11/AppsCenter.vue` OAuth、状态、scope、测试、删除；`browser/v11-flows.spec.ts` 邮件流程 | 未见连接历史单独展示；连接/撤销和 OAuth 实际可用性由连接器组另审。 |
| WEB-019 | Gmail 发送审批账号、收件人、主题、正文、附件、规则、送达及不确定状态 | 已实现 | `v11/AppsCenter.vue` 服务端快照预览、规则、发送和 SEND_UNCERTAIN；`browser/v11-flows.spec.ts` 审批发送一次 | 预览主要以完整 JSON 展示；本次未运行测试，真实 Gmail 结果不由本审计推断。 |

## 具体可修复项

1. **首次初始化**：先验证配置并确保管理员与可选 provider/channel 要么全部成功、要么可安全重试；加入无效模型和无效 Telegram 配置后的恢复测试。Main 已接手。
2. **投递状态**：为通知关闭和结果未变化引入明确的“无需投递/已抑制”终态，补自动化任务完成后的持久化和重启测试。
3. **聊天和任务界面**：为聊天页面提供可靠的当前任务关联，验证取消真实运行；任务详情返回并展示关联审批及成本。
4. **Telegram**：按规范补群组话题/引用的入站标识、会话映射与回复；区分发送者 allowlist 和群组目标授权；补平台报文测试。先明确是否纳入当前 P0 产品范围。
5. **Cron 漏跑**：依据 SRS 明确 coalesce 与 catch-up-one 的预期语义，再覆盖跨重启多个漏跑、skip、重叠策略和幂等；仅凭当前两者同路径不认定为缺陷。
6. **记忆**：补全单独导出、作用域语义、自动提取入口与时间冲突处理；为普通 Skill 提供真实权限声明及工具映射。
7. **模型和任务**：补所需 provider 支持、具体模型/会话/日期用量聚合、通用错误分类和不确定操作的人工核验；分别测试超时、429、5xx 切换。
8. **缺失界面**：补 Dashboard IM/今日用量、System 诊断下载及升级提示、Heartbeat 历史/手动运行、通道投递视图、连接历史和权限错误/键盘覆盖。
9. **复验**：并行修复完成后按清单逐项重新读取变更；运行相应定向测试和容器安装升级验收。当前文档不声称测试通过或 P0 已验收。
