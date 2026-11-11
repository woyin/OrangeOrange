# P0 本轮核验记录

本记录区分静态审计、自动化运行和外部验收。当前基线为 v1.1。真实 Google、Telegram、外部模型、完整来源备份、OpenWrt 和 72 小时实验未验收。

## 已观察到的运行

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
