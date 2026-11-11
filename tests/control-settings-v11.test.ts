import { test, expect } from 'vitest';
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
import { controlFixture } from './control-fixture.js';

test('NFR-005 Web可配置队列与并发下限，硬上限不可扩大且跨重开保留', async () => {
  const f=await controlFixture();
  try {
    await f.setup();
    expect((await f.request('settings','PATCH',{maxConcurrentRuns:1,maxQueueLength:1})).response.status).toBe(200);
    const c=await f.app.service.conversation({name:'limits'});
    f.app.service.createTask(c.id,'one');
    expect(()=>f.app.service.createTask(c.id,'two')).toThrow('QUEUE_FULL');
    for(const value of [0,3,1.5])expect((await f.request('settings','PATCH',{maxConcurrentRuns:value})).response.status).toBe(400);
    for(const value of [0,101,1.5])expect((await f.request('settings','PATCH',{maxQueueLength:value})).response.status).toBe(400);
    await f.reopen();
    expect((await f.request('settings')).json.data).toMatchObject({maxConcurrentRuns:1,maxQueueLength:1});
  }finally{await f.close();}
});

test('NFR-005 配置单并发后不同会话也不会同时派发，空闲后继续队列',async()=>{
  const f=await controlFixture();let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});
  try{
    await f.setup();
    expect((await f.request('settings','PATCH',{maxConcurrentRuns:1})).response.status).toBe(200);
    f.faux.setResponses([async()=>{await gate;return fauxAssistantMessage('first');},fauxAssistantMessage('second')]);
    const a=await f.app.service.conversation({name:'a'}),b=await f.app.service.conversation({name:'b'});
    const first=f.app.service.createTask(a.id,'first'),second=f.app.service.createTask(b.id,'second');
    await f.until(()=>f.faux.state.callCount===1);
    await f.app.service.tick();
    expect(f.app.service.get('tasks',second.id).status).toBe('QUEUED');
    expect(f.faux.state.callCount).toBe(1);
    release();
    await f.until(()=>f.app.service.get('tasks',first.id).status==='SUCCEEDED'&&f.app.service.get('tasks',second.id).status==='SUCCEEDED');
    expect(f.faux.state.callCount).toBe(2);
  }finally{release();await f.close();}
});

test('WEB-012 关闭通知只暂停自动化投递，主动会话回复仍正常，重开后设置保留',async()=>{
 const f=await controlFixture({fetcher:async(input,init)=>String(input).endsWith('sendMessage')?Response.json({ok:true,result:{message_id:1}}):Response.json({ok:true,result:[]})});
 try{
  await f.setup();await f.request('settings','PATCH',{notifications:false});
  const c=f.app.service.channel({name:'notify',type:'telegram',token:'123:test',allowedUsers:['123'],enabled:true});
  f.app.service.store.put('tasks','auto',{id:'auto',status:'SUCCEEDED',scheduleId:'schedule'});
  for(const [id,taskId]of [['auto-message','auto'],['reply','missing-task']] as const)f.app.service.store.put('outbox',id,{id,taskId,channelId:c.id,threadId:'123',state:'PENDING',attempts:0,nextRetryAt:0,content:'test'});
  await f.app.service.tick();
  expect(f.app.service.get('outbox','auto-message').state).toBe('PENDING');
  expect(f.app.service.get('outbox','reply').state).toBe('SENT');
  await f.reopen();expect(f.app.service.store.setting<any>('config',{}).notifications).toBe(false);
  await f.request('settings','PATCH',{notifications:true});await f.app.service.tick();
  expect(f.app.service.get('outbox','auto-message').state).toBe('SENT');
 }finally{await f.close();}
});
