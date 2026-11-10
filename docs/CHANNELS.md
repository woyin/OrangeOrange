# 消息渠道接入

当前实现 Telegram 私聊、WhatsApp Cloud API 文本消息和微信 iLink 机器人私聊。没有接入普通微信群、企业微信、公众号、媒体消息或个人 WhatsApp 非官方协议。所有渠道默认关闭。

代码和协议替身测试可在没有账号的环境运行。真实账号还需要下面的配置、网络和平台授权。本轮没有真实账号联调结果。

## 公共行为

- daemon 与 CLI 共用同一份 Pi Durable 存储和文件锁，不启动另一个写入运行时。
- 必须明确允许的发送者；不提供开放给所有人的默认入口。只响应私聊文本。
- 输入以平台、账号、聊天和消息 ID 生成去重键。消息输入与回复跟踪任务在同一提交内保存。
- 长轮询只在消息接收成功后保存游标；回调只在持久化接收后返回成功。
- 每个账号和发送者使用独立身份作用域，历史、记忆、提醒和收件箱按该作用域过滤。
- 同一聊天的回复按队列顺序发送，长消息分段，不交错发送后续回复。
- 发送意图先提交。网络超时、异常响应或发送中崩溃会留下 unknown；不会自动猜测发送失败并重发。
- 明确限流响应最多尝试三次。其他明确拒绝记为 failed。失败和未知不会自动阻塞其他新回复，但旧投递需要人工处理。
- 移除发送者授权后，尚未发送的回复会失败，不继续发给被移除的用户。

常用命令：

```sh
npm start -- channels
npm start -- deliveries
npm start -- delivery retry <投递ID>
npm start -- delivery discard <投递ID>
```

`channels` 显示配置，不等于平台已成功连通。`deliveries` 显示等待、发送、成功、失败和未知状态，不显示登录 token 或微信 context_token。`retry` 只用于 failed 或 unknown，并复用原回答和未确认消息段，不重新调用模型。对 unknown 重试仍可能产生重复消息，因为平台可能已经接受原请求。

渠道中发送 `/new` 会创建新会话并加载最新记忆。其余斜杠文本目前作为普通输入。可在本地通过 `sessions --scope ...` 查询会话，使用 `cancel` 取消运行。

## Telegram

使用 Bot API 的 getUpdates 长轮询和 sendMessage，不需要公网回调。

```sh
export OPENAI_API_KEY='你的模型凭据'
export ORANGE_TELEGRAM_TOKEN='BotFather 提供的 token'
export ORANGE_TELEGRAM_USERS='你的数字用户ID'
npm start -- daemon
```

多个允许用户用逗号分隔。用户 ID 与用户名不同，不能填写 @username。机器人只响应 private chat；群消息、机器人消息和非文本附件被忽略。

同一个 bot 只运行一个轮询网关。若此前配置了 webhook，需要先在 Telegram 侧关闭；本程序不会自动删除已有 webhook。API token 不写入 Durable 文档或日志。

默认记忆作用域：`telegram:<bot数字ID>:<用户数字ID>`。

## WhatsApp

使用 Meta WhatsApp Cloud API 的业务号码，不是个人 WhatsApp 扫码登录。

```sh
export OPENAI_API_KEY='你的模型凭据'
export ORANGE_WHATSAPP_TOKEN='Meta access token'
export ORANGE_WHATSAPP_PHONE_ID='业务号码的 phone_number_id'
export ORANGE_WHATSAPP_API_VERSION='v23.0'
export ORANGE_WHATSAPP_APP_SECRET='Meta 应用密钥'
export ORANGE_WHATSAPP_VERIFY_TOKEN='自行设置的回调校验字符串'
export ORANGE_WHATSAPP_USERS='允许的发送者号码或平台ID'
export ORANGE_WHATSAPP_PORT='8788'
npm start -- daemon
```

API 版本示例需要替换为你的 Meta 应用当前支持的版本。本程序要求显式指定版本。业务号码 ID 不是展示给用户的电话号码。允许的发送者需与 webhook 的 `messages[].from` 完全一致，通常为不带 `+` 的国际号码。

设置 Meta 回调 URL 为：

```text
https://你的公网域名/webhooks/whatsapp
```

