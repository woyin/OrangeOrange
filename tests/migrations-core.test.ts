import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ControlStore } from '../src/control/store.js';
import { MigrationEngine, type MigrationInventory } from '../src/migrations/core.js';

const dirs:string[]=[];
afterEach(()=>{for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
function setup(){const dir=mkdtempSync(join(tmpdir(),'migration-'));dirs.push(dir);const store=new ControlStore(dir);return {store,engine:new MigrationEngine(store)};}
function inventory(content='hello'):MigrationInventory{return {system:'hermes',instanceId:'example',version:'test',warnings:[],items:[{type:'session',sourceId:'1',content:{messages:[{role:'user',content},{role:'tool',content:'do not replay'},{role:'assistant',content:'answer'}]}}]};}

describe('migration transaction',()=>{
  it('imports once, detects changed source, preserves history, and rolls back only created data',()=>{
    const {store,engine}=setup();try {
      const p=engine.plan(inventory());const batch=engine.stage(p);
      expect(()=>engine.apply(batch.id,'bad')).toThrow('MIGRATION_APPROVAL_MISMATCH');
      engine.apply(batch.id,p.hash);expect(engine.verify(batch.id).ok).toBe(true);
      for(let n=0;n<2;n++){const again=engine.plan(inventory());expect(again.items[0]?.status).toBe('unchanged');engine.apply(engine.stage(again).id,again.hash);}
      expect(engine.listHistory()).toHaveLength(1);
      const changed=engine.plan(inventory('changed'));expect(changed.items[0]?.status).toBe('conflict');engine.apply(engine.stage(changed).id,changed.hash);expect(engine.listHistory()).toHaveLength(1);
      const copy=engine.plan(inventory('changed'),{'1':{strategy:'new'}});engine.apply(engine.stage(copy).id,copy.hash);expect(engine.listHistory()).toHaveLength(2);
      expect(engine.rollback(copy.id).removed).toHaveLength(1);expect(engine.listHistory()).toHaveLength(1);
      const continuation=engine.continuation(engine.listHistory()[0]!.id);expect(continuation.trust).toBe('untrusted');expect(continuation.messages).toEqual([{sourceRole:'user',text:'hello'},{sourceRole:'tool',text:'do not replay'},{sourceRole:'assistant',text:'answer'}]);
    } finally {store.close();}
  });
  it('rejects tampered and stale plans without partial writes',()=>{
    const {store,engine}=setup();try {
      const p=engine.plan(inventory());const altered=structuredClone(p);altered.items[0]!.content='changed';expect(()=>engine.stage(altered)).toThrow('MIGRATION_PLAN_HASH_MISMATCH');
      const p1=engine.plan(inventory()),p2=engine.plan(inventory());engine.stage(p1);engine.stage(p2);engine.apply(p1.id,p1.hash);
      expect(()=>engine.apply(p2.id,p2.hash)).toThrow('MIGRATION_PLAN_STALE');expect(engine.listHistory()).toHaveLength(1);
    } finally {store.close();}
  });
  it('joins imported message records to their source session for search and continuation',()=>{
    const {store,engine}=setup();try {const inv=inventory();inv.items=[{type:'session',sourceId:'session:s',content:{id:'s'}},{type:'message',sourceId:'message:1',content:{sessionId:'s',role:'user',text:'查找火星'}},{type:'message',sourceId:'message:2',content:{sessionId:'s',role:'tool',toolName:'search',argumentsSummary:'词=火星',text:'找到资料'}}];const p=engine.plan(inv);engine.stage(p);engine.apply(p.id,p.hash);const history=engine.listHistory('火星');expect(history).toHaveLength(1);expect(engine.continuation(history[0]!.id).messages).toEqual([{sourceRole:'user',text:'查找火星'},{sourceRole:'tool',text:'工具：search\n参数摘要：词=火星\n找到资料'}]);}finally{store.close();}
  });
  it('does not join unrelated messages when session identifiers are missing',()=>{
    const {store,engine}=setup();try{const inv:MigrationInventory={system:'openclaw',instanceId:'same',version:'test',warnings:[],items:[{type:'session',sourceId:'s',content:{}},{type:'message',sourceId:'m',content:{role:'user',text:'不相关'}}]};const p=engine.plan(inv);engine.stage(p);engine.apply(p.id,p.hash);expect(engine.listHistory('不相关')).toHaveLength(0);expect(engine.continuation(engine.listHistory()[0]!.id).messages).toEqual([]);}finally{store.close();}
  });
  it('returns skill and cron data only as disabled review drafts',()=>{
    const {store,engine}=setup();try{const inv=inventory();inv.items=[{type:'skill',sourceId:'skill',content:{requiredTools:['web']}},{type:'cron',sourceId:'cron',content:{expression:'0 9 * * *'}}];const p=engine.plan(inv);engine.stage(p);engine.apply(p.id,p.hash);const skill=engine.nativeDraft(p.items[0]!.targetId,{toolMap:{web:'web_fetch'}});expect(skill).toMatchObject({type:'skill',enabled:false,reviewRequired:true,toolMap:{web:'web_fetch'},draft:{requiredTools:['web']},missing:[]});expect(engine.nativeDraft(p.items[0]!.targetId).missing).toContain('toolMap:web');expect(engine.nativeDraft(p.items[1]!.targetId)).toMatchObject({type:'cron',enabled:false,reviewRequired:true,draft:{expression:'0 9 * * *',enabled:false},missing:expect.arrayContaining(['name','timezone','prompt'])});expect(store.list('schedules')).toHaveLength(0);}finally{store.close();}
  });
  it('promotes reviewed memory into native FTS and rolls it back safely',()=>{
    const {store,engine}=setup();try {const inv=inventory();inv.items=[{type:'memory',sourceId:'mem',content:'用户喜欢橙子'}];const p=engine.plan(inv);engine.stage(p);engine.apply(p.id,p.hash);const objectId=p.items[0]!.targetId;expect(store.searchMemories('橙子','owner')).toHaveLength(0);const memory=engine.promoteMemory(objectId,{approved:true,scope:'owner',content:'用户喜欢橙子'});expect(store.searchMemories('橙子','owner').map(m=>m.id)).toEqual([memory.id]);expect(engine.verify(p.id).ok).toBe(true);expect(engine.rollback(p.id).conflicts).toEqual([]);expect(store.searchMemories('橙子','owner')).toHaveLength(0);}finally{store.close();}
  });
  it('recovers a staged batch after SIGKILL during the commit transaction',()=>{
    const {store,engine}=setup();const dir=store.dataDir;const p=engine.plan(inventory());engine.stage(p);store.close();
    const script=`import {ControlStore} from './src/control/store.ts'; import {MigrationEngine} from './src/migrations/core.ts'; const s=new ControlStore(process.argv[1]); const original=s.put.bind(s); s.put=(kind,...args)=>{const result=original(kind,...args); if(kind==='migration_objects')process.kill(process.pid,'SIGKILL'); return result;}; new MigrationEngine(s).apply(process.argv[2],process.argv[3]);`;
    const killed=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',script,dir,p.id,p.hash],{cwd:process.cwd(),encoding:'utf8'});
    expect(killed.signal).toBe('SIGKILL');const reopened=new ControlStore(dir);try{const recovered=new MigrationEngine(reopened);expect(recovered.listHistory()).toHaveLength(0);expect(reopened.get<{state:string}>('migration_batches',p.id)?.state).toBe('STAGED');recovered.apply(p.id,p.hash);expect(recovered.verify(p.id).ok).toBe(true);}finally{reopened.close();}
  });
  it('leaves changed targets in place on rollback',()=>{
    const {store,engine}=setup();try {const p=engine.plan(inventory());engine.stage(p);engine.apply(p.id,p.hash);const id=engine.listHistory()[0]!.id;const object=store.get<Record<string,unknown>>('migration_objects',id)!;store.put('migration_objects',id,{...object,content:'user edit'});expect(engine.rollback(p.id).conflicts).toEqual([id]);expect(engine.listHistory()).toHaveLength(1);}finally{store.close();}
  });
});
