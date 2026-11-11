# 记忆策略

`MemoryPolicyService` 已接入 ControlService、模型 `memory_save`、Owner HTTP 和 Memory 页面。模型提出候选，服务端绑定主体、作用域和来源；工具权限批准不能代替敏感内容批准。

普通候选经过确定性分类、同主体/作用域精确去重和同 key 冲突判断后写入。健康、财务、身份候选保持 `PENDING_REVIEW`，秘密和禁记类别拒绝。`CONFLICT` 须先修订或删除旧值后审核。未提供 key 时无法推断语义冲突，文字精确匹配不等于语义去重。

Owner 在“记忆策略与内容审核”中修改禁记类别、查看候选正文和哈希、批准或拒绝。`PATCH /memory-policy` 保存类别；`GET /memory-candidates?scope=owner` 返回候选；`POST /memory-candidates/{id}/decision` 输入 scope、exactHash、approve/reject。决策会复查哈希、归属、现有策略、重复和冲突。

Owner 直接新建或修改记忆也执行相同分类和禁记检查。敏感内容须在当前请求中显式 `confirmSensitive:true`；模型不能调用该可信入口。已逐条批准的敏感记忆带 `sensitiveApproved:true`，可以在授权作用域内检索。未批准候选不进入 FTS 或模型上下文。密码与密钥即使确认也拒绝。

候选和记忆保存在私人 SQLite 中，并非独立加密分类存储。备份包含这些私人内容，应保护备份；OAuth/模型秘密另用加密秘密库且从普通备份清除。分类仅检查明确类别和常见文字模式，不能保证识别所有语言、编码或隐含敏感语义。禁记策略影响后续写入与待审批准，不自动删除历史记忆。

`ControlStore` 是内部可信 API。对外读取必须执行身份和scope限制；模型查询采用会话绑定作用域，Owner API可以管理本实例全部作用域。删除或过期后不再索引，编辑/软删除经现有 memory_revisions 留痕。

验证：`tests/control-memory-policy.test.ts` 覆盖策略与哈希审核，`tests/control-memory-policy-http.test.ts` 覆盖真实HTTP禁记、批准后召回、修改重新确认和秘密拒绝。浏览器界面需随最终前端门禁验收，不能用模块测试代替。
