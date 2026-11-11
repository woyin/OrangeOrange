import {test,expect} from 'vitest';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {PiAdapter} from '../src/pi-adapter.js';
import {config} from '../src/config.js';
import {until} from './helpers.js';
import {controlFixture,CONTROL_TEST_PASSWORD} from './control-fixture.js';

test('custom OpenAI endpoint receives real authenticated Chat Completions traffic',async()=>{
 const key=randomUUID(),requests:any[]=[];
 const server=createServer(async(req,res)=>{
  let body='';for await(const chunk of req)body+=chunk;
  requests.push({url:req.url,authorization:req.headers.authorization,body:JSON.parse(body)});
  res.writeHead(200,{'Content-Type':'text/event-stream'});
  const chunk={id:'proxy-test',object:'chat.completion.chunk',created:1,model:'gpt-4.1-mini',choices:[{index:0,delta:{role:'assistant',content:'proxy-ok'},finish_reason:null}]};
  res.write('data: '+JSON.stringify(chunk)+'\n\n');
  res.write('data: '+JSON.stringify({...chunk,choices:[{index:0,delta:{},finish_reason:'stop'}]})+'\n\n');res.end('data: [DONE]\n\n');
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const port=(server.address() as {port:number}).port,dir=await mkdtemp(join(tmpdir(),'provider-proxy-'));let adapter:PiAdapter|undefined;
 try{
  await mkdir(join(dir,'workspace'));
  adapter=await PiAdapter.open(config({ORANGE_DATA_DIR:join(dir,'data'),ORANGE_WORKSPACE:join(dir,'workspace'),ORANGE_MODEL:'gpt-4.1-mini'}));
  await adapter.configureProviders([{id:'proxy',vendor:'openai',model:'vendor/team-model:latest',baseUrl:`http://127.0.0.1:${port}/v1/`,apiKey:key}]);
  const c=await adapter.createConversation({externalId:'proxy-test'}),input=await adapter.dispatch('input.submit',{conversationId:c.id,requestId:randomUUID(),content:'hello'});
  const done=await until(()=>adapter!.dispatch('input.get',{id:input.id}),v=>['done','unanswered'].includes(v.status));
  expect(done.status).toBe('done');expect(requests).toHaveLength(1);expect(requests[0].url).toBe('/v1/chat/completions');expect(requests[0].authorization).toBe('Bearer '+key);expect(requests[0].body.model).toBe('vendor/team-model:latest');
  expect(JSON.stringify(await adapter.dispatch('history.list',{id:c.id,limit:100}))).toContain('proxy-ok');
 }finally{await adapter?.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(dir,{recursive:true,force:true});}
});

test('unknown-price custom model runs with token budget but refuses money budget',async()=>{
 const server=createServer(async(req,res)=>{for await(const chunk of req){}res.writeHead(200,{'Content-Type':'text/event-stream'});const c={id:'p',object:'chat.completion.chunk',created:1,model:'vendor/x',choices:[{index:0,delta:{role:'assistant',content:'priced?'},finish_reason:null}]};res.write('data: '+JSON.stringify(c)+'\n\n');res.write('data: '+JSON.stringify({...c,choices:[{index:0,delta:{},finish_reason:'stop'}]})+'\n\n');res.end('data: [DONE]\n\n');});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const port=(server.address() as {port:number}).port,f=await controlFixture();
 try{
  await f.setup();f.app.service.store.setSetting('config',{taskBudget:0.5});
  const created=await f.request('providers','POST',{vendor:'openai',model:'vendor/x',baseUrl:`http://127.0.0.1:${port}/v1`,apiKey:randomUUID()});
  expect(created.response.status).toBe(200);expect(f.app.service.list('providers')[0]!.pricingKnown).toBe(false);
  const conversation=await f.request('conversations','POST',{name:'pricing'}),id=conversation.json.data.id;
  expect((await f.request(`conversations/${id}/messages`,'POST',{content:'money budget'})).response.status).toBe(200);
  await f.until(()=>['FAILED','SUCCEEDED'].includes(f.app.service.list('tasks')[0]?.status),15000);
  expect(f.app.service.list('tasks')[0]!.error).toBe('BUDGET_PRICE_UNKNOWN');
  f.app.service.store.setSetting('config',{});
  expect((await f.request(`conversations/${id}/messages`,'POST',{content:'token budget'})).response.status).toBe(200);
  await f.until(()=>f.app.service.list('tasks').some(t=>t.status==='SUCCEEDED'));
  expect(f.app.service.list('tasks').find(t=>t.status==='SUCCEEDED')!.usage.costUnknown).toBe(true);
 }finally{await f.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test('provider endpoint and model validation rolls back setup; endpoint survives restart and can be cleared',async()=>{
 const f=await controlFixture();
 try{
  const base={username:'owner',password:CONTROL_TEST_PASSWORD,timezone:'UTC'},provider={vendor:'openai',model:'gpt-4.1-mini',apiKey:randomUUID()};
  for(const change of [{baseUrl:'file:///tmp/provider'},{baseUrl:'https://user:pass@example.com/v1'},{baseUrl:'https://example.com/v1?key=secret'},{model:'not-a-catalog-model'}]){
   const r=await f.request('setup','POST',{...base,provider:{...provider,...change}});expect(r.response.status).toBe(400);expect(r.json.error.code).toBe('model' in change?'UNSUPPORTED_MODEL':'INVALID_PROVIDER_URL');
   expect(f.app.service.store.list('users')).toHaveLength(0);expect(f.app.service.store.list('providers')).toHaveLength(0);expect(f.app.service.store.setting('initialized',false)).toBe(false);
  }
  const setup=await f.request('setup','POST',{...base,provider:{...provider,baseUrl:'https://proxy.example/v1'}});expect(setup.response.status).toBe(200);
  const record=f.app.service.list('providers')[0]!;expect(record.baseUrl).toBe('https://proxy.example/v1');expect(record.apiKey).toBeUndefined();
  await f.reopen();expect(f.app.service.list('providers')[0]!.baseUrl).toBe('https://proxy.example/v1');
  await f.app.service.provider({baseUrl:''},record.id);expect(f.app.service.list('providers')[0]!.baseUrl).toBeUndefined();
 }finally{await f.close();}
});
