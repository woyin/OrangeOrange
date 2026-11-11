# P0 安全、迁移、连接器与运维逐项审计

基准为 `Home_Durable_Agent_v1.1/IMPLEMENTATION_CHECKLIST.md` 的 P0 行。本分工覆盖 **SEC 12、OPS 6、MIG 15、CONN 8、GML 8、CUA 1、NFR 24，共 74 项**。清单实际使用 `CONN` 和 `GML`，没有 P0 `APP` 或 `GMAIL` 前缀。其他分工覆盖 67 项；全清单合计 141 项。

状态说明：**部分**表示已有相关实现，但要求的某些能力缺失或证据不足；**已实现，待验收**表示已定位主要实现和针对性测试，仍须按规格完成端到端或外部验收；**未实现**仅用于确认未找到要求能力的情况。表中的测试是源码中存在的测试，并非本次执行结果。本次为静态审计，未运行测试、容器、真实账户、目标设备或长期实验；测试文件存在不等于测试通过。真实来源备份、Google 授权和发送、双架构 CI 运行结果、目标设备和 72 小时记录需独立提供证据。

## 安全 SEC

| ID | 状态 | 代码与测试 | 具体缺口或验证限制 |
|---|---|---|---|
| SEC-001 | 已实现，待验收 | `src/control/security.ts`、`src/control/server.ts`；`tests/control-security-extended.test.ts` | 使用带盐 scrypt 和 HttpOnly/SameSite Cookie；Secure 取决于 HTTPS publicOrigin。本次未验证实际 HTTPS 代理与浏览器。 |
| SEC-002 | 部分 | `src/control/server.ts` 的 Origin、CSRF、rate、字段检查；`tests/control-security-extended.test.ts` | 需逐路由核对访问日志是否覆盖成功与失败写入；现有结构化启动日志不能证明所有写 API 都有访问日志。 |
| SEC-003 | 已实现，待验收 | `src/channels/telegram.ts`、`src/control/apps.ts`、`src/control/policy.ts`；`tests/channel-adapters.test.ts`、`tests/control-outbound-authorization.test.ts` | 需真实 Telegram 验证未知身份、显示名冒充和通道主体的权限上限。 |
| SEC-004 | 已实现，待验收 | `src/control/policy.ts`；`tests/control-policy.test.ts`、`tests/control-boundary.test.ts` | 需覆盖每个实际工具的风险分类与默认拒绝，不能由描述符本身推断所有入口均受控。 |
| SEC-005 | 已实现，待验收 | `src/control/policy.ts`；`tests/control-policy.test.ts` | 审批绑定任务、工具与操作哈希并记录摘要；需核对用户界面能理解实际影响和完整参数。 |
| SEC-006 | 已实现，待验收 | `src/control/policy.ts`、`src/control/store.ts`；`tests/control-policy.test.ts` | 有 PENDING、APPROVED、REJECTED、EXPIRED、REVOKED 及消费状态；需端到端验证到期、撤回和审计。 |
| SEC-007 | 部分 | `src/control/policy.ts`、`src/control/service.ts`；`tests/control-boundary.test.ts` | 测试覆盖一条越界读取诱导；不能证明全部网页、Skill、IM 和模型输出均无法影响授权。需扩展入口级注入验收。 |
| SEC-008 | 已实现，待验收 | `deploy/compose.yml`、`src/workspace.ts`；`tests/workspace.test.ts`、`tests/control-boundary.test.ts` | Compose 未挂 Docker Socket、未使用 host 网络；实际部署仍需 AT-002 检查挂载、工具和权限。 |
| SEC-009 | 已实现，待验收 | `src/runtime.ts`、`src/workspace.ts`；`tests/tools.test.ts` | 需运行重定向、DNS 重绑定、混合地址和 metadata 的实际请求测试；不能以工具声明代替网络验收。 |
| SEC-010 | 部分 | `src/control/maintenance.ts`、`src/migrations/importers.ts`；`tests/control-maintenance.test.ts` | 导出采用白名单、导入采用模式脱敏；任意自定义秘密模式无法保证识别，通知及所有日志路径需注入测试。 |
| SEC-011 | 部分 | `deploy/compose.yml`、`src/control/server.ts`；`docs/SECURITY.md` | Compose 默认绑定 127.0.0.1；LAN/VPN 的 TLS、认证代理和可信网段依赖部署配置，未见实际网络验收。 |
| SEC-012 | 已实现，待验收 | `src/control/store.ts`、`src/control/maintenance.ts`；`tests/control-maintenance.test.ts` | 应用级追加审计与轮转快照；不承诺防宿主管理员修改。需实际验证 Agent 无权删除或修改审计及备份。 |

