import { test, expect } from "vitest";
import { mkdtemp,mkdir,rm,writeFile,symlink } from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createModels} from "@earendil-works/pi-ai/models";
import {fauxProvider,fauxAssistantMessage,fauxToolCall} from "@earendil-works/pi-ai/providers/faux";
import {PiAdapter,type RuntimeOptions} from "../src/pi-adapter.js";
import {config} from "../src/config.js";
import {until} from "./helpers.js";
async function fixture(options:RuntimeOptions={}) {
 const dir=await mkdtemp(join(tmpdir(),"hda-adapter-")); await mkdir(join(dir,"data")); await mkdir(join(dir,"workspace"));
 const cfg=config({ORANGE_DATA_DIR:join(dir,"data"),ORANGE_WORKSPACE:join(dir,"workspace"),ORANGE_MODEL:"faux-1",ORANGE_SKILLS_DIR:join(dir,"skills")});
 await mkdir(join(dir,"skills","example"),{recursive:true}); await writeFile(join(dir,"skills","example","SKILL.md"),"---\ndescription: Example skill\n---\nSECRET_SKILL_BODY");
 const models=createModels();const faux=fauxProvider();models.setProvider(faux.provider);
 let adapter=await PiAdapter.open(cfg,{models,provider:"faux",...options});
 return {dir,cfg,faux,get adapter(){return adapter},async reopen(){await adapter.close();adapter=await PiAdapter.open(cfg,{models,provider:"faux",...options})},async cleanup(){await adapter.close();await rm(dir,{recursive:true,force:true})}};
}
async function submit(app:Awaited<ReturnType<typeof fixture>>,id:number,key="task") {
 const input=await app.adapter.dispatch("input.submit",{conversationId:id,requestId:key,content:"测试"});
 return until(()=>app.adapter.dispatch("input.get",{id:input.id}),v=>["done","unanswered","withdrawn"].includes(v.status));
}
test("externalId在Pi提交中原子去重，并跨重开保持映射",async()=>{const app=await fixture();try{
 const ids=await Promise.all(Array.from({length:10},()=>app.adapter.createConversation({externalId:"app:c1"})));
 expect(new Set(ids.map(c=>c.id)).size).toBe(1);await app.reopen();expect((await app.adapter.createConversation({externalId:"app:c1"})).id).toBe(ids[0]!.id);
 expect(await app.adapter.dispatch("conversation.list")).toHaveLength(1);
}finally{await app.cleanup()}});
test("真实工具循环通过gateway，真实view含live与usage，禁用legacy入口",async()=>{const calls:any[]=[];const app=await fixture({disableLegacyAutomation:true,toolGateway:async(call,execute)=>{calls.push(call);return execute()}});try{
 app.faux.setResponses([fauxAssistantMessage(fauxToolCall("current_time",{}),{stopReason:"toolUse"}),fauxAssistantMessage("完成")]);
 const c=await app.adapter.createConversation({externalId:"gateway"});const events:any[]=[];const observation=await app.adapter.observe(c.id,e=>events.push(e));
 expect(observation.value).toBeDefined();expect((await submit(app,c.id)).answerText).toBe("完成");observation.detach();
 expect(calls).toHaveLength(1);expect(calls[0]).toMatchObject({name:"current_time",conversationId:c.id,scope:"local"});expect(calls[0].callId).toBeTruthy();expect(calls[0].requestIds).toEqual(["task"]);expect(events.length).toBeGreaterThan(0);
 const live=await app.adapter.dispatch("conversation.live",{id:c.id});expect(live.usage).toBeDefined();
 await expect(app.adapter.dispatch("schedule.list")).rejects.toThrow("禁用");await expect(app.adapter.dispatch("reminder.list")).rejects.toThrow("禁用");
 expect((await app.adapter.tools()).find(t=>t.name==="current_time")).toHaveProperty("inputSchema");
}finally{await app.cleanup()}});
test("模型admission拒绝发生在provider发送前",async()=>{let admissions=0;const app=await fixture({modelAdmission:()=>{admissions++;throw new Error("BUDGET_EXHAUSTED")}});try{
 app.faux.setResponses([fauxAssistantMessage("不应发送")]);const c=await app.adapter.createConversation({externalId:"budget"});const end=await submit(app,c.id);
 expect(end.status).toBe("unanswered");expect(admissions).toBeGreaterThan(0);expect(app.faux.state.callCount).toBe(0);
}finally{await app.cleanup()}});
test("privatePaths阻止工作区内私有文件和符号链接读取",async()=>{const dir=await mkdtemp(join(tmpdir(),"hda-private-"));const app=await fixture({privatePaths:[dir]});try{
 await writeFile(join(dir,"master.key"),"DO_NOT_DISCLOSE");await symlink(dir,join(app.cfg.workspace,"private"));
 app.faux.setResponses([fauxAssistantMessage(fauxToolCall("read_file",{path:"private/master.key"}),{stopReason:"toolUse"}),fauxAssistantMessage("拒绝")]);const c=await app.adapter.createConversation({externalId:"private"});await submit(app,c.id);
 const history=await app.adapter.dispatch("history.list",{id:c.id});expect(JSON.stringify(history)).not.toContain("DO_NOT_DISCLOSE");expect(JSON.stringify(history)).toContain("符号链接超出工作区");
}finally{await app.cleanup();await rm(dir,{recursive:true,force:true})}});

