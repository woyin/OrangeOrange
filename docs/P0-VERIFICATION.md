# P0 本轮核验记录

本记录区分静态审计、自动化运行和外部验收。当前基线为 v1.1。真实 Google、Telegram、外部模型、完整来源备份、OpenWrt 和 72 小时实验未验收。

## 真实模型与 Telegram 探测（本轮）

使用本机 `.env` 中由 Owner 提供的凭据，对真实服务执行一次闭环。凭据未写入仓库、日志或本记录。

| 检查 | 结果 | 范围 |
|---|---|---|
| 模型地址探测 | 通过，状态 `online` | 请求配置地址的 `/models`，返回 25 个模型 |
| 真实对话 | 通过，`SUCCEEDED`，约 2.0 秒 | 一次真实 `/chat/completions` 调用，返回中文回复；usage 标记 `costUnknown` |
| Telegram | token 有效，`connected` | 仅 `getMe` 探测；未发送消息，入站与投递闭环未验证 |

首次运行失败，原因是 `.env` 中模型名写作 `group/deepseek-v4.1-flash`，服务端返回 404 并说明应为 `group/deepseek-v4-1-flash`。这暴露两个产品问题，已修复：连接测试只验证地址可用、不验证模型存在；运行时把上游错误压成 `CONTROL_MODEL_ERROR`，丢失原因。现在连接测试在 `/models` 列表不含该模型时返回 `model_not_listed`，运行时把上游文本记入任务失败记录与结构化日志（写入前脱敏 `sk-`、Bearer 和 Telegram token 形式）。

本轮还补充结构化日志（`src/control/log.ts`）：tick 异常、提交失败、模型失败均输出 JSON 行并保留原因；此前这些路径只留下 `WORKER_ERROR` 与 `SUBMISSION_FAILED`。测试确认日志不含密钥。

上述证据来自 macOS ARM64 宿主上的容器化服务，不是 OpenWrt 设备，也不是 72 小时运行。Telegram 只验证了凭据有效性。

## 连接测试地址缺陷修复

发现“测试连接”写死请求`https://api.openai.com/v1/models`，未使用配置的`baseUrl`，导致自定义代理的密钥被发往OpenAI官方并误报凭据无效。现按`baseUrl`拼接`/models`；401/403记为凭据无效，404/405记为“地址可达但无模型列表接口”，其他失败记为不可用。新增`tests/provider-test-endpoint.test.ts`核对请求路径与Bearer头，浏览器测试同时断言上游只收到`/v1/models`。本轮`npm run test:all`通过：62个后端文件315项、22项浏览器测试。

## 面向用户的呈现整改

连接测试原始返回、任务详情、系统页、审批、迁移与记忆审核此前直接显示内部状态码、英文键名和JSON。现已统一：状态与错误映射为中文结论；原始数据放入默认折叠的“技术详情”；接口错误消息不再回显代码。新增`tests/presentation.test.ts`与`tests/browser/presentation.spec.ts`，验证连接测试显示中文、原始`invalid_credentials`仅在展开后可见。本轮`npm run test:all`通过：61个后端文件314项、22项浏览器测试。

## 自定义模型 ID 与未知价格补验

已移除自定义地址对内置于OpenAI目录的模型白名单依赖：填写API地址时，模型ID按原样发送给兼容服务，可用`vendor/team-model:latest`等目录外名称。留空API地址时仍使用官方接口并要求目录内ID，避免拼写错误被当作可用模型。自定义模型未填上限时使用上下文32768与输出4096，可在模型设置中调整；输出不得超过上下文。

未知价格的模型不再套用其他模型价格。Token上限继续生效；一旦配置金额预算，任务以`BUDGET_PRICE_UNKNOWN`失败并给出具体原因，填写每百万Token输入/输出单价后才按该单价估算。此前金额预算失败只显示笼统的`MODEL_OR_BUDGET_FAILURE`，现已保留具体原因。

本轮`tests/provider-endpoint.test.ts`用本地兼容服务真实发送非目录模型请求，核对`/chat/completions`路径、Bearer认证、模型名与历史；并验证未知价格在Token预算下成功且标记`costUnknown`、在金额预算下明确失败、无地址的目录外模型被拒绝、配置重启后保留。生产Compose+Chromium验证使用`vendor/custom-model`完成真实聊天，日志：`/var/folders/7_/k830hyb566b3386880csl8900000gn/T/pi-fabric-shell-8LZfCY/output.log`。仍未使用真实代理密钥或对其模型目录作无依据推断。该补验后完整门禁为60个后端文件、312项测试及20项浏览器测试通过。

