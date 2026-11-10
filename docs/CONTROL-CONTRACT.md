# P0 并行模块契约

现有 CLI 保留。生产入口为 src/control/main.ts，Web 静态资源为 apps/web/dist，运行数据为 /data。业务只通过 src/pi-adapter.ts 调用 Pi Durable；应用数据库为 /data/app.sqlite，Pi 文件在 /data/pi/state.sqlite。

## Store（foundation actor）

导出 ControlStore class from src/control/store.ts；constructor(dataDir:string)。同步 Node SQLite，WAL/FULL，schema migration 与维护模式。方法：get<T>(kind,id):T|undefined；list<T>(kind):T[]；put(kind,id,value,actor="system"):void；remove(kind,id,actor="system"):void；transaction<T>(fn:()=>T):T；setting<T>(key,fallback):T；setSetting(key,value):void；event(type,entityId,payload?):number；events(after=0,limit=100):ControlEvent[]；audit(actor,action,target,result,requestId?):void；setSecret(name,value):void；getSecret(name):string|undefined；deleteSecret(name):void；secretMetadata():{name:string,configured:boolean}[]；searchMemories(query,scope?):any[]；close():void。公共 db: DatabaseSync 可用于在线备份。凭据 AES-GCM 加密，master key 来自 HDA_MASTER_KEY_FILE 或 data/master.key。查询与导出不暴露密钥。memory 实体 put 更新 FTS，只索引 status=active 且未过期的非secret记录。

导出 AuthService from src/control/security.ts；constructor(store)。setup({username,password,timezone}):void；login(username,password):{token,csrf,expiresAt}；authenticate(token):{userId,csrf,expiresAt}|undefined；logout(token):void；changePassword(userId,current,next):void。密码用 scrypt，session token 仅存 hash，session 落库。

导出 PolicyGateway from src/control/policy.ts；constructor(store)。工具 descriptor、审批参数hash/过期/单次消费、deny high-risk 与 exact approval tests。与 service actor 在 mesh 上核对实际方法签名。

## Pi Adapter（adapter actor）

导出 PiAdapter class from src/pi-adapter.ts；static open(config, options?:RuntimeOptions):Promise<PiAdapter>；dispatch(method,params?):Promise<any>；createConversation(params:{externalId:string;name?:string;scope?:string;channel?:string;workspace?:string;model?:string}):Promise<{id:number}>，Pi端externalId映射和conversation初始化同一提交；configureProviders(providers:{id:string;vendor:string;model:string;apiKey?:string;priority?:number}[]):Promise<void>；health():Promise<any>；tools():Promise<any[]>；close():Promise<void>。runtime 仅 adapter 内可见。RuntimeOptions 新增 toolGateway?: async(call:{name,args,scope,conversationId,taskId,callId,signal?}, execute:()=>Promise<any>)=>Promise<any>；wrap 全部工具；service 可将 Memory 工具替换到应用库、阻断禁用工具、等待持久化审批。新对话默认供应商配置，fallback 明确有限；service 可在任务安全边界调用 adapter 配置。

## HTTP API（service actor）

导出 startControlServer({dataDir,host?,port?,webDir?,runtimeOptions?,...}) from src/control/server.ts。返回 {url,close,store,...}，port=0 支持测试。生产 main.ts 调用，默认容器 0.0.0.0:8787，宿主 compose 映射127.0.0.1。Owner cookie 鉴权，X-CSRF-Token 写保护，Idempotency-Key 冲突409，所有控制API不回显密钥。接口路径依据 SRS 4.3；前端契约统一 {data,requestId}，列表 data={items,nextCursor:null}。setup GET /api/v1/setup/status -> {initialized:boolean}，POST /api/v1/setup，GET /api/v1/auth/session -> {username,csrf}。POST auth/login -> {csrf,username} + cookie；Owner密码字段标准 password。GET summary/ conversations/tasks/schedules/heartbeats/memories/approvals/providers/channels/tools/settings/system/audit/system/logs；GET conversations/:id/messages；POST conversations/:id/messages {content}。PATCH conversations/:id {name,status}；POST tasks/:id/actions {action}；POST schedules/:id/actions {action}；GET schedules/preview?expression=&timezone=。事件 GET /api/v1/events/stream?cursor=，单调ID。Models密钥POST-only metadataGET。setup payload {username,password,timezone,provider?:{vendor,model,apiKey},telegram?:{token,allowedUsers}}。上线auth后前端可通过实际返回JSON进行页面呈现，不Mock。

其余API若需调整，service actor写 docs/CONTROL-API-CONTRACT.md 并主动告知 web actor。

## 写入所有权

foundation: src/control/store.ts/security.ts/policy.ts 与 tests/control-store*.ts/control-policy*.ts。adapter: src/pi-adapter.ts、src/runtime.ts、src/config.ts 与 tests/pi-adapter*.ts。service: src/control/service.ts/server.ts/main.ts 及 tests/control-api*.ts、docs/CONTROL-API-CONTRACT.md。web: apps/web/**，自身package-lock；不改root依赖。deploy: deploy/**、Dockerfile、compose.yml、.dockerignore、.github/**、docs/ADR/0001*、docs/PI-DURABLE-API.md、LICENSE。Main: root package.json、README、status、架构运维文档、总体验收与整合。需要越界修改时先 mesh 请求，不覆盖其他人的工作。
