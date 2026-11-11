import {expect,test} from 'vitest';
import {fauxAssistantMessage} from '@earendil-works/pi-ai/providers/faux';
import {hash} from '../src/control/store.js';
import {controlFixture} from './control-fixture.js';
for(const mode of ['notifications-disabled','unchanged'] as const)test(`suppressed automation delivery is not pending: ${mode}`,async()=>{
 const f=await controlFixture();
 try{
  await f.setup();f.faux.setResponses([fauxAssistantMessage('same result')]);
  if(mode==='notifications-disabled')await f.request('settings','PATCH',{notifications:false});
  const c=await f.app.service.conversation({name:'delivery'});
  f.app.service.store.put('heartbeats','heartbeat',{id:'heartbeat',enabled:false,onlyOnChange:mode==='unchanged',lastResultHash:hash('same result')});
  const t=f.app.service.createTask(c.id,'check','heartbeat',mode,{heartbeatId:'heartbeat',channelId:'unused',threadId:'123'});
  await f.until(()=>f.app.service.get('tasks',t.id).status==='SUCCEEDED');
  expect(f.app.service.list('outbox')).toHaveLength(0);
  expect(f.app.service.get('tasks',t.id).deliveryStatus).toBe('NOT_REQUIRED');
 }finally{await f.close();}
});
