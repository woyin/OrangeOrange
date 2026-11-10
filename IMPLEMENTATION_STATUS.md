# SRS 实施追踪

以 docs/SRS.md v1.0 为基线。旧 CLI 功能仅作为可复用基础，不等于新 SRS 已验收。P1/P2 在 M4 通过前不新增开发。

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
