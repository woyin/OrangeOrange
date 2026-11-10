# ADR 0001：固定 Pi Durable 1.5.0 与容器验证

状态：M0 底座 gate 通过。最终 Web 部署与完整 P0 验收仍待后续。

采用 `@earendil-works/pi-durable`、Pi AI、Chord、Pi Schema 1.5.0，直接版本及间接依赖由 package-lock.json 锁定。使用 Node 24.14.1 Debian bookworm slim；上游要求 Node >=22.19.0。上游仍标为 Experimental，升级必须重新执行恢复与适配契约测试。

已阅读安装包官方英文 README、CHANGELOG 1.5.0（2026-11-02）、dist/storage/sqlite/node.js 及 Chord dist/sqlite/node.js。发布包源码映射包含原 TypeScript；实际运行接口以锁定发布包 JS 和 d.ts 为准。1.5.0 改用 pi-schema，Storage.commit 使用 batches/receive，不沿用旧版示例。

单个进程拥有 SQLite。Pi Durable 本身没有跨进程锁，应用使用 fs-ext 操作系统锁。上游 Node SQLite 设置 WAL/NORMAL。进程 SIGKILL 恢复不等于突然断电零丢失；电源故障和宿主机故障尚未验证。应用控制库与 Pi 库分离，通过稳定标识及 inbox/outbox 对账，不声明跨库事务。

目标性能假设为 4 核 ARM64 / 4 GiB RAM / SSD。当前 Docker daemon 为 linux/aarch64，实际仅 2 CPU / 2054832128 bytes RAM，低于 4 核 / 4 GiB 基准；不是实际 OpenWrt 基准机。独立 `/opt/homebrew/bin/docker-compose` 可用，Docker CLI 的 compose/buildx 插件缺失；不改全局安装。AMD64、真实 OpenWrt、72h、真实模型和 Telegram 都未验证。当前 docs/PHASE3-ACCEPTANCE.md 中 49 测试为继承基线，不作为本次 Linux 证据。

复现 M0：

```sh
DOCKER_BUILDKIT=0 docker build --platform linux/arm64 --target probe -t hda:m0-probe -f deploy/Dockerfile .
docker run --rm --read-only --tmpfs /tmp:rw,nosuid,nodev,size=256m --tmpfs /app/node_modules/.vite-temp:rw,nosuid,nodev,uid=1000,gid=1000,size=16m --tmpfs /app/node_modules/.vite:rw,nosuid,nodev,uid=1000,gid=1000,size=32m --cap-drop ALL --security-opt no-new-privileges --memory 1g --cpus 2 hda:m0-probe
```

probe 阶段保留编译工具和测试依赖，只作开发验证。runtime 阶段剥离工具链与开发依赖。最终管理后台入口及静态 Web 构建将在 M0 通过后接入，不以当前 CLI 默认命令声称 Web 完成。

## 构建过程记录

首次普通后台构建随会话关闭，未产生成功证据。首次持久后台构建完成原生工具链安装，但 npm registry 下载出现 EIDLETIMEOUT，588 秒后退出 1。随后使用缓存工具链层重试，依赖下载继续。上述失败属于构建网络条件，不计入 gate 通过。
## 本次 Linux ARM64 证据

本段 M0 证据对应加入 Playwright 开发依赖前的锁文件与源代码快照；后续生产镜像另行验证。正常重试构建于 247 秒内成功，镜像 `hda:m0-probe` / `211454d50254`。npm ci 安装 172 包，审计报告 0 已知漏洞（不是容器漏洞扫描结果）。Linux ARM64 下原生 fs-ext 编译与 Node SQLite 实际运行成功。

首次只读根探针因 Vite 必须写 node_modules/.vite-temp 而启动失败。增加两个有界测试缓存 tmpfs 后，4 文件、14 项测试全部通过，Vitest 总时长 7.00 秒：

- tests/recovery.test.ts：3 项；模型请求中 SIGKILL 恢复与输入去重、休眠交付去重、任务检查点迁移。
- tests/ownership.test.ts：1 项；进程排他锁及 SIGKILL 后释放。
- tests/tools.test.ts：2 项；工具循环、取消、有限轮次和重试。
- tests/gateway.test.ts：8 项；入站去重/授权、隔离、分段、发送确认丢失与 SIGKILL 后 unknown 不自动重发、游标与有限限流重试。

这些测试使用模型及通道替身，证明容器内真实 SQLite/进程/工具执行路径，不证明真实外部服务。运行身份为镜像 USER node，根只读，capabilities 全删除，no-new-privileges，1 GiB / 2 CPU 限制。无 host 网络、privileged、Docker Socket 或宿主机敏感挂载。

`deploy/Dockerfile.offline` 是网络故障备用入口。其 npm-cache 只允许由全新临时缓存按当前 package-lock 获取公开依赖，不得复制个人 npmrc 或整份个人缓存。本次正常重试成功，未执行备用入口，不作为已验证路径。

