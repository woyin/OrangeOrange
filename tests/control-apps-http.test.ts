import { test, expect } from 'vitest';
import { controlFixture } from './control-fixture.js';
import { GMAIL_SEND_SCOPE } from '../src/connectors/oauth.js';
const redirectUri='https://hda.example/api/v1/oauth/google/callback';
async function fixture(uncertain=false){
  let sends=0,exchanges=0;const clients:string[]=[];
  const fetcher:typeof fetch=async(input,init)=>{
    const url=String(input);
    if(url==='https://oauth2.googleapis.com/token'){exchanges++;clients.push(new URLSearchParams(String(init?.body)).get('client_id')!);return new Response(JSON.stringify({access_token:'test-access-opaque',refresh_token:'test-refresh-opaque',expires_in:3600,token_type:'Bearer',scope:GMAIL_SEND_SCOPE}));}
    if(url==='https://oauth2.googleapis.com/revoke')return new Response('');
    if(url==='https://gmail.googleapis.com/gmail/v1/users/me/messages/send'){sends++;if(uncertain)throw new Error('LOST_CONFIRMATION');return new Response(JSON.stringify({id:'gmail-confirmed',threadId:'thread-1'}));}
    throw new Error('UNEXPECTED_NETWORK');
  };
  const f=await controlFixture({oauthRedirectUris:[redirectUri],fetcher});
  async function connect(clientId='one.apps.googleusercontent.com'){
    const created=await f.request('app-connections','POST',{provider:'gmail',label:'Private Gmail',account:'sender@example.com',accountConfirmed:true,clientId,clientSecret:'test-client-secret-opaque',redirectUri});
    expect(created.response.status,JSON.stringify(created.json)).toBe(200);
    const start=await f.request(`app-connections/${created.json.data.id}/oauth/start`,'POST',{});
    expect(start.response.status,JSON.stringify(start.json)).toBe(200);
    const url=new URL(start.json.data.authorizationUrl);expect(url.searchParams.get('scope')).toBe(GMAIL_SEND_SCOPE);expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    const callback=await fetch(`${f.app.url}/api/v1/oauth/google/callback?${new URLSearchParams({state:url.searchParams.get('state')!,code:'test-code'})}`,{redirect:'manual'});
    expect(callback.status).toBe(303);
    expect(callback.headers.get('referrer-policy')).toBe('no-referrer');
    expect((await fetch(`${f.app.url}/api/v1/oauth/google/callback?${new URLSearchParams({state:url.searchParams.get('state')!,code:'test-code'})}`,{redirect:'manual'})).status).toBe(400);
    const connections=(await f.request('app-connections')).json.data.items;
    return connections.find((c:any)=>c.id===created.json.data.id||c.label==='Private Gmail'&&c.status==='CONNECTED')!;
  }
  return {...f,get app(){return f.app;},connect,counts:()=>({sends,exchanges,clients})};
}
async function propose(f:Awaited<ReturnType<typeof fixture>>,connectionId:string){
  const result=await f.request('action-intents','POST',{connectionId,action:'gmail.send_email',input:{to:['recipient@example.com'],subject:'安排',plainText:'Private body not for audit'}});
  expect(result.response.status,JSON.stringify(result.json)).toBe(200);return result.json.data;
}

