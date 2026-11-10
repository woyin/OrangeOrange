# 备份集成契约

OperationsService(getStore:()=>ControlStore,dataDir,hooks)，getStore必须返回恢复后的新store。hooks: quiesce/resume停止新业务与worker并安全暂停运行（保留可恢复输入）；piBackup(dest)使用adapter备份或关闭Pi后sqlite backup；closeStores/reopenStores幂等并负责Pi与app生命周期/锁。HTTP负责Owner再认证及confirm精确操作。

方法listBackups/createBackup/restore(id)/diagnostics。在线备份协调暂停写入，app与Pi分别SQLite backup；不假装跨库原子。manifest固定两个文件、sha256与schema检查。备份含个人Memory/IM/transcript，需认证读取；应用secret表和sessions从备份副本移除，master.key不包含。恢复后要重新配置模型/Telegram/Search凭据，不直接发送旧pending outbox（service恢复对账）。

restore先建立新快照rollbackId，关闭两store，替换固定路径并清理WAL/SHM，reopen失败回滚旧文件。需要service quiesce真正停止所有写（包括SSE/auth/settings），仅停止接收任务不够。审计日志由store仅存摘要，diagnostics不含正文和凭据。
