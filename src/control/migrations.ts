import { randomUUID } from 'node:crypto';
import { hash, type ControlStore } from './store.js';
import { MigrationService, type MigrationSourceInput, type MigrationInventory, type MigrationBatch, type ConflictChoice } from '../migrations/index.js';

type RequestRecord={id:string;inventory:MigrationInventory;batchId:string;createdAt:number};
export class MigrationCenterService {
  readonly engine:MigrationService;
  constructor(private store:ControlStore,readonlyRoots:readonly string[]){this.engine=new MigrationService(store,{readonlyRoots});}
  async scan(source:MigrationSourceInput){
    const inventory=await this.engine.scan(source),plan=this.engine.plan(inventory);
    const request:RequestRecord={id:randomUUID(),inventory,batchId:plan.id,createdAt:Date.now()};
    this.store.transaction(()=>{this.engine.stage(plan);this.store.put('migration_requests',request.id,request,'owner');this.store.event('migration.scanned',request.id);});
    return this.get(request.id);
  }
  private request(id:string){const r=this.store.get<RequestRecord>('migration_requests',id);if(!r)throw new Error('MIGRATION_NOT_FOUND');return r;}
  get(id:string){const r=this.request(id),batch=this.store.get<MigrationBatch>('migration_batches',r.batchId);if(!batch)throw new Error('MIGRATION_BATCH_NOT_FOUND');return {...r,state:batch.state,plan:batch.plan,verification:this.engine.verify(r.batchId),created:batch.created};}
  list(){return this.store.list<RequestRecord>('migration_requests').map(r=>this.get(r.id));}
  plan(id:string,choices:Record<string,ConflictChoice>={}){
    if (!choices || typeof choices !== 'object' || Array.isArray(choices) || Object.values(choices).some(c => !c || typeof c !== 'object' || Array.isArray(c) || Object.keys(c).some(k => !['strategy','content'].includes(k)) || !['keep','new','manualmerge'].includes(c.strategy))) throw new Error('MIGRATION_INVALID_CHOICE');
    const r=this.request(id),old=this.get(id);if(old.state!=='STAGED')throw new Error('MIGRATION_INVALID_STATE');
    const plan=this.engine.plan(r.inventory,choices);
    this.store.transaction(()=>{this.engine.stage(plan);this.store.put('migration_requests',id,{...r,batchId:plan.id},'owner');this.store.remove('migration_batches',r.batchId);this.store.event('migration.planned',id);});
    return plan;
  }
  apply(id:string,hash:string){const r=this.request(id);this.engine.apply(r.batchId,hash);this.store.event('migration.applied',id);return this.get(id);}
  rollback(id:string){const r=this.request(id),promotions=this.store.list<{id:string;batchId:string;targetKind:string;targetId:string;hash:string}>('migration_native_promotions').filter(p=>p.batchId===r.batchId);const conflicts=promotions.filter(p=>{const value=this.store.get(p.targetKind,p.targetId);return value&&hash(value)!==p.hash;}).map(p=>p.targetId);const verification=this.engine.verify(r.batchId);if(!verification.ok&&this.get(id).state==='COMPLETED')conflicts.push(...verification.problems);if(conflicts.length)return {batchId:r.batchId,removed:[],conflicts};return this.store.transaction(()=>{for(const p of promotions){this.store.remove(p.targetKind,p.targetId,'owner');if(p.targetKind==='reviewed_imported_skills')this.store.remove('skill_settings',p.targetId);this.store.remove('migration_native_promotions',p.id);}const result=this.engine.rollback(r.batchId);this.store.event('migration.rolled_back',id);return {...result,removed:[...result.removed,...promotions.map(p=>p.targetId)]};});}
}
