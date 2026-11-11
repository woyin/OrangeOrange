# SRS 实施追踪

以 `docs/Home_Durable_Agent_v1.1/SRS.md` 为当前需求基线。下方早期 v1.0 表格和测试数字保留为历史记录，不能用其“未开始”或“部分完成”标签判断当前版本。

## 当前核验结果

- 已提交开发基线：`37e7720`。提交前完整 `npm run test:all` 通过：49 个后端文件、288 项测试；14 项桌面/手机浏览器测试；3 项前端事件测试；HTTP 客户端契约、类型检查及前后端构建通过。
- 提交后补查 SYS-005：原 readiness 仅查内存标志，注入数据库不可用时仍返回 200。现已增加数据库 `SELECT 1`、调度器已启动和服务未停机检查，失败返回 503；liveness 仍返回 200。`tests/control-health.test.ts` 与 `tests/control-api.test.ts` 合计 14 项及类型检查通过。此后改动尚未运行完整门禁，也未提交。
- 离线管理员密码恢复：`src/control/admin-recovery.ts`、`docs/ADMIN-RECOVERY.md`；4 项真实子进程测试通过。需要停服务、独占锁、原主密钥与受限密码文件；恢复撤销所有会话。
- ARM64 镜像与恢复、47 文件 283 项容器测试是较早版本证据，不覆盖后续记忆策略与密码恢复改动。
- 208 条需求和 42 项验收的逐项 v1.1 映射尚未完成。不得据完整测试通过声称所有 P0 已交付。
- 真实 Gmail、真实模型/Telegram、真实 OpenClaw/Hermes 备份、OpenWrt、AMD64 最新应用镜像及 72 小时稳定性仍缺验收证据。M6/M7 的 Browser Worker、Bot Profiles、Routines 与多 Agent Supervisor 为明确未交付的后续工作。

## 历史追踪（待逐项替换）


## 当前阶段

本轮测试补全：本地完整门禁通过，30文件135项测试、3项前端事件、HTTP客户端契约和4项桌面/手机浏览器测试。原生Linux ARM64受限容器内同样135项通过，生产镜像全新容器恢复通过。真实模型/Telegram、OpenWrt、AMD64最终应用镜像及72h仍未验收。详见docs/TESTING.md和docs/acceptance-results.json。以下早期M0结果保留为历史证据。

M0：Linux ARM64底座验证通过（14项容器探针；非root/只读根/移除capabilities/限额）。宿主Node本轮49项测试通过。M1–M3开发进行中；M4真实OpenWrt/AMD64/72h与真实模型/Telegram未验收。设备默认4核ARM64/4GiB/SSD；实际开发Docker VM仅2核、约2GiB。详见ADR0001与WORKLOG。