## 运维 OPS

| ID | 状态 | 代码与测试 | 具体缺口或验证限制 |
|---|---|---|---|
| OPS-001 | 部分 | `src/control/main.ts`、`src/control/maintenance.ts`、`deploy/compose.yml` | 有 JSON 启动日志及 Docker 日志大小轮转；未证实所有日志包含要求的四种关联 ID、级别和保留策略。 |
| OPS-002 | 部分 | `src/control/maintenance.ts:87`；`tests/control-maintenance.test.ts` | RSS、CPU、磁盘、数据库、任务、失败及模型错误有指标；`imLatencyMs` 固定为 `null`，缺实际 IM 延迟采集。 |
| OPS-003 | 部分 | `src/control/operations.ts`、`src/backup.ts`；`tests/control-operations.test.ts` | 两库使用 SQLite backup API；需核对受管文件与配置均纳入一致性备份，并在活动写入时做真实恢复验收。 |
| OPS-004 | 已实现，待验收 | `src/control/operations.ts`、`src/control/server.ts`；`tests/control-operations.test.ts` | 有预备份、确认和校验及故障回滚测试；需检查 UI 覆盖范围展示并在空环境恢复。 |
| OPS-005 | 部分 | `src/control/maintenance.ts`、`deploy/compose.yml`；`tests/control-maintenance.test.ts` | 已清理到期任务、事件及受管附件，并设置容器日志轮转；需核对所有历史和日志的配置与清理覆盖。 |
| OPS-006 | 已实现，待验收 | `src/control/maintenance.ts`、`src/control/service.ts`；`tests/control-maintenance.test.ts` | 低水位及探测失败触发保护；真实卷空间不足、日志保留和恢复行为尚未本次验证。 |

## 迁移 MIG