test('GM HTTP OAuth单用PKCE、无Cookie回调、草拟不发送、哈希审批、确认后幂等',async()=>{
  const f=await fixture();
  try{
    for(const p of ['app-connections','action-intents','app-rules'])expect((await f.request(p)).response.status).toBe(401);
    await f.setup();
    expect((await f.request('app-connections','POST',{provider:'gmail',label:'x',account:'sender@example.com',accountConfirmed:true,clientId:'one',redirectUri:'https://evil.example/callback'})).response.status).toBe(400);
    const c=await f.connect();expect(c.status).toBe('CONNECTED');expect(c.accountVerifiedByProvider).toBe(false);
    const i=await propose(f,c.id);expect(f.counts().sends).toBe(0);
    expect((await f.request(`action-intents/${i.id}/send`,'POST',{inputHash:i.inputHash})).response.status).toBe(400);
    expect(f.counts().sends).toBe(0);
    const preview=(await f.request(`action-intents/${i.id}/decision`)).json.data;expect(preview.proposal.mail.plainText).toBe('Private body not for audit');
    expect((await f.request(`action-intents/${i.id}/decision`,'POST',{decision:'APPROVED',inputHash:'0'.repeat(64)})).response.status).toBe(409);
    expect((await f.request(`action-intents/${i.id}/decision`,'POST',{decision:'APPROVED',inputHash:i.inputHash})).response.status).toBe(200);
    const sent=await f.request(`action-intents/${i.id}/send`,'POST',{inputHash:i.inputHash});expect(sent.json.data).toMatchObject({status:'CONFIRMED',gmailId:'gmail-confirmed'});
    expect((await f.request(`action-intents/${i.id}/send`,'POST',{inputHash:i.inputHash})).json.data.status).toBe('CONFIRMED');
    expect(f.counts()).toMatchObject({sends:1,exchanges:1});
    expect((await f.request(`action-intents/${i.id}/decision`)).json.data.bodyRetained).toBe(false);
    for(const path of ['app-connections','action-intents','config/export','system/diagnostics']){const value=JSON.stringify((await f.request(path)).json);for(const secret of ['test-access-opaque','test-refresh-opaque','test-client-secret-opaque','Private body not for audit'])expect(value).not.toContain(secret);}
  }finally{await f.close();}
});

test('GM HTTP 丢失发送确认跨服务重开保持SEND_UNCERTAIN，拒绝再次发送',async()=>{
  const f=await fixture(true);
  try{
    await f.setup();const c=await f.connect(),i=await propose(f,c.id);
    await f.request(`action-intents/${i.id}/decision`,'POST',{decision:'APPROVED',inputHash:i.inputHash});
    expect((await f.request(`action-intents/${i.id}/send`,'POST',{inputHash:i.inputHash})).json.data.status).toBe('SEND_UNCERTAIN');
    await f.reopen();
    expect((await f.request('action-intents')).json.data.items[0].status).toBe('SEND_UNCERTAIN');
    expect((await f.request(`action-intents/${i.id}/send`,'POST',{inputHash:i.inputHash})).response.status).not.toBe(200);
    expect(f.counts().sends).toBe(1);
  }finally{await f.close();}
});

test('GM备份恢复不包含OAuth秘密，恢复后账号要求重授权且邮件正文按保留策略清理',async()=>{
  const f=await fixture();
  try{
    await f.setup();
    expect((await f.request('settings','PATCH',{gmailBodyRetentionDays:7})).response.status).toBe(200);
    const c=await f.connect(),i=await propose(f,c.id);
    await f.request(`action-intents/${i.id}/decision`,'POST',{decision:'REJECTED',inputHash:i.inputHash});
    expect((await f.request(`action-intents/${i.id}/decision`)).json.data.bodyRetained).toBe(true);
    expect(f.app.service.apps.cleanBodies(Date.now()+8*86400000)).toBe(1);
    expect(f.app.service.apps.preview(i.id).bodyRetained).toBe(false);
    const snapshot=await f.app.service.snapshot();
    await f.app.service.restore(snapshot.id);
    const restored=f.app.service.apps.list();
    expect(restored[0]).toMatchObject({status:'NEEDS_REAUTH'});
    expect(f.app.service.store.secretMetadata()).toHaveLength(0);
    expect(f.app.service.apps.preview(i.id).intent.status).toBe('CANCELLED');
    expect((await f.request('app-connections')).response.status).toBe(401);
    expect(f.counts().sends).toBe(0);
  }finally{await f.close();}
});