| 需求 ID | 优先级 | 状态 | 实现与验证证据 |
|---|---|---|---|
| G-01 | 目标/场景 | 未开始 | SRS 基线已登记；待实现与本轮验证 |
| G-02 | 目标/场景 | 未开始 | SRS 基线已登记；待实现与本轮验证 |
| G-03 | 目标/场景 | 未开始 | SRS 基线已登记；待实现与本轮验证 |
| G-04 | 目标/场景 | 未开始 | SRS 基线已登记；待实现与本轮验证 |
| G-05 | 目标/场景 | 未开始 | SRS 基线已登记；待实现与本轮验证 |
| G-06 | 目标/场景 | 未开始 | SRS 基线已登记；待实现与本轮验证 |
| US-01 | 目标/场景 | 未开始 | SRS 基线已登记；待实现与本轮验证 |
| US-02 | 目标/场景 | 未开始 | SRS 基线已登记；待实现与本轮验证 |
| US-03 | 目标/场景 | 未开始 | SRS 基线已登记；待实现与本轮验证 |
| US-04 | 目标/场景 | 未开始 | SRS 基线已登记；待实现与本轮验证 |
| US-05 | 目标/场景 | 未开始 | SRS 基线已登记；待实现与本轮验证 |
| US-06 | 目标/场景 | 未开始 | SRS 基线已登记；待实现与本轮验证 |
| US-07 | 目标/场景 | 未开始 | SRS 基线已登记；待实现与本轮验证 |
| SYS-001 | P0 | 部分完成 | deploy/Dockerfile、deploy/compose.yml；独立Compose config通过，生产Web启动待集成 |
| SYS-002 | P0 | 部分完成 | src/control/security.ts/store.ts与Web设置页已实现；鉴权/初始化模块测试通过，完整容器验收待执行 |
| SYS-003 | P0 | 部分完成 | store.ts schema版本检查/迁移回滚/query_only维护测试通过；服务维护模式集成仍需验证 |
| SYS-004 | P0 | 部分完成 | 本轮Node 49测试与Linux ARM64 14底座探针通过；应用两库对账待实现 |
| SYS-005 | P0 | 未开始 | SRS 基线已登记；待实现与本轮验证 |
| SYS-006 | P0 | 部分完成 | 认证config/export与system/diagnostics已接HTTP，脱敏与未登录拒绝集成测试通过；Web下载及整体部署待验收 |
| SYS-007 | P1 | 未开始 | SRS 基线已登记；待实现与本轮验证 |
| GW-001 | P0 | 未开始 | SRS 基线已登记；待实现与本轮验证 |
| GW-002 | P0 | 未开始 | SRS 基线已登记；待实现与本轮验证 |
| GW-003 | P0 | 未开始 | SRS 基线已登记；待实现与本轮验证 |
| GW-004 | P0 | 部分完成 | store inbox/outbox唯一约束与旧Gateway去重通过；新API入站测试执行中 |
| GW-005 | P0 | 未开始 | SRS 基线已登记；待实现与本轮验证 |
| GW-006 | P0 | 部分完成 | 出站重查allowlist防撤权后旧队列发送，回归先复现再修复通过；真实平台收发未验收 |
| GW-007 | P0 | 未开始 | SRS 基线已登记；待实现与本轮验证 |
| GW-008 | P0 | 未开始 | SRS 基线已登记；待实现与本轮验证 |
| GW-009 | P1 | 未开始 | SRS 基线已登记；待实现与本轮验证 |
| GW-010 | P1 | 未开始 | SRS 基线已登记；待实现与本轮验证 |
| CHAT-001 | P0 | 未开始 | SRS 基线已登记；待实现与本轮验证 |
| CHAT-002 | P0 | 未开始 | SRS 基线已登记；待实现与本轮验证 |
| CHAT-003 | P0 | 未开始 | SRS 基线已登记；待实现与本轮验证 |
| CHAT-004 | P0 | 未开始 | SRS 基线已登记；待实现与本轮验证 |
| CHAT-005 | P0 | 未开始 | SRS 基线已登记；待实现与本轮验证 |
| CHAT-006 | P1 | 未开始 | SRS 基线已登记；待实现与本轮验证 |
| CHAT-007 | P2 | 未开始 | SRS 基线已登记；待实现与本轮验证 |
| TASK-001 | P0 | 未开始 | SRS 基线已登记；待实现与本轮验证 |
| TASK-002 | P0 | 部分完成 | Control子进程SIGKILL模型inflight恢复原task/piSubmissionId且history仅1输入；跨库缺引用对账通过 |
| TASK-003 | P0 | 未开始 | SRS 基线已登记；待实现与本轮验证 |
| TASK-004 | P0 | 部分完成 | 既有只读工具与发送unknown测试通过；统一ToolDescriptor待实现 |
| TASK-005 | P0 | 部分完成 | 真实进程executor副作用后确认前SIGKILL，重开UNCERTAIN且不重放；新crash回归通过 |
| TASK-006 | P0 | 部分完成 | service.ts持久PAUSED与模型/工具屏障，真实运行暂停/跨重开resume保持submission、取消不新步骤测试通过 |
| TASK-007 | P0 | 未开始 | SRS 基线已登记；待实现与本轮验证 |
| TASK-008 | P0 | 未开始 | SRS 基线已登记；待实现与本轮验证 |
| TASK-009 | P0 | 未开始 | SRS 基线已登记；待实现与本轮验证 |
| TASK-010 | P1 | 未开始 | SRS 基线已登记；待实现与本轮验证 |
| TASK-011 | P1 | 未开始 | SRS 基线已登记；待实现与本轮验证 |
| TASK-012 | P1 | 未开始 | SRS 基线已登记；待实现与本轮验证 |
| AUTO-001 | P0 | 未开始 | SRS 基线已登记；待实现与本轮验证 |
| AUTO-002 | P0 | 未开始 | SRS 基线已登记；待实现与本轮验证 |
| AUTO-003 | P0 | 未开始 | SRS 基线已登记；待实现与本轮验证 |
| AUTO-004 | P0 | 未开始 | SRS 基线已登记；待实现与本轮验证 |
| AUTO-005 | P0 | 未开始 | SRS 基线已登记；待实现与本轮验证 |
| AUTO-006 | P0 | 未开始 | SRS 基线已登记；待实现与本轮验证 |
| AUTO-007 | P1 | 未开始 | SRS 基线已登记；待实现与本轮验证 |
| AUTO-008 | P1 | 未开始 | SRS 基线已登记；待实现与本轮验证 |
| AUTO-009 | P1 | 未开始 | SRS 基线已登记；待实现与本轮验证 |
| AUTO-010 | P2 | 未开始 | SRS 基线已登记；待实现与本轮验证 |
| MEM-001 | P0 | 部分完成 | 应用memories schema/FTS/修订已实现，控制API联调中 |
| MEM-002 | P0 | 部分完成 | 真实工具结果进入模型context、Owner/Telegram隔离、删除后新上下文不召回；浏览器编辑/禁用/删除通过；类别禁记策略仍需验收 |
| MEM-003 | P0 | 未开始 | SRS 基线已登记；待实现与本轮验证 |
| MEM-004 | P0 | 部分完成 | store FTS检索支持中文短词与字面特殊字符；大数据性能未测 |
| MEM-005 | P0 | 部分完成 | 受控before/after修订与软删除基础测试通过；Web联调中 |
| MEM-006 | P0 | 部分完成 | 失效记忆排除/过期索引清理单测通过 |
| MEM-007 | P1 | 未开始 | SRS 基线已登记；待实现与本轮验证 |
| MEM-008 | P1 | 未开始 | SRS 基线已登记；待实现与本轮验证 |
| MEM-009 | P1 | 未开始 | SRS 基线已登记；待实现与本轮验证 |
| MEM-010 | P2 | 未开始 | SRS 基线已登记；待实现与本轮验证 |
| MODEL-001 | P0 | 未开始 | SRS 基线已登记；待实现与本轮验证 |
| MODEL-002 | P0 | 部分完成 | 429/503/timeout控制面最多两次重试，与Pi host interrupted恢复解耦；写后不切换重放测试通过，真实外部主备未联调 |
| MODEL-003 | P0 | 未开始 | SRS 基线已登记；待实现与本轮验证 |
| MODEL-004 | P0 | 未开始 | SRS 基线已登记；待实现与本轮验证 |
| MODEL-005 | P0 | 部分完成 | AES-GCM密钥/metadata基础测试通过；HTTP秘密过滤验收待补 |
| MODEL-006 | P1 | 未开始 | SRS 基线已登记；待实现与本轮验证 |
| MODEL-007 | P1 | 未开始 | SRS 基线已登记；待实现与本轮验证 |
| MODEL-008 | P2 | 未开始 | SRS 基线已登记；待实现与本轮验证 |
| EXT-001 | P0 | 部分完成 | ToolDescriptor及Policy注册校验已实现，适配输出整合中 |
| EXT-002 | P0 | 部分完成 | runtime toolGateway全工具包裹与拒绝不执行单测通过；生产工具映射待验收 |
| EXT-003 | P0 | 未开始 | SRS 基线已登记；待实现与本轮验证 |
| EXT-004 | P0 | 未开始 | SRS 基线已登记；待实现与本轮验证 |
| EXT-005 | P0 | 未开始 | SRS 基线已登记；待实现与本轮验证 |
| EXT-006 | P1 | 未开始 | SRS 基线已登记；待实现与本轮验证 |
| EXT-007 | P1 | 未开始 | SRS 基线已登记；待实现与本轮验证 |
| EXT-008 | P1 | 未开始 | SRS 基线已登记；待实现与本轮验证 |
| EXT-009 | P1 | 未开始 | SRS 基线已登记；待实现与本轮验证 |
| EXT-010 | P2 | 未开始 | SRS 基线已登记；待实现与本轮验证 |
| SEC-001 | P0 | 部分完成 | OpenAPI全保护路径/SSE匿名矩阵、CSRF/Origin、cookie持久与恢复撤销验证；桌面/手机登录测试通过 |
| SEC-002 | P0 | 未开始 | SRS 基线已登记；待实现与本轮验证 |
| SEC-003 | P0 | 未开始 | SRS 基线已登记；待实现与本轮验证 |
| SEC-004 | P0 | 部分完成 | policy未知主体/未知工具/高危默认拒绝测试通过；统一任务集成中 |
| SEC-005 | P0 | 部分完成 | 审批规范参数hash/单次消费/过期测试通过；UI篡改验收待补 |
| SEC-006 | P0 | 部分完成 | 应用库审批状态持久化测试通过；重启等待审批任务集成待验收 |
| SEC-007 | P0 | 部分完成 | 真实read_file越界诱导仍拒绝、关闭工具后新调用被Policy拒绝；确定性边界测试通过，不表示任意模型均不受注入影响 |
| SEC-008 | P0 | 部分完成 | M0非root/只读根/cap-drop/no-new-privileges容器运行14测试；生产权限审查待进行 |
| SEC-009 | P0 | 部分完成 | 既有web地址固定/重定向/私有地址测试于本轮49测试通过；新控制面审计待验证 |
| SEC-010 | P0 | 部分完成 | 事件/审计摘要和密钥加密测试通过；日志/诊断扫描待执行 |
| SEC-011 | P0 | 未开始 | SRS 基线已登记；待实现与本轮验证 |
| SEC-012 | P0 | 部分完成 | audit append-only触发器与单调序号测试通过；轮转备份待集成 |
| SEC-013 | P1 | 未开始 | SRS 基线已登记；待实现与本轮验证 |
| WEB-001 | P0 | 部分完成 | Vue设置/登录表单与实际HTTP客户端测试通过；浏览器验收待执行 |
| WEB-002 | P0 | 未开始 | SRS 基线已登记；待实现与本轮验证 |
| WEB-003 | P0 | 未开始 | SRS 基线已登记；待实现与本轮验证 |
| WEB-004 | P0 | 未开始 | SRS 基线已登记；待实现与本轮验证 |
| WEB-005 | P0 | 未开始 | SRS 基线已登记；待实现与本轮验证 |
| WEB-006 | P0 | 未开始 | SRS 基线已登记；待实现与本轮验证 |
| WEB-007 | P0 | 未开始 | SRS 基线已登记；待实现与本轮验证 |
| WEB-008 | P0 | 未开始 | SRS 基线已登记；待实现与本轮验证 |
| WEB-009 | P0 | 部分完成 | 实际浏览器工具/技能启停与取消确认通过，固定name标识，内容版本hash在390px正确换行 |
| WEB-010 | P0 | 未开始 | SRS 基线已登记；待实现与本轮验证 |
| WEB-011 | P0 | 未开始 | SRS 基线已登记；待实现与本轮验证 |
| WEB-012 | P0 | 未开始 | SRS 基线已登记；待实现与本轮验证 |
| WEB-013 | P0 | 部分完成 | SSE前端3测试通过，真实HTTP事件与断线补偿待浏览器验收 |
| WEB-014 | P0 | 部分完成 | 真实浏览器11页面/390px无横向溢出，错误/危险确认、稳定表单输入覆盖；完整无障碍审计未执行 |
| WEB-015 | P1 | 未开始 | SRS 基线已登记；待实现与本轮验证 |
| WEB-016 | P2 | 未开始 | SRS 基线已登记；待实现与本轮验证 |
| OPS-001 | P0 | 未开始 | SRS 基线已登记；待实现与本轮验证 |
| OPS-002 | P0 | 部分完成 | system/metrics返回真实RSS/CPU/磁盘/队列/失败指标；HTTP验证RSS与脱敏，IM延迟无来源返回null |
| OPS-003 | P0 | 部分完成 | HTTP已接Operations，模型inflight/待批活动备份与独立空环境两库恢复测试通过；目标容器最终验证另记 |
| OPS-004 | P0 | 部分完成 | HTTP完整hash/schema/journal/rollback集成，恢复后cookie失效；部分关闭保持维护，8项HTTP回归与模块故障回归通过 |
| OPS-005 | P0 | 部分完成 | 定时worker已接安全retention，保护活动/待批/uncertain，Memory失效与入站墓碑HTTP测试通过；附件/Pi transcript物理清理仍缺 |
| OPS-006 | P0 | 未开始 | SRS 基线已登记；待实现与本轮验证 |
| OPS-007 | P1 | 未开始 | SRS 基线已登记；待实现与本轮验证 |
| OPS-008 | P1 | 未开始 | SRS 基线已登记；待实现与本轮验证 |
| NFR-001 | P0 | 部分完成 | Linux ARM64镜像与14底座测试通过；AMD64/生产E2E未验证 |
| NFR-002 | P0 | 部分完成 | 容器内Node底座已运行，无OpenWrt命令依赖；真实设备未提供 |
| NFR-003 | P0 | 未开始 | SRS 基线已登记；待实现与本轮验证 |
| NFR-004 | P0 | 未开始 | SRS 基线已登记；待实现与本轮验证 |
| NFR-005 | P0 | 未开始 | SRS 基线已登记；待实现与本轮验证 |
| NFR-006 | P0 | 部分完成 | M0无浏览器，最终生产prune与镜像审查待进行 |
| NFR-007 | P0 | 未开始 | SRS 基线已登记；待实现与本轮验证 |
| NFR-008 | P0 | 部分完成 | 底座崩溃恢复/模型重试/发送未知测试通过；新业务任务需新增故障测试 |
| NFR-009 | P0 | 未开始 | SRS 基线已登记；待实现与本轮验证 |
| NFR-010 | P0 | 未开始 | SRS 基线已登记；待实现与本轮验证 |
| NFR-011 | P0 | 未开始 | SRS 基线已登记；待实现与本轮验证 |
| NFR-012 | P0 | 未开始 | SRS 基线已登记；待实现与本轮验证 |
| NFR-013 | P0 | 未开始 | SRS 基线已登记；待实现与本轮验证 |
| NFR-014 | P0 | 未开始 | SRS 基线已登记；待实现与本轮验证 |
| NFR-015 | P0 | 未开始 | SRS 基线已登记；待实现与本轮验证 |
| NFR-016 | P0 | 未开始 | SRS 基线已登记；待实现与本轮验证 |
| NFR-017 | P0 | 未开始 | SRS 基线已登记；待实现与本轮验证 |
| NFR-018 | P0 | 未开始 | SRS 基线已登记；待实现与本轮验证 |
| NFR-019 | P0 | 未开始 | SRS 基线已登记；待实现与本轮验证 |
| NFR-020 | P0 | 未开始 | SRS 基线已登记；待实现与本轮验证 |
| AT-001 | P0门禁 | 部分完成 | 本地状态PARTIAL；tests/browser/console.spec.ts；实际环境限制见acceptance-results.json与TESTING.md |
| AT-002 | P0门禁 | 部分完成 | Linux ARM64生产容器非root/read-only/cap-drop/no-new-privileges/命名卷/localhost smoke通过；见acceptance-results.json |
| AT-003 | P0门禁 | 阻塞 | 本地状态BLOCKED；tests/control-api.test.ts；实际环境限制见acceptance-results.json与TESTING.md |
| AT-004 | P0门禁 | 部分完成 | 本地状态PASS；tests/control-api.test.ts；实际环境限制见acceptance-results.json与TESTING.md |
| AT-005 | P0门禁 | 部分完成 | 本地状态PASS；tests/control-api.test.ts、tests/gateway.test.ts；实际环境限制见acceptance-results.json与TESTING.md |
| AT-006 | P0门禁 | 部分完成 | 本地状态PARTIAL；tests/control-crash.test.ts；实际环境限制见acceptance-results.json与TESTING.md |
| AT-007 | P0门禁 | 部分完成 | 本地状态PASS；tests/control-crash.test.ts、tests/control-policy.test.ts；实际环境限制见acceptance-results.json与TESTING.md |
| AT-008 | P0门禁 | 部分完成 | 本地状态PASS；tests/control-crash.test.ts、tests/control-api.test.ts；实际环境限制见acceptance-results.json与TESTING.md |
| AT-009 | P0门禁 | 部分完成 | 本地状态PARTIAL；tests/schedules.test.ts、tests/control-api.test.ts；实际环境限制见acceptance-results.json与TESTING.md |
| AT-010 | P0门禁 | 部分完成 | 本地状态PASS；tests/control-api.test.ts；实际环境限制见acceptance-results.json与TESTING.md |
| AT-011 | P0门禁 | 部分完成 | 本地状态PASS；tests/control-runtime-extended.test.ts；实际环境限制见acceptance-results.json与TESTING.md |
| AT-012 | P0门禁 | 部分完成 | 本地状态PASS；tests/control-runtime-extended.test.ts；实际环境限制见acceptance-results.json与TESTING.md |
| AT-013 | P0门禁 | 部分完成 | 本地状态PASS；tests/control-runtime-extended.test.ts、tests/control-store-fixes.test.ts；实际环境限制见acceptance-results.json与TESTING.md |
| AT-014 | P0门禁 | 部分完成 | 本地状态PASS；tests/control-policy.test.ts、tests/control-runtime-extended.test.ts；实际环境限制见acceptance-results.json与TESTING.md |
| AT-015 | P0门禁 | 部分完成 | 本地状态PASS；tests/control-boundary.test.ts、tests/workspace.test.ts；实际环境限制见acceptance-results.json与TESTING.md |
| AT-016 | P0门禁 | 部分完成 | 本地状态PASS；tests/web.test.ts、tests/web-http.test.ts；实际环境限制见acceptance-results.json与TESTING.md |
| AT-017 | P0门禁 | 部分完成 | 本地状态PASS；tests/control-security-extended.test.ts；实际环境限制见acceptance-results.json与TESTING.md |
| AT-018 | P0门禁 | 部分完成 | 本地状态PASS；tests/control-api.test.ts、apps/web/src/events.check.ts；实际环境限制见acceptance-results.json与TESTING.md |
| AT-019 | P0门禁 | 部分完成 | 生产ARM64镜像在全新容器及空卷恢复通过，登录/会话/Memory完整；活动任务HTTP备份、独立目录恢复与8项故障边界回归通过 |
| AT-020 | P0门禁 | 部分完成 | 本地状态PASS；tests/control-api.test.ts、tests/control-maintenance.test.ts；实际环境限制见acceptance-results.json与TESTING.md |
| AT-021 | P0门禁 | 部分完成 | 本地状态PASS；tests/control-maintenance-http.test.ts、tests/control-runtime-extended.test.ts；实际环境限制见acceptance-results.json与TESTING.md |
| AT-022 | P0门禁 | 部分完成 | 本地状态PASS；tests/browser/console.spec.ts、tests/control-runtime-extended.test.ts；实际环境限制见acceptance-results.json与TESTING.md |
| AT-023 | P0门禁 | 阻塞 | 本地状态BLOCKED；.github/workflows/containers.yml、deploy/smoke.mjs；实际环境限制见acceptance-results.json与TESTING.md |
| AT-024 | P0门禁 | 部分完成 | 本地状态PARTIAL；scripts/control-soak.ts；实际环境限制见acceptance-results.json与TESTING.md |

