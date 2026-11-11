# 运维与恢复

本文件是当前源码的操作说明，不是发布验收证明。状态和证据范围见 [V1.1 交付入口](V1.1-DELIVERY.md)。OpenWrt 部署前先完成 [设备检查](OPENWRT-PREFLIGHT.md)。以下 Compose 命令均在仓库根目录执行，使用同一个 Compose 项目和 `deploy/compose.yml`。

## 安装与可信访问

条件：Docker 和 Docker Compose 插件可用；源码版本已固定；宿主有足够磁盘、内存和构建空间；8787 本地端口空闲。首次安装使用新项目的空卷。运行：

```sh
docker compose -f deploy/compose.yml config
docker compose -f deploy/compose.yml up -d --build
docker compose -f deploy/compose.yml ps
docker compose -f deploy/compose.yml logs --tail=100 hda
```

检查配置无误，容器运行且健康；在宿主浏览器访问 `http://127.0.0.1:8787/`，完成 Owner、密码和时区设置，然后在 Web 中配置模型及可选 Telegram。密码至少 12 个字符。`/health/live` 返回 200 表示进程响应；`/health/ready` 返回 200 才表示服务就绪。首次构建需要访问镜像和依赖源；离线安装未由上述命令保证。

默认端口仅绑定宿主 `127.0.0.1:8787`。远程管理使用可信 VPN 或 TLS 代理；远程 HTTPS 地址须与 `HDA_PUBLIC_ORIGIN` 精确一致，代理信任需按实际部署配置 `HDA_TRUST_PROXY`。默认 Compose 不设置这些变量或代理。不要直接向 WAN 开放管理端口。

`/data` 和只读 `/workspace` 使用独立卷；容器 UID/GID 为 1000。替换为 bind mount 时须预先配置权限。根文件系统只读，容器丢弃 capability；不要用 privileged 或宿主根目录挂载解决权限问题。

## 密钥与配置

模型、Telegram 等凭据通过 Web 配置，普通备份和配置导出不包含 secrets。默认主密钥为 `/data/master.key`，创建后应另存安全的独立副本，并与数据库及普通备份分开加密保管。可通过 `HDA_MASTER_KEY_FILE` 使用独立受控挂载；默认 Compose 未提供该挂载或环境变量。文件须为容器 UID 1000 可读的 32 字节原始密钥，且挂载和祖先路径由可信管理员控制。迁移原有数据库时必须使用与其配对的原密钥；已有数据库而密钥缺失时不会自动替换。

当前没有主密钥轮换或对已有 secrets 重加密的操作接口。不要直接替换密钥或删除 `master.key` 来轮换；已有密文将无法解密。模型和 Telegram 凭据可在 Web 中重新配置，不能将其作为主密钥轮换的替代。离线备份恢复与完整数据卷恢复的密钥要求不同，见下文。

## 备份

条件：服务已就绪，Owner 能登录且知道当前密码。进入 Web「系统」的「备份与恢复」，输入密码，点击「创建备份」并确认。成功结果和备份列表会显示服务器生成的备份 ID。记录该 ID；服务在 `/data/backups/<ID>/` 保存 `app.sqlite`、`pi.sqlite` 和 `manifest.json`。Web 当前没有备份下载按钮；须由设备管理员导出目录。

条件：在宿主已有私有备份目录，且当前目录是仓库根目录。以下命令提示输入刚生成的 ID，复制到当前目录下新建的私有 `hda-backup`；若目录已存在则停止，避免覆盖。之后将其加密保存到设备外，并验证三个文件存在。

```sh
read -r HDA_BACKUP_ID
umask 077
mkdir hda-backup && docker cp "$(docker compose -f deploy/compose.yml ps -q hda):/data/backups/$HDA_BACKUP_ID" hda-backup/
ls -l "hda-backup/$HDA_BACKUP_ID"
```

输入必须是备份列表中的完整 ID。备份含私人会话、任务及记忆；保护副本和传输过程。快照通过 SQLite 备份生成并校验两个数据库，应用库副本删除 secrets 和 sessions；不含主密钥。它不是整个数据卷或工作区的完整镜像。双库不具备跨库原子事务，依赖暂停写入和恢复对账。定期在隔离环境演练恢复，确认所需数据和附件可用。

## 恢复与回滚

同一服务恢复：确认备份 ID 在 Web「系统」备份列表中，确认允许覆盖当前状态；输入当前 Owner 密码和 ID，点击「确认并恢复备份」。服务先校验 manifest、hash、数据库完整性和 schema，再创建当前状态的回滚备份。成功后旧会话失效；使用备份中的 Owner 用户名和密码重新登录，检查任务、会话和记忆，并重新配置模型、搜索、Telegram 和 Gmail 等凭据。Gmail 须重新授权，缺失正文的旧待审邮件须重建。不要盲重发不确定投递。

空卷灾备：在隔离的新 Compose 项目或新主机上按安装步骤启动空卷，使用临时 Owner 和密码完成设置；不要连接真实消息通道或启用可能产生外部副作用的任务。将设备外保存的 `hda-backup/<ID>` 安全复制到新宿主的仓库根目录。打开 Web「系统」以初始化并查看备份列表。确认目录包含三个原始文件、备份 ID 与 manifest 一致，且 ID 不在新服务的备份列表中。下面在新宿主执行；提示时输入该 ID。命令以容器用户创建文件，遇到已有文件会失败，不覆盖。

