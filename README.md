# OrangeOrange

基于 Pi Durable 1.5.0 的本地代理。提供持久化对话、只读资料工具、人工技能、分身份长期记忆、中文历史搜索和一次性提醒。已增加 Telegram、WhatsApp Cloud API 与微信 iLink 的私聊文本接入，以及通用提示词定时任务、在线搜索和网页读取工具。

当前使用说明见 [定时任务与联网](docs/SCHEDULES.md)、[渠道接入](docs/CHANNELS.md)、[记忆与提示词](docs/MEMORY.md) 和 [本轮验收记录](docs/PHASE3-ACCEPTANCE.md)。真实模型与真实平台账号仍需凭据和联调；首版历史记录见 [MVP 验收记录](docs/ACCEPTANCE.md)。

完整测试命令为 `npm run test:all`。浏览器、故障注入、容器和72小时脚本说明见[测试与验收](docs/TESTING.md)。本地模拟供应商通过不等于真实模型或Telegram联调通过。

## 环境与安装

当前验证环境：macOS，Node.js 24.14.1，npm 11。项目固定 Node 24 系列和依赖版本。`fs-ext` 使用系统文件锁，安装时需要可用的本地编译工具；macOS 可使用 Xcode Command Line Tools。暂不支持 Windows。

```sh
npm ci
npm run typecheck
npm test
npm run build
```

开发入口是 `npm run dev -- <命令>`。构建后可直接使用 `node dist/cli.js <命令>`。以下示例使用构建产物，无需全局安装。

## 启动与首次对话

在终端 A 配置服务并保持运行：

```sh
export OPENAI_API_KEY='你的 API key'
export ORANGE_WORKSPACE="$HOME/Documents"
export ORANGE_SKILLS_DIR="$PWD/skills"
node dist/cli.js daemon
```

程序不会自动读取 `.env`。配置样例见 [.env.example](.env.example)。默认模型是 `gpt-4.1-mini`；可用 `ORANGE_MODEL` 选择 Pi 内建 OpenAI 目录中的模型。当前版本只支持 OpenAI API key，不读取 Pi CLI 的登录凭据。

在终端 B 操作：

```sh
node dist/cli.js new 日常助手
node dist/cli.js sessions
node dist/cli.js chat <会话ID>
```

`chat` 每行提交一个输入。`/exit` 退出客户端。`/cancel` 取消当前执行及排队输入。等待回答期间可在另一个终端运行 `cancel`。关闭客户端不会取消服务中的工作。

也可单次提交并稍后查询：

```sh
node dist/cli.js ask <会话ID> '请读取 项目说明.md 并引用来源' --request-id review-001
node dist/cli.js input <返回的输入ID> --wait
node dist/cli.js status
```

输入提交前会把 requestId 打印到 stderr。连接中断时，用同一个 requestId 和同一个会话重试 `ask`，或查询已经拿到的输入 ID。相同 ID 采用第一次提交的内容，不会创建第二次输入。`--wait` 最多等待三分钟；超时只停止等待，不取消任务。

`status` 显示运行任务、失败、输入队列和模型用量。金额来自 Pi 的模型目录，只是估计；目录价格为零或缺失时不能据此认定实际免费。费用不会被作为硬性额度执行。

## 记忆、资料与技能

```sh
node dist/cli.js memory save '偏好先给结果，再给证据' --id response-style
node dist/cli.js memory list
node dist/cli.js memory save '偏好简明回答并引用来源' --id response-style
node dist/cli.js memory delete response-style
```

每个身份作用域的记忆最多 50 条、总计 6000 字符，每条最多 2000 字符。记录包含类型、来源和创建/更新时间。新会话保存记忆快照；更新或删除后，可新建会话或执行 `refresh-memory <会话ID>`。运行中拒绝刷新。`memory_search`、`memory_list` 和 CLI 查询实时状态。默认渠道身份独立，显式共享方法见接入说明。

代理也可以通过 `memory_save` 等工具管理记忆。只有工具提交成功才算保存，文字确认不构成证据。

