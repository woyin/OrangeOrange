# V1.1 维护接口

`MaintenanceService.maintainAudit(now = Date.now()): {file: string; lastSeq: number}` 每次最多导出 1000 条连续审计记录。`rotateAudit()` 是兼容别名。没有新记录时 `file` 是空字符串，`lastSeq` 是已保存游标。调用方应检查错误，并在下一次计划维护时继续；不要在磁盘满时循环重试。磁盘满或配额用尽报告 `AUDIT_DISK_FULL`。

每个 JSON 包含 `firstSeq`、`lastSeq`、`rows` 和 `hash`。`hash` 是 `JSON.stringify(rows)` 的 SHA-256 十六进制摘要。文件先以 0600 写临时文件并同步，再原子重命名并同步目录；之后保存数据库游标。重启后若文件已存在且内容一致，会恢复游标。快照目录权限为 0700，拒绝数据目录和快照目录本身为符号链接。部署方必须控制数据目录的祖先目录；该检查不能防止特权用户或并发路径替换。

配置 `config.auditSnapshotRetentionDays`，默认 30，范围为 1–3650 整数。每次最多检查 1000 个目录项，删除超过期限且游标已覆盖的快照。目录枚举没有持久续接位置：如果前 1000 项长期不满足删除条件，后续文件可能无法清理，因此目前不能保证快照数量或磁盘空间有硬上限。审计表是独立的追加流水，不删除或轮转该表；快照保留期不会限制数据库大小。摘要用于检测意外损坏，快照和摘要都在本机，因此不能防止主机管理员篡改。

`retention(now)` 按 `config.artifactRetentionDays ?? retentionDays` 清理过期 artifact 实体，范围为 1–3650 整数。活动任务、未终结 Gmail intent 和所有仍保留的 Gmail payload 中的 `artifactId` 会保护对应实体。未终结 intent 的正文缺失，或任一保留正文无法解密或解析时，跳过全部 artifact 删除。清理不会修改附件引用。

## Main 接线

`ControlService.cleanup()` 已在小时维护流程中调用 `retention(now)`、`maintainAudit(now)` 和邮件正文清理。`PATCH /api/v1/settings` 已接受并校验 `artifactRetentionDays` 和 `auditSnapshotRetentionDays`，均为 1–3650 的整数，并写入 `config`；Web「设置」也提供这两个字段。保存后可重新读取设置确认数值。磁盘满时检查错误和可用空间，不要循环重试。

现有 `retention()` 对历史任务、事件和引用仍使用全量扫描；目前只对审计快照批次和快照目录检查设定上限。若要求整个维护周期严格有界，需要另行改造历史清理和引用扫描，不能把当前接口称为全流程有界。

条件：开发环境已安装依赖。运行 `npx vitest run tests/control-maintenance.test.ts`，以退出码和测试结果验证维护行为；它不能代替目标设备的长期运行验收。