| ID | 状态 | 代码与测试 | 具体缺口或验证限制 |
|---|---|---|---|
| MIG-001 | 部分 | `src/migrations/index.ts`、`src/migrations/core.ts`、`src/migrations/importers.ts`；`tests/migrations-core.test.ts` | 有扫描、计划、暂存、应用、验证、回滚；未找到统一 `SourceImporter` 插件接口及全部阶段的显式源格式契约。 |
| MIG-002 | 部分 | `src/migrations/source.ts`、`src/migrations/importers.ts:2417`；`tests/migrations-integration.test.ts`；`docs/MIGRATION-COMPATIBILITY.md` | ZIP、只读状态目录和工作区有实现。SRS §3.12 要求导入完整备份并显示版本、清单和未知字段；`MIGRATION_DESIGN.md` §7–8 要求针对固定版本建立至少两个 fixture，不要求支持全部历史版本。旧 JSONL 被标记 `legacy_jsonl_ignored`，是明确的版本限制，不能仅据此判为 P0 实现缺口。已声明版本仍需以真实完整备份完成 MT-001。 |
| MIG-003 | 部分 | `src/migrations/importers.ts:2795`；`tests/migrations-importers.test.ts` | 支持已识别 Hermes schema 和相关文件；真实 `~/.hermes/` 导出及其他版本未验收，未知格式不能推定支持。 |
| MIG-004 | 部分 | `src/migrations/index.ts`、`src/migrations/importers.ts`、`src/control/migrations.ts`；`tests/control-migrations-http.test.ts` | 有清单、计数和警告；受支持类型及未知字段的分类完整性需用真实来源核验。 |
| MIG-005 | 部分 | `src/migrations/core.ts`；`tests/migrations-core.test.ts` | 计划包括 sourceId、hash、targetId、状态、来源和确认哈希；并非每项都明确提供独立 reason、原始时间或完整 Manifest 字段。 |
| MIG-006 | 已实现，待验收 | `src/migrations/core.ts`、`src/control/migrations.ts`；`tests/migrations-core.test.ts`、`tests/control-migrations-http.test.ts` | 有历史搜索和受限不可信续聊材料；须完成 MT-006，证明新 Pi 会话及工具调用不会重放旧轨迹。 |
| MIG-007 | 部分 | `src/migrations/importers.ts`、`src/migrations/core.ts`；`tests/migrations-importers.test.ts` | 指令和记忆带来源与不可信标记，支持人工提升；各文件类型、作用域与冲突预览需真实来源验收。 |
| MIG-008 | 部分 | `src/migrations/core.ts`、`src/migrations/importers.ts`；`tests/migrations-core.test.ts` | Skill 默认为禁用和待审，MCP 为草案；需逐项核对脚本依赖与工具声明能否完整识别。 |
| MIG-009 | 部分 | `src/migrations/core.ts` 的 `nativeDraft`；`tests/migrations-core.test.ts` | 草案禁用且检查名称、表达式、时区和提示；草案字段未完整映射运行模式、目标通道及依赖能力，需人工补齐。 |
| MIG-010 | 部分 | `src/migrations/index.ts`、`src/migrations/importers.ts`；`tests/migrations-importers.test.ts` | 跳过已识别敏感文件并列重授权；未见完整显式安全迁移扩展点，模式识别也不能保证找出所有自定义秘密。 |
| MIG-011 | 已实现，待验收 | `src/migrations/source.ts`、`src/migrations/importers.ts`；`tests/migrations-source.test.ts` | 只读挂载校验、文件校验及 SQLite 一致性检查已有实现；需 Linux 实际只读挂载和活动 WAL 来源验收。 |
| MIG-012 | 已实现，待验收 | `src/migrations/core.ts`；`tests/migrations-core.test.ts` | 身份加内容哈希去重，变更按冲突处理；需用真实来源执行三次导入及单项变化的 MT-003。 |
| MIG-013 | 已实现，待验收 | `src/migrations/core.ts`；`tests/migrations-core.test.ts` | 支持 keep/new/manualmerge，默认 keep；需核对 UI 可选择和解释各冲突。 |
| MIG-014 | 部分 | `src/migrations/core.ts`、`src/control/migrations.ts`；`tests/migrations-core.test.ts` | 数据库批次事务、哈希校验和按批回滚存在；跨文件故障补偿及 SIGKILL 恢复仍需 MT-004 证明。 |
| MIG-015 | 部分 | `src/control/migrations.ts`、`apps/web/src`；`tests/control-migrations-http.test.ts`、`tests/browser/v11-flows.spec.ts` | HTTP 和页面有迁移路径；映射、冲突、报告、撤销的完整浏览器流程及真实包尚未本次验收。 |

## 应用连接 CONN

