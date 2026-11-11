import { randomUUID } from 'node:crypto';
import { ControlStore, hash } from './store.js';

export interface MemoryProposal {
  principalId:string; scope:string; content:string; kind:string; source:string;
  category?:string; key?:string; confidence?:number;
}
export type MemoryPolicyState = 'REJECTED'|'DUPLICATE'|'CONFLICT'|'PENDING_REVIEW'|'APPLIED';
export interface MemoryPolicyResult { state:MemoryPolicyState; id:string; exactHash?:string; reason?:string; }
export interface MemoryDecision { principalId:string; scope:string; id:string; exactHash:string; decision:'approve'|'reject'; }
type Candidate = MemoryProposal & { id:string; exactHash:string; state:'CONFLICT'|'PENDING_REVIEW'|'APPLIED'|'REJECTED'|'DUPLICATE'; categories:string[]; origin:'model'|'owner'; created_at:number; memoryId?:string };
type Memory = Record<string, unknown> & { id:string };
const CANDIDATES='memory_policy_candidates';
const SETTINGS='memory_policy_blocked_categories';
const rules: [string, RegExp][] = [
  ['secret', /\b(?:password|passwd|passphrase|api[ _-]?key|secret|access[ _-]?token|private[ _-]?key)\b|密码|口令|密钥|令牌/i],
  ['health', /\b(?:health|medical|diagnos(?:is|ed)|diabetes|cancer|disease|medication|patient)\b|健康|医疗|疾病|病史|诊断|糖尿病|癌症|用药/i],
  ['finance', /\b(?:financ(?:e|ial)|bank|salary|income|debt|credit[ -]?card|account balance)\b|财务|金融|银行|工资|收入|负债|信用卡|账户余额/i],
  ['identity', /\b(?:identity|passport|social security|ssn|national id)\b|身份证|护照|社保号/i],
];
const aliases:Record<string,string> = { password:'secret', passwords:'secret', credential:'secret', credentials:'secret', '密码':'secret', '密钥':'secret', medical:'health', '健康':'health', financial:'finance', '财务':'finance', id:'identity', '身份证':'identity' };
function categoryName(value:string):string { const v=value.trim().toLowerCase(); return aliases[v]??v; }
function categories(input:MemoryProposal):string[] {
  const found=new Set<string>();
  if(input.category) {
    const declared=categoryName(input.category);found.add(declared);
    for(const [name,pattern] of rules) if(pattern.test(input.category)) found.add(name);
  }
  for(const [name,pattern] of rules) if(pattern.test(input.content)) found.add(name);
  return [...found].sort();
}
function validText(value:unknown,max:number):value is string {return typeof value==='string' && value.trim().length>0 && value.length<=max;}
function validate(input:MemoryProposal):void {
  if(!validText(input.principalId,200)||!validText(input.scope,200)||!validText(input.content,10000)||!validText(input.source,500)||!['working','episodic','semantic','procedural'].includes(input.kind)||
    (input.category!==undefined&&!validText(input.category,200))||(input.key!==undefined&&!validText(input.key,200))||
    (input.confidence!==undefined&&(!Number.isFinite(input.confidence)||input.confidence<0||input.confidence>1))) throw new Error('INVALID_MEMORY_PROPOSAL');
}
function identity(input:MemoryProposal, origin:'model'|'owner'):string {
  return hash({principalId:input.principalId,scope:input.scope,content:input.content,kind:input.kind,source:input.source,category:input.category??null,key:input.key??null,confidence:input.confidence??null,origin});
}
function active(m:Memory):boolean {
  const expiry=m.expires_at??m.expiresAt;
  const at=typeof expiry==='string'?Date.parse(expiry):Number(expiry);
  return m.status==='active'&&(expiry==null||at>Date.now());
}
function ownerOf(m:Memory):unknown { return m.principalId??'owner'; }

