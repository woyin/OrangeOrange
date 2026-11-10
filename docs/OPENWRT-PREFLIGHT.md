# OpenWrt 部署前检查

目标是运行 Docker 容器。OpenWrt 只提供容器宿主和持久存储；不在宿主安装 Node/Python 或运行 Agent 业务进程。真实设备信息尚未提供，本文件是部署前步骤，不是兼容性结论。

## 记录设备

由设备管理员运行只读检查并保存输出：

```sh
uname -m
docker version
docker info
df -h
```

Compose 使用设备已有命令：`docker compose version` 或 `docker-compose version`。两者皆无时，先按 OpenWrt/Docker 官方方法配置管理工具。业务仍只在容器中运行。

需要记录：CPU架构、核心数、RAM、SSD路径与剩余容量、文件系统、Docker/Compose版本、cgroup/seccomp能力和访问方式。预设性能参考为4核ARM64/4GiB RAM/SSD；小于该基准的设备应另测，减少并发或任务规模，不能直接套用基准指标。

当前开发Docker VM只有2核和2054832128字节内存。开发机结果不能作为上述性能目标已达标的证明。

## 安装边界

主服务只使用应用持久卷及单独受限工作区。检查compose配置，确认非root、只读根文件系统、临时目录、cap_drop、no-new-privileges、内存/CPU限制和健康检查。

默认管理端口只映射宿主127.0.0.1:8787。需要LAN/VPN访问时，先配置可信TLS入口、准确的公开origin和认证；不把WAN端口转发作为安装步骤。

首次安装通过Web /setup创建Owner和模型、时区、可选Telegram；不直接编辑SQLite。凭据主密钥的保存和恢复必须按OPERATIONS.md执行，与普通配置导出分开。

## 上线验收

1. 用空卷执行Compose安装，完成Web设置与登录。
2. 通过允许的真实Telegram身份完成一次模型/工具交互；未授权身份不能触发模型。
3. 容器重启后会话、任务、Cron和未完成审批仍存在；不确定投递不能自动盲重发。
4. 备份到新卷恢复，检查数据库完整性、会话与未完成任务。
5. 在设备上记录空闲RSS、两个并发任务的RSS/CPU/延迟、磁盘占用和72小时运行指标。
6. 完成docs/SRS.md全部AT用例，并更新acceptance-results.json。开发机Mock不能替代真实平台/设备证据。

发布门禁为 `node scripts/check-release.mjs`。缺少真实OpenWrt、双架构、真实模型/Telegram和72小时证据时，脚本保持不可发布。