test("Pi在线备份可恢复externalId映射",async()=>{const app=await fixture();try{
 const c=await app.adapter.createConversation({externalId:"backup"});const destination=join(app.dir,"snapshot.sqlite");await app.adapter.backup(destination);
 const {DatabaseSync}=await import("node:sqlite");const db=new DatabaseSync(destination,{readOnly:true});expect(db.prepare("PRAGMA integrity_check").get()).toEqual({integrity_check:"ok"});db.close();
 expect((await app.adapter.createConversation({externalId:"backup"})).id).toBe(c.id);
}finally{await app.cleanup()}});
test("gateway拒绝不会执行原工具，requestIds映射业务任务",async()=>{const calls:any[]=[];const app=await fixture({toolGateway:async call=>{calls.push(call);throw new Error("POLICY_DENIED")}});try{
 app.faux.setResponses([fauxAssistantMessage(fauxToolCall("memory_save",{content:"不允许保存"}),{stopReason:"toolUse"}),fauxAssistantMessage("拒绝")]);const c=await app.adapter.createConversation({externalId:"deny"});await submit(app,c.id,"app-task-1");
 expect(calls[0].requestIds).toEqual(["app-task-1"]);expect(await app.adapter.dispatch("memory.list")).toEqual([]);expect(JSON.stringify(await app.adapter.dispatch("history.list",{id:c.id}))).toContain("POLICY_DENIED");
}finally{await app.cleanup()}});

test("OpenAI配置仅内存注入密钥，有限候选且拒绝未经核实供应商",async()=>{const app=await fixture();let adapter:PiAdapter|undefined;try{
 await app.adapter.close();adapter=await PiAdapter.open({...app.cfg,model:"gpt-4.1-mini"});
 await adapter.configureProviders([{id:"primary",vendor:"openai",model:"gpt-4.1-mini",apiKey:"TEST_SECRET_NEVER_EXPORT"},{id:"backup",vendor:"openai",model:"gpt-4.1-mini"}]);
 const c=await adapter.createConversation({externalId:"provider"});expect(c.id).toBeGreaterThan(0);expect(JSON.stringify(await adapter.health())).not.toContain("TEST_SECRET_NEVER_EXPORT");
 await expect(adapter.configureProviders([{id:"bad",vendor:"unknown",model:"x"}])).rejects.toThrow("OpenAI");
 await expect(adapter.createConversation({externalId:"bad-model",model:"missing"})).rejects.toThrow("未配置");
}finally{await adapter?.close();await rm(app.dir,{recursive:true,force:true})}});