每个会话固定绑定创建时的工作区。`read_file` 只读取其中的普通 UTF-8 文件，最大 128 KiB，拒绝目录穿越、符号链接越界和二进制文件。`read_file` 还禁止读取代理私有数据目录。工作区不是操作系统沙箱；不要让不受信任的其他进程同时替换工作区目录结构。本版没有 Shell、文件修改和浏览器工具。

```sh
node dist/cli.js skills
node dist/cli.js skill document-review
```

技能目录格式为 `<技能目录>/<名称>/SKILL.md`。名称仅支持小写英文字母、数字和连字符，最长 64 字符。元数据仅解析以 `---` 包围的 frontmatter 中单行 `description:`，描述最长 300 字符。目录名作为技能名称；不是完整 YAML 或完整 Agent Skills 实现。启动时加载描述，工具按需读取正文；修改描述后需重启服务。技能中的脚本不会执行。

内置示例是 [document-review](skills/document-review/SKILL.md)。技能可用工具为：`current_time`、`read_file`、`memory_list`、`memory_search`、`memory_save`、`memory_delete`、`history_search`、`skill_load`、`reminder_create`、`reminder_list`、`reminder_cancel`。

## 历史与中文搜索

```sh
node dist/cli.js history <会话ID> --limit 20
node dist/cli.js history <会话ID> --before <上一页before值> --limit 20
node dist/cli.js search 发布检查
node dist/cli.js reindex
```

历史按记录 ID 倒序分页，页大小为 1–100。会话列表展示最近 100 条记录中可见的用户会话。

搜索按身份作用域过滤，返回原文、conversationId 和 entryId。CLI 默认 local，可用 `--scope` 指定管理员查询范围。中文按单个汉字切分，其他文字按 Unicode 单词切分，多词使用 AND 匹配；这不是语义搜索，也不是短语顺序匹配。最多返回 20 条。仅索引已持久化的用户与正常助手文本；不索引系统提示词、完整工具输出、流式片段和服务环境配置。用户主动输入的敏感文本仍属于会话数据，应按私有数据管理。

原始记录位于 `state.sqlite`；`history.sqlite` 是可重建投影。索引记录与增量游标在同一索引事务中提交。服务启动时补追，`reindex` 全量重建。索引丢失后会自动从原始记录恢复。若索引文件损坏导致无法启动，停止服务后移走 `history.sqlite` 及其 `-wal`、`-shm` 文件，再启动；不要移走 `state.sqlite`。

## 一次性提醒与收件箱

```sh
node dist/cli.js remind '2026-12-01T09:00:00+08:00' '检查发布情况' --timezone Asia/Shanghai --id release-check
node dist/cli.js reminders
node dist/cli.js unremind release-check
node dist/cli.js inbox
node dist/cli.js ack <通知ID>
node dist/cli.js inbox --all
```

示例时间需替换为你的目标时间。`at` 必须包含 `Z` 或 UTC 偏移，决定绝对执行时间。`timezone` 是 IANA 时区，用于当地时间展示。未提供时区展示参数时使用服务本机时区。返回值同时包含 epoch 毫秒、UTC ISO 时间和当地时间。

到期后，任务在一次 Durable 提交中写入唯一收件箱通知并把提醒标为 delivered。渠道会话创建的提醒另由持久化队列发回原私聊；平台发送成功与已读状态仍分开，WhatsApp 还受 24 小时回复窗口限制。用户执行 `ack` 后通知才是 read。打印到终端不算已读，因此终端可能再次展示未确认通知。

服务关闭或主机休眠时不保证准点交付。重启或恢复运行后补交付所有已到期且未取消的提醒。取消先提交则不交付；交付先提交则取消返回 delivered。已经取消的休眠任务可能保留到原截止时间，但不会生成通知。

提醒到期不调用模型。无 API key 时，CLI 记忆、历史、资料之外的直接管理命令与提醒仍可使用；只有模型输入提交会明确报缺少凭据。

