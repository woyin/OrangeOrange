import {expect,test} from 'vitest';
import {fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai/providers/faux';
import {controlFixture} from './control-fixture.js';
test('GW-008 IM approval uses expiring plain text notification without executing the action',async()=>{
 const sends:any[]=[];const f=await controlFixture({fetcher:async(input,init)=>{if(String(input).endsWith('sendMessage')){sends.push(JSON.parse(String(init?.body)));return Response.json({ok:true,result:{message_id:1}});}return Response.json({ok:true,result:[]});}});
 try{
 await f.setup();const tool=f.app.service.get('tools','memory_save');f.app.service.policy.register({...tool,sideEffect:'non_idempotent_write',idempotent:false} as any);
 f.app.service.store.put('principals','telegram:123:42',{id:'telegram:123:42',allowed:true,permissions:['memory_save']});
 f.faux.setResponses([fauxAssistantMessage(fauxToolCall('memory_save',{content:'private candidate'}),{stopReason:'toolUse'})]);
 const channel=f.app.service.channel({type:'telegram',name:'approval',token:'123:test',allowedUsers:['42'],enabled:true});
 const task=(await f.app.service.inbound(channel.id,{platform:'telegram',account:'123',user:'42',chat:'42',id:'1',text:'remember',timestamp:Date.now()}))!;
 await f.until(()=>f.app.service.get('tasks',task.id).status==='WAITING_APPROVAL');
 await f.until(()=>sends.length===1);
 expect(sends[0].text).toContain('审批');expect(sends[0].text).toContain('到期');expect(sends[0].text).not.toContain('private candidate');expect(f.app.service.list('memories')).toHaveLength(0);
 await f.app.service.taskAction(task.id,'cancel');
 }finally{await f.close();}
});
