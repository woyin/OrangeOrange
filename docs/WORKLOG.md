# 实施日志

## M0 底座探针通过

需求基线：docs/SRS.md v1.0。已建立全量需求ID追踪、模块契约及架构，保留旧CLI兼容。不在M4完成前新增P1/P2能力。

本轮Node基线命令：`npm run typecheck && npm test && npm run build`。结果：15文件49测试通过，含模型/工具调用、持久会话、SIGKILL、去重、取消、外部发送未知、单实例锁。它们是底座证据，不替代新Web控制面或真实OpenWrt验收。

上游固定Pi Durable/Pi AI/Chord/Pi Schema 1.5.0；已核对发布包英文README、发布说明、类型与实现。容器探针命令与结论由ADR0001记录。

环境：macOS ARM64；Colima Docker server Linux aarch64，2CPU，2054832128字节RAM。Docker CLI的compose/buildx子命令缺失，但独立docker-compose 5.7.0可用。目标设备未提供，暂按SRS 4核ARM64/4GiB/SSD假设，不宣称已达性能基准。

已确认风险：普通actor后台进程可能随activation结束；M0镜像构建改持久任务，不能只根据提交成功声称镜像可用。初始Dockerfile缺失强制prompts目录已由部署负责人修复，待重新构建和运行。

## 并行工作约定

使用fabric-swarm，所有子代理明确绑定gpt-6.1-sol low；没有使用DS 4.1 flash。run为hda-v1-n10，topic为team.hda-v1-n10。M0完成前其余业务任务blocked；所有任务CAS领取并检查依赖，按docs/CONTROL-CONTRACT.md文件所有权写入。

M0 -> foundation/adapter/web -> service -> acceptance。Main负责需求状态、总集成、文档和发布门禁。发布脚本scripts/check-release.mjs默认要求全部AT、真实OpenWrt、双架构、真实模型/Telegram和72小时证据；当前明确不可发布。

## M0 结果补记

正常网络构建成功，hda:m0-probe镜像211454d50254；npm ci 172包、0已知漏洞。非root、只读根、tmpfs、移除capabilities、no-new-privileges、1GiB/2CPU容器中4个测试文件14项通过。M0 CAS完成并解锁foundation/adapter/web。第一次构建因npm registry EIDLETIMEOUT失败；隔离备用cache准备已停止清理，未将offline探针记作成功。

API/任务编排依赖基础模块完成，验收依赖API和Web完成。M0探针不代表M4或性能目标通过。

## 本轮恢复执行：出站授权与维护接入

已复现并修复Telegram旧outbox在allowlist移除后仍发送的问题。发送前重读channel.enabled与allowedUsers；已撤销收件人标记FAILED/RECIPIENT_NOT_ALLOWED，保留审计，不调用平台也不自动重试。该检查适用于当前私聊连接器。

ControlService定时清理现已调用MaintenanceService.retention，保护活动/待批/不确定副作用任务，失效Memory移除FTS，保留入站去重键。任务历史已清理后的重复入站返回410 TASK_HISTORY_EXPIRED，不新建任务。settings.retentionDays限1–3650整数。

新增Owner认证接口GET /api/v1/system/metrics、/system/diagnostics、/config/export，system/logs返回固定安全日志投影。公开导出不包含自由文本提示词、个人Memory、消息或密钥；不是完整配置迁移包。

本轮复现证据：新增control-outbound-authorization测试先失败（撤权123仍发出），修复后通过。control-maintenance-http真实HTTP测试验证未登录401、私密marker不进入维护输出、真实RSS和清理后幂等墓碑。类型检查与相关19项测试通过，另新增HTTP测试1项通过。最终完整回归见下一条记录。

仍未完成：service旧snapshot/restore尚未替换为OperationsService；活动任务备份、运行中pause/resume、真实设备/模型/Telegram与72h验收不因此通过。不得将模块测试替代HTTP备份凭据清除验收。

本轮最终完整门禁：`npm run typecheck && npm test && npm run build:all && npm run test:web-console`通过。25个测试文件、107项测试，另3项前端SSE测试通过；服务端与Web生产构建通过。OpenAPI JSON语法与新增维护路由存在性检查通过，该检查不是完整OpenAPI schema验证。`release:check`仍失败：24项AT未登记及真实双架构/OpenWrt/模型/Telegram/72h证据缺失。最终结果不得表述为全部P0交付。

## 测试补全与根因修复

新增可运行的安全/执行集成、真实进程SIGKILL、HTTP备份恢复和桌面/手机浏览器套件。`npm run test:all`于本轮通过：30个Vitest文件、135项测试、3项前端SSE测试、HTTP客户端契约、4项Playwright（1280/390 px），类型与生产构建通过。补全测试映射见TESTING.md及acceptance-results.json；这些是本地证据，不是默认真实外部验收。

测试复现并修复：运行暂停409（现持久PAUSED、模型/工具边界等待、跨重开保留submission）；Memory gateway raw receipt丢失（现归一ToolResult.output且生产不注入旧Pi记忆快照）；注入MutableModels不能首次配置（保留可变目录）；重试与host interrupted恢复耦合（Pi保留崩溃恢复策略，普通供应商错误由控制面固定错误码/有界退避接管）；关闭部分失败（保持维护且Adapter.close幂等）。没有在预算耗尽时盲目重试，写后供应商错误也不重放副作用。

HTTP现已实际接入OperationsService，含活动模型/等待审批备份、两库SQLite快照、凭据/session旧页清理、sha256/schema校验、独立空目录恢复、启动journal先取得外层独占锁，以及恢复后撤销旧cookie。备份屏障同时阻止设置和登录写入；失败保留维护。测试不直接修改Pi私有表。

浏览器发现并修复工具name/id不匹配、刷新清空表单、技能hash撑宽移动布局。移除多余globalSetup，所有浏览器fixture按测试清理。

新增test:all统一入口、test:soak与CI短跑/产物保留。15秒soak实测14任务全部完成、2次模拟确认丢失全部进入不确定状态，报告full72Hours=false。72小时未实跑。

容器构建遇到npm ci长时间无进展，补用镜像内Node头文件和有限网络重试；probe必须携带OpenAPI以运行匿名接口矩阵，已补COPY。AMD64 Node探针通过，但本地legacy builder在跨架构COPY阶段失败。ARM64最终构建/smoke证据随后补记，不把旧镜像结果当作当前源码验收。没有修改用户Docker凭据配置，公开镜像探针使用独立临时匿名配置。

ARM64最终容器证据：生产镜像sha256:e77e1a9a7528bf51615e2396ded64822866dbcaf07193d4a98d287687d0680be构建成功；deploy/smoke.mjs验证全新容器/空卷恢复、Owner登录、会话/Memory、旧session撤销、初始化后重启持久性及非root/read-only/cap-drop。随后原生Linux ARM64 probe在1GiB/2CPU受限容器内30文件135测试通过（26.11s）。测试脚本先复现Docker随机端口重启后改变，修正为重读inspect；全新卷fixture使用node身份写入，未增加capabilities。AMD64仅基础Node探针通过，legacy构建器跨架构失败；真实OpenWrt、外部模型/Telegram、完整72小时仍未验收。