/** Trusted callers must authenticate and authorize the Owner and principal before invoking this service. */
export class MemoryPolicyService {
  constructor(private readonly store:ControlStore) {}
  setBlockedCategories(owner:string, values:string[]):void {
    if(!validText(owner,200)||!Array.isArray(values)||values.some(v=>!validText(v,200))) throw new Error('INVALID_MEMORY_POLICY');
    this.store.put(SETTINGS,owner,{ principalId:owner, categories:[...new Set(values.map(categoryName))].sort() },'owner');
  }
  /** Authenticated Owner writes bind confirmation to this exact request body, not a tool approval. */
  assertOwnerWrite(input:MemoryProposal,confirmedSensitive=false):string[] {
    validate(input);const cats=categories(input);
    if(cats.includes('secret')||this.blocked(input.principalId,cats))throw new Error('MEMORY_POLICY_BLOCKED');
    if(cats.some(c=>['health','finance','identity'].includes(c))&&!confirmedSensitive)throw new Error('MEMORY_CONTENT_CONFIRMATION_REQUIRED');
    return cats;
  }
  propose(input:MemoryProposal):MemoryPolicyResult { return this.submit(input,'model'); }
  /** Call only for an authenticated, explicit Owner instruction, never for a model claim. */
  writeOwner(input:MemoryProposal):MemoryPolicyResult { return this.submit(input,'owner'); }
  listCandidates(principalId:string,scope:string):Candidate[] {
    if(!validText(principalId,200)||!validText(scope,200)) throw new Error('INVALID_MEMORY_POLICY');
    return this.store.list<Candidate>(CANDIDATES).filter(c=>c.principalId===principalId&&c.scope===scope&&(c.state==='PENDING_REVIEW'||c.state==='CONFLICT'));
  }
  decide(request:MemoryDecision):MemoryPolicyResult {
    if(request.decision!=='approve'&&request.decision!=='reject') throw new Error('INVALID_MEMORY_DECISION');
    return this.store.transaction(()=>{
      const c=this.store.get<Candidate>(CANDIDATES,request.id);
      if(!c||c.principalId!==request.principalId||c.scope!==request.scope||!['PENDING_REVIEW','CONFLICT'].includes(c.state)) throw new Error('CANDIDATE_NOT_FOUND');
      if(c.exactHash!==request.exactHash||identity(c,c.origin)!==c.exactHash) throw new Error('CANDIDATE_HASH_MISMATCH');
      if(request.decision==='reject') return this.finish(c,'REJECTED','owner_rejected');
      const cats=categories(c);
      if(cats.includes('secret')||this.blocked(c.principalId,cats)) return this.finish(c,'REJECTED','policy_blocked');
      const existing=this.existing(c);
      if(existing.duplicate) { this.finish(c,'DUPLICATE','duplicate',existing.duplicate.id); return {state:'DUPLICATE',id:existing.duplicate.id,exactHash:c.exactHash}; }
      if(existing.conflict) return {state:'CONFLICT',id:c.id,exactHash:c.exactHash,reason:'existing_key'};
      this.apply(c,cats,true);
      return this.finish(c,'APPLIED',undefined,c.id);
    });
  }
  private blocked(principalId:string,cats:string[]):boolean {
    const policy=this.store.get<{categories:string[]}>(SETTINGS,principalId);
    return cats.some(c=>policy?.categories.includes(c));
  }
  private existing(input:MemoryProposal):{duplicate?:Memory; conflict?:Memory} {
    const records=this.store.list<Memory>('memories').filter(m=>active(m)&&ownerOf(m)===input.principalId&&m.scope===input.scope);
    return { duplicate:records.find(m=>m.content===input.content), conflict:input.key?records.find(m=>m.key===input.key&&m.content!==input.content):undefined };
  }
  private submit(input:MemoryProposal,origin:'model'|'owner'):MemoryPolicyResult {
    validate(input);
    return this.store.transaction(()=>{
      const cats=categories(input);const id=randomUUID();
      if(cats.includes('secret')||this.blocked(input.principalId,cats)) return {state:'REJECTED',id,reason:'policy_blocked'};
      const existing=this.existing(input);
      if(existing.duplicate) return {state:'DUPLICATE',id:existing.duplicate.id};
      const exactHash=identity(input,origin);
      const prior=this.store.list<Candidate>(CANDIDATES).find(c=>c.exactHash===exactHash&&c.principalId===input.principalId&&c.scope===input.scope&&(c.state==='PENDING_REVIEW'||c.state==='CONFLICT'));
      if(prior) return {state:prior.state as 'PENDING_REVIEW'|'CONFLICT',id:prior.id,exactHash};
      const state=existing.conflict?'CONFLICT':cats.some(c=>['health','finance','identity'].includes(c))?'PENDING_REVIEW':'APPLIED';
      const c:Candidate={...input,id,exactHash,state,categories:cats,origin,created_at:Date.now()};
      if(state==='APPLIED') this.apply(c,cats);
      else this.store.put(CANDIDATES,id,c,origin);
      return {state,id,exactHash,...(state==='CONFLICT'?{reason:'existing_key'}:{})};
    });
  }
  private apply(c:Candidate,cats:string[],approved=false):void {
    const now=Date.now();
    this.store.put('memories',c.id,{id:c.id,principalId:c.principalId,scope:c.scope,content:c.content,kind:c.kind,source:c.source,category:c.category,key:c.key,confidence:c.confidence??1,origin:c.origin,sensitive:cats.some(x=>['health','finance','identity'].includes(x)),sensitiveApproved:approved,status:'active',created_at:now,updated_at:now},c.origin);
  }
  private finish(c:Candidate,state:Candidate['state'],reason?:string,memoryId?:string):MemoryPolicyResult {
    this.store.put(CANDIDATES,c.id,{...c,state,memoryId},'owner');
    return {state,id:c.id,exactHash:c.exactHash,...(reason?{reason}:{})};
  }
}
