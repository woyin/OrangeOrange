import {expect,test} from 'vitest';
import {controlFixture} from './control-fixture.js';

test('owner delivery views expose authoritative memory, prompt history, scoped tasks and usage',async()=>{
 const f=await controlFixture();
 try{
  expect((await f.request('memories/export')).response.status).toBe(401);await f.setup();
  const a=await f.app.service.conversation({name:'a'}),b=await f.app.service.conversation({name:'b'});
  const t=f.app.service.createTask(a.id,'a');f.app.service.createTask(b.id,'b');
  expect((await f.request('tasks?conversationId='+a.id)).json.data.items.map((v:any)=>v.id)).toEqual([t.id]);
  await f.request('settings','PATCH',{systemPrompt:'reviewed instruction'});
  expect((await f.request('settings/history')).json.data.items).toEqual([expect.objectContaining({content:'reviewed instruction'})]);
  f.app.service.memory({kind:'semantic',scope:'owner',source:'owner',content:'remember this'});
  const exported=(await f.request('memories/export')).json.data;expect(exported.version).toBe(1);expect(exported.items).toHaveLength(1);
  f.app.service.store.put('budget_reservations','usage',{id:'usage',day:new Date().toISOString().slice(0,10),state:'settled',actualTokens:12,actualCost:0.01});
  const summary=(await f.request('system/summary')).json.data;expect(summary.usageToday).toMatchObject({tokens:12,cost:0.01,unknownCost:false});expect(summary.version).toBe('0.1.0');expect(summary.piVersion).toBe('1.5.0');expect(Array.isArray(summary.channels)).toBe(true);
 }finally{await f.close();}
});