## 自定义 OpenAI 兼容地址补验

已将提供商类型与`baseUrl`分离。首次设置和模型编辑均可配置API基础地址；留空保持官方接口，清空已保存地址可切回官方接口。自定义地址使用Chat Completions协议；该次补验时仍限定内置OpenAI模型ID，后续补验已移除该限制并处理未知价格。未宣称支持任意协议或代理的真实价格。地址不接受URL内凭据、查询参数、片段及非HTTPS协议；仅回环HTTP用于明确配置的本地服务。所有配置在写入Owner、提供商或密钥之前校验，错误不会留下半初始化状态。

本轮`npm run test:all`通过：60文件311项后端、20项浏览器及原有事件/HTTP/类型/构建检查。`tests/provider-endpoint.test.ts`执行真实本地HTTP/SSE请求，核对URL、Bearer认证、模型ID及会话历史，并验证配置重启恢复、清空地址和无效配置回滚。完整日志：`/var/folders/7_/k830hyb566b3386880csl8900000gn/T/pi-fabric-shell-W4YUhy/output.log`。

`orangeorange/hda:local-provider-fix`的生产Compose+Chromium验证通过，包括真实浏览器聊天经容器内本地兼容服务返回回复，随后重启和桌面/手机重新登录。日志：`/var/folders/7_/k830hyb566b3386880csl8900000gn/T/pi-fabric-shell-1WNqkb/output.log`。本机8787实例已更新并通过实际页面验证，数据卷保留。未使用真实密钥请求用户服务。本轮未重跑AMD64、完整Linux probe和安全扫描；下方保留历史验证范围。

## 本地首次配置修复补验

针对本地Docker试用反馈，已在实际页面复现：短于12字符的初始化密码返回`INVALID_CREDENTIALS`，页面缺少约束提示。另在失败路径中复现错误重绘清空表单、退出后旧刷新覆盖登录错误的问题。现已增加`WEAK_PASSWORD`、前端最小长度及中文提示，稳定表单初始值，并阻止退出后的旧刷新更新状态。未获得用户当时的请求内容，因此不把该复现条件视为其原始请求的确定输入。

当前本地`npm run test:all`通过：59文件309项后端、20项桌面/手机浏览器、3项事件、HTTP客户端契约、类型检查及前后端构建。运行日志：`/var/folders/7_/k830hyb566b3386880csl8900000gn/T/pi-fabric-shell-g2LahS/output.log`。

`HDA_TEST_IMAGE=orangeorange/hda:local-auth-fix node deploy/compose-smoke.mjs`通过。脚本现在使用真实Chromium操作生产Compose容器，覆盖短密码拦截、服务端拒绝、保留输入并重试、首次配置、重启保留会话、桌面/手机退出及错误密码后重新登录。测试使用独立卷与随机本机端口，结束后清理；没有调用真实模型、Gmail或Telegram。运行日志：`/var/folders/7_/k830hyb566b3386880csl8900000gn/T/pi-fabric-shell-cmIjRD/output.log`。

本机`orangeorange-local`已更新到该镜像并通过健康及实际页面验证，原数据卷保留。未设置用户的管理员凭据。运行Compose浏览器测试前，宿主需要`npm ci`和`npx playwright install chromium`；CI另安装Chromium系统依赖。本轮没有重跑完整Linux probe、AMD64或安全扫描。以下表格与后续原记录保留为修复前证据，不代表本轮全部重验。

## 修复前已观察到的运行

