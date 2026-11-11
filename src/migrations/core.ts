import { createHash, randomUUID } from 'node:crypto';
import type { ControlStore } from '../control/store.js';

export type ConflictChoice = { strategy:'keep'|'new'|'manualmerge'; content?:unknown };
export interface MigrationItem { sourceId:string; type:string; content:unknown; sourceTime?:string|number; warnings?:string[] }
export interface MigrationInventory { system:'openclaw'|'hermes'; instanceId:string; version:string; sourceVersion?:string|null; formatVersion?:string; items:MigrationItem[]; warnings:string[]; manifestHash?:string; summary?:{files:number; bytes:number; indexed:number; assets:number; reauthorization:number; unmapped:number} }
export interface PlanItem extends MigrationItem { sourceHash:string; targetId:string; status:'new'|'unchanged'|'conflict'; choice:ConflictChoice; priorHash?:string }
export interface MigrationPlan { id:string; inventory:Omit<MigrationInventory,'items'>; items:PlanItem[]; hash:string }
export interface MigrationBatch { id:string; plan:MigrationPlan; state:'STAGED'|'COMPLETED'|'ROLLED_BACK'; createdAt:number; finishedAt?:number; created:{id:string; hash:string; kind?:string}[] }
export interface VerificationReport { batchId:string; ok:boolean; expected:number; present:number; problems:string[] }
export interface RollbackReport { batchId:string; removed:string[]; conflicts:string[] }
export interface ImportedHistory { id:string; system:string; instanceId:string; sourceId:string; content:unknown }
export interface ContinuationMaterial { historyId:string; source:{system:string; instanceId:string; sourceId:string}; trust:'untrusted'; messages:unknown[] }
interface StoredObject { id:string; system:string; instanceId:string; sourceId:string; type:string; sourceHash:string; content:unknown; sourceTime?:string|number; batchId:string; trust:'untrusted'; enabled:false }
function canonical(v:unknown):string {
  if(v===null||typeof v!=='object') return JSON.stringify(v) ?? 'null';
  if(Array.isArray(v)) return '['+v.map(canonical).join(',')+']';
  const o=v as Record<string,unknown>; return '{'+Object.keys(o).filter(k=>o[k]!==undefined).sort().map(k=>JSON.stringify(k)+':'+canonical(o[k])).join(',')+'}';
}
function digest(v:unknown):string { return createHash('sha256').update(canonical(v)).digest('hex'); }
function planHash(p:Omit<MigrationPlan,'hash'>):string {return digest(p);}
const OBJECTS='migration_objects', BATCHES='migration_batches';
function identity(system:string,instanceId:string,type:string,sourceId:string):string{return JSON.stringify([system,instanceId,type,sourceId]);}
function groupObjects(objects:StoredObject[]):Map<string,StoredObject[]>{const map=new Map<string,StoredObject[]>();for(const object of objects){const key=identity(object.system,object.instanceId,object.type,object.sourceId);const group=map.get(key)??[];group.push(object);map.set(key,group);}return map;}
export class MigrationEngine {
  constructor(readonly store:ControlStore) {}
  plan(inventory:MigrationInventory, choices:Record<string,ConflictChoice>={}):MigrationPlan {
    if(!inventory.instanceId || !inventory.version) throw new Error('MIGRATION_SOURCE_ID_REQUIRED');
    const seen=new Set<string>(); const objects=groupObjects(this.store.list<StoredObject>(OBJECTS));
    const items=inventory.items.map(item=>{
      const key=item.type+'\0'+item.sourceId;
      if(!item.sourceId||!item.type||seen.has(key)) throw new Error('MIGRATION_DUPLICATE_SOURCE_ID'); seen.add(key);
      const sourceHash=digest(item.content);
      const existing=objects.get(identity(inventory.system,inventory.instanceId,item.type,item.sourceId))??[];
      const same=existing.find(o=>o.sourceHash===sourceHash);
      const prior=existing.at(-1); const status:PlanItem['status']=same?'unchanged':prior?'conflict':'new';
      const choice=choices[key]??choices[item.sourceId]??{strategy:'keep' as const};
      if(!['keep','new','manualmerge'].includes(choice.strategy)) throw new Error('MIGRATION_INVALID_CHOICE');
      if(status==='conflict'&&choice.strategy==='manualmerge'&&choice.content===undefined) throw new Error('MIGRATION_MERGE_CONTENT_REQUIRED');
      return {...item,sourceHash,targetId:same?.id??randomUUID(),status,choice,...(prior?{priorHash:digest(prior)}:{})};
    });
    const p={id:randomUUID(),inventory:{system:inventory.system,instanceId:inventory.instanceId,version:inventory.version,sourceVersion:inventory.sourceVersion,formatVersion:inventory.formatVersion,warnings:inventory.warnings,manifestHash:inventory.manifestHash,summary:inventory.summary},items};
    return {...p,hash:planHash(p)};
  }
  stage(plan:MigrationPlan):MigrationBatch {
    const {hash,...body}=plan;
    if(planHash(body)!==hash)throw new Error('MIGRATION_PLAN_HASH_MISMATCH');
    const batch:MigrationBatch={id:plan.id,plan,state:'STAGED',createdAt:Date.now(),created:[]};
    this.store.transaction(()=>{if(this.store.get(BATCHES,batch.id))throw new Error('MIGRATION_BATCH_EXISTS');const sourceId=digest([plan.inventory.system,plan.inventory.instanceId]);this.store.put('migration_sources',sourceId,{id:sourceId,...plan.inventory});this.store.put(BATCHES,batch.id,batch);});
    return batch;
  }
  apply(id:string,approvedPlanHash:string):MigrationBatch {
    return this.store.transaction(()=>{
      const batch=this.requireBatch(id);
      if(batch.plan.hash!==approvedPlanHash)throw new Error('MIGRATION_APPROVAL_MISMATCH');
      const {hash,...body}=batch.plan;if(planHash(body)!==hash)throw new Error('MIGRATION_PLAN_HASH_MISMATCH');
      if(batch.state==='COMPLETED')return batch;
      if(batch.state!=='STAGED')throw new Error('MIGRATION_INVALID_STATE');
      const objects=groupObjects(this.store.list<StoredObject>(OBJECTS));const created:MigrationBatch['created']=[];
      for(const item of batch.plan.items){
        const key=identity(batch.plan.inventory.system,batch.plan.inventory.instanceId,item.type,item.sourceId);const existing=objects.get(key)??[];
        const same=existing.find(o=>o.sourceHash===item.sourceHash);
        const prior=existing.at(-1);
        if((prior?digest(prior):undefined)!==item.priorHash || (item.status==='unchanged'&&!same))throw new Error('MIGRATION_PLAN_STALE');
        if(same || (item.status==='conflict'&&item.choice.strategy==='keep'))continue;
        const content=item.status==='conflict'&&item.choice.strategy==='manualmerge'?item.choice.content:item.content;
        const object:StoredObject={id:item.targetId,system:batch.plan.inventory.system,instanceId:batch.plan.inventory.instanceId,sourceId:item.sourceId,type:item.type,sourceHash:item.sourceHash,content,sourceTime:item.sourceTime,batchId:id,trust:'untrusted',enabled:false};
        if(this.store.get(OBJECTS,object.id))throw new Error('MIGRATION_TARGET_EXISTS');
        this.store.put(OBJECTS,object.id,object);existing.push(object);objects.set(key,existing);created.push({id:object.id,hash:digest(object)});
      }
      const done:MigrationBatch={...batch,state:'COMPLETED',created,finishedAt:Date.now()};this.store.put(BATCHES,id,done);return done;
    });
  }
  verify(id:string):VerificationReport {
    const batch=this.requireBatch(id);const problems:string[]=[];let present=0;
    for(const item of batch.created){const value=this.store.get(item.kind??OBJECTS,item.id);if(value&&digest(value)===item.hash)present++;else problems.push(item.id);}
    if(batch.state!=='COMPLETED')problems.push('BATCH_NOT_COMPLETED');
    return {batchId:id,ok:problems.length===0,expected:batch.created.length,present,problems};
  }
  rollback(id:string):RollbackReport {
    return this.store.transaction(()=>{
      const batch=this.requireBatch(id);if(batch.state==='ROLLED_BACK')return {batchId:id,removed:[],conflicts:[]};
      if(batch.state!=='COMPLETED'&&batch.state!=='STAGED')throw new Error('MIGRATION_INVALID_STATE');
      const removed:string[]=[],conflicts:string[]=[];
      for(const entry of batch.created){const object=this.store.get(entry.kind??OBJECTS,entry.id);if(object&&digest(object)!==entry.hash)conflicts.push(entry.id);}
      if(conflicts.length)return {batchId:id,removed,conflicts};
      for(const entry of [...batch.created].reverse()){const kind=entry.kind??OBJECTS;if(!this.store.get(kind,entry.id))continue;this.store.remove(kind,entry.id);removed.push(entry.id);}
      this.store.put(BATCHES,id,{...batch,state:'ROLLED_BACK',finishedAt:Date.now()});
      return {batchId:id,removed,conflicts};
    });
  }
  listHistory(query=''):ImportedHistory[] {
    const objects=this.store.list<StoredObject>(OBJECTS);const bySession=new Map<string,Map<string,StoredObject>>();
    for(const m of objects){if(m.type!=='message'||!m.content||typeof m.content!=='object')continue;const c=m.content as Record<string,unknown>;
      const parts=m.system==='hermes'&&typeof c.sessionId==='string'?[m.system,m.instanceId,c.sessionId]:m.system==='openclaw'&&typeof c.agentId==='string'&&typeof c.sessionKey==='string'?[m.system,m.instanceId,c.agentId,c.sessionKey]:undefined;
      if(parts){const key=JSON.stringify(parts),group=bySession.get(key)??new Map<string,StoredObject>();group.set(m.sourceId,m);bySession.set(key,group);}}
    return objects.filter(o=>['session','conversation','history'].includes(o.type)).map(o=>{
      const session=o.content&&typeof o.content==='object'?o.content as Record<string,unknown>:{};
      const parts=o.system==='hermes'&&typeof session.id==='string'?[o.system,o.instanceId,session.id]:o.system==='openclaw'&&typeof session.agentId==='string'&&typeof session.sessionKey==='string'?[o.system,o.instanceId,session.agentId,session.sessionKey]:undefined;
      const messages=parts?[...(bySession.get(JSON.stringify(parts))?.values()??[])].map(m=>m.content):[];
      const content=messages.length?{...session,messages}:o.content;return {id:o.id,system:o.system,instanceId:o.instanceId,sourceId:o.sourceId,content};
    }).filter(o=>canonical(o.content).toLowerCase().includes(query.toLowerCase()));
  }
  continuation(id:string,messageLimit=10):ContinuationMaterial {
    if(!Number.isInteger(messageLimit)||messageLimit<0||messageLimit>50)throw new Error('MIGRATION_INVALID_MESSAGE_LIMIT');
    const history=this.listHistory().find(o=>o.id===id);if(!history)throw new Error('MIGRATION_HISTORY_NOT_FOUND');
    const content=history.content as {messages?:unknown[]};const messages=Array.isArray(content?.messages)?content.messages:[];
    const safe=messages.slice(-messageLimit).map(m=>{const x=m as {role?:unknown;content?:unknown;text?:unknown;toolName?:unknown;argumentsSummary?:unknown};const content=x?.text??x?.content??'';const prefix=[x?.toolName?`工具：${String(x.toolName)}`:'',x?.argumentsSummary?`参数摘要：${typeof x.argumentsSummary==='string'?x.argumentsSummary:canonical(x.argumentsSummary)}`:''].filter(Boolean).join('\n');const text=[prefix,typeof content==='string'?content:canonical(content)].filter(Boolean).join('\n');return {sourceRole:typeof x?.role==='string'?x.role.slice(0,80):'unknown',text:text.slice(0,4000)};});
    return {historyId:id,source:{system:history.system,instanceId:history.instanceId,sourceId:history.sourceId},trust:'untrusted',messages:messageLimit?safe:[]};
  }
  promoteMemory(objectId:string, review:{approved:true; scope:string; content:string}):{id:string} {
    if(review.approved!==true||!review.scope||review.scope.length>200||!review.content||review.content.length>10000)throw new Error('MIGRATION_REVIEW_REQUIRED');
    return this.store.transaction(()=>{
      const object=this.store.get<StoredObject>(OBJECTS,objectId);if(!object||!['memory','instruction'].includes(object.type))throw new Error('MIGRATION_MEMORY_NOT_FOUND');
      const batch=this.requireBatch(object.batchId);if(batch.state!=='COMPLETED')throw new Error('MIGRATION_INVALID_STATE');
      const id='migration:'+objectId;if(this.store.get('memories',id))throw new Error('MIGRATION_ALREADY_PROMOTED');
      const now=Date.now();const memory={id,kind:'semantic',scope:review.scope,content:review.content,source:`migration:${object.system}:${object.instanceId}:${object.sourceId}`,confidence:1,status:'active',created_at:now,updated_at:now,provenance:{sourceSystem:object.system,sourceInstanceId:object.instanceId,sourceObjectId:object.sourceId,sourceHash:object.sourceHash,batchId:object.batchId,trust:'untrusted',reviewed:true}};
      this.store.put('memories',id,memory,'owner');this.store.put(BATCHES,batch.id,{...batch,created:[...batch.created,{kind:'memories',id,hash:digest(memory)}]});return {id};
    });
  }
  nativeDraft(objectId:string, options:{toolMap?:Record<string,string>;requiredTools?:string[]}={}):{type:'skill'|'cron'; source:unknown; sourceId:string; trust:'untrusted'; enabled:false; reviewRequired:true; toolMap:Record<string,string>; draft:Record<string,unknown>; missing:string[]} {
    const object=this.store.get<StoredObject>(OBJECTS,objectId);if(!object||!['skill','cron'].includes(object.type))throw new Error('MIGRATION_DRAFT_NOT_FOUND');
    const toolMap=options.toolMap??{};for(const [source,target] of Object.entries(toolMap))if(!source||typeof target!=='string'||!target)throw new Error('MIGRATION_INVALID_TOOL_MAP');
    const source=object.content && typeof object.content==='object'?object.content as Record<string,unknown>:{};const missing:string[]=[];let draft:Record<string,unknown>;
    if(object.type==='cron'){const schedule=source.schedule&&typeof source.schedule==='object'?source.schedule as Record<string,unknown>:{};const expression=typeof schedule.expr==='string'?schedule.expr:typeof source.schedule==='string'?source.schedule:typeof source.expression==='string'?source.expression:undefined;const timezone=typeof source.timezone==='string'?source.timezone:typeof schedule.tz==='string'?schedule.tz:typeof schedule.timezone==='string'?schedule.timezone:undefined;const delivery=source.delivery&&typeof source.delivery==='object'?source.delivery as Record<string,unknown>:{};const targetChannel=source.targetChannel??delivery.channel??delivery.platform;draft={name:source.name,expression,timezone,prompt:source.prompt,runMode:source.runMode,targetChannel,requiredCapabilities:source.requiredCapabilities,enabled:false};for(const field of ['name','expression','timezone','prompt','runMode','targetChannel'])if(typeof draft[field]!=='string'||!draft[field])missing.push(field);if(!Array.isArray(draft.requiredCapabilities)||!draft.requiredCapabilities.every(v=>typeof v==='string'&&v.length>0))missing.push('requiredCapabilities');}
    else {const declared=Array.isArray(source.requiredTools)?source.requiredTools:options.requiredTools;const tools=declared?.filter((v):v is string=>typeof v==='string')??[];if(!declared)missing.push('requiredTools');for(const name of tools)if(!toolMap[name])missing.push(`toolMap:${name}`);draft={name:source.name,requiredTools:tools,toolMap,enabled:false};}
    return {type:object.type as 'skill'|'cron',source:object.content,sourceId:objectId,trust:'untrusted',enabled:false,reviewRequired:true,toolMap,draft,missing};
  }
  private requireBatch(id:string):MigrationBatch {const batch=this.store.get<MigrationBatch>(BATCHES,id);if(!batch)throw new Error('MIGRATION_BATCH_NOT_FOUND');return batch;}
}
