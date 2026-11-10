# 记忆与提示词

本轮提供有界、可检查的长期记忆，不引入向量数据库或无人审核的自动学习。

## 记忆结构

每条记录包含：id、content、scope、kind、source、createdAt、updatedAt；工具保存时还记录 conversationId。

- preference：用户偏好。
- fact：稳定事实。
- project：项目背景。

每个 scope 最多 50 条、6000 字符，每条最多 2000 字符。同一个 scope 中，相同内容与类型的新记录会返回已有记录。更新已有 id 时保留创建时间；未指定 kind 时保留原类型。来源记录最后一次保存来自 CLI、工具或旧版迁移，不构成内容正确性的保证。

```sh
npm start -- memory save '偏好先给结论再给证据' --id answer-style --kind preference
npm start -- memory search '偏好'
npm start -- memory list
npm start -- memory save '使用中文并引用来源' --id answer-style
npm start -- memory delete answer-style
```

远端身份需由本地管理命令显式指定 scope，例如：

```sh
npm start -- memory list --scope 'telegram:123456:7890'
npm start -- sessions --scope 'telegram:123456:7890'
```

本地 Unix socket 是管理员接口，可以显式选择 scope。消息平台没有暴露此接口。模型工具从会话的 Profile 取 scope，不接受用户提示词提供的 scope；同一个 id 可以在不同身份中存在，不会相互更新或删除。

`memory_search` 对当前身份的实时记忆执行 NFKC 归一化、不区分大小写的子串查询。`history_search` 使用现有全文检索，但在 SQL 中限制为当前身份拥有的会话。提醒列表、取消和收件箱也按相同作用域过滤。

## 快照与刷新

新会话在创建事务中保存本身份记忆快照，避免不相关的记忆修改导致每次请求都改变提示词。实时记忆工具反映最新状态。

```sh
npm start -- refresh-memory <会话ID>
```

显式刷新会更新该会话的快照。提交内检查运行状态，运行中拒绝刷新；先等回答完成或取消。消息渠道可使用 `/new` 建立新会话并读取最新快照。

删除长期记忆不会自动删除旧会话记录、旧快照或备份。需要让已有会话不再注入该条记忆时，删除后刷新或新建会话。

## 提示词文件

默认从安装目录的 prompts/ 读取：

- IDENTITY.md：身份、表达方式和执行原则。
- POLICY.md：工具证据、记忆处理、身份边界、时间与渠道规则。

可通过 ORANGE_PROMPTS_DIR 指向自己的目录。两份文件必须存在，合计最多 12000 字符。文件只作为文本读取，不执行代码。修改后重启 daemon；文件属于受信任的管理员配置，不由模型工具修改。

系统提示词按顺序包含 identity、policy、channel_context、memory 和 skills。channel_context 由服务生成；memory 使用 JSON 包装为资料，明确不能覆盖系统规则。当前时间通过工具提供，不在每次请求中动态改写系统提示词。

默认规则要求：

1. 只有工具提交成功后才能声称记住或设置提醒。
2. 用户明确要求时保存简短、可复用的记忆；纠错时更新已有 id。
3. 区分记忆、原始历史与推断；不把检索结果自动提升为事实。
4. 读取文件或历史后引用来源。
5. 按渠道使用短段落；相对时间先查询当前时间。
6. 不声称已经进行工具未支持的操作，不混淆本地收件箱、外部交付和用户已读。

这些是模型行为约束，不能替代代码权限控制。代码另外限制工具身份作用域、只读文件边界和私有数据目录。

## 旧数据迁移

orange.app、orange.profile 和 orange.reminder 从 v1 升级到 v2。已有记录归入 local；旧记忆标记为 fact、来源 legacy，创建时间沿用原更新时间；旧提醒保持原截止时间。实际 v1 SQLite 的记忆、会话和待执行任务迁移已纳入测试。

升级前仍应停止并备份。不要用旧版本程序打开已经升级后的数据目录。
