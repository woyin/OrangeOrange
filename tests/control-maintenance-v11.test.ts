import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, utimesSync, symlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ControlStore } from '../src/control/store.js';
import { MaintenanceService } from '../src/control/maintenance.js';

const dirs:string[]=[];const stores:ControlStore[]=[];
afterEach(()=>{for(const s of stores.splice(0))s.close();for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
function fixture(){const dir=mkdtempSync(join(tmpdir(),'maintenance-v11-'));dirs.push(dir);const s=new ControlStore(dir);stores.push(s);return {dir,s,m:new MaintenanceService(()=>s,dir)};}
it('writes bounded consecutive batches and resumes after reopening',()=>{
  const {dir,s,m}=fixture();
  const insert=s.db.prepare('INSERT INTO audit_events(actor,action,target,result,at) VALUES(?,?,?,?,?)');
  s.transaction(()=>{for(let i=0;i<2100;i++)insert.run('a','b','c','d',1);});
  const first=m.rotateAudit();const a=JSON.parse(readFileSync(first.file,'utf8'));expect(a.rows.length).toBe(1000);expect(first.lastSeq).toBe(1000);expect(a.hash).toBe(createHash('sha256').update(JSON.stringify(a.rows)).digest('hex'));
  s.close();stores.splice(stores.indexOf(s),1);const reopened=new ControlStore(dir);stores.push(reopened);
  const resumed=new MaintenanceService(()=>reopened,dir).rotateAudit();const b=JSON.parse(readFileSync(resumed.file,'utf8'));expect(b.rows[0].seq).toBe(first.lastSeq+1);expect(resumed.lastSeq).toBe(2000);
});
it('expires covered snapshots without deleting audit rows',()=>{
  const {s,m}=fixture();s.audit('a','test','t','ok');const first=m.rotateAudit();utimesSync(first.file,1,1);const count=s.db.prepare('SELECT COUNT(*) AS n FROM audit_events').get()!.n;
  m.maintainAudit();expect(()=>readFileSync(first.file)).toThrow();expect(s.db.prepare('SELECT COUNT(*) AS n FROM audit_events').get()!.n).toBe(count);
});
it('rejects a symlink data directory and invalid policies',()=>{
  const {dir,s,m}=fixture();const link=join(dir,'link');symlinkSync(dir,link);expect(()=>new MaintenanceService(()=>s,link).rotateAudit()).toThrow('UNSAFE_AUDIT_DIRECTORY');
  s.setSetting('config',{artifactRetentionDays:0});expect(()=>m.retention()).toThrow('INVALID_ARTIFACT_RETENTION_DAYS');s.setSetting('config',{auditSnapshotRetentionDays:0});expect(()=>m.rotateAudit()).toThrow('INVALID_AUDIT_SNAPSHOT_RETENTION_DAYS');
});
it('protects every artifact if a retained payload cannot be parsed',()=>{
  const {s,m}=fixture();const now=Date.now();s.setSetting('config',{retentionDays:1});s.put('artifacts','a',{id:'a',createdAt:now-2*86400000,base64:'eA=='});s.setSecret('gmail:payload:orphan','not json');m.retention(now);expect(s.get('artifacts','a')).toBeDefined();
});
it('removes only expired unreferenced artifacts and protects retained secret attachments',()=>{
  const {s,m}=fixture();const now=Date.now();s.setSetting('config',{retentionDays:1,artifactRetentionDays:2});
  for(const id of ['old','live','secret','recent'])s.put('artifacts',id,{id,base64:'eA==',createdAt:now-(id==='recent'?1:3)*86400000});
  s.put('tasks','t',{id:'t',status:'RUNNING',artifactId:'live'});
  s.put('gmail_intents','i',{id:'i',status:'CONFIRMED'});s.setSecret('gmail:payload:i',JSON.stringify({mail:{attachments:[{artifactId:'secret'}]}}));
  m.retention(now);expect(s.get('artifacts','old')).toBeUndefined();for(const id of ['live','secret','recent'])expect(s.get('artifacts',id)).toBeDefined();
});
