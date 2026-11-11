import { randomUUID, createHash } from 'node:crypto';
import { ControlStore } from '../control/store.js';

export const GLOBAL_DAILY_SEND_LIMIT=200;
export const ACCOUNT_DAILY_SEND_LIMIT=100;
export const GLOBAL_MIN_SEND_INTERVAL_MS=500;
export const ACCOUNT_MIN_SEND_INTERVAL_MS=1000;
export const SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
export interface AttachmentRef { artifactId:string; filename:string }
export interface AttachmentSnapshot extends AttachmentRef { sha256:string; contentType:string; size:number }
export interface MailInput { to:string[]; cc?:string[]; bcc?:string[]; subject:string; plainText:string; html?:string; attachments?:AttachmentRef[] }
export interface SnapshotMail extends Omit<MailInput,'attachments'> { attachments?:AttachmentSnapshot[] }
export interface ManagedArtifact { bytes:Buffer; sha256:string; contentType:string }
/** Adapt the trusted ArtifactStore.read interface; the identifier is never a filesystem path. */
export function artifactResolver(store:{read(id:string):{bytes:Buffer;sha256:string;mimeType:string}}):(id:string)=>ManagedArtifact {return id=>{const a=store.read(id);return {bytes:a.bytes,sha256:a.sha256,contentType:a.mimeType};};}
export interface Proposal { connectionId:string; account:string; taskId:string; principalId:string; profileId:string; workflowId:string; templateId:string; expiresAt:number; mail:MailInput }
interface SnapshotProposal extends Omit<Proposal,'mail'> {mail:SnapshotMail}
export type ActionStatus = 'WAITING_APPROVAL'|'APPROVED'|'DISPATCHING'|'CONFIRMED'|'FAILED'|'SEND_UNCERTAIN'|'CANCELLED';
export interface Intent { id:string; inputHash:string; connectionId:string; account:string; taskId:string; principalId:string; profileId:string; workflowId:string; templateId:string; expiresAt:number; status:ActionStatus; createdAt:number; messageId:string; attemptId?:string; dispatchedAt?:number; finishedAt?:number; gmailId?:string; threadId?:string; error?:string; approvalHash?:string; ruleId?:string }
export interface Grant { id:string; connectionId:string; principalId:string; profileId:string; taskId:string; workflowId:string; enabled:boolean }
export interface SendRule { id:string; connectionId:string; profileId:string; workflowId:string; templateId:string; templateHash:string; recipients:string[]; domains:string[]; minIntervalMs:number; dailyLimit:number; expiresAt:number; enabled:boolean; forbiddenTypes:string[] }
export interface SendDependencies {
  authorizeTask?:(context:Pick<Proposal,'principalId'|'taskId'|'profileId'|'workflowId'>)=>void;
  connection(id:string):{status:string; account:string}|undefined;
  accessToken(id:string):Promise<string>;
  resolveArtifact(id:string):ManagedArtifact;
  buildMessage(mail:SnapshotMail,messageId:string,attachments:Array<AttachmentSnapshot & {bytes:Buffer}>,account:string):Promise<string>;
  fetch?:typeof fetch;
  now?:()=>number;
  markNeedsReauth?(id:string):void;
}
const digest=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
/** Hash the exact mail payload to bind an automatic rule to reviewed content. */
export const mailTemplateHash=(mail:SnapshotMail):string=>digest(mail);
const owner=(actor:string)=>{if(actor!=='owner')throw new Error('OWNER_REQUIRED');};
const kind='gmail_intents';
const nonempty=(s:string)=>typeof s==='string'&&s.trim().length>0;

