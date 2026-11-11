import { createHash, randomUUID } from 'node:crypto';
import type { ControlStore } from './store.js';
import { ArtifactStore } from './artifacts.js';
import { createGmailConnector, discardPendingAuthorization, mailTemplateHash, GMAIL_SEND_SCOPE, validateAddress, type MailInput, type SendRule, type Grant } from '../connectors/index.js';

type Client={id:string;label:string;account:string;redirectUri:string;oauthConnectionId?:string;status:string;createdAt:number;authorizationGeneration?:string};
type ClientConfig={clientId:string;clientSecret?:string};
export class AppError extends Error {constructor(readonly code:string){super(code);}}
export class AppsService {
  private pending=new Set<Promise<unknown>>();
  constructor(private store:ControlStore, private options:{redirectUris:readonly string[];fetcher?:typeof fetch}){}
  private clients(){return this.store.list<Client>('gmail_clients');}
  private client(id:string):Client {const c=this.clients().find(c=>c.id===id||c.oauthConnectionId===id);if(!c)throw new AppError('CONNECTION_NOT_FOUND');return c;}
  private connector(id:string){
    const c=this.client(id),raw=this.store.getSecret(`gmail:client:${c.id}`);if(!raw)throw new AppError('NEEDS_REAUTH');
    const config=JSON.parse(raw) as ClientConfig;
    return createGmailConnector(this.store,{authorizeTask:p=>{const task=this.store.get<Record<string,any>>('tasks',p.taskId);if(!task||task.principalId!==p.principalId||['CANCELLED','FAILED','PAUSED'].includes(task.status))throw new AppError('MAIL_TASK_NOT_RUNNING');if(task.principalId!=='owner'&&task.channelId){const channel=this.store.get<Record<string,any>>('channels',task.channelId);if(!channel?.allowedUsers?.includes(String(task.principalId).split(':').at(-1)))throw new AppError('ACCOUNT_PERMISSION_DENIED');}},oauth:{...config,redirectUris:this.options.redirectUris,...(this.options.fetcher?{fetch:async(url,init)=>this.options.fetcher!(url,{...init,signal:AbortSignal.timeout(15000),redirect:'error'})}:{})},artifacts:new ArtifactStore(this.store),accountForConnection:connectionId=>{const owner=this.clients().find(x=>x.oauthConnectionId===connectionId);return owner?.account;},fetcher:this.options.fetcher});
  }
  private actions(id:string){const intent=this.store.get<{connectionId:string}>('gmail_intents',id);if(!intent)throw new AppError('INTENT_NOT_FOUND');return this.connector(intent.connectionId).actions;}
  create(input:{provider:string;label:string;account:string;accountConfirmed:boolean;clientId:string;clientSecret?:string;redirectUri:string}){
    if(input.provider!=='gmail'||typeof input.label!=='string'||!input.label.trim()||input.label.length>100)throw new AppError('INVALID_CONNECTION');
    if(input.accountConfirmed!==true)throw new AppError('ACCOUNT_CONFIRMATION_REQUIRED');
    const account=validateAddress(input.account);
    if(!this.options.redirectUris.includes(input.redirectUri))throw new AppError('REDIRECT_URI_NOT_ALLOWED');
    // Validate configuration before persisting an Owner-controlled draft account.
    const clientId=String(input.clientId??'');if(!clientId||clientId.length>512)throw new AppError('INVALID_CLIENT_ID');
    if(input.clientSecret!==undefined&&(typeof input.clientSecret!=='string'||input.clientSecret.length>4096))throw new AppError('INVALID_CLIENT_SECRET');
    const c:Client={id:randomUUID(),label:input.label,account,redirectUri:input.redirectUri,status:'DISCONNECTED',createdAt:Date.now()};
    this.store.transaction(()=>{this.store.setSecret(`gmail:client:${c.id}`,JSON.stringify({clientId,clientSecret:input.clientSecret}));this.store.put('gmail_clients',c.id,c,'owner');this.connector(c.id);});
    return this.publicClient(c);
  }
  private publicClient(c:Client){
    if(!this.store.getSecret(`gmail:client:${c.id}`))return {...c,id:c.oauthConnectionId??c.id,status:'NEEDS_REAUTH',scopes:[GMAIL_SEND_SCOPE],accountVerifiedByProvider:false};
    const oauth=c.oauthConnectionId?this.connector(c.id).oauth.publicStatus(c.oauthConnectionId):undefined;
    return {...c,id:c.oauthConnectionId??c.id,status:oauth?.status??c.status,scopes:oauth?.scopes??[GMAIL_SEND_SCOPE],accountVerifiedByProvider:false};
  }
  list(){return this.clients().map(c=>this.publicClient(c));}
  private clearPending(clientId:string){for(const flow of this.store.list<{id:string;clientId:string}>('gmail_http_oauth').filter(f=>f.clientId===clientId)){discardPendingAuthorization(this.store,flow.id,'owner');this.store.remove('gmail_http_oauth',flow.id);}}
  cleanupAuthorizations(now=Date.now()){
    let removed=0;
    this.store.transaction(()=>{for(const flow of this.store.list<{id:string;clientId:string;expiresAt:number}>('gmail_http_oauth'))if(flow.expiresAt<=now){discardPendingAuthorization(this.store,flow.id,'owner');this.store.remove('gmail_http_oauth',flow.id);removed++;}});
    return removed;
  }
  cancelAuthorization(state:string){const key=createHash('sha256').update(state).digest('hex'),flow=this.store.get<{clientId:string}>('gmail_http_oauth',key);if(!flow)throw new AppError('STATE_INVALID');discardPendingAuthorization(this.store,key,'owner');this.store.remove('gmail_http_oauth',key);return {cancelled:true};}
  async start(id:string){
    const c=this.client(id),generation=randomUUID();
    this.clearPending(c.id);
    this.store.put('gmail_clients',c.id,{...c,authorizationGeneration:generation,status:'AUTH_PENDING'});
    const start=await this.connector(id).oauth.startAuthorization({principalId:'owner',redirectUri:c.redirectUri});
    const stateHash=createHash('sha256').update(start.state).digest('hex');
    if(this.clients().find(x=>x.id===c.id)?.authorizationGeneration!==generation){discardPendingAuthorization(this.store,stateHash,'owner');throw new AppError('AUTHORIZATION_SUPERSEDED');}
    this.store.put('gmail_http_oauth',stateHash,{id:stateHash,clientId:c.id,generation,expiresAt:start.expiresAt});
    return {authorizationUrl:start.authorizationUrl,expiresAt:start.expiresAt};
  }
  async complete(state:string,code:string){
    if(typeof state!=='string'||state.length>512)throw new AppError('STATE_INVALID');
    const key=createHash('sha256').update(state).digest('hex'),pending=this.store.get<{clientId:string;generation:string;expiresAt:number}>('gmail_http_oauth',key);
    if(!pending||pending.expiresAt<=Date.now())throw new AppError('STATE_INVALID');
    const before=this.client(pending.clientId);
    if(before.authorizationGeneration!==pending.generation)throw new AppError('STATE_INVALID');
    this.store.remove('gmail_http_oauth',key);
    const connector=this.connector(pending.clientId),connection=await connector.oauth.completeAuthorization({state,code});
    const current=this.clients().find(c=>c.id===pending.clientId);
    if(!current||current.authorizationGeneration!==pending.generation){await connector.oauth.revoke(connection.id,'owner').catch(()=>{});throw new AppError('CONNECTION_REVOKED');}
    const prior=current.oauthConnectionId;
    this.store.put('gmail_clients',current.id,{...current,oauthConnectionId:connection.id,status:'CONNECTED'});
    if(prior&&prior!==connection.id)await connector.oauth.revoke(prior,'owner').catch(()=>{});
    return {connected:true,connectionId:connection.id};
  }
  async test(id:string){const c=this.client(id);if(!c.oauthConnectionId)throw new AppError('NEEDS_REAUTH');await this.connector(id).oauth.accessToken(c.oauthConnectionId,'owner');return this.publicClient(this.client(id));}
  async revoke(id:string){
    const c=this.client(id),connector=this.store.getSecret(`gmail:client:${c.id}`)?this.connector(id):undefined;
    this.store.transaction(()=>{this.clearPending(c.id);this.store.deleteSecret(`gmail:client:${c.id}`);this.store.remove('gmail_clients',c.id,'owner');for(const rule of this.rules().filter(r=>r.connectionId===c.oauthConnectionId||r.connectionId===c.id))this.store.put('gmail_rules',rule.id,{...rule,enabled:false});for(const grant of this.grants().filter(g=>g.connectionId===c.oauthConnectionId))this.store.put('gmail_grants',grant.id,{...grant,enabled:false});for(const intent of this.store.list<Record<string,any>>('gmail_intents').filter(i=>i.connectionId===c.oauthConnectionId&&['WAITING_APPROVAL','APPROVED'].includes(i.status)))this.cancel(intent.id);});
    try{if(c.oauthConnectionId&&connector)await connector.oauth.revoke(c.oauthConnectionId,'owner');return {deleted:true};}finally{this.cleanBodies();}
  }
  propose(input:{connectionId:string;action:string;input:MailInput;taskId?:string;templateId?:string},context:{principalId:string;taskId:string;profileId:string;workflowId:string}){
    if (!input.input || typeof input.input !== 'object' || Array.isArray(input.input) || Object.keys(input.input).some(k => !['to','cc','bcc','subject','plainText','html','attachments'].includes(k))) throw new AppError('INVALID_MAIL_FIELDS');
    if (input.input.attachments && (!Array.isArray(input.input.attachments) || input.input.attachments.some(a => !a || typeof a !== 'object' || Object.keys(a).some(k => !['artifactId','filename'].includes(k))))) throw new AppError('INVALID_ATTACHMENT_FIELDS');
    if(input.action!=='gmail.send_email')throw new AppError('ACTION_NOT_ALLOWED');const c=this.client(input.connectionId);if(!c.oauthConnectionId)throw new AppError('NEEDS_REAUTH');
    const result=this.connector(c.id).actions.proposalApi(context).invoke({connectionId:c.oauthConnectionId,account:c.account,templateId:input.templateId??'manual',expiresAt:Date.now()+10*60000,mail:input.input});
    const next={...result,summary:{recipients:[...input.input.to,...(input.input.cc??[]),...(input.input.bcc??[])].map(a=>a.replace(/^[^@]+@/,'***@')),subjectHash:createHash('sha256').update(input.input.subject).digest('hex'),contentHash:createHash('sha256').update(input.input.plainText).digest('hex'),attachmentCount:input.input.attachments?.length??0}};
    this.store.put('gmail_intents',next.id,next);this.store.event('action.proposed',next.id);return next;
  }
  intents(){return this.store.list('gmail_intents');}
  preview(id:string){const intent=this.store.get<Record<string,any>>('gmail_intents',id);if(!intent)throw new AppError('INTENT_NOT_FOUND');const raw=this.store.getSecret(`gmail:payload:${id}`);if(raw===undefined)return {intent,bodyRetained:false};const proposal=JSON.parse(raw);if(createHash('sha256').update(JSON.stringify(proposal)).digest('hex')!==intent.inputHash)throw new AppError('INTENT_HASH_MISMATCH');return {intent,proposal,templateHash:mailTemplateHash(proposal.mail),bodyRetained:true};}
  approve(id:string,inputHash:string){const result=this.actions(id).approve('owner',id,inputHash);this.store.event('action.changed',id);return result;}
  cancel(id:string){return this.store.transaction(()=>{const current=this.preview(id).intent;if(!['WAITING_APPROVAL','APPROVED'].includes(current.status))throw new AppError('CANCEL_NOT_ALLOWED');const result={...current,status:'CANCELLED',finishedAt:Date.now()};this.store.put('gmail_intents',id,result,'owner');this.cleanBodies();this.store.event('action.changed',id);return result;});}
  async send(id:string,inputHash:string){
    const prior=this.preview(id).intent;if(prior.inputHash!==inputHash)throw new AppError('INTENT_HASH_MISMATCH');if(prior.status==='CONFIRMED')return prior;
    const promise=this.actions(id).execute('owner',id,inputHash);this.pending.add(promise);
    try{const result=await promise;this.cleanBodies();this.store.event('action.changed',id);return result;}finally{this.pending.delete(promise);}
  }
  dryRun(id:string){return this.actions(id).dryRun('owner',id);}
  rules(){return this.store.list<SendRule>('gmail_rules');}
  rule(input:Omit<SendRule,'id'>,id:string=randomUUID()){const c=this.client(input.connectionId);if(!c.oauthConnectionId)throw new AppError('NEEDS_REAUTH');const rule={...input,id,connectionId:c.oauthConnectionId};this.connector(c.id).actions.setRule('owner',rule);return rule;}
  grant(input:Omit<Grant,'id'>){const c=this.client(input.connectionId);if(!c.oauthConnectionId)throw new AppError('NEEDS_REAUTH');const normalized={...input,connectionId:c.oauthConnectionId};const id=createHash('sha256').update(JSON.stringify({connectionId:normalized.connectionId,principalId:input.principalId,profileId:input.profileId,taskId:input.taskId,workflowId:input.workflowId})).digest('hex');this.connector(c.id).actions.grant('owner',{...normalized,id});const principal=this.store.get<Record<string,any>>('principals',input.principalId);if(principal){const active=this.grants().some(g=>g.principalId===input.principalId&&g.enabled);const permissions=new Set<string>(principal.permissions??[]);for(const name of ['gmail_send_email','gmail_connections']){if(active)permissions.add(name);else permissions.delete(name);}this.store.put('principals',input.principalId,{...principal,permissions:[...permissions]},'owner');}return {id,granted:input.enabled};}
  grants(){return this.store.list<Grant>('gmail_grants');}
  setGrantEnabled(id:string,enabled:boolean){const grant=this.grants().find(g=>g.id===id);if(!grant)throw new AppError('GRANT_NOT_FOUND');return this.grant({...grant,enabled});}
  recover(){let count=0;this.store.transaction(()=>{for(const intent of this.store.list<{id:string;status:string}>('gmail_intents'))if(intent.status==='DISPATCHING'){this.store.put('gmail_intents',intent.id,{...intent,status:'SEND_UNCERTAIN',error:'PROCESS_INTERRUPTED',finishedAt:Date.now()});count++;}});this.cleanBodies();return count;}
  cleanBodies(now=Date.now()) {
    this.cleanupAuthorizations(now);
    const days=this.store.setting<{gmailBodyRetentionDays?:number}>('config',{}).gmailBodyRetentionDays??0;
    if(!Number.isInteger(days)||days<0||days>365)throw new AppError('INVALID_BODY_RETENTION');
    let removed=0;
    this.store.transaction(()=>{
      for(const original of this.store.list<Record<string,any>>('gmail_intents')){
        let i=original;
        if(['WAITING_APPROVAL','APPROVED'].includes(i.status)&&i.expiresAt<=now){i={...i,status:'CANCELLED',error:'INTENT_EXPIRED',finishedAt:now};this.store.put('gmail_intents',i.id,i);}
        if(['CONFIRMED','FAILED','SEND_UNCERTAIN','CANCELLED'].includes(i.status)&&typeof i.finishedAt==='number'&&i.finishedAt+days*86400000<=now&&this.store.getSecret(`gmail:payload:${i.id}`)!==undefined){this.store.deleteSecret(`gmail:payload:${i.id}`);removed++;}
      }
    });
    return removed;
  }
  async drain(){await Promise.allSettled([...this.pending]);}
}