## v1.1 新增需求基线

权威规格位于docs/Home_Durable_Agent_v1.1，执行与M0新证据见docs/V1.1-GAP-AND-PLAN.md。下列TODO不能视为完成。

| ID | 优先级 | 需求 | 状态 | 代码/证据 |
|---|---|---|---|---|
| WEB-017 | P0 | 迁移中心：来源选择、离线包上传/只读路径、导入预览、映射、冲突与回滚 | TODO | 待填 |
| WEB-018 | P0 | 应用连接中心：账号 OAuth 授权/状态/权限清单、测试、断开、历史记录 | TODO | 待填 |
| WEB-019 | P0 | Gmail 发送审批 UI：发送账号、收件人、主题、正文、附件、规则、送达与不确定状态 | TODO | 待填 |
| WEB-020 | P1 | Computer Use：远端 Worker 配对、实时只读观察、操作时间线、人工接管、暂停/恢复 | TODO | 待填 |
| WEB-021 | P1 | Bot Profiles + Routine 工作看板，查看 Bot 权限、任务、连接器、预算和报警 | TODO | 待填 |
| MIG-001 | P0 | 定义 SourceImporter 插件接口：probe → inventory → validate → plan → stage → apply → verify → rollback，源类型、源版本与格式版本显式声明 | TODO | 待填 |
| MIG-002 | P0 | 支持 OpenClaw 完整备份包、显式选取的状态目录和工作区目录的离线导入 | TODO | 待填 |
| MIG-003 | P0 | 支持 Hermes Agent ~/.hermes/ 导出或只读副本导入；读取 state.db 及可识别配置、记忆、Skills、Cron | TODO | 待填 |
| MIG-004 | P0 | 导入前生成只读预览和逐类统计：配置、身份/指令、Memory、历史会话、Skills、MCP、Cron、附件 | TODO | 待填 |
| MIG-005 | P0 | 使用 MigrationManifest 和 ImportPlan；逐项 source_id/hash/target_id/status/reason、原始时间和来源；执行前必须显式确认 | TODO | 待填 |
| MIG-006 | P0 | 会话作为**历史消息与工具轨迹归档**，允许浏览、搜索；“继续对话”创建新的 Pi Durable 会话，引用源会话及受限历史摘要/选定消息 | TODO | 待填 |
| MIG-007 | P0 | MEMORY.md、USER.md、SOUL.md、Agent/Prompt 文件按类型与作用域映射；内容有来源、信任级别及冲突预览 | TODO | 待填 |
| MIG-008 | P0 | Skills 仅以**停用/待审**状态导入；记录脚本依赖、所需工具、来源哈希；MCP 只导入配置草案 | TODO | 待填 |
| MIG-009 | P0 | Cron/自动化只导入为**禁用草案**，包含时区、运行模式、目标通道、依赖能力和原始表达式；用户审查后才激活 | TODO | 待填 |
| MIG-010 | P0 | 默认**不自动复制** API Key、OAuth access/refresh token、Cookie、IM Bot token、邮箱授权；建立待重新授权清单；提供显式安全迁移扩展点 | TODO | 待填 |
| MIG-011 | P0 | 源目录只读；绝不覆盖/改写来源；从活动 SQLite 导入时使用来源官方备份/SQLite backup API 或静态一致性快照；不得只复制 .db 忽略 WAL | TODO | 待填 |
| MIG-012 | P0 | 按 (source_system, source_instance_id, source_object_id, content_hash) 实现幂等导入；重复导入只更新确有变化项 | TODO | 待填 |
| MIG-013 | P0 | 冲突策略有 保留目标 / 导入为新项 / 手动合并，默认不覆盖本系统有效数据；导入失败保留清晰状态 | TODO | 待填 |
| MIG-014 | P0 | 分阶段 staging → 校验 → 数据库事务提交；跨文件副作用使用补偿式回滚；对激活与重授权采用独立步骤 | TODO | 待填 |
| MIG-015 | P0 | Web 提供“迁移向导、映射预览、冲突处理、验证报告、撤销本批次”的全流程 | TODO | 待填 |
| MIG-016 | P1 | 可选**单向增量只读同步**来源的新会话/记忆，具 source cursor、变更检测、删除冲突提示 | TODO | 待填 |
| MIG-017 | P1 | 生成中立格式的 HDA Export Bundle（含 manifest、JSONL、Markdown、受管资源）供未来再迁移 | TODO | 待填 |
| MIG-018 | P1 | 兼容性矩阵按已测试 OpenClaw/Hermes 版本发布；遇到未知 schema/version 不擅自猜测 | TODO | 待填 |
| CONN-001 | P0 | 统一 AppConnector 契约：manifest/discoverScopes/connect/test/refresh/revoke/listActions/invoke | TODO | 待填 |
| CONN-002 | P0 | 动作元数据声明 inputSchema, outputSchema, read/write/send/delete, risk, requiredScopes, timeout, retryClass, approvalPolicy | TODO | 待填 |
| CONN-003 | P0 | 账号级连接与分层权限：仅 Owner 可以连接，指定 Agent Profile/任务/工作流获最小必要动作能力 | TODO | 待填 |
| CONN-004 | P0 | 支持 OAuth 2.0 Authorization Code + PKCE（适用时），state 校验、redirect URI 白名单、凭据加密存储、撤销 | TODO | 待填 |
| CONN-005 | P0 | 在 LAN/软路由场景下提供可工作的授权方案：可信 HTTPS 域名回调；或单独受控本地授权辅助端（需威胁建模） | TODO | 待填 |
| CONN-006 | P0 | 统一连接状态：DISCONNECTED/AUTH_PENDING/CONNECTED/EXPIRED/NEEDS_REAUTH/ERROR/REVOKED | TODO | 待填 |
| CONN-007 | P0 | 外部动作建立操作意图 ActionIntent：不可变参数快照、请求哈希、审查、执行结果、确认不确定状态 | TODO | 待填 |
| CONN-008 | P0 | 支持动作级限流、每日次数上限、允许的目标/域名/收件人名单、Dry-run 和取消 | TODO | 待填 |
| CONN-009 | P1 | 应用连接器 SDK：模板、测试夹具、权限注册、错误码、文档生成 | TODO | 待填 |
| CONN-010 | P1 | 可接入 Gmail 读取/草稿、Google Calendar、Drive、GitHub 等，但**各自权限独立授权** | TODO | 待填 |
| CONN-011 | P1 | 可将外部 MCP Server 映射为受控 AppConnector，逐工具授权和审计 | TODO | 待填 |
| GML-001 | P0 | Gmail OAuth 用户授权，首发仅申请 https://www.googleapis.com/auth/gmail.send；在 UI 显示该 scope 是 Sensitive | TODO | 待填 |
| GML-002 | P0 | 仅提供 gmail.send_email：to,cc?,bcc?,subject,plainText,html?,attachments?；对收件人/标题/编码/附件大小校验 | TODO | 待填 |
| GML-003 | P0 | 默认“草拟本系统待发送内容 → Web/IM 审批 → 发送”；不得让用户仅说“帮我写封邮件”就直接发送 | TODO | 待填 |
| GML-004 | P0 | 审批界面完整预览收件人、主题、正文、附件、发送账号、可能的敏感信息；批准绑定不可变内容哈希 | TODO | 待填 |
| GML-005 | P0 | 支持显式配置“已预授权自动发送规则”：精确接收人或域名、发送模板、工作流、频率、预算、有效期 | TODO | 待填 |
| GML-006 | P0 | 避免 Gmail HTTP 超时/响应丢失导致二次发送：保存意图和 RFC Message-ID；没有可核验结果时标记 SEND_UNCERTAIN，默认不重试 | TODO | 待填 |
| GML-007 | P0 | Gmail 限流、失效授权、撤销、配额、附件失败给出可操作错误；需要人工重授权时暂停动作 | TODO | 待填 |
| GML-008 | P0 | 管理后台包括账户连接、权限说明、发送历史、审批、规则及撤销入口；允许删除已连接账号 | TODO | 待填 |
| GML-009 | P1 | 可选独立追加 gmail.compose 以管理 Gmail 原生草稿；新增 scope 必须单独征求同意 | TODO | 待填 |
| GML-010 | P1 | 可选 gmail.readonly 读取、线程搜索、摘要；必须提示 Restricted scope 的合规与潜在审核成本 | TODO | 待填 |
| GML-011 | P1 | 邮件触发器：轮询或 Gmail push/watch（需验证 API/基础设施可行性），去重后触发自动化 | TODO | 待填 |
| GML-012 | P1 | 可选择把邮件正文作为 Memory 候选；默认不把完整邮箱内容永久写入 Memory | TODO | 待填 |
| CUA-001 | P0 | 预留 ExecutionBackend 接口：provision/start/observe/act/stop/checkpoint/cleanup，任务/租户授权和能力声明 | TODO | 待填 |
| CUA-002 | P1 | 实装独立 Browser Worker：首选 Playwright 浏览器自动化，可由独立 Docker 容器或远程机器运行 | TODO | 待填 |
| CUA-003 | P1 | Worker 只能经 Gateway 签发的短期、范围受限凭据受理作业；强认证，允许注册/停用/吊销 | TODO | 待填 |
| CUA-004 | P1 | 支持 navigate, snapshot, locate, click, type, select, scroll, upload, download 和截图；操作有超时、步数限制 | TODO | 待填 |
| CUA-005 | P1 | 策略优先 API/MCP，只有可用 API 不满足工作需要时才选浏览器；记录选择理由与失败降级 | TODO | 待填 |
| CUA-006 | P1 | 支持在 Web 查看只读实时画面、DOM/截图记录、动作时间线、停止与人工接管 | TODO | 待填 |
| CUA-007 | P1 | 可保存**非秘密**的浏览器会话标识/运行检查点；登录凭据或 Cookie 持久化需单独加密、授权、时效与隔离策略 | TODO | 待填 |
| CUA-008 | P1 | 登录使用安全交互：用户在受控会话里亲自完成；凭据不经聊天和 LLM 上下文传递 | TODO | 待填 |
| CUA-009 | P1 | **浏览器安全边界**：默认拒绝 localhost、容器元数据、RFC1918/LAN 目标、文件协议与内网 DNS 重绑定；对家庭内网访问另建逐目标授权 Worker | TODO | 待填 |
| CUA-010 | P1 | 对发送、发布、购买、删除、权限更改、下载执行等设高危审批；独立策略引擎在模型外判定 | TODO | 待填 |
| CUA-011 | P1 | 任务结束时返回结构化产物、截图/文件引用、操作轨迹与结果核验，不靠 LLM“我做完了”自述 | TODO | 待填 |
| CUA-012 | P1 | Worker 资源配额：CPU/RAM、浏览器实例、并发会话、总步数、单任务时长；超限可取消和回收 | TODO | 待填 |
| CUA-013 | P1 | 支持用户中途 pause/takeover/resume/cancel；Agent 恢复后必须重新确认页面状态和待执行动作 | TODO | 待填 |
| CUA-014 | P1 | Worker 发生不确定外部副作用时暂停，记录 UNCERTAIN，不盲目重复点击“提交” | TODO | 待填 |
| CUA-015 | P2 | 可选远端完整 Desktop Worker（Linux 图形桌面，或显式授权的 Mac/PC 节点）；与浏览器工具共享审批机制 | TODO | 待填 |
| CUA-016 | P2 | 可选独立凭据库/Vault 和登录会话隔离（逐身份/Worker），支持撤销与轮换 | TODO | 待填 |
| BOT-001 | P1 | 支持可命名的 Bot Profile（身份/目标/模型/Memory 作用域/连接器白名单/工具权限/预算） | TODO | 待填 |
| BOT-002 | P1 | 通过 Web 或 IM 对 Bot 委派持久任务；每个任务有责任人 Bot、交付标准、下一次检查点 | TODO | 待填 |
| BOT-003 | P1 | Bot 任务可由 Cron、Heartbeat、Webhook、应用事件触发，复用现有 Task Core | TODO | 待填 |
| BOT-004 | P1 | 支持从成功任务中生成 Skill/Routine 草稿，包括步骤、权限、触发器和失败策略，用户批准才能启用 | TODO | 待填 |
| BOT-005 | P1 | 跨 Bot 委派使用 Supervisor、父子任务、预算、超时、失败升级和结果验收 | TODO | 待填 |
| BOT-006 | P1 | 通知分级：完成摘要、异常告警、审批请求；支持静默期、去重和会话关联 | TODO | 待填 |
| BOT-007 | P1 | UI 展示 Bot 工作看板：在做什么、等待谁、占用什么工具、连接了哪些账号、花费多少 | TODO | 待填 |
| BOT-008 | P2 | 跨 Agent 工具协作与工作流模板市场（仅经过可信审核） | TODO | 待填 |
| NFR-021 | P0 | 迁移必须支持离线备份包的大小配额、解压炸弹检测、路径规范化、符号链接阻止、压缩文件条目计数和 SHA-256 校验；禁止在应用容器内执行来源脚本。 | TODO | 待填 |
| NFR-022 | P0 | 导入输出包含字段级兼容性报告、未迁移清单、时间戳和数据量；不得静默丢弃重要字段。 | TODO | 待填 |
| NFR-023 | P0 | OAuth 秘密使用 AES-256-GCM 或等价 AEAD 加密，并制定独立于普通数据库备份的主密钥托管与轮换方案；避免与加密数据无保护地同处一份导出。 | TODO | 待填 |
| NFR-024 | P0 | 邮箱外发审计不得无条件持久化正文；默认保存经脱敏的收件人、摘要、邮件哈希和平台 ID，完整正文保留可配置。 | TODO | 待填 |
| NFR-025 | P1 | Browser Worker 与主容器处于可控网络边界，默认不能访问路由器管理 IP、Docker socket、存储卷和元数据端点；通过 e2e 测试证明。 | TODO | 待填 |
| NFR-026 | P1 | Browser Worker 峰值资源、网络出口、运行时间须独立配置和测量；主服务在 Worker 故障时仍可正常聊天、调度及审查。 | TODO | 待填 |
| NFR-027 | P1 | Computer Use 观察流必须认证、短期令牌且可撤销；截图、视频、网页正文作为敏感工件设置保留期和脱敏/删除。 | TODO | 待填 |
| MT-001 | 以完整 OpenClaw 静态备份运行导入预览 | 未执行 | 待填 |
| MT-002 | 导入 Hermes `state.db`、Memory、Skills、Cron 的固定版本夹具 | 未执行 | 待填 |
| MT-003 | 同一备份导入三次，含 1 个变更源对象 | 未执行 | 待填 |
| MT-004 | 导入过程中 SIGKILL，重启后恢复或回滚 | 未执行 | 待填 |
| MT-005 | 含恶意 `../` 文件、压缩炸弹、符号链接和隐藏密钥的导入包 | 未执行 | 待填 |
| MT-006 | 从历史聊天点击“继续”并触发工具调用 | 未执行 | 待填 |
| GM-001 | Gmail 使用 OAuth 授权 `gmail.send` 后执行测试邮件 | 未执行 | 待填 |
| GM-002 | 用户只说“帮我写邮件”，系统生成内容但没有审批 | 未执行 | 待填 |
| GM-003 | 审批后修改 To/Body，再复用原审批 ID | 未执行 | 待填 |
| GM-004 | 发送后阻断 Gmail 响应，再重启服务 | 未执行 | 待填 |
| GM-005 | 断开 Gmail 授权、模拟 refresh 失效、请求超授权 scope | 未执行 | 待填 |
| CU-001 | 在独立 Worker 打开测试页面、填写并导出报表 | 未执行 | 待填 |
| CU-002 | 恶意网页诱导访问 192.168.x.x / 127.0.0.1 / metadata IP | 未执行 | 待填 |
| CU-003 | 网页要求“提交购买”而审批未通过 | 未执行 | 待填 |
| CU-004 | Browser Worker 在“提交”后断联，恢复会话 | 未执行 | 待填 |
| CU-005 | Owner 接管会话、停用 Worker 或断开连接 | 未执行 | 待填 |
| BT-001 | Bot Profile 无 Gmail 权限却尝试代替主 Bot 发邮件 | 未执行 | 待填 |
| BT-002 | 从成功操作生成 Routine 草稿并安排日程 | 未执行 | 待填 |