test("admission同步关联两个并发会话，并跨重开恢复UUID映射",async()=>{const calls:any[]=[];const app=await fixture({modelAdmission:r=>{calls.push(r);return {maxTokens:100}}});try{
 const a=await app.adapter.createConversation({externalId:"a"});const b=await app.adapter.createConversation({externalId:"b"});
 app.faux.setResponses([fauxAssistantMessage("a"),fauxAssistantMessage("b")]);await Promise.all([submit(app,a.id,"a1"),submit(app,b.id,"b1")]);
 expect(new Set(calls.map(r=>r.conversationId))).toEqual(new Set([a.id,b.id]));expect(new Set(calls.map(r=>r.options.sessionId)).size).toBe(2);
 const sessions=new Map(calls.map(r=>[r.conversationId,r.options.sessionId]));await app.reopen();calls.length=0;
 app.faux.setResponses([fauxAssistantMessage("a2"),fauxAssistantMessage("b2")]);await Promise.all([submit(app,a.id,"a2"),submit(app,b.id,"b2")]);
 expect(calls).toHaveLength(2);for(const r of calls)expect(r.options.sessionId).toBe(sessions.get(r.conversationId));
}finally{await app.cleanup()}});
test("systemPrompt进入真实provider上下文，configure后续round并跨重开保持",async()=>{const contexts:string[]=[];const app=await fixture();try{
 const c=await app.adapter.createConversation({externalId:"prompt",systemPrompt:"INSTRUCTIONS_V1"});
 const response=(context:unknown)=>{contexts.push(JSON.stringify(context));return fauxAssistantMessage("ok")};
 app.faux.setResponses([response]);await submit(app,c.id,"p1");expect(contexts[0]).toContain("INSTRUCTIONS_V1");
 await app.adapter.dispatch("conversation.configure",{id:c.id,systemPrompt:"INSTRUCTIONS_V2"});await app.reopen();
 app.faux.setResponses([response]);await submit(app,c.id,"p2");expect(contexts[1]).toContain("INSTRUCTIONS_V2");
}finally{await app.cleanup()}});
test("技能返回正文版本权限，禁用跨重开并拒绝真实toolcall",async()=>{const app=await fixture();try{
 const skills=await app.adapter.dispatch("skill.list");expect(skills[0]).toMatchObject({name:"example",content:expect.stringContaining("SECRET_SKILL_BODY"),version:expect.stringMatching(/^[a-f0-9]{64}$/),permissions:["skill_load"],enabled:true});
 await app.adapter.dispatch("skill.toggle",{name:"example",enabled:false});await app.reopen();expect((await app.adapter.dispatch("skill.list"))[0].enabled).toBe(false);
 await expect(app.adapter.dispatch("skill.load",{name:"example"})).rejects.toThrow("禁用");
 const c=await app.adapter.createConversation({externalId:"skill"});app.faux.setResponses([fauxAssistantMessage(fauxToolCall("skill_load",{name:"example"}),{stopReason:"toolUse"}),fauxAssistantMessage("拒绝")]);await submit(app,c.id);
 const history=JSON.stringify(await app.adapter.dispatch("history.list",{id:c.id}));expect(history).toContain("技能已禁用");expect(history).not.toContain("SECRET_SKILL_BODY");
 await app.adapter.dispatch("skill.toggle",{name:"example",enabled:true});expect((await app.adapter.dispatch("skill.load",{name:"example"})).content).toContain("SECRET_SKILL_BODY");
}finally{await app.cleanup()}});
test("禁用legacy时自动化工具先经gateway override，仅fallback拒绝",async()=>{const calls:string[]=[];const app=await fixture({disableLegacyAutomation:true,toolGateway:async(call,execute)=>{calls.push(call.name);if(call.name==="schedule_create")return {output:[{type:"text",text:"UNIFIED_TASK_CREATED"}]};return execute()}});try{
 const c=await app.adapter.createConversation({externalId:"automation"});app.faux.setResponses([fauxAssistantMessage(fauxToolCall("schedule_create",{name:"daily",cron:"0 8 * * *",prompt:"check"}),{stopReason:"toolUse"}),fauxAssistantMessage("ok")]);await submit(app,c.id,"schedule");expect(calls).toContain("schedule_create");
 const history=JSON.stringify(await app.adapter.dispatch("history.list",{id:c.id}));expect(history).toContain("UNIFIED_TASK_CREATED");expect(history).not.toContain("生产模式禁用旧自动化工具");
 app.faux.setResponses([fauxAssistantMessage(fauxToolCall("reminder_list",{}),{stopReason:"toolUse"}),fauxAssistantMessage("ok")]);await submit(app,c.id,"fallback");expect(JSON.stringify(await app.adapter.dispatch("history.list",{id:c.id}))).toContain("生产模式禁用旧自动化工具");
}finally{await app.cleanup()}});

test("注入MutableModels可配置供应商且保留原faux目录，清空后仍可执行",async()=>{const app=await fixture();try{
 await app.adapter.configureProviders([{id:"configured",vendor:"openai",model:"gpt-4.1-mini",apiKey:"INJECTED_TEST_SECRET"}]);
 const configured=await app.adapter.createConversation({externalId:"injected-provider"});expect(configured.id).toBeGreaterThan(0);
 expect(JSON.stringify(await app.adapter.health())).not.toContain("INJECTED_TEST_SECRET");
 await app.adapter.configureProviders([]);app.faux.setResponses([fauxAssistantMessage("injected-still-works")]);
 const c=await app.adapter.createConversation({externalId:"injected-faux"});expect((await submit(app,c.id)).answerText).toBe("injected-still-works");
}finally{await app.cleanup()}});