```sh
read -r HDA_BACKUP_ID
docker compose -f deploy/compose.yml exec -T hda node -e 'const fs=require("node:fs");const id=process.argv[1];if(!/^[0-9a-f-]{36}$/.test(id))throw Error("invalid ID");fs.mkdirSync("/data/backups/"+id,{recursive:false,mode:0o700})' "$HDA_BACKUP_ID"
for HDA_FILE in app.sqlite pi.sqlite manifest.json; do
  docker compose -f deploy/compose.yml exec -T hda node -e 'const fs=require("node:fs");const [id,name]=process.argv.slice(1);if(!/^[0-9a-f-]{36}$/.test(id)||!["app.sqlite","pi.sqlite","manifest.json"].includes(name))throw Error("invalid input");fs.writeFileSync("/data/backups/"+id+"/"+name,fs.readFileSync(0),{mode:0o600,flag:"wx"})' "$HDA_BACKUP_ID" "$HDA_FILE" < "hda-backup/$HDA_BACKUP_ID/$HDA_FILE"
done
```

若任一命令报错或复制中途失败，不要继续恢复；先由管理员检查并清理新卷中该不完整备份目录，再重新导入。刷新 Web「系统」确认 ID 出现在列表；用临时 Owner 的密码执行恢复。成功后用备份中的 Owner 登录，检查关键数据并重配凭据。普通备份不含主密钥和 secrets，空卷初始化生成的新密钥可用于重新配置的凭据；它不能解密原卷剩余密文。单独保存的原主密钥用于配对原完整数据卷，不要覆盖正在运行的空卷密钥。备份不保证包含独立 `/workspace` 内容，须按实际工作区另行备份和验证。

恢复失败并出现 `RESTORE_RECOVERY_REQUIRED` 或启动发现未完成 journal 时，保留整个卷、`restore-journal.json` 和回滚文件；不要删除 journal 或只替换一库。修复前先保全卷副本。恢复过程会先验证两份回滚库；无法验证时保持停止写入。

## 升级

条件：确认目标版本及其 schema 兼容性，停止外部入站并处理运行中任务。先按上述步骤创建备份并导出，另存匹配主密钥；记录旧源码版本和镜像 digest，并确认备份可用。在仓库根目录切换到已审查的目标源码后运行：

```sh
docker compose -f deploy/compose.yml up -d --build
docker compose -f deploy/compose.yml ps
docker compose -f deploy/compose.yml logs --tail=100 hda
```

检查 ready、登录、关键任务、Cron、审批和投递记录。失败时停止写入并保全当前卷；回滚使用旧镜像和升级前匹配的完整数据副本，不让旧程序直接打开已升级的新 schema。普通备份不含 secrets，使用它恢复后必须重新配置凭据。

忘记密码时按 [离线管理员恢复](ADMIN-RECOVERY.md) 准备密码文件。默认 Compose 的具体操作如下：先确认没有其他实例占用卷，准备容器 UID 1000 可读、权限 0600 的宿主绝对路径密码文件；终端提示时分别输入现有 Owner 的准确用户名和该路径。不要在命令行输入密码。若使用自定义主密钥挂载，先确保一次性容器也获得同一挂载和 `HDA_MASTER_KEY_FILE`。

```sh
docker compose -f deploy/compose.yml stop hda
docker compose -f deploy/compose.yml ps
read -r HDA_OWNER
read -r HDA_PASSWORD_FILE
docker compose -f deploy/compose.yml run --rm --no-deps -v "$HDA_PASSWORD_FILE:/run/secrets/admin-reset:ro" hda node dist/control/admin-recovery.js --data-dir /data --username "$HDA_OWNER" --password-file /run/secrets/admin-reset --confirm-reset
docker compose -f deploy/compose.yml up -d
```

仅在 `ps` 确认服务已停止后运行恢复命令。密码文件须为非符号链接的 UTF-8 普通文件，最多 4096 字节，密码 12–1024 字符；可带一个末尾换行。命令显示成功后安全移除临时密码文件，确认服务健康并用新密码登录；全部旧会话已撤销。命令失败时检查文件权限、用户名、数据库、主密钥及占用锁，保留原数据。

## 故障处理

- live 正常而 ready 返回 503：查看 Compose 日志及登录后的系统状态，检查磁盘、维护状态和 adapter；外部模型不可用不等于进程死亡。
- `MASTER_KEY_MISSING` 或 `MASTER_KEY_INVALID`：核对原密钥、挂载、32 字节长度和权限；不要生成替代密钥。
- 锁冲突：确认只有一个实例占用数据目录；不要删除锁文件来启动第二写入者。
- 磁盘低水位：释放受控空间，保留活跃任务和不确定副作用；维护及审计限制见 [维护接口](MAINTENANCE-V11.md)。
- `DELIVERY_UNCERTAIN`、`SEND_UNCERTAIN` 或 operation `UNCERTAIN`：先在外部平台人工核对，不自动盲重发。
- DNS 返回保留地址：检查 Fake-IP 和代理的公开解析，不放宽 SSRF 防护。

## 验证

迁移前阅读 [迁移兼容性](MIGRATION-COMPATIBILITY.md) 和 [迁移 HTTP 契约](V1.1-HTTP-CONTRACT.md)；Gmail 的授权、审批和不确定发送处理见 [Gmail 操作说明](GMAIL.md)。真实来源、真实 Google 账号和真实发送尚未验收。

开发环境门禁是 `npm run test:all` 和 `npm run release:check`；在已安装项目依赖的开发环境运行，依据退出码和输出判断。门禁结果不能代替目标设备和外部服务验收。Pi 库使用 WAL/NORMAL，突然断电与 SIGKILL 测试不同；建议 SSD 和 UPS。
