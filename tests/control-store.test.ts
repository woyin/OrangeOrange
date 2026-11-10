import { describe,it,expect,afterEach,vi } from 'vitest';
import { mkdtempSync,rmSync,readFileSync,copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync,backup } from 'node:sqlite';
import { ControlStore } from '../src/control/store.js';
import { AuthService } from '../src/control/security.js';
const dirs:string[]=[];const stores:ControlStore[]=[];
function open(dir=mkdtempSync(join(tmpdir(),'hda-control-'))) {if(!dirs.includes(dir))dirs.push(dir);const s=new ControlStore(dir);stores.push(s);return s;}
afterEach(()=>{vi.useRealTimers();for(const s of stores.splice(0))try{s.close();}catch{}for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
describe('ControlStore SYS-003 GW-004/006 MEM SEC',()=>{
 it('persists independent app database, FULL WAL, and rejects duplicate inbox/outbox keys',()=>{
  const s=open();expect(()=>new ControlStore(s.dataDir)).toThrow('APP_DATABASE_ALREADY_OWNED');expect(s.db.prepare('PRAGMA synchronous').get()!.synchronous).toBe(2);expect(s.db.prepare('PRAGMA journal_mode').get()!.journal_mode).toBe('wal');
  for(const kind of ['inbox_events','outbox']){s.put(kind,'a',{dedupe_key:'same',state:'RECEIVED'});expect(()=>s.put(kind,'b',{dedupe_key:'same'})).toThrow();expect(s.list(kind)).toHaveLength(1);}
  const dir=s.dataDir;s.close();const reopened=open(dir);expect(reopened.list('outbox')).toHaveLength(1);expect(reopened.schemaVersion).toBe(1);
 });
 it('rolls back nested and thenable transactions',()=>{
  const s=open();expect(()=>s.transaction(()=>{s.put('tasks','bad',{state:'RUNNING'});throw Error('fail');})).toThrow('fail');expect(s.get('tasks','bad')).toBeUndefined();
  expect(()=>s.transaction(()=>{s.put('tasks','async',{});return Promise.resolve('forbidden');})).toThrow('ASYNC_TRANSACTION_FORBIDDEN');expect(s.get('tasks','async')).toBeUndefined();
  s.transaction(()=>{s.put('tasks','good',{});try{s.transaction(()=>{s.put('tasks','nested',{});throw Error('nested');});}catch{}});expect(s.get('tasks','good')).toEqual({});expect(s.get('tasks','nested')).toBeUndefined();
 });
 it('rejects writes attempted after an async transaction resumes',async()=>{
  const s=open();let resumed:Promise<void>|undefined;
  expect(()=>s.transaction(()=>{resumed=(async()=>{await Promise.resolve();s.put('tasks','escaped',{});})();return resumed;})).toThrow('ASYNC_TRANSACTION_FORBIDDEN');
  await expect(resumed).rejects.toThrow('ASYNC_TRANSACTION_FORBIDDEN');expect(s.get('tasks','escaped')).toBeUndefined();
 });
 it('enters genuine query-only maintenance for a newer schema',()=>{
  const s=open();const dir=s.dataDir;s.close();const db=new DatabaseSync(join(dir,'app.sqlite'));db.exec('PRAGMA user_version=999');db.close();
  const m=open(dir);expect(m.maintenance).toBe(true);expect(m.maintenanceReason).toBe('SCHEMA_NEWER_THAN_APPLICATION');expect(()=>m.put('tasks','bad',{})).toThrow('MAINTENANCE');expect(()=>m.db.exec("INSERT INTO entities VALUES('tasks','b','{}',NULL)")).toThrow();
 });
 it('rolls back a failed initial migration and retains a readable maintenance database',()=>{
  const dir=mkdtempSync(join(tmpdir(),'hda-migrate-'));dirs.push(dir);
  // Create a conflicting FTS shadow table to cause a real SQL migration failure.
  const keyStore=open(dir);keyStore.close();const db=new DatabaseSync(join(dir,'app.sqlite'));db.exec('DROP TABLE memory_fts; DROP TABLE entities; PRAGMA user_version=0; CREATE TABLE memory_fts_data(id INTEGER)');db.close();
  const failed=open(dir);expect(failed.maintenance).toBe(true);expect(failed.db.prepare('PRAGMA user_version').get()!.user_version).toBe(0);expect(failed.db.prepare("SELECT name FROM sqlite_master WHERE name='entities'").all()).toHaveLength(0);
 });
 it('indexes only active non-secret scoped unexpired memories and creates atomic revisions',()=>{
  vi.useFakeTimers();vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));const s=open();
  s.put('memories','a',{id:'a',scope:'project:a',kind:'semantic',status:'active',content:'orchard apples',expires_at:Date.now()+1000});
  s.put('memories','b',{id:'b',scope:'project:b',status:'active',content:'orchard pears'});
  s.put('memories','secret',{id:'secret',scope:'project:a',status:'active',secret:true,content:'orchard secret'});
  expect(s.searchMemories('orchard','project:a').map(m=>m.id)).toEqual(['a']);
  s.put('memories','a',{id:'a',scope:'project:a',status:'active',content:'orchard oranges',expires_at:Date.now()+1000},'owner');
  expect(s.searchMemories('apples')).toHaveLength(0);expect(s.searchMemories('oranges')).toHaveLength(1);expect(s.list('memory_revisions')).toHaveLength(4);
  vi.advanceTimersByTime(1001);expect(s.searchMemories('oranges')).toHaveLength(0);expect(s.db.prepare('SELECT * FROM memory_fts WHERE id=?').all('a')).toHaveLength(0);
  s.remove('memories','b','owner');expect(s.searchMemories('pears')).toHaveLength(0);expect(s.get<{status:string}>('memories','b')!.status).toBe('deleted');expect(s.list('memory_revisions')).toHaveLength(5);
  expect(()=>s.transaction(()=>{s.put('memories','rollback',{id:'rollback',scope:'project:a',status:'active',content:'rollbackfruit'});throw Error('abort');})).toThrow('abort');expect(s.list('memory_revisions')).toHaveLength(5);expect(s.searchMemories('rollbackfruit')).toHaveLength(0);
 });
 it('encrypts secrets, emits digest events, and keeps append-only audit without payload text',()=>{
  const s=open();const secret='fake-api-key-never-log-12345';s.setSecret('provider',secret);expect(s.getSecret('provider')).toBe(secret);expect(s.secretMetadata()).toEqual([{name:'provider',configured:true}]);
  s.put('providers','p',{apiKey:secret});s.event('provider.updated','p',{apiKey:secret});
  const audit=s.db.prepare('SELECT * FROM audit_events').all();expect(JSON.stringify(audit)).not.toContain(secret);expect(JSON.stringify(s.events())).not.toContain(secret);expect(s.events()[0]!.event_id).toBeGreaterThan(0);
  expect(()=>s.db.exec('DELETE FROM audit_events')).toThrow('APPEND_ONLY');expect(()=>s.db.exec("UPDATE audit_events SET result='x'")).toThrow('APPEND_ONLY');
  expect(readFileSync(join(s.dataDir,'master.key'))).toHaveLength(32);const dir=s.dataDir;s.close();const r=open(dir);expect(r.getSecret('provider')).toBe(secret);r.deleteSecret('provider');expect(r.getSecret('provider')).toBeUndefined();
 });
 it('restores a consistent online sqlite backup with a separately supplied key',async()=>{
  const s=open();s.put('tasks','a',{status:'QUEUED'});s.setSecret('key','hidden');const restoreDir=mkdtempSync(join(tmpdir(),'hda-restored-'));dirs.push(restoreDir);const target=join(restoreDir,'app.sqlite');await backup(s.db,target);const db=new DatabaseSync(target);expect(db.prepare('PRAGMA integrity_check').get()!.integrity_check).toBe('ok');expect(db.prepare('SELECT count(*) AS n FROM entities').get()!.n).toBe(1);db.close();
  expect(()=>new ControlStore(restoreDir)).toThrow('MASTER_KEY_MISSING');copyFileSync(join(s.dataDir,'master.key'),join(restoreDir,'master.key'));const restored=open(restoreDir);expect(restored.get('tasks','a')).toEqual({status:'QUEUED'});expect(restored.getSecret('key')).toBe('hidden');
 });
});
describe('AuthService SEC-001/002',()=>{
 it('sets up once, hashes password/token, persists session and revokes on password change',()=>{
  const s=open();const auth=new AuthService(s);auth.setup({username:'owner',password:'safe-password-123',timezone:'UTC'});expect(()=>auth.setup({username:'second',password:'safe-password-123',timezone:'UTC'})).toThrow('ALREADY_INITIALIZED');
  expect(()=>auth.login('owner','wrong')).toThrow('INVALID_CREDENTIALS');const login=auth.login('owner','safe-password-123');const session=auth.authenticate(login.token)!;expect(session.csrf).toBe(login.csrf);expect(JSON.stringify(s.list('sessions'))).not.toContain(login.token);expect(JSON.stringify(s.list('users'))).not.toContain('safe-password-123');expect(auth.verifyPassword(session.userId,'safe-password-123')).toBe(true);
  const dir=s.dataDir;s.close();const r=open(dir);const a=new AuthService(r);expect(a.authenticate(login.token)).toEqual(session);a.changePassword(session.userId,'safe-password-123','new-safe-password-123');expect(a.authenticate(login.token)).toBeUndefined();expect(a.verifyPassword(session.userId,'new-safe-password-123')).toBe(true);const next=a.login('owner','new-safe-password-123');a.logout(next.token);expect(a.authenticate(next.token)).toBeUndefined();
 });
 it('rejects expired sessions',()=>{vi.useFakeTimers();const s=open();const auth=new AuthService(s);auth.setup({username:'owner',password:'safe-password-123',timezone:'UTC'});const login=auth.login('owner','safe-password-123');vi.advanceTimersByTime(24*3600_000);expect(auth.authenticate(login.token)).toBeUndefined();});
});
