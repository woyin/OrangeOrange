import {test,expect} from 'vitest';
import {createHash} from 'node:crypto';
import {fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai/providers/faux';
import {controlFixture} from './control-fixture.js';
import {hermesFixtureArchive,zipFixture} from './control-migration-fixture.js';
const password='a-long-test-password';

test('MT HTTP 服务器计划、精确确认/再认证、三次导入去重、Memory审查与批次回滚',async()=>{
 const f=await controlFixture();
 try{
  expect((await f.request('migrations')).response.status).toBe(401);await f.setup();
  const archive=await hermesFixtureArchive(),source={system:'hermes',instanceId:'old-hermes',archiveBase64:archive.toString('base64'),sha256:createHash('sha256').update(archive).digest('hex')};
  const scan=await f.request('migrations','POST',source);expect(scan.response.status,JSON.stringify(scan.json)).toBe(200);const initial=scan.json.data;
  expect(JSON.stringify(initial)).not.toContain('should-not-copy-secret');
  expect(initial.plan.items.some((i:any)=>i.type==='session')).toBe(true);
  expect((await f.request(`migrations/${initial.id}/apply`,'POST',{planHash:initial.plan.hash,password:'wrong',confirm:true})).response.status).toBe(403);
  expect((await f.request(`migrations/${initial.id}/apply`,'POST',{planHash:'0'.repeat(64),password,confirm:true})).response.status).not.toBe(200);
  const applied=await f.request(`migrations/${initial.id}/apply`,'POST',{planHash:initial.plan.hash,password,confirm:true});expect(applied.response.status,JSON.stringify(applied.json)).toBe(200);
  expect(applied.json.data.verification.ok).toBe(true);
  const count=f.app.service.list('migration_objects').length;expect(count).toBeGreaterThan(3);
  for(let n=0;n<2;n++){const again=(await f.request('migrations','POST',source)).json.data;expect((await f.request(`migrations/${again.id}/apply`,'POST',{planHash:again.plan.hash,password,confirm:true})).response.status).toBe(200);}
  expect(f.app.service.list('migration_objects')).toHaveLength(count);
  expect(f.app.service.list('schedules')).toHaveLength(0);expect(f.app.service.list('reviewed_imported_skills')).toHaveLength(0);
  const memory=f.app.service.list('migration_objects').find(i=>i.type==='memory')!;
  expect((await f.request(`migrations/objects/${memory.id}/memory`,'POST',{approved:true,scope:'owner',content:'Approved imported apple preference'})).response.status).toBe(200);
  expect(f.app.service.store.searchMemories('apple','owner')).toHaveLength(1);
  expect((await f.request(`migrations/${initial.id}/rollback`,'POST',{password,confirm:true})).response.status).toBe(200);
  expect(f.app.service.store.searchMemories('apple','owner')).toHaveLength(0);
 }finally{await f.close();}
});

test('MT-006 HTTP旧历史续聊新建Pi会话，实际工具仅来自新的用户任务',async()=>{
 const f=await controlFixture();
 try{
  await f.setup();f.app.service.store.setSetting('config',{tokenBudget:262144});
  const archive=await hermesFixtureArchive(),scan=(await f.request('migrations','POST',{system:'hermes',instanceId:'history',archiveBase64:archive.toString('base64'),sha256:createHash('sha256').update(archive).digest('hex')})).json.data;
  expect((await f.request(`migrations/${scan.id}/apply`,'POST',{planHash:scan.plan.hash,password,confirm:true})).response.status).toBe(200);
  const history=(await f.request('migrations/history?search=Original')).json.data.items;expect(history).toHaveLength(1);
  const continued=await f.request(`migrations/history/${history[0].id}/continue`,'POST',{name:'continued',messageLimit:10});expect(continued.response.status,JSON.stringify(continued.json)).toBe(200);
  const c=continued.json.data;expect(c.piConversationId).toBeDefined();expect(c.continuedFromImportedConversationId).toBe(history[0].id);expect(f.faux.state.callCount).toBe(0);
  f.faux.setResponses([fauxAssistantMessage(fauxToolCall('current_time',{}),{stopReason:'toolUse'}),fauxAssistantMessage('new task completed')]);
  const t=(await f.request(`conversations/${c.id}/messages`,'POST',{content:'Run current_time now'})).json.data;
  await f.until(()=>['SUCCEEDED','FAILED'].includes(f.app.service.get('tasks',t.id).status));
  expect(f.app.service.get('tasks',t.id).status).toBe('SUCCEEDED');
  expect(f.app.service.get('tasks',t.id).goal).toContain('Original history marker');
  expect(f.app.service.list('operations')).toHaveLength(1);
  const original=(await f.request(`migrations/history/${history[0].id}`)).json.data;expect(JSON.stringify(original)).toContain('Original history marker');
 }finally{await f.close();}
});

test('MT-005 HTTP ZIP与SHA拒绝、目录越界拒绝，不允许客户端注入清单或计划',async()=>{
 const f=await controlFixture();
 try{
  await f.setup();
  for(const files of [{'../escape':'x'},{'valid':'x'}] as Array<Record<string,string>>){const archive=zipFixture(files);const result=await f.request('migrations','POST',{system:'hermes',instanceId:'unsafe',archiveBase64:archive.toString('base64'),sha256:createHash('sha256').update(archive).digest('hex')});expect(result.response.status).not.toBe(200);}
  expect((await f.request('migrations','POST',{system:'hermes',instanceId:'unsafe',directory:'/etc'})).response.status).not.toBe(200);
  expect((await f.request('migrations','POST',{system:'hermes',instanceId:'unsafe',inventory:{items:[]}})).response.status).toBe(400);
  expect(f.app.service.list('migration_objects')).toHaveLength(0);
 }finally{await f.close();}
});
