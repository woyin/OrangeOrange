# 安全边界

本文是SRS v1.0实施约束，完成状态以IMPLEMENTATION_STATUS.md与AT-RESULTS.md为准。

Owner通过认证Web管理配置。Telegram allowlist只允许发起任务，不自动等于Owner。Agent、Skill、网页、IM与模型输出不能授予权限。未知主体、未知或停用工具默认拒绝。

容器不得拥有shell工具、Docker Socket、宿主机根目录、host网络或OpenWrt管理路径。生产非root、只读根、cap-drop ALL、no-new-privileges，工作区与私有数据隔离。文件工具拒绝整个数据目录和主密钥路径，并检查真实路径及符号链接。

密码采用明确参数与版本的scrypt随机盐哈希。session token随机生成，仅存摘要；过期和密码变更撤销会话。写API需认证、CSRF、Origin、字段白名单、大小及频率限制。Idempotency-Key绑定请求内容，冲突409。

默认宿主端口127.0.0.1:8787。localhost HTTP不是TLS；LAN/VPN须可信TLS代理、准确公开origin及受限来源，不信任任意代理头。不默认暴露WAN。

密钥用AES-256-GCM与每条随机nonce加密，名称为AAD。主密钥从HDA_MASTER_KEY_FILE或私有master.key读取，文件0600，数据目录0700。已有数据丢失主密钥时拒绝自动生成替代密钥。

GET仅返回密钥配置状态。错误、事件、诊断、审计和日志不得包含token、Cookie、Authorization、用户正文或Memory。审计append-only仅是应用级保护，不抗宿主机管理员改盘。

审批绑定规范参数哈希、主体、任务、工具和过期时间，只消费一次。批准不能产生不存在的高危执行器。非幂等动作执行前持久化意图，执行后缺确认则UNCERTAIN，不自动再执行。任务成功与投递成功分开，发送缺确认标DELIVERY_UNCERTAIN；发送前重新检查授权。

HTTP工具仅公开HTTP(S)标准端口，拒绝私有/保留/loopback/link-local/metadata及混合DNS，固定验证地址连接，逐次验证重定向。带搜索凭据的请求不随重定向转发。执行有超时、取消和字节上限。

备份移除应用secrets/sessions，不含master.key；但仍含私人任务、Memory与transcript，必须认证保护并加密存放。用户将秘密写入聊天时不会自动从不可变transcript或旧备份消失。恢复后需重新配置凭据。

schema不兼容进入维护模式，低磁盘进入保护模式，拒绝新任务写入并提供可读错误。CI扫描配置不等于已通过扫描；真实平台、目标设备及故障验收未完成不得宣称可发布。
