import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, statSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { scryptSync } from 'node:crypto';
import { ControlStore } from '../src/control/store.js';
import { AuthService } from '../src/control/security.js';
vi.mock('node:crypto',async importOriginal=>{const actual=await importOriginal<typeof import('node:crypto')>();return {...actual,scryptSync:vi.fn(actual.scryptSync)};});
const stores:ControlStore[]=[];const dirs:string[]=[];
function open(dir=mkdtempSync(join(tmpdir(),'hda-fixes-'))){if(!dirs.includes(dir))dirs.push(dir);const s=new ControlStore(dir);stores.push(s);return s;}
afterEach(()=>{for(const s of stores.splice(0))s.close();for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});vi.clearAllMocks();});
it('检索中文两字三字、C++和引号，并保持作用域及重开索引',()=>{
 const s=open();s.put('memories','a',{id:'a',status:'active',scope:'project:a',content:'我喜欢简洁中文回答，使用C++和"引号"'});
 for(const query of ['中文','中文回','简洁','C++','"引号"','"'])expect(s.searchMemories(query,'project:a').map(m=>m.id)).toEqual(['a']);
 expect(s.searchMemories('中文','project:b')).toEqual([]);expect(s.searchMemories('" OR *')).toEqual([]);
 const dir=s.dataDir;s.close();const r=open(dir);expect(r.searchMemories('中文')).toHaveLength(1);r.remove('memories','a','owner');expect(r.searchMemories('中文')).toEqual([]);
});
it('保留Owner受控的修改前后正文，审计不含正文',()=>{
 const s=open();const first={id:'a',status:'active',content:'修改之前的私人偏好'};const next={...first,content:'修改之后的私人偏好'};
 s.put('memories','a',first,'owner');s.put('memories','a',next,'owner');s.remove('memories','a','owner');
 const revisions=s.memoryRevisions('a','owner') as any[];expect(revisions).toHaveLength(3);expect(revisions[0].before).toBeNull();expect(revisions[1].before).toEqual(first);expect(revisions[1].after).toEqual(next);expect(revisions[2].after.status).toBe('deleted');
 expect(()=>s.memoryRevisions('a','runtime')).toThrow('OWNER_REQUIRED');expect(JSON.stringify(s.db.prepare('SELECT * FROM audit_events').all())).not.toContain('私人偏好');
});
it('数据库创建及重开显式收紧0600且WAL/SHM无组或其他权限',()=>{
 const s=open();expect(statSync(s.dbPath).mode&0o777).toBe(0o600);for(const suffix of ['-wal','-shm'])expect(statSync(s.dbPath+suffix).mode&0o077).toBe(0);
 const dir=s.dataDir;s.close();chmodSync(join(dir,'app.sqlite'),0o644);const r=open(dir);expect(statSync(r.dbPath).mode&0o777).toBe(0o600);
});
it('版本化scrypt明确参数，未知用户名同样执行真实scrypt，未知版本拒绝',()=>{
 const s=open();const auth=new AuthService(s);auth.setup({username:'owner',password:'long-enough-password',timezone:'UTC'});
 const user=s.list<any>('users')[0];expect(user.passwordHash).toMatch(/^scrypt\$v1\$N=32768,r=8,p=3\$[a-f0-9]{32}\$[a-f0-9]{128}$/);
 vi.mocked(scryptSync).mockClear();expect(()=>auth.login('absent','wrong')).toThrow('INVALID_CREDENTIALS');expect(scryptSync).toHaveBeenCalledTimes(1);expect(vi.mocked(scryptSync).mock.calls[0]![3]).toEqual({N:32768,r:8,p:3,maxmem:64*1024*1024});
 vi.mocked(scryptSync).mockClear();expect(()=>auth.login('owner','wrong')).toThrow('INVALID_CREDENTIALS');expect(scryptSync).toHaveBeenCalledTimes(1);
 s.put('users',user.id,{...user,passwordHash:user.passwordHash.replace('$v1$','$v99$')});expect(()=>auth.login('owner','long-enough-password')).toThrow('INVALID_CREDENTIALS');
 s.put('users',user.id,{...user,passwordHash:user.passwordHash.split('$').slice(3).join(':')});expect(auth.login('owner','long-enough-password').token).toBeTruthy();
});
it('维护模式保留已有会话读取但拒绝登录及写入',()=>{
 const s=open();const auth=new AuthService(s);auth.setup({username:'owner',password:'long-enough-password',timezone:'UTC'});const session=auth.login('owner','long-enough-password');const dir=s.dataDir;s.close();const db=new DatabaseSync(join(dir,'app.sqlite'));db.exec('PRAGMA user_version=999');db.close();const r=open(dir);const a=new AuthService(r);expect(r.maintenance).toBe(true);expect(a.authenticate(session.token)).toBeDefined();expect(()=>a.login('owner','long-enough-password')).toThrow('MAINTENANCE');expect(()=>r.put('tasks','a',{})).toThrow('MAINTENANCE');
});
