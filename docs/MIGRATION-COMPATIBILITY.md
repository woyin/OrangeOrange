# 迁移兼容性与限制

本表记录已核对的上游源码，不表示已完成真实备份验收。版本支持必须有对应版本的真实来源产物或可追溯的上游 fixture，以及迁移测试证据；没有证据时不得声明兼容。

| 来源 | 已核对源码提交 | 已知格式 | 验收状态 |
| --- | --- | --- | --- |
| OpenClaw | `d290127ec6750ac3b3504d44ab50b7cee5f92ec7` | 主干未发布 schema 41；每 Agent `agents/<id>/agent/openclaw-agent.sqlite` | 合成 fixture 测试通过；真实备份未验收 |
| OpenClaw | `847611dcaa3bf0e2783335f961dd1fd0580e4d9f` | `v2026.11.3`；agent schema 27 | 合成 fixture 测试通过；真实备份未验收 |
| OpenClaw | `0f327ca37eb7d2fcc85da6e98004bbd56ff35c3d` | 旧 JSONL 布局 | 未支持；不会伪报完整导入 |
| Hermes | `47edbcd170be6a2edf876eaa5c4b9a8595bc4cf0` | `state.db` schema 33；配置版本 53 | 合成 fixture 测试通过；真实备份未验收 |
| Hermes | `2bd378ed1b8d6bf2192cb26e0a55ff3091e6bd19` | `v0.23.0`；`state.db` schema 32 | 合成 fixture 测试通过；真实备份未验收 |

新版本 OpenClaw 的会话权威源不能用旧 JSONL 代替。Hermes 的 `sessions/sessions.json` 是路由索引，不代表完整历史。未知 schema、损坏库或缺少一致性证据的 SQLite 副本必须拒绝或明确报告未支持，不能声称完整迁移。

目录输入只允许服务端配置的只读挂载根。生产环境需要在 Linux 上核验挂载是只读的；无法确认只读时拒绝目录输入；扫描前也会拒绝可写的嵌套挂载。挂载表在检查后被特权进程更改时，应用无法提供原子隔离，部署环境必须固定挂载配置。ZIP 输入不访问宿主路径。严格模式拒绝符号链接和硬链接；ZIP64、分卷、加密 ZIP 和不支持的压缩方法会被拒绝。源文件不会作为命令执行。

迁移核心的计划、暂存、批次和归档记录保存在 `ControlStore`，属于现有数据库备份范围。计划哈希用于确认具体快照；服务端必须保存扫描和计划，不能信任客户端提交的完整清单或计划。源文本和历史工具结果是不可信数据。续聊必须创建新会话，不得重放历史工具调用。Skill 与 Cron 草案保持禁用，须经独立审查后由现有功能激活。已审查的 Memory 可经 `promoteMemory` 写入原生实体并参与 FTS；回滚遇到后续修改会报告冲突。

每个来源有两个固定上游版本的合成 fixture。尚无真实 OpenClaw/Hermes 备份的端到端验收记录；不能将合成 fixture 测试描述为真实来源验收。已验证的 OpenClaw 冷归档支持按文件或 SQLite blob 读取，并校验压缩内容和分块清单。`session_transcript_archives` 支持按 SQLite blob 校验 SHA-256 后解码 identity 或 zstd 数据。用户、助手、系统与工具文本按只读历史归档；工具参数仅保留摘要，不生成可执行调用。未知非文本块和未映射事件按类别报告。多代归档按会话合并，尚未跨代去重。受管附件目前仅支持受限大小的 PNG/JPEG；其他文件保留清单和哈希。MCP 草案仅保留服务名和传输类型；命令、参数、环境及地址须由 Owner 审查并重新填写。历史文本和图片采用确定性凭据识别，不能保证识别所有自定义秘密格式。
