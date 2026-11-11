import {expect,test} from 'vitest';
import {controlFixture} from './control-fixture.js';
test('WEB-005 heartbeat can run, pause, resume and report persisted task history',async()=>{
 const f=await controlFixture();try{
 await f.setup();const c=await f.app.service.conversation({name:'heartbeat'});
 const h=(await f.request('heartbeats','POST',{conversationId:c.id,intervalSeconds:60,prompt:'check',enabled:false})).json.data;
 const run=await f.request(`heartbeats/${h.id}/actions`,'POST',{action:'run'});expect(run.response.status).toBe(200);expect(run.json.data.heartbeatId).toBe(h.id);
 expect((await f.request(`heartbeats/${h.id}/history`)).json.data.items.map((t:any)=>t.id)).toEqual([run.json.data.id]);
 expect((await f.request(`heartbeats/${h.id}/actions`,'POST',{action:'resume'})).json.data.enabled).toBe(true);
 expect((await f.request(`heartbeats/${h.id}/actions`,'POST',{action:'pause'})).json.data.enabled).toBe(false);
 expect((await f.request(`heartbeats/${h.id}/actions`,'POST',{action:'unknown'})).response.status).toBe(400);
 }finally{await f.close();}
});
