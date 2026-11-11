import { test, expect } from 'vitest';
import { controlFixture } from './control-fixture.js';

test('MEM HTTP禁记生效、敏感候选精确哈希审核后才召回、修改也不能绕过',async()=>{
 const f=await controlFixture();
 try{
  expect((await f.request('memory-policy')).response.status).toBe(401);await f.setup();
  expect((await f.request('memory-policy','PATCH',{categories:['health']})).response.status).toBe(200);
  expect((await f.request('memories','POST',{kind:'semantic',scope:'owner',source:'owner',content:'健康病史',confirmSensitive:true})).response.status).not.toBe(200);
  await f.request('memory-policy','PATCH',{categories:[]});
  const pending=f.app.service.memoryPolicy.propose({principalId:'owner',scope:'owner',kind:'semantic',content:'健康记录 clinical marker',source:'task:test'});
  expect(pending.state).toBe('PENDING_REVIEW');expect(f.app.service.store.searchMemories('clinical','owner')).toHaveLength(0);
  expect((await f.request(`memory-candidates/${pending.id}/decision`,'POST',{scope:'owner',decision:'approve',exactHash:'0'.repeat(64)})).response.status).not.toBe(200);
  expect((await f.request(`memory-candidates/${pending.id}/decision`,'POST',{scope:'owner',decision:'approve',exactHash:pending.exactHash})).json.data.state).toBe('APPLIED');
  expect(f.app.service.store.searchMemories('clinical','owner')).toHaveLength(1);
  expect((await f.request(`memories/${pending.id}`,'PATCH',{content:'new 健康 clinical value'})).response.status).not.toBe(200);
  expect((await f.request(`memories/${pending.id}`,'PATCH',{content:'new 健康 clinical value',confirmSensitive:true})).response.status).toBe(200);
  expect((await f.request(`memories/${pending.id}`,'PATCH',{content:'password=secret',confirmSensitive:true})).response.status).not.toBe(200);
 }finally{await f.close();}
});
