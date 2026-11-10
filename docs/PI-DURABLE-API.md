# Pi Durable 1.5.0 已核实 API

来源为锁定 npm 包内官方英文 README、CHANGELOG、dist/*.js 与 *.d.ts。业务唯一入口由 src/pi-adapter.ts 封装；下列为上游 API，不是项目 REST API。

| 能力 | 真实接口及限制 |
|---|---|
| 打开 | Harness.open(storage, {models, registry}, context) |
| SQLite | openNodeSqliteStorage(path)，导入 /storage/sqlite/node；底层使用 Node SQLite，WAL/NORMAL |
| 会话 | harness.root(context, options)，conversation.submit({type:'input',content,requestId}, context) |
| 去重 | 相同 requestId 找回原 Submission；项目仍须核对请求内容冲突 |
| 恢复 | harness.resume() 启动调度；submit/wait 也会启动。重新打开不会自动补偿外部副作用 |
| 等待 | submission.wait(context)；取消等待不等于取消工作 |
| 工具 | defineTool + defineExtension + registry.install；意图先提交，只有 replay:'safe' 才会在中断后重跑 |
| 任务 | defineTask，phase 检查点与 api.commit/sleepUntil，version/migrate |
| 取消 | Conversation.abort / Harness.abortTask（见锁定 d.ts）；业务取消通过适配器映射 |
| 订阅 | watch/observeConversation/observeTaskGraph/observeDoc；Chord tagged WatchCall，不能假设 CLI Extension API |
| 用量 | 持久化 pi.usage；上游报告/估算值不是最终账单 |
| 存储所有权 | 同一 storage 只准单进程；上游没有跨进程锁，应用必须提供锁 |

模型中断可能重新请求并再次计费。非幂等工具中断必须转不确定状态，由应用核实；不能用 replay-safe 标记替代外部幂等。Subagent 为上游能力，项目 P0 不启用。
