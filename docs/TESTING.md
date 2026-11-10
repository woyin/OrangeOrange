# 测试与验收

需求基线为[SRS](SRS.md)。本地测试通过、容器测试通过、真实外部服务验收是不同证据层级。`faux`仅模拟上游模型，仍运行实际Pi Harness、ControlService、HTTP、SQLite与策略；测试不模拟这些业务组件。

## 本地完整门禁

使用锁定的Node 24版本，安装根与Web依赖，安装测试浏览器：

```sh
npm ci
npm --prefix apps/web ci
npx playwright install chromium
npm run test:all
```

`test:all`依次执行根类型检查、全部Vitest用例、服务端/Web生产构建、前端SSE解析测试、真实HTTP客户端契约测试和Playwright浏览器测试。浏览器按1280 px桌面和390 px手机执行，启动实际HTTP后端与临时SQLite，不拦截或Mock后台请求。首次设置用默认模型目录仅验证配置保存，不调用付费模型；任务执行用faux供应商。

## 新增的关键回归

| 文件 | 行为与故障边界 |
|---|---|
| tests/control-runtime-extended.test.ts | 模型/工具预算在发送前拒绝；RUNNING暂停/继续；PAUSED跨重开保留原submission；取消后不新增步骤；记忆owner/Telegram隔离与删除；429/503/timeout有界重试；写入后不自动切换重放；审批跨重开与参数哈希 |
| tests/control-security-extended.test.ts | OpenAPI中全部受保护路径及SSE拒绝匿名；Origin/CSRF；幂等跨路由冲突及重开 |
| tests/control-crash.test.ts | 真实子进程SIGKILL：模型inflight恢复同task/input；非幂等executor副作用后确认前中断保UNCERTAIN；出站发送后丢确认保DELIVERY_UNCERTAIN；效果计数仅一次 |
| tests/control-backup-http.test.ts | 备份凭据/session清除及SQLite旧页；恢复后旧cookie无效；篡改hash拒绝；WAITING_APPROVAL和model-inflight活动备份；原submission继续；独立数据目录恢复两库后执行；启动journal先独占再恢复；并发写入屏障；部分关闭失败保持维护 |
| tests/control-boundary.test.ts | 不可信输入引导真实read_file越界仍拒绝；Owner禁用后新工具调用立即拒绝 |
| tests/control-outbound-authorization.test.ts | 收件人撤权后旧队列不发送，仍授权私聊正常，后续tick不重发 |
| tests/control-maintenance-http.test.ts | 维护接口匿名拒绝、导出秘密扫描、真实RSS、清理后的入站去重墓碑 |
| tests/pi-adapter.test.ts | 注入可变模型目录可配置供应商且保留原faux，关闭幂等由备份故障回归覆盖 |
| tests/browser/console.spec.ts | 首次配置、登录/注销、聊天/刷新历史、Memory检索删除与取消确认、Cron编辑预览、工具/技能开关、审批篡改与批准、11页面无横向溢出 |

另保留原SQLite恢复故障注入、SSRF重定向/DNS、文件路径、记忆FTS、调度DST、append-only审计和单写锁测试。新增测试先复现真实失败，再修复源；不以skip/todo代替可执行断言。

## 容器门禁

```sh
docker build --target runtime -t hda:testfill-runtime -f deploy/Dockerfile .
HDA_TEST_IMAGE=hda:testfill-runtime node deploy/smoke.mjs
docker build --target probe -t hda:testfill-probe -f deploy/Dockerfile .
```

`deploy/smoke.mjs`创建独立容器及命名卷，检查非root、只读根、cap-drop、健康/Web、匿名拒绝、首次设置、初始化后重启保留cookie与会话、双库备份恢复及旧session撤销。最终清理容器和卷。不修改生产卷，不验证真实模型/Telegram。

`.github/workflows/containers.yml`在原生AMD64/ARM64 runner构建镜像，运行全部根测试和容器smoke；另运行浏览器/客户端契约/短时soak、依赖扫描、容器扫描与Secret扫描。CI配置存在不代表远程CI已执行成功。

## 72小时稳定性脚本

```sh
npm run test:soak
```

默认实际运行72小时，每30秒提交一个任务。使用真实控制面/SQLite，按固定频率注入模型503和Telegram发送确认丢失。采集峰值RSS、运行数、队列、失败任务和不确定投递；每分钟更新`artifacts/control-soak.json`。队列超过100、并发超过2、RSS超过1 GiB或worker报错时失败；结束后有界排空已受理任务。SIGTERM/SIGINT保留中断报告并返回非零。

快速检查脚本自身：

```sh
npm run test:soak -- --duration-seconds=15 --interval-seconds=1
```

短跑报告明确`full72Hours:false`；不会改写发布验收结果。该脚本检测队列/资源边界，不等于已经证明无内存泄漏，也不能替代真实模型或IM服务长期连通测试。

## 发布边界

`npm run release:check`继续检查全部AT、两个目标架构、真实OpenWrt、真实模型/Telegram和72小时证据。未完成项保持非PASS。真实账号、目标设备和72小时不可用时，使用本报告中的本地证据并明确缺口，不把模拟服务测试记成真实外部验收。