## 停止、备份与恢复

```sh
node dist/cli.js stop
node dist/cli.js backup /绝对路径/orange-backup
```

备份需要服务已经停止，且目标目录不存在、位于数据目录之外。命令在取得同一文件锁后，通过 SQLite 备份 API 生成包含 WAL 已提交内容的一致性快照。备份包含原始会话、记忆、提醒和提交状态，不包含模型凭据、工作区文件或技能。历史索引可重建，无需备份。

恢复到一个不存在的数据目录：

```sh
ORANGE_DATA_DIR=/绝对路径/restored-orange node dist/cli.js restore /绝对路径/orange-backup
ORANGE_DATA_DIR=/绝对路径/restored-orange node dist/cli.js daemon
```

所有访问该实例的 CLI 都必须使用相同的 `ORANGE_DATA_DIR`。已恢复会话仍引用原工作区路径；文件和技能需单独保留。恢复后的过期提醒会补交付。

## 数据与恢复边界

默认数据目录是 `~/.orangeorange`。`ORANGE_DATA_DIR` 可覆盖。目录权限设为 0700，socket 权限为 0600。管理员 API 只监听 Unix socket。仅启用 WhatsApp 时，会另在配置的 127.0.0.1 端口监听验签回调，不暴露管理员 RPC。

一个 daemon 在打开数据库前持有 `flock` 排他锁。另一个 daemon 或离线备份不能同时打开写入运行时。锁由操作系统在进程退出时释放，锁文件本身不删除。客户端不能直接打开 Harness。

SQLite 默认 WAL + synchronous=NORMAL 能恢复进程崩溃，但断电或宿主存储故障可能丢失最新提交。它不替代备份。

正在流式生成的片段默认可能丢失约一秒；最终结果以持久化提交为准。模型请求中断后按 Durable 策略重试，不保证生成同一回答。每次生成请求超时 60 秒，最多 2 次 Durable 重试，SDK 内重试关闭；每次 run 最多 12 轮工具调用，生成输出最多 2048 token。不自动续跑，不启动子代理。上下文压缩可能另有模型开销，没有硬性总费用承诺。

任务从持久化检查点恢复，不恢复普通 JavaScript 调用栈。只读工具可重新读取，文件变化时结果可能不同。模型从已经提交的工具结果继续。本版不承诺任何外部副作用的恰好一次执行。

结构化运行日志写入 stderr，只记录生命周期和错误类别，不主动记录消息、工具正文或 API key。会话数据库仍保存实际消息与工具结果。

## 验证与升级

```sh
npm run typecheck
npm test
npm run build
npm run smoke:live
# 在独立临时目录重新安装、构建并验证编译后的程序：
npm run smoke:install
```

渠道配置见 [CHANNELS.md](docs/CHANNELS.md)，提示词文件为 `prompts/IDENTITY.md` 与 `prompts/POLICY.md`，可通过 `ORANGE_PROMPTS_DIR` 指定，修改后重启服务。

单项命令：`test:schedules`、`test:web`、`test:channels`、`test:ownership`、`test:recovery`、`test:cli`、`test:workspace`、`test:skills`、`test:memory`、`test:history`、`test:reminders`。

普通测试使用模型替身，不访问付费 API。恢复测试会对独立子进程发送 SIGKILL。真实模型冒烟测试需要 `OPENAI_API_KEY` 和已构建的 `dist/`，使用临时数据目录执行实际 CLI 和工具流程。无凭据时返回退出码 2，并明确标为 BLOCKED。它会产生真实 API 费用，沿用上述每请求和每 run 限制。

Pi Durable 仍为实验性 API。当前固定 1.5.0，禁止直接对生产数据自动升级。先停止、备份，再用备份副本验证旧任务恢复和迁移；本项目的阶段迁移测试仅证明机制可用，不代表任意未来版本都兼容。

具体实现阶段见 [开发计划](MVP-PLAN.md)，当前证据见 [验收记录](docs/ACCEPTANCE.md)。
