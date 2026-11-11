import {expect,test} from 'vitest';
import {fauxAssistantMessage} from '@earendil-works/pi-ai/providers/faux';
import {controlFixture} from './control-fixture.js';
import {telegramAdapter} from '../src/channels/telegram.js';

test('GW-002 Telegram forum input retains topic and reply reference',async()=>{
 const adapter=telegramAdapter('123:test',['42'],undefined,async()=>Response.json({ok:true,result:[{update_id:1,message:{message_id:7,message_thread_id:9,chat:{id:-100,type:'supergroup'},from:{id:42},text:'hello',date:1}}]}),true);
 const page=await adapter.poll!('',new AbortController().signal);
 expect(page.messages).toEqual([expect.objectContaining({chat:'-100',user:'42',messageThreadId:'9',messageId:'7'})]);
});
test('GW-005 topic conversations isolate sender and topic, delivery rechecks sender allowlist',async()=>{
 const sends:any[]=[];
 const f=await controlFixture({fetcher:async(input,init)=>{if(String(input).endsWith('sendMessage')){sends.push(JSON.parse(String(init?.body)));return Response.json({ok:true,result:{message_id:99}});}return Response.json({ok:true,result:[]});}});
 try{
  await f.setup();f.faux.setResponses([fauxAssistantMessage('reply')]);
  const channel=f.app.service.channel({type:'telegram',name:'topics',token:'123:test',allowedUsers:['42','43'],enabled:true});
  const base={platform:'telegram' as const,account:'123',user:'42',chat:'-100',id:'1',text:'hello',timestamp:1,messageThreadId:'9',messageId:'7'};
  const a=(await f.app.service.inbound(channel.id,base))!;
  const b=(await f.app.service.inbound(channel.id,{...base,id:'2',messageThreadId:'10'}))!;
  const c=(await f.app.service.inbound(channel.id,{...base,id:'3',user:'43'}))!;
  expect(new Set([a.conversationId,b.conversationId,c.conversationId]).size).toBe(3);
  await f.until(()=>sends.length>0);
  expect(sends[0]).toMatchObject({chat_id:'-100',message_thread_id:9,reply_parameters:{message_id:7}});
  f.app.service.channel({allowedUsers:['43']},channel.id);
  f.app.service.store.put('outbox','revoked',{id:'revoked',channelId:channel.id,threadId:'-100',recipientUserId:'42',state:'PENDING',attempts:0,nextRetryAt:0,content:'denied'});
  await f.app.service.tick();expect(f.app.service.get('outbox','revoked').state).toBe('FAILED');
 }finally{await f.close();}
});