/** Trusted service boundary. Only the proposal facade may be exposed to an agent. */
export class GmailActions {
  private readonly now:()=>number;
  private readonly fetcher:typeof fetch;
  constructor(private readonly store:ControlStore,private readonly deps:SendDependencies) {this.now=deps.now??Date.now;this.fetcher=deps.fetch??fetch;}
  manifest() {return {name:'gmail',version:'1.0',scopes:[SEND_SCOPE],actions:this.listActions()};}
  discoverScopes() {return [{scope:SEND_SCOPE,sensitivity:'Sensitive'}];}
  listActions() {return [{name:'gmail.send_email',inputSchema:{type:'object',required:['connectionId','mail']},outputSchema:{type:'object'},sideEffect:'send',risk:'EXTERNAL_SEND',requiredScopes:[SEND_SCOPE],timeoutMs:30000,retryClass:'never_after_dispatch',approvalPolicy:'owner_or_explicit_rule'}];}
  /** Model-facing method: never dispatches or approves. */
  proposalApi(context:Pick<Proposal,'principalId'|'taskId'|'profileId'|'workflowId'>) {const bound={...context};return {manifest:()=>this.manifest(),discoverScopes:()=>this.discoverScopes(),listActions:()=>this.listActions(),invoke:(input:Omit<Proposal,'principalId'|'taskId'|'profileId'|'workflowId'>)=>this.propose({...input,...bound})};}
  grant(actor:string,g:Grant):void {owner(actor);if(![g.id,g.connectionId,g.principalId,g.profileId,g.taskId,g.workflowId].every(nonempty)||typeof g.enabled!=='boolean')throw new Error('INVALID_GRANT');this.store.put('gmail_grants',g.id,g,actor);}
  setRule(actor:string,r:SendRule):void {
    owner(actor);
    if(![r.id,r.connectionId,r.profileId,r.workflowId,r.templateId,r.templateHash].every(nonempty)||!Array.isArray(r.recipients)||!Array.isArray(r.domains)||!Array.isArray(r.forbiddenTypes)||!r.recipients.concat(r.domains,r.forbiddenTypes).every(nonempty)||(!r.recipients.length&&!r.domains.length)||!Number.isSafeInteger(r.dailyLimit)||r.dailyLimit<1||!Number.isSafeInteger(r.minIntervalMs)||r.minIntervalMs<0||!Number.isFinite(r.expiresAt)||(r.enabled&&r.expiresAt<=this.now())||typeof r.enabled!=='boolean')throw new Error('INVALID_RULE');
    this.store.put('gmail_rules',r.id,r,actor);
  }
  private allowed(p:Proposal):boolean {return p.principalId==='owner'||this.store.list<Grant>('gmail_grants').some(g=>g.enabled&&g.connectionId===p.connectionId&&g.principalId===p.principalId&&g.profileId===p.profileId&&(g.taskId===p.taskId||g.taskId==='*')&&g.workflowId===p.workflowId);}
  private connection(p:Proposal):void {this.deps.authorizeTask?.(p);const c=this.deps.connection(p.connectionId);if(!c||!['CONNECTED','EXPIRED'].includes(c.status)||c.account!==p.account)throw new Error('CONNECTION_UNAVAILABLE');if(!this.allowed(p))throw new Error('ACCOUNT_PERMISSION_DENIED');}
  private payload(i:Intent):SnapshotProposal {const raw=this.store.getSecret(`gmail:payload:${i.id}`);if(!raw)throw new Error('PAYLOAD_UNAVAILABLE');const p=JSON.parse(raw) as SnapshotProposal;if(digest(p)!==i.inputHash)throw new Error('INTENT_HASH_MISMATCH');return p;}
  propose(input:Proposal):Intent {
    const p=JSON.parse(JSON.stringify(input)) as Proposal;
    if(!p||![p.connectionId,p.account,p.taskId,p.principalId,p.profileId,p.workflowId,p.templateId].every(nonempty)||!Number.isFinite(p.expiresAt)||p.expiresAt<=this.now()||!p.mail||!Array.isArray(p.mail.to)||!p.mail.to.length||!Array.isArray(p.mail.cc??[])||!Array.isArray(p.mail.bcc??[])||!p.mail.to.concat(p.mail.cc??[],p.mail.bcc??[]).every(nonempty)||!nonempty(p.mail.subject)||typeof p.mail.plainText!=='string'||(p.mail.html!==undefined&&typeof p.mail.html!=='string')||!Array.isArray(p.mail.attachments??[]))throw new Error('INVALID_PROPOSAL');
    this.connection(p);
    if(p.mail.html!==undefined&&/[<>]/.test(p.mail.html.replace(/<\/?(?:p|br|b|strong|em|i|ul|ol|li|blockquote|pre|code)\s*\/?>/gi,'')))throw new Error('UNSAFE_HTML');
    const attachments=(p.mail.attachments??[]).map(ref=>{if(!ref||!nonempty(ref.artifactId)||!nonempty(ref.filename)||Object.keys(ref).some(k=>k!=='artifactId'&&k!=='filename'))throw new Error('INVALID_ATTACHMENT');const a=this.deps.resolveArtifact(ref.artifactId);if(createHash('sha256').update(a.bytes).digest('hex')!==a.sha256)throw new Error('ARTIFACT_HASH_MISMATCH');return {...ref,sha256:a.sha256,size:a.bytes.length,contentType:a.contentType};});
    const snapshot:SnapshotProposal={...p,mail:{...p.mail,attachments}};
    const id=randomUUID();const i:Intent={id,inputHash:digest(snapshot),connectionId:p.connectionId,account:p.account,taskId:p.taskId,principalId:p.principalId,profileId:p.profileId,workflowId:p.workflowId,templateId:p.templateId,expiresAt:p.expiresAt,status:'WAITING_APPROVAL',createdAt:this.now(),messageId:`<${randomUUID()}@orangeorange.local>`};
    this.store.transaction(()=>{this.store.setSecret(`gmail:payload:${id}`,JSON.stringify(snapshot));this.store.put(kind,id,i);this.store.event('gmail.intent.created',id,i);});return i;
  }
  get(id:string):Intent {const i=this.store.get<Intent>(kind,id);if(!i)throw new Error('INTENT_NOT_FOUND');return i;}
  list(actor:string):Intent[] {owner(actor);return this.store.list<Intent>(kind);}
  preview(actor:string,id:string):{intent:Intent;proposal:SnapshotProposal} {owner(actor);const i=this.get(id);return {intent:i,proposal:this.payload(i)};}
  approve(actor:string,id:string,exactHash:string):Intent {owner(actor);return this.store.transaction(()=>{const i=this.get(id);this.connection(this.payload(i));if(i.status!=='WAITING_APPROVAL'||i.expiresAt<=this.now()||i.inputHash!==exactHash)throw new Error('APPROVAL_INVALID');const next:Intent={...i,status:'APPROVED',approvalHash:exactHash};this.store.put(kind,id,next,actor);this.store.event('gmail.intent.updated',id,next);return next;});}
  cancel(actor:string,id:string):Intent {owner(actor);return this.store.transaction(()=>{const i=this.get(id);if(!['WAITING_APPROVAL','APPROVED'].includes(i.status))throw new Error('CANCEL_NOT_ALLOWED');const next:Intent={...i,status:'CANCELLED',finishedAt:this.now()};this.store.put(kind,id,next,actor);this.store.event('gmail.intent.updated',id,next);return next;});}
  private ruleFor(p:SnapshotProposal):SendRule|undefined {
    const recipients=p.mail.to.concat(p.mail.cc??[],p.mail.bcc??[]).map(x=>x.toLowerCase());
    return this.store.list<SendRule>('gmail_rules').find(r=>r.enabled&&r.expiresAt>this.now()&&r.connectionId===p.connectionId&&r.profileId===p.profileId&&r.workflowId===p.workflowId&&r.templateId===p.templateId&&r.templateHash===mailTemplateHash(p.mail)&&recipients.every(a=>r.recipients.some(x=>x.toLowerCase()===a)||r.domains.some(x=>a.split('@').length===2&&a.split('@')[1]===x.toLowerCase()))&&(p.mail.attachments??[]).every(a=>!r.forbiddenTypes.includes(a.contentType)));
  }
  private budget(r:SendRule):void {const now=this.now(),start=Math.floor(now/86400000)*86400000;const prior=this.store.list<Intent>(kind).filter(i=>i.ruleId===r.id&&i.dispatchedAt!==undefined);if(prior.filter(i=>i.dispatchedAt!>=start).length>=r.dailyLimit||prior.some(i=>now-i.dispatchedAt!<r.minIntervalMs))throw new Error('RULE_BUDGET_EXCEEDED');}
  private hardBudget(accountAddress:string):void {const now=this.now(),start=Math.floor(now/86400000)*86400000;const all=this.store.list<Intent>(kind).filter(i=>i.dispatchedAt!==undefined);const account=all.filter(i=>i.account.toLowerCase()===accountAddress.toLowerCase());if(all.filter(i=>i.dispatchedAt!>=start).length>=GLOBAL_DAILY_SEND_LIMIT||account.filter(i=>i.dispatchedAt!>=start).length>=ACCOUNT_DAILY_SEND_LIMIT||all.some(i=>now-i.dispatchedAt!<GLOBAL_MIN_SEND_INTERVAL_MS)||account.some(i=>now-i.dispatchedAt!<ACCOUNT_MIN_SEND_INTERVAL_MS))throw new Error('SEND_HARD_LIMIT');}
  dryRun(actor:string,id:string):{intent:Intent;eligible:boolean;reason:string} {owner(actor);const i=this.get(id);const p=this.payload(i);try {this.connection(p);if(i.expiresAt<=this.now())throw new Error('INTENT_EXPIRED');if(i.status==='APPROVED'&&i.approvalHash===i.inputHash){this.hardBudget(i.account);return {intent:i,eligible:true,reason:'APPROVED'};}const r=this.ruleFor(p);if(i.status==='WAITING_APPROVAL'&&r){this.budget(r);this.hardBudget(i.account);return {intent:i,eligible:true,reason:'RULE'};}throw new Error('APPROVAL_REQUIRED');}catch(e){return {intent:i,eligible:false,reason:e instanceof Error?e.message:'DENIED'};}}
  /** Call exactly once during exclusive service startup, before accepting dispatches. */
  recoverInterrupted():number {return this.store.transaction(()=>{let n=0;for(const i of this.store.list<Intent>(kind))if(i.status==='DISPATCHING'){const next={...i,status:'SEND_UNCERTAIN',error:'PROCESS_INTERRUPTED',finishedAt:this.now()};this.store.put(kind,i.id,next);this.store.event('gmail.intent.updated',i.id,next);n++;}return n;});}
  async execute(actor:string,id:string,exactHash:string):Promise<Intent> {
    owner(actor);let i=this.get(id);if(i.inputHash!==exactHash)throw new Error('INTENT_HASH_MISMATCH');if(i.status==='CONFIRMED')return i;if(!['WAITING_APPROVAL','APPROVED'].includes(i.status))throw new Error('SEND_NOT_ALLOWED');
    const p=this.payload(i);this.connection(p);if(i.expiresAt<=this.now())throw new Error('INTENT_EXPIRED');
    const check=this.dryRun(actor,id);if(!check.eligible)throw new Error(check.reason);
    const attachments=(p.mail.attachments??[]).map(ref=>{const a=this.deps.resolveArtifact(ref.artifactId);if(a.sha256!==ref.sha256||a.contentType!==ref.contentType||a.bytes.length!==ref.size||createHash('sha256').update(a.bytes).digest('hex')!==ref.sha256)throw new Error('ARTIFACT_HASH_MISMATCH');return {...ref,bytes:a.bytes};});
    const raw=await this.deps.buildMessage(p.mail,i.messageId,attachments,p.account);const token=await this.deps.accessToken(p.connectionId);
    i=this.store.transaction(()=>{const current=this.get(id);if(current.inputHash!==exactHash)throw new Error('INTENT_HASH_MISMATCH');if(!['WAITING_APPROVAL','APPROVED'].includes(current.status))throw new Error('SEND_NOT_ALLOWED');const original=this.payload(current);this.connection(original);if(current.expiresAt<=this.now())throw new Error('INTENT_EXPIRED');let ruleId:string|undefined;if(current.status==='APPROVED'){if(current.approvalHash!==current.inputHash)throw new Error('APPROVAL_INVALID');}else{const r=this.ruleFor(original);if(!r)throw new Error('APPROVAL_REQUIRED');this.budget(r);ruleId=r.id;}this.hardBudget(current.account);const next:Intent={...current,status:'DISPATCHING',attemptId:randomUUID(),dispatchedAt:this.now(),ruleId};this.store.put(kind,id,next,actor);this.store.event('gmail.intent.updated',id,next);return next;});
    let status:ActionStatus='SEND_UNCERTAIN',error:string|undefined,gmailId:string|undefined,threadId:string|undefined;
    try {
      const response=await this.fetcher('https://gmail.googleapis.com/gmail/v1/users/me/messages/send',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({raw}),signal:AbortSignal.timeout(30000),redirect:'error'});
      if(response.ok){const data=await response.json() as {id?:unknown;threadId?:unknown};if(typeof data.id==='string'&&data.id){status='CONFIRMED';gmailId=data.id;if(typeof data.threadId==='string')threadId=data.threadId;}else error='INVALID_RESPONSE';}
      else if(response.status===401){status='FAILED';error='NEEDS_REAUTH';}
      else if(response.status===429){status='FAILED';error='RATE_LIMITED';}
      else if(response.status===403){status='FAILED';error='FORBIDDEN_OR_QUOTA';}
      else if(response.status>=400&&response.status<500){status='FAILED';error='FAILED_VALIDATION';}
      else error='UPSTREAM_UNCERTAIN';
    } catch {error='NETWORK_UNCERTAIN';}
    return this.store.transaction(()=>{const current=this.get(id);if(current.status!=='DISPATCHING'||current.attemptId!==i.attemptId)throw new Error('DISPATCH_STATE_CHANGED');const next:Intent={...current,status,error,gmailId,threadId,finishedAt:this.now()};if(error==='NEEDS_REAUTH')this.deps.markNeedsReauth?.(current.connectionId);this.store.put(kind,id,next,actor);this.store.event('gmail.intent.updated',id,next);return next;});
  }
}
