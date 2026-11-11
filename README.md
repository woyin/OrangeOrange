# OrangeOrange

## 定位

OrangeOrange 是一个私人常驻 AI Agent。

在 OpenWrt 等设备上用 Docker 运行。容器内是常驻服务，重启后保留会话和任务。

底座是 Pi Durable 1.5.0。项目依赖 `@earendil-works/pi-durable` 1.5.0，与 `@earendil-works/pi-ai`、`@earendil-works/pi-schema`、`@earendil-works/chord` 同版本。

管理入口是自带的前端管理台。前端位于 `apps/web`，使用 Vue 3，由同一个服务在 8787 端口提供。

主要入口是管理台。终端命令属于底座与兼容入口，见下文。

本仓库提供源码和操作说明。本文不声明版本已发布，也不声明已完成验收。

## 快速开始

条件：宿主已安装 Docker 和 Docker Compose 插件；8787 端口空闲；首次构建可访问镜像和依赖源。

在仓库根目录执行：

```sh
docker compose -f deploy/compose.yml up -d --build
```

检查状态：

```sh
docker compose -f deploy/compose.yml ps
docker compose -f deploy/compose.yml logs --tail=100 hda
```

在宿主浏览器打开 `http://127.0.0.1:8787`，完成首次配置：创建 Owner、设置密码（至少 12 个字符）、选择时区。之后在管理台配置模型，Telegram 为可选项。

健康检查：`/health/live` 返回 200 表示进程响应；`/health/ready` 返回 200 表示服务就绪。

默认只绑定本机。`deploy/compose.yml` 将端口映射为 `127.0.0.1:8787:8787`，不对局域网或公网开放。

远程访问须经可信 VPN 或 TLS 反向代理，并正确设置 `HDA_PUBLIC_ORIGIN` 与 `HDA_TRUST_PROXY`。不要向 WAN 做端口转发。

`/data` 是可写数据卷，`/workspace` 是只读工作区卷。二者使用独立卷。改用 bind mount 时须先设置好权限。

## 环境变量

服务只读取下列变量。未设置时使用括号内默认值。

| 变量 | 作用 |
|---|---|
| `HDA_DATA_DIR` | 数据目录，存放数据库与主密钥。默认 `/data`。 |
| `HDA_WORKSPACE` | 工作区目录，按只读访问。默认 `/workspace`。 |
| `HDA_PORT` | 监听端口。默认 `8787`。 |
| `HDA_PUBLIC_ORIGIN` | 对外 HTTPS 地址，用于 Origin 校验、Cookie 的 Secure 标记和 OAuth 回调。未设置时只按请求 Host 判断。 |
| `HDA_TRUST_PROXY` | 设为字符串 `true` 才生效；仅在其前方有可信 TLS 代理时设置。 |

默认 Compose 已设置数据目录、工作区和端口。默认 Compose 不设置公开地址和代理信任。

模型密钥、Telegram 凭据在管理台写入，不写入 Compose 文件，也不写入环境变量。

主密钥默认位于 `${HDA_DATA_DIR}/master.key`。另有 `HDA_MASTER_KEY_FILE` 可单独挂载主密钥文件，默认 Compose 未启用。

## 安全边界

- 容器以非 root 运行：`user: "1000:1000"`。
- 根文件系统只读：`read_only: true`。只有 `/data`、`/workspace` 和 tmpfs `/tmp` 可写。
- 丢弃全部 capability：`cap_drop: ALL`。同时启用 `no-new-privileges`。
- 资源受限：内存 1 GiB，2 CPU，进程数 128，停止宽限 30 秒。
- 未认证请求被拒绝。写接口要求认证、CSRF 和 Origin 校验。
- 未知主体、未知工具和停用工具默认拒绝。
- 高风险操作在执行前生成审批。审批绑定操作参数哈希、主体、任务和过期时间，只能消费一次。管理台是唯一批准入口，聊天消息不授予权限。
- 凭据用 AES-256-GCM 加密存储。读取接口只返回是否已配置，不回显密钥明文。错误、事件、审计和日志不写入密钥。
- 文件工具拒绝整个数据目录和主密钥路径，并检查真实路径与符号链接。

安全边界不是发布证明。当前容器漏洞扫描未通过，见文末。

## 开发命令

开发需要 Node.js 24.14.1（`engines` 限定 24 系列，版本见 `.node-version`）和 npm。

| 命令 | 用途 |
|---|---|
| `npm ci` | 按 lockfile 安装依赖。 |
| `npm run typecheck` | 后端 TypeScript 类型检查。 |
| `npm test` | 后端单元与契约测试（vitest）。 |
| `npm run test:all` | 完整门禁：类型检查、后端测试、前后端构建、前端测试、前端集成测试、浏览器端到端测试。 |
| `npm run release:check` | 发布门禁。当前按设计失败，见下文。 |
| `npm run test:e2e` | 浏览器端到端测试（Playwright）。首次需安装 Chromium。 |

`npm run release:check` 读取 `docs/acceptance-results.json`。它要求验收用例通过、两个架构的镜像启动记录、72 小时稳定性、真实设备与外部服务证据，以及依赖审计、密钥扫描和容器扫描全部通过。

当前该命令返回非零。这是门禁生效的表现，不是发布通过。其他测试通过不能替代它。

`npm run test:all` 中的浏览器测试需要本机 Chromium。安装命令：`npx playwright install chromium`。

## 旧 CLI

仓库仍保留命令行入口：`npm run dev -- <命令>`，构建后为 `node dist/cli.js <命令>`。

控制平面不使用它。控制平面打开运行时适配器时设置 `disableLegacyAutomation: true`。在该模式下，`schedule_` 和 `reminder_` 系列旧自动化工具被拒绝，旧定时任务能力不启用。

它只用于底座测试和兼容，不是主要入口。日常操作请使用管理台。

## 相关文档

- [V1.1 交付入口](docs/V1.1-DELIVERY.md)：当前操作入口、提供商配置说明和证据范围。
- [运维与恢复](docs/OPERATIONS.md)：安装、升级、备份、空卷恢复、离线密码恢复和故障处理。
- [P0 本轮核验](docs/P0-VERIFICATION.md)：分层核验记录、复现命令和安全结论。

## 未验收内容

以下项目尚无真实证据。不得据此宣称已发布或已验收。

| 项目 | 状态 |
|---|---|
| 真实 OpenWrt 设备部署 | 未验收。现有文档是部署前检查步骤。 |
| 真实模型服务 | 未验收。当前使用本地兼容服务和模拟供应商。 |
| 真实 Telegram | 未验收。未向真实账号发送消息。 |
| 真实迁移来源 | 未验收。openclaw 与 hermes 备份未实测。 |
| 72 小时稳定性 | 未验收。 |
| 容器漏洞扫描 | 未通过。仍有未修复的高危和严重项，发布门禁因此阻断。 |
