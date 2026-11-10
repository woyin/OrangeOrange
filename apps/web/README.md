# Web 控制台

在此目录运行 `npm ci`、`npm run typecheck`、`npm test`、`npm run build`。静态产物位于 `apps/web/dist`，由生产控制服务提供。开发命令 `npm run dev` 仅绑定 localhost，`/api` 代理到 `http://127.0.0.1:8787`。

页面覆盖 WEB-001 至 WEB-014。全部写操作请求实际 `/api/v1` API，使用同源 cookie、CSRF 与幂等键。表单凭据字段不会从 GET 数据填充。运行状态通过 SSE 事件触发补拉，保存单调 cursor；断线每三秒重连，十秒轮询提供额外补偿。409/410 与 reset/resync 事件要求全量刷新。

`src/events.check.ts` 验证命名事件、多行正文、注释与游标重置解析。界面使用文本渲染不可信正文与 Skill 内容，不注入 HTML。样式在 700px 以下切换顶部滚动导航，核心表单适配 390px。

边界：本目录构建与解析单测不能替代服务端安全测试、真实模型/Telegram、浏览器端到端、ARM64/AMD64与72小时验收。已按 `docs/CONTROL-API-CONTRACT.md` 适配，`npm run test:integration` 使用root已安装tsx运行前端客户端到真实ControlServer的HTTP契约检查。技能启停按name调用真实PATCH接口，系统指令按服务端任务快照应用于后续新建任务。保留期清理、备份下载/诊断包等仍受服务端能力边界限制，不能据此宣布SRS全部完成。附件当前只展示服务端已有状态。
