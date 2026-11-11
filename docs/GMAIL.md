# Gmail 发送后端

本模块提供 OAuth、动作审批和 Gmail 发送能力，并已接入控制服务 HTTP 接口。Google 的 `gmail.send` 是敏感权限；公开发行可能需要 Google 审核。当前仅请求这一权限，不读取邮箱。真实 Google 账号授权和发送尚未验收。

## 接入

从 `src/connectors/index.ts` 导入 `createGmailConnector`。传入 `ControlStore`、`oauth`（`clientId`、可选 `clientSecret`、精确 HTTPS `redirectUris`）、`ArtifactStore`、`accountForConnection`，以及测试用可选 `fetcher`、`now`。返回 `{oauth, actions}`。该工厂的 OAuth 配置对应一个 OAuth Client；多个 Client 的配置、待授权 state 与连接 ID 的映射由服务端管理。Client Secret 不得放入普通实体。`accountForConnection` 必须从 Owner 控制的绑定取得地址；仅凭 `gmail.send` 不能独立核验邮箱地址，界面必须说明地址由 Owner 确认。

OAuth 使用 `startAuthorization({principalId:'owner',redirectUri})` 和 `completeAuthorization({state,code})`。回调可无 Cookie；单用 state 绑定 Owner 和精确回调地址。客户端密钥和 token 不得提供给模型。`connection(id,'owner')`、`connections('owner')`、`publicStatus(id)` 读取状态；`refresh(id,'owner')`、`revoke(id,'owner')` 管理授权。`fetch` 仅替换传输，Google 请求地址固定。主服务必须认证调用方、保护写入操作和 OAuth 回调输入。

模型只获得 `actions.proposalApi({principalId,taskId,profileId,workflowId})`，这些值必须由服务端认证上下文决定。`invoke` 只创建提议；不可向模型暴露 `actions`、OAuth 或 `execute`。Owner 可提议，其他身份需要 Owner 用 `grant('owner', grant)` 对账号、身份、profile、task、workflow 精确授权。可信服务可以调用 `propose`；不得从模型参数采信身份。只有经认证的 Owner 才能调用管理方法；字符串 `owner` 本身不是身份认证。

Owner 使用 `preview('owner', id)` 查看完整快照和 `inputHash`，再调用 `approve('owner', id, inputHash)`。调用 `execute('owner', id, inputHash)` 发出一次；`dryRun` 不发送，`cancel` 仅取消未开始动作。`list('owner')` 和 `get(id)` 返回状态；应限制读取权限。启动时，在接受发送前调用一次 `recoverInterrupted()`。它把中断的 `DISPATCHING` 改为 `SEND_UNCERTAIN`；不能重发该意图。要再次发送须建立新意图并重新授权，提醒用户可能重复。Gmail API 返回 message ID 不表示最终送达。

`setRule('owner', rule)` 设置明确的账号、profile、workflow、template、收件人或域名、有效期、每日限额、最小间隔和禁止的附件类型。`templateHash` 使用 `mailTemplateHash(preview.proposal.mail)` 计算，绑定完整邮件和附件摘要。改变内容需要新规则或人工审批；日期预算以 UTC 日计算。规则预算只约束规则授权的发送，人工逐次批准的发送不消耗规则预算。所有发送另外共享硬上限：UTC 日全局 200 次、每个账号 100 次，全局最小间隔 500 毫秒、账号最小间隔 1000 毫秒。预算以发送登记时间计数，包括不确定和失败的尝试。

附件输入只能是 `{artifactId,filename}`。`artifacts.read(id)` 返回 `bytes`、`sha256`、`mimeType`；提议时将大小、类型和 hash 纳入快照，发送前重新读取并核验。HTML 只允许无属性的 `p`、`br`、`b`、`strong`、`em`、`i`、`ul`、`ol`、`li`、`blockquote`、`pre`、`code` 标签；其他标签和属性会被拒绝。地址、MIME 编码、附件大小和文件名在发送前校验。

## 状态、恢复和限制

普通备份保留连接元数据和意图状态，但现有备份流程删除所有 secrets，包括 OAuth 凭据和待审邮件正文。恢复后 OAuth 连接显示 `NEEDS_REAUTH`，原待审意图缺正文时不能预览或发送，需要重新创建。审计和持久事件只存摘要；正文快照存于 AES-GCM secrets，预览须认证。主服务按 `finishedAt` 清理终态正文；`gmailBodyRetentionDays` 默认为 0，可设置为 0–365 天。受管附件由现有 ArtifactStore 负责访问控制和备份。

发送超时、网络中断、5xx 或成功响应缺少 Gmail ID 都视为 `SEND_UNCERTAIN`；不会自动重试。401 为 `NEEDS_REAUTH`，429 为 `RATE_LIMITED`，403 为 `FORBIDDEN_OR_QUOTA`，其他明确 4xx 为 `FAILED_VALIDATION`。在没有读取权限时，不可假设能查询已发送邮件来消除不确定性。

自动测试使用假上游，不代表真实发送验收。建议 Owner 使用独立 Google 测试项目和受控收件箱完成授权、发送及响应丢失检查，保留脱敏证据。

## Google 官方文档

- [OAuth 2.0 for Web Server Applications](https://developers.google.com/identity/protocols/oauth2/web-server)
- [OAuth 2.0 for Mobile & Desktop Apps：PKCE](https://developers.google.com/identity/protocols/oauth2/native-app)
- [Gmail API scopes](https://developers.google.com/workspace/gmail/api/auth/scopes)
- [Send email](https://developers.google.com/workspace/gmail/api/guides/sending)
- [users.messages.send](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/send)

HTTP 路由、Owner Cookie 与写入保护、callback 的单用 state/PKCE 和 303 响应见 [v1.1 HTTP 接入约定](V1.1-HTTP-CONTRACT.md)。callback 不依赖 Cookie，响应包含 `Referrer-Policy: no-referrer`。Owner 创建连接时必须确认地址；该确认不等于 Google 身份核验。
