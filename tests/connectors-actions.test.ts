import { describe,it,expect,afterEach } from 'vitest';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { ControlStore } from '../src/control/store.js';
import { GmailActions, mailTemplateHash, type Proposal } from '../src/connectors/actions.js';
import { createGmailConnector } from '../src/connectors/index.js';

const dirs:string[]=[];const stores:ControlStore[]=[];
afterEach(()=>{for(const s of stores.splice(0))s.close();for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
function setup(fetcher:typeof fetch=async()=>Response.json({id:'google-id',threadId:'thread'})) {
 const d=mkdtempSync(join(tmpdir(),'gmail-actions-'));dirs.push(d);const store=new ControlStore(d);stores.push(store);let bytes=Buffer.from('hello');
 const actions=new GmailActions(store,{connection:()=>({status:'CONNECTED',account:'owner@example.com'}),accessToken:async()=>'secret-token',resolveArtifact:()=>({bytes,sha256:createHash('sha256').update(bytes).digest('hex'),contentType:'text/plain'}),buildMessage:async()=>Buffer.from('mail').toString('base64url'),fetch:fetcher,now:()=>1700000000000});
 const proposal:Proposal={connectionId:'c',account:'owner@example.com',taskId:'t',principalId:'owner',profileId:'p',workflowId:'w',templateId:'template',expiresAt:1700000600000,mail:{to:['a@example.com'],subject:'主题',plainText:'正文'}};
 return {store,actions,proposal,change:()=>{bytes=Buffer.from('changed');}};
}
describe('Gmail action governance',()=>{
 it('binds authenticated context, requires approval and sends once',async()=>{
  let calls=0;const {actions,proposal}=setup(async(url,init)=>{calls++;expect(url).toBe('https://gmail.googleapis.com/gmail/v1/users/me/messages/send');expect(init?.method).toBe('POST');return Response.json({id:'g1'});});
  const api=actions.proposalApi({principalId:'im:1',profileId:'p',workflowId:'w',taskId:'t'});
  expect(()=>api.invoke({...proposal,principalId:'owner'} as never)).toThrow('ACCOUNT_PERMISSION_DENIED');
  const i=actions.propose(proposal);expect(i.status).toBe('WAITING_APPROVAL');
  await expect(actions.execute('owner',i.id,i.inputHash)).rejects.toThrow('APPROVAL_REQUIRED');expect(calls).toBe(0);
  expect(()=>actions.approve('owner',i.id,'wrong')).toThrow('APPROVAL_INVALID');actions.approve('owner',i.id,i.inputHash);
  expect((await actions.execute('owner',i.id,i.inputHash)).gmailId).toBe('g1');expect((await actions.execute('owner',i.id,i.inputHash)).status).toBe('CONFIRMED');expect(calls).toBe(1);
 });
 it('fails closed on changed secret payload and attachments',async()=>{
  const {actions,proposal,change,store}=setup();proposal.mail.attachments=[{artifactId:'a',filename:'x.txt'}];const i=actions.propose(proposal);actions.approve('owner',i.id,i.inputHash);change();await expect(actions.execute('owner',i.id,i.inputHash)).rejects.toThrow('ARTIFACT_HASH_MISMATCH');
  store.setSecret(`gmail:payload:${i.id}`,JSON.stringify({...proposal,mail:{...proposal.mail,subject:'changed'}}));expect(()=>actions.preview('owner',i.id)).toThrow('INTENT_HASH_MISMATCH');
 });
 it('rejects unauthorized dispatch before building MIME or accessing tokens',async()=>{
  const d=mkdtempSync(join(tmpdir(),'gmail-preflight-'));dirs.push(d);const store=new ControlStore(d);stores.push(store);let builds=0,tokens=0;const actions=new GmailActions(store,{connection:()=>({status:'CONNECTED',account:'owner@example.com'}),accessToken:async()=>{tokens++;return 'x';},resolveArtifact:()=>{throw new Error('unexpected');},buildMessage:async()=>{builds++;return 'x';},now:()=>1700000000000});const i=actions.propose({connectionId:'c',account:'owner@example.com',taskId:'t',principalId:'owner',profileId:'p',workflowId:'w',templateId:'x',expiresAt:1700000600000,mail:{to:['a@example.com'],subject:'s',plainText:'t'}});await expect(actions.execute('owner',i.id,i.inputHash)).rejects.toThrow('APPROVAL_REQUIRED');expect([builds,tokens]).toEqual([0,0]);
 });
 it('applies hard limit to approved actions and permits disabling expired rules',async()=>{
  const {actions,proposal,store}=setup();const i=actions.propose(proposal);actions.approve('owner',i.id,i.inputHash);for(let n=0;n<100;n++)store.put('gmail_intents',`past-${n}`,{...i,id:`past-${n}`,status:'CONFIRMED',dispatchedAt:1699999990000,connectionId:'other'});expect(actions.dryRun('owner',i.id).reason).toBe('SEND_HARD_LIMIT');await expect(actions.execute('owner',i.id,i.inputHash)).rejects.toThrow('SEND_HARD_LIMIT');
  const rule={id:'expired',connectionId:'c',profileId:'p',workflowId:'w',templateId:'t',templateHash:'hash',recipients:['a@example.com'],domains:[],minIntervalMs:0,dailyLimit:1,expiresAt:1699999999000,enabled:false,forbiddenTypes:[]};expect(()=>actions.setRule('owner',rule)).not.toThrow();expect(()=>actions.setRule('owner',{...rule,enabled:true})).toThrow('INVALID_RULE');
 });
 it('rejects risky HTML, ungranted principals, and cancellation prevents send',async()=>{
  const {actions,proposal}=setup();expect(()=>actions.propose({...proposal,principalId:'im:1'})).toThrow('ACCOUNT_PERMISSION_DENIED');expect(()=>actions.propose({...proposal,mail:{...proposal.mail,html:'<img src=x onerror=alert(1)>'}})).toThrow('UNSAFE_HTML');
  const i=actions.propose(proposal);actions.cancel('owner',i.id);await expect(actions.execute('owner',i.id,i.inputHash)).rejects.toThrow('SEND_NOT_ALLOWED');
 });
 it('keeps response loss uncertain and refuses retries',async()=>{
  let count=0;const {actions,proposal}=setup(async()=>{count++;throw new Error('lost');});const i=actions.propose(proposal);actions.approve('owner',i.id,i.inputHash);expect((await actions.execute('owner',i.id,i.inputHash)).status).toBe('SEND_UNCERTAIN');await expect(actions.execute('owner',i.id,i.inputHash)).rejects.toThrow('SEND_NOT_ALLOWED');expect(count).toBe(1);
 });
 it('propagates Gmail 401 to the public OAuth connection status',async()=>{
  const {store,proposal}=setup();store.put('app_connections','c',{id:'c',provider:'google',ownerId:'owner',scopes:['https://www.googleapis.com/auth/gmail.send'],status:'CONNECTED',createdAt:1700000000000,updatedAt:1700000000000,lastAuthorizedAt:1700000000000,tokenExpiresAt:1700003600000,refreshable:false});store.setSecret('app_connection:c:access_token','token');const {oauth,actions}=createGmailConnector(store,{oauth:{clientId:'client',redirectUris:['https://example.com/callback'],now:()=>1700000000000},artifacts:{read:()=>{throw new Error('unexpected');}},accountForConnection:()=>proposal.account,fetcher:async()=>new Response('',{status:401}),now:()=>1700000000000});const i=actions.propose(proposal);actions.approve('owner',i.id,i.inputHash);expect((await actions.execute('owner',i.id,i.inputHash)).error).toBe('NEEDS_REAUTH');expect(oauth.publicStatus('c')?.status).toBe('NEEDS_REAUTH');
 });
 it('classifies provider failures and never retries them automatically',async()=>{
  for(const [code,state,error] of [[401,'FAILED','NEEDS_REAUTH'],[403,'FAILED','FORBIDDEN_OR_QUOTA'],[429,'FAILED','RATE_LIMITED'],[500,'SEND_UNCERTAIN','UPSTREAM_UNCERTAIN']] as const){
   const {actions,proposal}=setup(async()=>new Response('',{status:code}));const i=actions.propose(proposal);actions.approve('owner',i.id,i.inputHash);const result=await actions.execute('owner',i.id,i.inputHash);expect([result.status,result.error]).toEqual([state,error]);await expect(actions.execute('owner',i.id,i.inputHash)).rejects.toThrow('SEND_NOT_ALLOWED');
  }
 });
 it('atomically rejects concurrent dispatch of the same intent',async()=>{
  let count=0;let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});const {actions,proposal}=setup(async()=>{count++;await gate;return Response.json({id:'g1'});});const i=actions.propose(proposal);actions.approve('owner',i.id,i.inputHash);const first=actions.execute('owner',i.id,i.inputHash);await new Promise(resolve=>setImmediate(resolve));await expect(actions.execute('owner',i.id,i.inputHash)).rejects.toThrow('SEND_NOT_ALLOWED');release();expect((await first).status).toBe('CONFIRMED');expect(count).toBe(1);
 });
 it('recovers interrupted dispatch without retry',async()=>{
  const {actions,proposal,store}=setup();const i=actions.propose(proposal);store.put('gmail_intents',i.id,{...i,status:'DISPATCHING',attemptId:'attempt'});expect(actions.recoverInterrupted()).toBe(1);expect(actions.get(i.id).status).toBe('SEND_UNCERTAIN');await expect(actions.execute('owner',i.id,i.inputHash)).rejects.toThrow('SEND_NOT_ALLOWED');
 });
 it('enforces exact automatic template and daily budget',async()=>{
  const {actions,proposal}=setup();const first=actions.propose(proposal);const mail=actions.preview('owner',first.id).proposal.mail;
  actions.setRule('owner',{id:'r',connectionId:'c',profileId:'p',workflowId:'w',templateId:'template',templateHash:mailTemplateHash(mail),recipients:['a@example.com'],domains:[],minIntervalMs:0,dailyLimit:1,expiresAt:1700000600000,enabled:true,forbiddenTypes:[]});
  expect(actions.dryRun('owner',first.id).eligible).toBe(true);expect((await actions.execute('owner',first.id,first.inputHash)).status).toBe('CONFIRMED');const second=actions.propose(proposal);expect(actions.dryRun('owner',second.id).reason).toBe('RULE_BUDGET_EXCEEDED');await expect(actions.execute('owner',second.id,second.inputHash)).rejects.toThrow('RULE_BUDGET_EXCEEDED');
  const altered=actions.propose({...proposal,mail:{...proposal.mail,plainText:'changed'}});expect(actions.dryRun('owner',altered.id).reason).toBe('APPROVAL_REQUIRED');
 });
});