本地服务器只监听 `127.0.0.1:<配置端口>`。你需要自行提供 HTTPS 反向代理或隧道，并仅转发上述路径；本轮没有创建公网资源或部署隧道。GET 挑战使用 verify token，POST 使用原始请求体和应用密钥验证 X-Hub-Signature-256。还会校验 phone_number_id，只处理 messages 中的文本。

只实现用户发消息后 24 小时内的自由文本回复。窗口过期时保存 failed，不尝试绕过窗口，也没有实现模板消息。因此较久后的主动提醒可能只进入本地收件箱，外部投递失败；用户再次发消息后可以人工重试。

默认记忆作用域：`whatsapp:<phone_number_id>:<发送者ID>`。

## 微信

使用 iLink Bot API 的独立机器人身份。微信账号扫码用于授权机器人，不表示普通个人账号的全部联系人和群聊都可由程序控制。当前只处理私聊文本，不实现媒体 CDN 或普通微信群。

先停止 daemon，再登录：

```sh
npm start -- stop
npm start -- weixin login
```

CLI 展示终端二维码和扫码链接。用微信扫描并在手机上确认。成功后输出账号及用户 ID，不输出 token；凭据保存到数据目录下的 `weixin-credentials.json`，权限为 0600。登录时持有同一个数据目录排他锁。

随后启动：

```sh
export OPENAI_API_KEY='你的模型凭据'
export ORANGE_WEIXIN_ENABLED='1'
npm start -- daemon
```

未设置 ORANGE_WEIXIN_USERS 时，只允许扫码凭据中的 user。也可显式设置允许列表：

```sh
export ORANGE_WEIXIN_USERS='允许的 iLink user ID'
```

已有 token 时可改用环境变量，不读取保存的文件：

```sh
export ORANGE_WEIXIN_ACCOUNT_ID='iLink bot ID'
export ORANGE_WEIXIN_TOKEN='iLink bot token'
export ORANGE_WEIXIN_USERS='允许的 iLink user ID'
```

程序使用 getupdates 长轮询，保存 get_updates_buf 和每个 peer 的 context_token，回复时携带 context_token 与稳定 client_id。没有 context_token 时拒绝主动发送；会话过期后需要用户先给机器人发消息，必要时重新扫码。不会在错误后自动去掉 token 盲目重发。

iLink 的接口形状参考当前 Hermes 微信适配器；本轮通过协议替身测试，尚未用真实微信账号验证服务可用性、账号资格和长期行为。默认作用域为 `weixin:<iLink bot ID>:<iLink user ID>`。

## 同一用户跨平台共享记忆

默认隔离更容易避免误读。若三个平台确实都是你本人，每个平台只允许一个明确用户时，可以显式绑定到已有 CLI 身份：

```sh
export ORANGE_TELEGRAM_MEMORY_SCOPE='local'
export ORANGE_WHATSAPP_MEMORY_SCOPE='local'
export ORANGE_WEIXIN_MEMORY_SCOPE='local'
```

只需设置实际启用的平台。程序拒绝把含多个允许用户的渠道绑定到同一个共享作用域。共享后，记忆、历史与提醒可互相访问，但不同渠道仍保留独立对话和投递目标。配置共享后，用 `/new` 创建新会话。

不要把不同人的账号绑定到同一个 scope。所有获准用户目前读取同一个配置工作区；作用域隔离不等于操作系统或工作区文件隔离。`read_file` 额外禁止读取代理私有数据目录。

## 提醒、备份和恢复

由渠道会话创建的提醒保留来源路由。到期后先写入本地收件箱，再由可恢复队列发回来源私聊。外部发送成功不自动把通知标为已读。CLI 创建的提醒没有来源渠道，仍只写本地收件箱。

现有备份会保存路由、轮询游标、回复跟踪和微信 context_token；它们属于私有数据。不会保存 Telegram/WhatsApp 环境 token 或微信登录凭据文件。恢复后需重新提供渠道凭据。不要同时运行备份与原实例去消费同一账号。

## 验证命令与资料

```sh
npm run test:channels
npm run test:memory
npm run typecheck
npm test
npm run build
```

测试只使用本地 HTTP 和协议替身，不向真实用户发消息。

- Telegram Bot API：https://core.telegram.org/bots/api
- WhatsApp webhooks：https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks
- Hermes 微信说明：https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/messaging/weixin.md
- Hermes 微信协议参考：https://github.com/NousResearch/hermes-agent/blob/main/plugins/platforms/weixin/adapter.py
