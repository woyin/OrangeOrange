import { test, expect } from 'vitest';
import { readFile, appendFile, cp, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { ControlService } from '../src/control/service.js';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { controlFixture } from './control-fixture.js';

test('HTTP备份去除凭据和session旧页，恢复后旧登录失效且私人记录保留', async () => {
 const f = await controlFixture();
 try {
  await f.setup();
  const marker='BACKUP_SESSION_PAGE_MARKER_938247';
  f.app.store.setSecret('provider:test','private-provider-key');
  f.app.store.put('sessions','old-page',{csrf:marker,padding:marker.repeat(400)});
  const memory=f.app.service.memory({kind:'semantic',scope:'owner',content:'preserved-memory',source:'owner'});
  const c=await f.app.service.conversation({name:'before-backup'});
  const result=await f.request('backup','POST',{confirm:true,password:'a-long-test-password'});
  expect(result.response.status).toBe(200);
  const id=result.json.data.id;
  const path=join(f.app.service.options.dataDir,'backups',id,'app.sqlite');
  const db=new DatabaseSync(path,{readOnly:true});
  try { expect(db.prepare('SELECT count(*) AS n FROM secrets').get()?.n).toBe(0);expect(db.prepare("SELECT count(*) AS n FROM entities WHERE kind='sessions'").get()?.n).toBe(0); } finally {db.close();}
  expect((await readFile(path)).includes(Buffer.from(marker))).toBe(false);
  f.app.store.put('conversations',c.id,{...c,name:'changed'});
  const restored=await f.request('restore','POST',{confirm:true,password:'a-long-test-password',backupId:id});
  expect(restored.response.status).toBe(200);
  expect(restored.json.data.credentialsRequired).toBe(true);
  expect(f.app.service.get('conversations',c.id).name).toBe('before-backup');
  expect(f.app.service.get('memories',memory.id).content).toBe('preserved-memory');
  expect(f.app.store.getSecret('provider:test')).toBeUndefined();
  expect((await f.request('auth/session')).response.status).toBe(401);
 } finally {await f.close();}
});

test('真实WAITING_APPROVAL活动任务可备份，批准后沿同一submission继续且只写一次', async () => {
 const f=await controlFixture();
 try {
  await f.setup();
  const tool=f.app.service.get('tools','memory_save');
  f.app.service.policy.register({...tool,sideEffect:'non_idempotent_write',idempotent:false} as any);
  f.faux.setResponses([fauxAssistantMessage(fauxToolCall('memory_save',{content:'backup-resume-memory'}),{stopReason:'toolUse'}),fauxAssistantMessage('saved')]);
  const c=await f.app.service.conversation({name:'active-backup'});
  const t=f.app.service.createTask(c.id,'remember');
  await f.until(()=>f.app.service.get('tasks',t.id).status==='WAITING_APPROVAL');
  const submission=f.app.service.get('tasks',t.id).piSubmissionId;
  const approval=f.app.service.list('approvals')[0]!;
  const result=await f.request('backup','POST',{confirm:true,password:'a-long-test-password'});
  expect(result.response.status).toBe(200);
  expect(f.app.service.get('tasks',t.id).status).toBe('WAITING_APPROVAL');
  expect(f.app.service.list('memories')).toHaveLength(0);
  expect((await f.request(`approvals/${approval.id}/decisions`,'POST',{decision:'APPROVED',operationHash:approval.operationHash})).response.status).toBe(200);
  await f.until(()=>f.app.service.get('tasks',t.id).status==='SUCCEEDED');
  expect(f.app.service.get('tasks',t.id).piSubmissionId).toBe(submission);
  expect(f.app.service.list('memories')).toHaveLength(1);
 }finally{await f.close();}
});

test('HTTP恢复拒绝校验不符备份且保留当前数据和登录',async()=>{
 const f=await controlFixture();try{
  await f.setup();const c=await f.app.service.conversation({name:'untouched'});
  const result=await f.request('backup','POST',{confirm:true,password:'a-long-test-password'});expect(result.response.status).toBe(200);
  await appendFile(join(f.app.service.options.dataDir,'backups',result.json.data.id,'pi.sqlite'),'tamper');
  const restored=await f.request('restore','POST',{confirm:true,password:'a-long-test-password',backupId:result.json.data.id});
  expect(restored.response.status).toBeGreaterThanOrEqual(400);
  expect(f.app.service.get('conversations',c.id).name).toBe('untouched');
  expect((await f.request('auth/session')).response.status).toBe(200);
 }finally{await f.close();}
});

test('备份在独立空环境恢复两库关联与记忆，随后真实模型任务可执行',async()=>{
 const source=await controlFixture();const destination=await controlFixture();
 try{
  await source.setup();await destination.setup();
  const c=await source.app.service.conversation({name:'source-conversation'});
  source.app.service.memory({kind:'semantic',scope:'owner',content:'migrated-memory',source:'owner'});
  const snap=await source.app.service.snapshot();
  await cp(join(source.app.service.options.dataDir,'backups',snap.id),join(destination.app.service.options.dataDir,'backups',snap.id),{recursive:true});
  await destination.app.service.restore(snap.id);
  expect(destination.app.service.get('conversations',c.id).piConversationId).toBe(c.piConversationId);
  expect(destination.app.store.searchMemories('migrated','owner')).toHaveLength(1);
  destination.faux.setResponses([fauxAssistantMessage('restored-answer')]);
  const task=destination.app.service.createTask(c.id,'prove restore');
  await destination.until(()=>destination.app.service.get('tasks',task.id).status==='SUCCEEDED');
  expect(destination.app.service.get('tasks',task.id).result).toBe('restored-answer');
  expect(destination.faux.state.callCount).toBe(1);
 }finally{await source.close();await destination.close();}
});

test('启动先独占目录再恢复journal，完整回滚后才打开两库',async()=>{
 const f=await controlFixture();try{
  await f.setup();const c=await f.app.service.conversation({name:'checkpoint'});const snap=await f.app.service.snapshot();
  const data=f.app.service.options.dataDir;const rollback='.restore-'+randomUUID();
  await cp(join(data,'backups',snap.id),join(data,rollback),{recursive:true});
  f.app.store.put('conversations',c.id,{...c,name:'interrupted-new-state'});
  await writeFile(join(data,'restore-journal.json'),JSON.stringify({version:1,rollback}));
  await expect(ControlService.open(f.app.service.options)).rejects.toThrow('另一个服务');
  expect(f.app.service.get('conversations',c.id).name).toBe('interrupted-new-state');
  await f.reopen();
  expect(f.app.service.get('conversations',c.id).name).toBe('checkpoint');
  await expect(readFile(join(data,'restore-journal.json'))).rejects.toMatchObject({code:'ENOENT'});
  expect((await f.app.service.adapter.dispatch('conversation.list',{scope:'owner'})).some((row:any)=>row.id===c.piConversationId)).toBe(true);
 }finally{await f.close();}
});

test('真实模型请求中备份保留输入，恢复运行不重复提交或丢失任务',async()=>{
 const f=await controlFixture();try{
  await f.setup();
  f.faux.setResponses([async(_context,options)=>{await new Promise<void>(resolve=>{if(options?.signal?.aborted)return resolve();options?.signal?.addEventListener('abort',()=>resolve(),{once:true});});return fauxAssistantMessage('discarded-inflight');},fauxAssistantMessage('after-active-backup')]);
  const c=await f.app.service.conversation({name:'model-active-backup'});const task=f.app.service.createTask(c.id,'run across backup');
  await f.until(()=>f.faux.state.callCount===1);
  const submission=f.app.service.get('tasks',task.id).piSubmissionId;
  const snapshot=await f.request('backup','POST',{confirm:true,password:'a-long-test-password'});
  expect(snapshot.response.status).toBe(200);
  await f.until(()=>f.app.service.get('tasks',task.id).status==='SUCCEEDED');
  expect(f.app.service.get('tasks',task.id)).toMatchObject({piSubmissionId:submission,result:'after-active-backup'});
  expect(f.app.service.list('tasks')).toHaveLength(1);expect(f.faux.state.callCount).toBe(2);
  const history=await f.app.service.adapter.dispatch('history.list',{id:c.piConversationId,limit:100});
  expect(history.items.filter((entry:any)=>entry.kind==='pi.user')).toHaveLength(1);
 }finally{await f.close();}
});

test('备份屏障覆盖并发设置及登录写入，完成后恢复正常访问',async()=>{
 const f=await controlFixture();let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});
 try{
  await f.setup();let entered=false;const original=f.app.service.adapter.close.bind(f.app.service.adapter);
  f.app.service.adapter.close=async()=>{entered=true;await gate;await original();};
  const snapshot=f.request('backup','POST',{confirm:true,password:'a-long-test-password'});
  const deadline=Date.now()+3000;while(!entered&&Date.now()<deadline)await new Promise(r=>setTimeout(r,10));expect(entered).toBe(true);
  expect((await f.request('settings','PATCH',{language:'en'})).response.status).toBe(503);
  expect((await f.request('auth/login','POST',{username:'owner',password:'a-long-test-password'})).response.status).toBe(503);
  release();expect((await snapshot).response.status).toBe(200);
  expect((await f.request('auth/session')).response.status).toBe(200);
 }finally{release();await f.close();}
});

test('Pi关闭途中失败保持维护屏障，不继续运行不完整adapter',async()=>{
 const f=await controlFixture();try{
  await f.setup();const original=f.app.service.adapter.close.bind(f.app.service.adapter);let first=true;
  f.app.service.adapter.close=async()=>{await original();if(first){first=false;throw new Error('PARTIAL_ADAPTER_CLOSE');}};
  const result=await f.request('backup','POST',{confirm:true,password:'a-long-test-password'});
  expect(result.response.status).toBeGreaterThanOrEqual(400);
  expect(f.app.service.maintenanceActive).toBe(true);
  expect((await f.request('conversations','POST',{name:'must-not-run'})).response.status).toBe(503);
  expect((await f.request('auth/login','POST',{username:'owner',password:'a-long-test-password'})).response.status).toBe(503);
 }finally{await f.close();}
});
