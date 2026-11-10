# 运维与恢复

本项目仅以Docker容器部署在OpenWrt，不在宿主运行Node/Python业务。发布状态以IMPLEMENTATION_STATUS.md和AT-RESULTS.md为准。

## 安装与可信访问

设备前提见[部署前检查](OPENWRT-PREFLIGHT.md)。使用明确tag的镜像或锁定源码构建；不得自动追踪latest。Compose默认只映射127.0.0.1:8787，首次访问/setup创建Owner，配置模型、时区与可选Telegram。LAN/VPN需要可信TLS代理和HDA_PUBLIC_ORIGIN，不默认对WAN开放。

数据卷为/data，工作区为独立/workspace只读卷。容器UID/GID为1000，现有bind mount须由设备管理员事先设置正确权限；不要通过privileged或整个宿主根目录挂载解决权限错误。应用根文件系统只读，临时目录有配额。

## 密钥与配置

Owner密码不能通过环境变量GET回显。模型/Telegram密钥通过Web专用表单添加或轮换，普通列表只显示配置状态。

应用主密钥默认在私有/data/master.key，可用HDA_MASTER_KEY_FILE指向受控挂载文件。已存在加密数据但主密钥丢失时拒绝生成替代密钥。保留主密钥的安全独立副本；不要放进普通配置导出、支持包或公开备份。

HDA_DATA_DIR、HDA_WORKSPACE、HDA_HOST、HDA_PORT、HDA_WEB_DIR决定进程路径，生产取Compose默认值。部署可选公开origin不得指向不受信任代理。旧ORANGE_* CLI是兼容开发入口，不与生产控制面同时对同一个Pi库运行。

## 备份

Web备份/恢复需Owner重新输入密码并显式确认。服务先停止新写入并协调Pi生命周期，再分别调用SQLite备份能力，保存应用库与Pi库；不直接复制活动WAL主文件假装快照。

每份备份使用服务器生成UUID，manifest固定文件名与sha256，记录创建时间和schema。备份应用副本清除secret/session，执行secure_delete和VACUUM减少旧页残留；不含master.key。备份仍含私人会话、IM任务、Memory和关联信息，下载与保存需认证保护，建议设备外加密备份。

双库没有全局原子事务，一致性依赖服务quiesce屏障、稳定任务ID与重启对账。模块测试通过不等于所有真实活动任务的hooks已验收。

## 恢复与回滚

恢复仅接受服务器已有备份ID，不接受任意文件系统路径。先检查manifest、hash、integrity与schema，再备份当前状态，关闭两库并保存独立回滚文件。

替换前落盘restore-journal.json，替换失败或重开失败恢复旧两库。若回滚缺文件或校验失败，保留journal和剩余回滚依据，并保持停止业务写入，不继续运行混合数据库。

进程启动时，必须在打开任何业务数据库前、取得单实例所有权后调用recoverInterruptedRestore。发现未完成journal先校验完整旧两库，再回滚。禁止人工只删除journal让服务绕过校验；修复应保留原卷副本。

恢复备份后session已失效，Owner重新登录并补配置模型、搜索和Telegram凭据。恢复不会自动声称此前不确定的发送已送达；需在投递记录中核对。

## 升级

1. 保存当前镜像tag/digest和应用版本。
2. 停止新入站，完成或安全暂停当前任务，创建经校验的备份。
3. 更新锁定版本与镜像，启动前检查schema。
4. 检查live/ready、数据库完整性、未完成任务、Cron、审批和outbox。
5. 失败时使用升级前镜像加升级前完整备份卷；不要用旧程序直接打开新schema。

应用迁移事务失败或schema超前时进入只读维护模式，禁止运行任务。密码重置维护流程须采用只允许设备管理员的离线工具，并撤销旧session；不可放置无认证HTTP重置后门。当前是否已提供该工具见实施状态，不能靠修改数据库密码明文完成。

## 故障处理

- live通过而ready失败：检查维护/磁盘/adapter状态，不把外部模型故障当成进程死亡。
- 模型失败：检查配置状态、有限重试和安全主备规则，不能无限重试；不记录原始密钥/响应正文。
- outbox DELIVERY_UNCERTAIN或operation UNCERTAIN：先核对平台结果，人工确认，不能直接盲目重放。
- 磁盘低水位：停止新写入、保留可读诊断，释放受控旧日志/终态记录，不删除活跃任务或未确认副作用。
- SQLite owner锁冲突：只允许单主实例，不通过删除锁文件启动第二写入者。
- DNS返回保留地址：检查Fake-IP或代理配置，给Agent公开网络的真实解析，不放宽SSRF限制访问metadata。

## 验证

开发Node与浏览器测试不安装到OpenWrt宿主。CI和开发环境运行typecheck、tests、Web构建/浏览器E2E、容器测试、安全扫描。目标设备记录内存/CPU/磁盘/启动时间与72小时指标。发布门禁为npm run release:check，缺少真实OpenWrt、双架构、真实模型/IM或72小时证据保持失败。

上游Pi库WAL/NORMAL的突然断电可靠性与SIGKILL恢复不同。建议SSD与UPS；不能承诺绝对零丢失。