| 检查 | 结果与范围 |
|---|---|
| `npm run test:all` | 59 文件、308 项后端测试通过；18 项桌面/390px浏览器、3 项事件测试、真实HTTP客户端契约、类型检查及前后端构建通过。外部供应商采用受控传输，SQLite/Pi/HTTP与进程故障为真实执行。 |
| ARM64 受限 probe 容器 `npm test` | 同样 59 文件、308 项通过。非root、只读根、cap-drop ALL、no-new-privileges、1GiB/2CPU。 |
| `HDA_TEST_IMAGE=hda:p0-arm64 node deploy/smoke.mjs` | 应用镜像、重启、两库备份、旧会话撤销、全新容器空卷恢复通过。 |
| `HDA_TEST_IMAGE=hda:p0-amd64 node deploy/smoke.mjs` | 同上通过，ARM64宿主仿真执行，未宣称原生AMD64硬件验收。曾发现重启后端口映射暂未出现的脚本竞态，修复后通过。 |
| `HDA_TEST_IMAGE=hda:p0-arm64 node deploy/compose-smoke.mjs` | 从生产Compose解析配置，隔离卷及随机loopback端口，空卷设置、重启和Owner登录通过。临时资源自动清理。 |
| 两个 `npm audit --audit-level=high` | 根项目与apps/web均为0 vulnerabilities。 |
| Gitleaks | Git历史扫描无泄漏；src、apps/web/src、scripts、deploy、docs、tests逐目录扫描无泄漏。没有扫描或发布私人代理会话目录作为交付代码。 |
| Trivy | 已更新系统包并移除运行时npm/npx。ARM64和AMD64分别剩34 HIGH/1 CRITICAL匹配项，当前发行版无修复版本；扫描失败并阻止发布。详见container-security-results.json；没有接受或忽略这些漏洞。 |

本地完整门禁日志：`/var/folders/7_/k830hyb566b3386880csl8900000gn/T/pi-fabric-shell-NF2QVQ/output.log`。ARM64完整容器测试日志：`/var/folders/7_/k830hyb566b3386880csl8900000gn/T/pi-fabric-shell-vCg5DV/output.log`。这些是本机运行收据，其他设备应执行下列命令重新验证，不能依赖本机临时路径长期存在。

## 复现入口

在已安装依赖的开发环境运行 `npm run test:all`。使用锁定 Node 24.14.1 和仓库lockfile。

构建运行时镜像：`docker buildx build --platform linux/arm64 --target runtime --load -t hda:p0-arm64 -f deploy/Dockerfile .`；另一架构替换为 `linux/amd64` 与对应tag。无buildx的legacy builder不能据此推定具备跨架构能力。

对每个构建镜像运行 `HDA_TEST_IMAGE=<tag> node deploy/smoke.mjs`。Compose安装验证运行 `HDA_TEST_IMAGE=<tag> node deploy/compose-smoke.mjs`，脚本优先使用 `docker compose`，本机不提供插件时使用 `docker-compose`。生产镜像只提供Node入口，npm/npx不是运行时运维接口。

审计覆盖检查已确认208条需求、141条P0逐ID唯一映射、67条P1/P2保留TODO。42条验收包含35条P0验收和7条后续Computer Use/Bot验收；测试PASS均保留作用范围。`npm run release:check`仍须因外部证据和未解决安全门槛失败，不能修改记录以消除失败。

## 本轮安全与交付结论

功能修复提交：`d14f4f2`；生产镜像及 Compose 复验提交：`c6b43db`。健康检查此前提交：`47814f6`。本轮没有推送、部署真实设备或向真实 Gmail/Telegram 发送消息。

安全修补后的 ARM64 和 AMD64 生产镜像再次通过 `deploy/smoke.mjs`，ARM64 的生产 Compose 初始化与重启也通过。最终镜像 ID 与扫描明细在 [容器安全结果](container-security-results.json)。每个架构仍有 **34 个 HIGH 和 1 个 CRITICAL 包/CVE 匹配项**，扫描未给出当前 Debian 发行版的修复版本；这些不是35个不同CVE。风险状态为 `NOT_ACCEPTED`，CI/发布门禁未忽略它们。

`npm run release:check` 当前预期返回1：既缺少真实账号、设备、来源和72小时证据，也缺少通过的容器安全门禁。此处“预期失败”仅表示门禁有效，不是发布验收通过。普通测试全部通过不能替代安全门禁。

最终运行收据：本地完整门禁 `.../pi-fabric-shell-NF2QVQ/output.log`；最终ARM64探针 `.../pi-fabric-shell-miH9iw/output.log`；修补后双架构运行与Compose `.../pi-fabric-shell-vyK1gp/output.log`。省略号均为本机 `/var/folders/7_/k830hyb566b3386880csl8900000gn/T`。文档检查确认7个shell块语法、39个相对链接及141条P0映射均通过。