| ID | 状态 | 代码与测试 | 具体缺口或验证限制 |
|---|---|---|---|
| CONN-001 | 部分 | `src/connectors/actions.ts:44`、`src/connectors/oauth.ts`；`tests/connectors-oauth.test.ts` | Gmail 实现 manifest、scope、动作和 OAuth 生命周期；未找到统一 `AppConnector` 接口把所有要求方法约束为可插拔契约。 |
| CONN-002 | 已实现，待验收 | `src/connectors/actions.ts:46`；`tests/connectors-actions.test.ts` | Gmail 动作声明 schema、风险、scope、超时、重试和审批；schema 内容及后续连接器的强制验证仍需核验。 |
| CONN-003 | 已实现，待验收 | `src/connectors/actions.ts`、`src/control/apps.ts`；`tests/control-outbound-authorization.test.ts` | Owner 建连，grant 绑定账号、主体、profile、task、workflow；需真实端到端验证权限撤销。 |
| CONN-004 | 已实现，待验收 | `src/connectors/oauth.ts`、`src/control/store.ts`；`tests/connectors-oauth.test.ts` | PKCE、state、回调白名单、加密和撤销有实现；尚无真实 Google 授权验收。 |
| CONN-005 | 部分 | `src/connectors/oauth.ts`、`docs/GMAIL.md` | 要求配置可信 HTTPS 精确回调；代码提供方案，但真实 LAN/VPN 域名、证书及 Google 回调未验收。 |
| CONN-006 | 已实现，待验收 | `src/connectors/oauth.ts`、`src/control/apps.ts`；`tests/connectors-oauth.test.ts` | 有连接状态和失效映射；需以真实授权、刷新及撤销检查 UI 状态。 |
| CONN-007 | 已实现，待验收 | `src/connectors/actions.ts`；`tests/connectors-actions.test.ts` | 持久化意图、哈希、结果及不确定状态；真实中断后外部效果未验收。 |
| CONN-008 | 已实现，待验收 | `src/connectors/actions.ts`、`src/control/apps.ts`；`tests/connectors-actions.test.ts` | Gmail 有硬限流、规则收件人/域名、dry-run 和取消；通用连接器能力未建立，真实提供商配额尚未验证。 |

## Gmail GML

| ID | 状态 | 代码与测试 | 具体缺口或验证限制 |
|---|---|---|---|
| GML-001 | 已实现，待验收 | `src/connectors/oauth.ts`、`src/connectors/actions.ts`；`tests/connectors-oauth.test.ts` | 只允许 gmail.send 且声明 Sensitive；真实 Google 授权、UI 展示及可能的 Google 审核未验收。 |
| GML-002 | 已实现，待验收 | `src/connectors/actions.ts`、`src/connectors/mime.ts`；`tests/connectors-mime.test.ts` | 提供发送动作、地址、主题、MIME、附件及大小校验；真实邮件客户端兼容性未验收。 |
| GML-003 | 已实现，待验收 | `src/connectors/actions.ts`、`src/control/apps.ts`；`tests/connectors-actions.test.ts` | 默认提议后审批，自动规则须显式配置；需真实聊天中验证仅要求撰写不会触发发送。 |
| GML-004 | 部分 | `src/control/apps.ts`、`src/connectors/actions.ts`；`tests/connectors-actions.test.ts`、`tests/browser/v11-flows.spec.ts` | 哈希绑定内容和附件；发送账号由 Owner 确认而非 Google 身份核验，敏感内容提示及完整界面预览需端到端检查。 |
| GML-005 | 已实现，待验收 | `src/connectors/actions.ts`；`tests/connectors-actions.test.ts` | 规则绑定接收人/域名、模板哈希、工作流、频率、日限额及期限；真实自动触发流程未验收。 |
| GML-006 | 已实现，待验收 | `src/connectors/actions.ts`、`src/control/apps.ts`；`tests/connectors-actions.test.ts` | 保存 Message-ID，响应丢失和重启标记 SEND_UNCERTAIN，默认不重试；真实 Gmail 阻断响应未验收。 |
| GML-007 | 已实现，待验收 | `src/connectors/actions.ts`、`src/connectors/oauth.ts`；`tests/connectors-actions.test.ts` | 区分失效授权、限流和配额等错误；真实提供商错误文案及重新授权交互未验收。 |
| GML-008 | 部分 | `src/control/apps.ts`、`apps/web/src`；`tests/control-apps-http.test.ts`、`tests/browser/v11-flows.spec.ts` | 有连接、规则、意图及删除接口；完整管理后台流程、历史及权限说明需要浏览器与真实账号验收。 |

