import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels, type MutableModels } from "@earendil-works/pi-ai/models";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import type { ConversationId } from "@earendil-works/pi-durable";
import { openRuntime, type Runtime, type RuntimeOptions } from "./runtime.js";
import type { Config } from "./config.js";
import { DatabaseSync, backup } from "node:sqlite";
import { join } from "node:path";
export type { RuntimeOptions } from "./runtime.js";
export type ProviderConfig = {id:string;vendor:string;model:string;apiKey?:string;priority?:number};

/** 唯一控制平面 SDK 边界。不会自主执行供应商切换。 */
export class PiAdapter {
  private providers: ProviderConfig[] = [];
  private backingUp = false;
  private constructor(private readonly runtime:Runtime, private readonly models:MutableModels | undefined, readonly config:Config) {}
  static async open(config:Config, options:RuntimeOptions = {}):Promise<PiAdapter> {
    const injected = options.models as Partial<MutableModels> | undefined;
    const models = options.models
      ? (typeof injected?.setProvider === "function" && typeof injected?.deleteProvider === "function" ? options.models as MutableModels : undefined)
      : createModels();
    if (!options.models) models!.setProvider(openaiProvider());
    const runtime = await openRuntime(config,{...options,models:options.models ?? models});
    return new PiAdapter(runtime,models,config);
  }
  dispatch(method:string,params:Record<string,unknown> = {}):Promise<any> {
    if (this.backingUp && !["status","conversation.live","input.get","history.list","conversation.list","conversation.state"].includes(method)) return Promise.reject(new Error("备份期间暂停业务写入"));
    return this.runtime.dispatch(method,params);
  }
  async createConversation(params:{externalId:string;name?:string;scope?:string;channel?:string;workspace?:string;model?:string;systemPrompt?:string}):Promise<{id:number}> {
    if (this.backingUp) throw new Error("备份期间暂停业务写入");
    const selected = params.model ? this.providers.find(p=>p.id===params.model || p.model===params.model) : this.providers[0];
    if (params.model && this.providers.length && !selected) throw new Error("模型未配置");
    return this.runtime.createConversation({...params,...(selected ? {provider:selected.id,model:selected.model}: {})});
  }
  async configureProviders(providers:ProviderConfig[]):Promise<void> {
    if (providers.length > 8 || new Set(providers.map(p=>p.id)).size !== providers.length) throw new Error("供应商候选必须唯一且最多八个");
    if (!this.models && providers.length) throw new Error("注入模型目录不支持动态供应商配置");
    const prepared = providers.map(p=>{
      if (p.vendor !== "openai" || !p.id || !p.model) throw new Error("仅支持已核实的 OpenAI 供应商");
      const base = openaiProvider();
      if (!base.getModels().some(m=>m.id===p.model)) throw new Error("模型不在供应商目录");
      return { ...base,id:p.id,getModels:()=>base.getModels().map(model=>({...model,provider:p.id})),getAllModels:()=>base.getModels().map(model=>({...model,provider:p.id})),auth:{apiKey:{name:"服务密钥",resolve:async()=>p.apiKey ? {auth:{apiKey:p.apiKey}}:undefined}} };
    });
    for (const previous of this.providers) this.models?.deleteProvider(previous.id);
    prepared.forEach(p=>this.models!.setProvider(p));
    this.providers = [...providers].sort((a,b)=>(a.priority ?? 0)-(b.priority ?? 0));
  }
  async health():Promise<any> { return this.dispatch("status"); }
  async tools():Promise<any[]> {
    return this.runtime.toolDescriptors.map(tool=>({name:tool.name,version:"1",description:tool.description,inputSchema:tool.parameters,sideEffect:/^(memory_save|memory_delete|schedule_|reminder_|gmail_send_email$)/.test(tool.name)?"idempotent_write":"read_only",permissions:[tool.name],timeoutMs:60000,idempotent:true,executor:"in-process"}));
  }
  /** 真正的 SDK view observer；回调只同步记录，不得重入 adapter。 */
  async observe(conversationId:number, listener:(event:any)=>void):Promise<{value:unknown;detach:()=>void}> {
    const observation = await this.runtime.harness.observeConversation(conversationId as ConversationId,{advance:call=>listener(call),end:end=>listener({type:"end",end})},ctx);
    return {value:observation.value,detach:()=>observation.detach()};
  }
  /** service须先停止新run与配置写入；拒绝仍有活动任务的快照。使用SQLite在线backup，不复制WAL。 */
  async backup(destination:string):Promise<void> {
    if (this.backingUp) throw new Error("备份已在进行");
    this.backingUp = true;
    let reader:DatabaseSync|undefined;
    try {
      const work = await this.runtime.harness.inspect(ctx);
      if (work.tasks.length || work.submissions.length) throw new Error("备份前必须排空运行任务");
      reader = new DatabaseSync(join(this.config.dataDir,"state.sqlite"),{readOnly:true});
      await backup(reader,destination);
    } finally { reader?.close(); this.backingUp = false; }
  }
  private closing?: Promise<void>;
  close():Promise<void> { return this.closing ??= this.runtime.close(); }
}
