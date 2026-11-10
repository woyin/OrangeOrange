import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ControlStore } from '../src/control/store.js';
import { MaintenanceService } from '../src/control/maintenance.js';
const open:ControlStore[]=[];const dirs:string[]=[];
afterEach(()=>{for(const s of open.splice(0))s.close();for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
function fixture(){const dir=mkdtempSync(join(tmpdir(),'hda-maint-'));dirs.push(dir);const s=new ControlStore(dir);open.push(s);return {dir,s,m:new MaintenanceService(()=>s,dir)};}
describe('persistent maintenance',()=>{
  it('cleans expired history while retaining active, approval and uncertain work and inbound dedupe',()=>{
    const {s,m,dir}=fixture();const now=Date.now();s.setSetting('retentionDays',1);
    for(const [id,state] of [['old','SUCCEEDED'],['active','RUNNING'],['uncertain','FAILED'],['delivery','SUCCEEDED'],['approval','CANCELLED']])s.put('tasks',id!,{id,status:state,updatedAt:now-3*86400000});
    s.put('operations','u',{id:'u',taskId:'uncertain',state:'UNCERTAIN'});
    s.put('outbox','d',{id:'d',taskId:'delivery',state:'DELIVERY_UNCERTAIN'});
    s.put('approvals','a',{id:'a',taskId:'approval',status:'PENDING'});
    s.put('task_steps','step',{id:'step',taskId:'old',status:'SUCCEEDED'});
    s.put('operations','done',{id:'done',taskId:'old',state:'CONFIRMED'});
    s.put('outbox','sent',{id:'sent',taskId:'old',state:'SENT'});
    s.put('inbox_events','in',{id:'in',dedupe_key:'telegram:123',taskId:'old',text:'private'});
    s.put('sessions','expired',{expiresAt:now-1});s.put('sessions','live',{expiresAt:now+10000});
    s.event('task.changed','old');s.db.prepare('UPDATE events SET at=?').run(now-3*86400000);const latest=s.event('task.changed','active');
    const audits=Number(s.db.prepare('SELECT COUNT(*) AS n FROM audit_events').get()!.n);
    const r=m.retention(now);expect(r).toMatchObject({sessions:1,tasks:1,events:1,eventFloor:latest});
    expect(s.get('tasks','old')).toBeUndefined();expect(s.list('task_steps')).toEqual([]);expect(s.get('operations','done')).toBeUndefined();
    for(const id of ['active','uncertain','delivery','approval'])expect(s.get('tasks',id)).toBeDefined();
    expect(s.get('sessions','live')).toBeDefined();expect(s.get('inbox_events','in')).toBeDefined();
    expect(()=>s.put('inbox_events','duplicate',{dedupe_key:'telegram:123'})).toThrow();
    expect(Number(s.db.prepare('SELECT COUNT(*) AS n FROM audit_events').get()!.n)).toBeGreaterThanOrEqual(audits);
    s.close();const reopened=new ControlStore(dir);open.push(reopened);expect(reopened.get('tasks','old')).toBeUndefined();expect(reopened.get('inbox_events','in')).toBeDefined();
  });
  it('expires memory and FTS while preserving revisions and append-only audit snapshots',()=>{
    const {s,m}=fixture();const now=Date.now();s.put('memories','mem',{id:'mem',content:'private preference',status:'active',expiresAt:now+1000});
    expect(s.searchMemories('private')).toHaveLength(1);const revisions=s.memoryRevisions('mem','owner').length;
    expect(m.retention(now+2000).memories).toBe(1);expect(s.searchMemories('private')).toEqual([]);expect(s.memoryRevisions('mem','owner')).toHaveLength(revisions+1);
    expect(s.db.prepare('SELECT * FROM memory_fts').all()).toEqual([]);expect(()=>s.db.exec('DELETE FROM audit_events')).toThrow('APPEND_ONLY');
    const result=m.rotateAudit();expect(JSON.parse(readFileSync(result.file,'utf8')).rows.at(-1).seq).toBe(result.lastSeq);expect(statSync(result.file).mode&0o777).toBe(0o600);
  });
  it('exports only constrained configuration and never secret text or injected event fields',async()=>{
    const {s,m}=fixture();const secret='sk-secret-injected-cookie-memory';
    s.setSetting('config',{retentionDays:30,language:secret,timezone:secret,token:secret,passwordHash:secret,cookie:secret});
    for(const kind of ['providers','channels','tools','users','memories'])s.put(kind,'injected',{id:'injected',name:secret,model:secret,vendor:secret,type:secret,permission:secret,token:secret,passwordHash:secret,content:secret});
    s.event(secret,secret,{secret});s.setSecret('token',secret);
    expect(JSON.stringify(m.exportConfig())).not.toContain(secret);expect(JSON.stringify(await m.diagnostics())).not.toContain(secret);expect(m.logs()[0]).toMatchObject({code:'CONTROL_EVENT'});
  });
  it('reports measured metrics and disk protection including probe failure',async()=>{
    const {s,dir}=fixture();const protections:boolean[]=[];const m=new MaintenanceService(()=>s,dir,{diskProbe:()=>({totalBytes:1024**3,freeBytes:1}),onProtection:v=>protections.push(v)});
    s.put('tasks','f',{id:'f',status:'FAILED'});s.put('tasks','q',{id:'q',status:'QUEUED'});
    const r=await m.metrics();expect(r.rss).toBeGreaterThan(0);expect(r.dbBytes).toBeGreaterThan(0);expect(r.cpuUserMicros+r.cpuSystemMicros).toBeGreaterThan(0);expect(r).toMatchObject({diskLow:true,queueDepth:1,failedTasks:1,failureRate:1,imLatencyMs:null});expect(protections).toEqual([true]);
    const unavailable=await new MaintenanceService(()=>s,dir,{diskProbe:()=>{throw new Error('secret');}}).metrics();expect(unavailable).toMatchObject({disk:null,diskLow:true,diskProbeAvailable:false});
  });
  it('rejects unsafe retention policy and symlink snapshot directory',()=>{const {s,m,dir}=fixture();s.setSetting('retentionDays',0);expect(()=>m.retention()).toThrow('INVALID_RETENTION_DAYS');const other=mkdtempSync(join(tmpdir(),'hda-other-'));dirs.push(other);symlinkSync(other,join(dir,'audit-snapshots'));expect(()=>m.rotateAudit()).toThrow('UNSAFE_AUDIT_DIRECTORY');});
});