## 执行后端 CUA

| ID | 状态 | 代码与测试 | 具体缺口或验证限制 |
|---|---|---|---|
| CUA-001 | 已实现，待验收 | `src/execution/index.ts`；`tests/execution.test.ts` | 定义七阶段接口、任务/主体/租户授权和能力声明。测试使用 FakeBackend；真实 Browser Worker 属 P1，不能由此推定已交付。 |

## 非功能 NFR

| ID | 状态 | 代码与测试 | 具体缺口或验证限制 |
|---|---|---|---|
| NFR-001 | 部分 | `.github/workflows/containers.yml`、`docs/OPENWRT-PREFLIGHT.md`、`deploy/Dockerfile` | CI 配置 amd64/arm64 原生 runner 各自构建测试；尚无本次两架构运行收据，也未证明发布的多架构 manifest 存在。 |
| NFR-002 | 已实现，待验收 | `deploy/compose.yml`、`deploy/Dockerfile`、`docs/OPENWRT-PREFLIGHT.md` | 以 Docker 为宿主接口；仍须目标 OpenWrt Docker 主机验证。 |
| NFR-003 | 部分 | `docs/OPENWRT-PREFLIGHT.md`、`deploy/compose.yml` | 已列资源及部署条件；4 核 ARM64、4 GiB、SSD 基准机未实测，设备不足时尚须重算。 |
| NFR-004 | 部分 | `src/control/maintenance.ts`、`deploy/compose.yml` | 可测 RSS、容器设置 1 GiB 上限；没有本次基准机空闲和双任务峰值报告，不能视为达到目标。 |
| NFR-005 | 部分 | `src/control/server.ts`、`src/control/service.ts`；`tests/control-budgets.test.ts` | 有并发及队列配置验证；需核对默认值、硬限以及所有创建入口，并证明 P0 未启用 subagent。 |
| NFR-006 | 已实现，待验收 | `deploy/Dockerfile`、`.github/workflows/containers.yml` | 生产镜像构建未安装浏览器，浏览器只在 CI 测试 job 安装；须检查实际发布镜像依赖。 |
| NFR-007 | 部分 | `deploy/smoke.mjs`、`tests/recovery.test.ts`、`tests/control-crash.test.ts` | 存在重启与恢复测试；基准机、数据基线下 60 秒内就绪及重复事件验收无本次记录。 |
| NFR-008 | 部分 | `src/control/service.ts`、`src/connectors/actions.ts`；`tests/recovery.test.ts`、`tests/control-crash.test.ts` | 中断与不确定状态有处理；网络断开和模型超时的全部入口恢复策略需故障注入验收。 |
| NFR-009 | 部分 | `scripts/control-soak.ts`、`.github/workflows/containers.yml` | CI 仅运行 15 秒合成 smoke；没有 72 小时指标与无无限积压证明。 |
| NFR-010 | 部分 | `src/control/service.ts`、`src/channels`、`src/connectors`；`tests/channel-adapters.test.ts` | 有超时和部分限流/错误处理；未找到完整的跨工具、MCP、通道断路器策略及隔离验收。 |
| NFR-011 | 部分 | `tests/control-operations.test.ts`、`deploy/smoke.mjs`、`.github/workflows/containers.yml` | 有两库恢复测试及容器 smoke；未证实每次 release 都运行空环境全流程恢复。 |
| NFR-012 | 部分 | `src/control/policy.ts`、`src/control/security.ts`、`deploy/compose.yml`；`tests/control-boundary.test.ts` | 有默认拒绝、认证、容器限制和不可信输入测试；需覆盖所有入口、秘密路径及实际部署。 |
| NFR-013 | 部分 | `deploy/compose.yml`、`src/control/server.ts`；`tests/control-security-extended.test.ts` | 默认宿主绑定 loopback，认证由应用执行；非 loopback 实际代理、来源限制及公网暴露情况未验收。 |
| NFR-014 | 已实现，待验收 | `src/control/operations.ts`、`src/control/maintenance.ts`；`tests/control-operations.test.ts`、`tests/control-maintenance.test.ts` | 普通备份排除 secrets 和主密钥，配置导出白名单；自由文本及用户自填秘密仍需泄露注入测试。 |
| NFR-015 | 部分 | `src/control/artifacts.ts`、`src/control/server.ts`；`tests/control-artifacts.test.ts` | 有受管工件与认证接口；须逐项验证类型、配额、规范化名称、固定位置及下载鉴权，包括迁移上传。 |
| NFR-016 | 已实现，待验收 | `.github/workflows/containers.yml` 的 native 与 secrets jobs | CI 配置 npm audit、Trivy 高危扫描，以及 `gitleaks:v8.24.3` Secret 扫描；本次未运行 CI，也未核实高危项的实际处理或书面风险接受记录。 |
| NFR-017 | 部分 | `apps/web/src`、`src/control/server.ts`；`tests/browser/v11-flows.spec.ts` | 有设置、迁移和连接界面；首次空卷配置所有主要功能仍需 AT-001 验证。 |
| NFR-018 | 部分 | `docs/openapi.json`、`docs/OPERATIONS.md`、`docs/MIGRATION-COMPATIBILITY.md` | 有 API、运维及迁移文档；尚未逐路由确认 OpenAPI 覆盖，升级回滚与故障排查是否覆盖所有功能。 |
| NFR-019 | 部分 | `src/control/main.ts`、`src/control/maintenance.ts`、`src/control/store.ts` | 有事件、任务及审计记录；未证实日志可完整关联 IM event → Task → Pi run → Tool → Delivery。 |
| NFR-020 | 部分 | `tests/browser/v11.spec.ts`、`tests/browser/v11-flows.spec.ts`、`apps/web/src` | 有浏览器测试；本次未运行 390px 全核心操作与桌面布局验收。 |
| NFR-021 | 已实现，待验收 | `src/migrations/source.ts`、`src/migrations/index.ts`；`tests/migrations-source.test.ts` | 有配额、路径、链接、ZIP 检查和哈希；须运行恶意包 MT-005 并确认部署环境不执行来源脚本。 |
| NFR-022 | 部分 | `src/migrations/importers.ts`、`src/migrations/core.ts`；`tests/migrations-importers.test.ts` | 有警告、计数和未映射报告；尚不能证明所有重要字段均有字段级兼容性报告。 |
| NFR-023 | 部分 | `src/control/store.ts`、`src/connectors/oauth.ts`；`tests/connectors-oauth.test.ts` | secrets 使用 AES-256-GCM，普通备份排除秘密和密钥；独立主密钥托管及轮换的完整运行方案尚需验证。 |
| NFR-024 | 已实现，待验收 | `src/control/apps.ts`、`src/connectors/actions.ts`；`tests/control-apps-http.test.ts` | 意图摘要脱敏、正文在加密 secrets 中并按配置清理，默认终态零天；需验证所有审计/日志及真实发送路径不泄露正文。 |

优先核对可修复缺口：OPS-002 的 `imLatencyMs` 固定为空；MIG-009 草案缺部分运行元数据。MIG-002 的旧 JSONL 未支持属于已披露的版本限制，不因规范要求全部历史版本而单独判定为 P0 缺口；已声明版本仍需真实备份验收。NFR-016 的 Secret 扫描已在 CI 配置。接口型缺口 MIG-001、CONN-001 和 NFR-010 的完整断路器策略需要先确定最小契约及针对性验证。其余标记为部分的项目应先按表中具体条件核对，不能仅按状态推断全部代码缺失。