test('GM Task Center真实绑定、取消后禁止批准与发信，跨重开不派发模型任务',async()=>{
 const f=await fixture();
 try{
  await f.setup();const c=await f.connect(),i=await propose(f,c.id);
  const task=f.app.service.get('tasks',i.taskId);expect(task).toMatchObject({executionKind:'connector',status:'WAITING_APPROVAL',principalId:'owner',actionIntentId:i.id});
  await f.app.service.tick();expect(f.faux.state.callCount).toBe(0);
  await f.reopen();expect(f.app.service.get('tasks',i.taskId).status).toBe('WAITING_APPROVAL');expect(f.faux.state.callCount).toBe(0);
  expect((await f.request(`tasks/${i.taskId}/actions`,'POST',{action:'cancel'})).response.status).toBe(200);
  expect(f.app.service.apps.preview(i.id).intent.status).toBe('CANCELLED');
  expect((await f.request(`action-intents/${i.id}/decision`,'POST',{decision:'APPROVED',inputHash:i.inputHash})).response.status).not.toBe(200);
  expect((await f.request(`action-intents/${i.id}/send`,'POST',{inputHash:i.inputHash})).response.status).not.toBe(200);expect(f.counts().sends).toBe(0);
 }finally{await f.close();}
});

test('GM OAuth重授权清除旧凭据、取消/过期清PKCE、账号删除不会残留有效授权',async()=>{
 const f=await fixture();
 try{
  await f.setup();const c=await f.connect();
  const start=await f.request(`app-connections/${c.id}/oauth/start`,'POST',{}),state=new URL(start.json.data.authorizationUrl).searchParams.get('state')!;
  const callback=await fetch(`${f.app.url}/api/v1/oauth/google/callback?${new URLSearchParams({state,code:'reauth'})}`,{redirect:'manual'});expect(callback.status).toBe(303);
  expect(f.app.service.store.get<any>('app_connections',c.id).status).toBe('REVOKED');
  expect(f.app.service.store.secretMetadata().filter(s=>s.name.includes(c.id))).toHaveLength(0);
  const current=(await f.request('app-connections')).json.data.items[0];
  const pending=await f.request(`app-connections/${current.id}/oauth/start`,'POST',{}),cancelState=new URL(pending.json.data.authorizationUrl).searchParams.get('state')!;
  expect(f.app.service.store.secretMetadata().some(s=>s.name.startsWith('oauth_pending:'))).toBe(true);
  expect((await fetch(`${f.app.url}/api/v1/oauth/google/callback?${new URLSearchParams({state:cancelState,error:'access_denied'})}`,{redirect:'manual'})).status).toBe(303);
  expect(f.app.service.store.list('oauth_pending')).toHaveLength(0);
  expect(f.app.service.store.secretMetadata().some(s=>s.name.startsWith('oauth_pending:'))).toBe(false);
  await f.request(`app-connections/${current.id}/oauth/start`,'POST',{});
  expect(f.app.service.apps.cleanupAuthorizations(Date.now()+11*60000)).toBe(1);
  expect(f.app.service.store.list('gmail_http_oauth')).toHaveLength(0);
  expect(f.app.service.store.secretMetadata().some(s=>s.name.startsWith('oauth_pending:'))).toBe(false);
  expect((await f.request(`app-connections/${current.id}`,'DELETE',{password:'a-long-test-password',confirm:true})).response.status).toBe(200);
  expect(f.app.service.apps.list()).toHaveLength(0);
  expect(f.app.service.store.secretMetadata()).toHaveLength(0);
 }finally{await f.close();}
});

test('GM预授权规则通过真实调度tick发送，未启用规则绝不自动发信',async()=>{
 const f=await fixture();
 try{
  await f.setup();const c=await f.connect(),i=await propose(f,c.id),preview=f.app.service.apps.preview(i.id);
  const rule={connectionId:c.id,profileId:'owner',workflowId:'manual',templateId:'manual',templateHash:preview.templateHash,recipients:['recipient@example.com'],domains:[],minIntervalMs:0,dailyLimit:1,expiresAt:Date.now()+60000,forbiddenTypes:[],enabled:false};
  const stored=await f.request('app-rules','POST',rule);expect(stored.response.status,JSON.stringify(stored.json)).toBe(200);
  await f.app.service.tick();expect(f.counts().sends).toBe(0);
  expect((await f.request(`app-rules/${stored.json.data.id}`,'PATCH',{enabled:true})).response.status).toBe(200);
  await f.until(()=>f.app.service.apps.preview(i.id).intent.status==='CONFIRMED');
  expect(f.counts().sends).toBe(1);expect(f.app.service.get('tasks',i.taskId).status).toBe('SUCCEEDED');
 }finally{await f.close();}
});
