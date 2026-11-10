import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startControlServer } from '../../../src/control/server.ts';
import { api, setCsrf, ApiError } from './api.ts';
const dir=await mkdtemp(join(tmpdir(),'hda-web-api-'));
const previousCwd=process.cwd();process.chdir(new URL('../../../',import.meta.url).pathname);
const app=await startControlServer({dataDir:join(dir,'data'),workspace:join(dir,'workspace'),port:0,tickMs:60000,diskProbe:async()=>1e9});
const nativeFetch=globalThis.fetch;let cookie='';
globalThis.fetch=async(input,init)=>{const path=String(input);if(!path.startsWith('/api/v1/'))return nativeFetch(input,init);const headers=new Headers(init?.headers);headers.set('Origin',app.url);if(cookie)headers.set('Cookie',cookie);const response=await nativeFetch(app.url+path,{...init,headers});const returned=response.headers.get('set-cookie');if(returned)cookie=returned.split(';')[0];return response;};
try {
 await assert.rejects(api('tasks'),(e:unknown)=>e instanceof ApiError&&e.status===401);
 const setup=await api('setup','POST',{username:'owner',password:'web-integration-safe-value',timezone:'Asia/Shanghai'});setCsrf(setup.csrf);
 assert.equal((await api('auth/session')).username,'owner');
 const conversation=await api('conversations','POST',{name:'中文会话'});assert.ok(conversation.id);
 await api('conversations/'+conversation.id,'PATCH',{status:'archived'});assert.equal((await api('conversations')).items[0].status,'archived');
 const schedule=await api('schedules','POST',{name:'每天检查',expression:'30 8 * * *',timezone:'Asia/Shanghai',prompt:'检查状态',misfirePolicy:'coalesce',overlapPolicy:'queue_one'});assert.ok(schedule.conversationId);
 assert.equal((await api('schedules/preview?expression=30%208%20*%20*%20*&timezone=Asia%2FShanghai')).items.length,5);
 const heartbeat=await api('heartbeats','POST',{conversationId:schedule.conversationId,intervalSeconds:60,prompt:'检查变化',onlyOnChange:true});assert.ok(heartbeat.id);
 const memory=await api('memories','POST',{kind:'semantic',scope:'owner',content:'中文记忆偏好',source:'Owner',confidence:1,expiresAt:new Date(Date.now()+86400000).toISOString()});assert.ok(memory.id);
 await api('memories/'+memory.id,'PATCH',{status:'blocked'});assert.equal((await api('memories?q='+encodeURIComponent('中文'))).items.length,0);
 const provider=await api('providers','POST',{vendor:'openai',model:'gpt-4o-mini',apiKey:'integration-placeholder-value'});assert.ok(provider.configured??provider.id);assert.ok(!JSON.stringify(await api('providers')).includes('integration-placeholder-value'));
 const channel=await api('channels','POST',{name:'Telegram',type:'telegram',token:'integration-token-value',allowedUsers:['123'],enabled:false});assert.ok(channel.id);assert.ok(!JSON.stringify(await api('channels')).includes('integration-token-value'));
 const skills=(await api('skills')).items;assert.ok(skills.length>0,'真实可信技能目录应有技能用于启停验证');if(skills.length){const skill=skills[0];await api('skills/'+encodeURIComponent(skill.name),'PATCH',{enabled:false});assert.equal((await api('skills')).items.find((s:any)=>s.name===skill.name).enabled,false);await api('skills/'+encodeURIComponent(skill.name),'PATCH',{enabled:true});assert.equal((await api('skills')).items.find((s:any)=>s.name===skill.name).enabled,true);}
 await api('settings','PATCH',{timezone:'UTC',dailyBudget:1,retentionDays:30,systemPrompt:'后续任务使用的中文系统指令'});assert.equal((await api('settings')).timezone,'UTC');const task=await api('conversations/'+schedule.conversationId+'/messages','POST',{content:'核对任务指令快照'});assert.equal(task.systemPrompt,'后续任务使用的中文系统指令');
 await assert.rejects(api('tasks','POST',{}),(e:unknown)=>e instanceof ApiError&&e.status===404);
 await api('auth/logout','POST',{});await assert.rejects(api('tasks'),(e:unknown)=>e instanceof ApiError&&e.status===401);
 console.log('PASS:真实HTTP API客户端初始化/登录cookie-CSRF、会话归档、Cron预览、Heartbeat、Memory禁用、密钥不回显、设置、技能真实启停、新任务系统指令快照与注销；未调用真实模型或Telegram。');
} finally {process.chdir(previousCwd);globalThis.fetch=nativeFetch;await app.close();await rm(dir,{recursive:true,force:true});}
