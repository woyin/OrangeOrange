# OpenWrt 部署前检查

目标是运行 Docker 容器。OpenWrt 只提供容器宿主和持久存储；不在宿主安装 Node/Python 或运行 Agent 业务进程。真实设备信息尚未提供，本文件是部署前步骤，不是兼容性结论。操作入口见 [V1.1 交付入口](V1.1-DELIVERY.md)。

## 记录设备

条件：设备管理员已登录目标宿主，且 Docker 已配置。运行只读检查并保存输出；确认命令成功、Docker 服务可用且磁盘空间足够：

```sh
uname -m
docker version
docker info
docker compose version
df -h
```

本文提供的安装命令依赖 `docker compose` 插件。若不可用，先按设备和 Docker 官方说明配置；不要假定 `docker-compose` 与本文命令等价。记录 CPU 架构、核心数、RAM、SSD 路径与容量、文件系统、Docker/Compose 版本、cgroup/seccomp 能力和访问方式。预设性能参考为 4 核 ARM64、4 GiB RAM 和 SSD；小于该基准的设备须另测。

开发机结果不能证明目标设备达到上述指标。完整构建还需要镜像和依赖源的网络访问及足够构建空间；运行容器不要求宿主安装 Node/Python。

## 安装边界

按 [运维与恢复](OPERATIONS.md) 从锁定源码构建安装。先检查 Compose 展开配置及其非 root 用户、只读根文件系统、临时目录、cap_drop、no-new-privileges、资源限制和健康检查。默认管理端口只映射宿主 `127.0.0.1:8787`；需要远程访问时先配置可信 TLS 入口及准确的公开 origin，不将 WAN 端口转发作为安装步骤。

首次通过 Web 创建 Owner 和时区，再配置模型及可选 Telegram。按运维文档独立保存主密钥并演练备份恢复；普通备份和配置导出不含凭据。工作区为独立只读卷，须另行确认其备份范围。

## 上线验收

1. 在目标设备的空卷执行 Compose 安装，完成 Web 设置与登录，记录健康状态。
2. 经授权使用真实模型和 Telegram 身份完成一次交互；验证未授权身份不能触发模型。
3. 容器重启后检查会话、任务、Cron 和未完成审批；不确定投递不能自动盲重发。
4. 将备份恢复至隔离新卷，检查数据库、关键数据及凭据重配。
5. 在设备上记录空闲 RSS、两个并发任务的 RSS/CPU/延迟、磁盘占用和 72 小时运行指标。
6. 按实际适用范围检查 [v1.0 SRS](SRS.md) 和 [v1.1 基线](Home_Durable_Agent_v1.1/SRS.md)，在 [验收记录](acceptance-results.json) 中保存可追溯证据。开发机 Mock 不能替代真实平台和设备证据。

条件：开发环境已安装依赖。在仓库根目录运行 `npm run release:check`，根据退出码和报告判定当前门禁；缺少真实设备、外部服务或长期运行证据不得宣称完成验收。门禁本身正在更新，最终结果以重跑为准。
