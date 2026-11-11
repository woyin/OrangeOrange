import { test, expect } from 'vitest';
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
import { controlFixture } from './control-fixture.js';

test('MODEL-004 软阈值在供应商请求前暂停，Owner调高后继续；逐次预留可追溯',async()=>{
 const f=await controlFixture();
 try{
  await f.setup();f.faux.setResponses([fauxAssistantMessage('resumed')]);
  await f.request('settings','PATCH',{softTaskBudget:0});
  const c=await f.app.service.conversation({name:'soft-budget'}),t=f.app.service.createTask(c.id,'pause before call');
  await f.until(()=>f.app.service.get('tasks',t.id).status==='PAUSED');
  expect(f.faux.state.callCount).toBe(0);expect(f.app.service.get('tasks',t.id).error).toBe('BUDGET_SOFT_LIMIT');
  expect(f.app.service.list('budget_reservations')).toHaveLength(0);
  expect((await f.request('settings','PATCH',{softTaskBudget:1})).response.status).toBe(200);
  expect((await f.request(`tasks/${t.id}/actions`,'POST',{action:'resume'})).response.status).toBe(200);
  await f.until(()=>['SUCCEEDED','FAILED'].includes(f.app.service.get('tasks',t.id).status));
  expect(f.app.service.get('tasks',t.id).status).toBe('SUCCEEDED');expect(f.faux.state.callCount).toBe(1);
  expect(f.app.service.list('budget_reservations')).toHaveLength(1);
 }finally{await f.close();}
});
