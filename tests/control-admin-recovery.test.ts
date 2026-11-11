import { afterEach, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { acquireOwnership } from '../src/ownership.js';
import { AuthService } from '../src/control/security.js';
import { ControlStore } from '../src/control/store.js';

const dirs:string[]=[];
afterEach(()=>{for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});
function fixture() {
  const dir=mkdtempSync(join(tmpdir(),'admin-recovery-'));dirs.push(dir);
  const store=new ControlStore(dir);const auth=new AuthService(store);
  auth.setup({username:'owner',password:'old-strong-password',timezone:'UTC'});
  const token=auth.login('owner','old-strong-password').token;
  store.setSecret('preserve','encrypted-value');store.put('tasks','keep',{id:'keep'});
  store.put('sessions','other',{userId:'other',csrf:'csrf',expiresAt:Date.now()+10000});
  store.close();
  const file=join(dir,'reset');writeFileSync(file,'new-strong-password\n',{mode:0o600});
  return {dir,file,token};
}
function command(dir:string,file:string,extra:string[]=['--confirm-reset'],username='owner') {
  const env={...process.env};delete env.HDA_MASTER_KEY_FILE;
  return spawnSync(process.execPath,['--import','tsx',resolve('src/control/admin-recovery.ts'),'--data-dir',dir,'--username',username,'--password-file',file,...extra],{encoding:'utf8',env,timeout:15000});
}

it('recovers the unique owner atomically, revokes all sessions, and preserves other data',()=>{
  const {dir,file,token}=fixture();const result=command(dir,file);
  expect(result.status,result.stderr).toBe(0);
  expect(result.stdout+result.stderr).not.toContain('new-strong-password');
  const store=new ControlStore(dir);
  try {
    const auth=new AuthService(store);expect(auth.authenticate(token)).toBeUndefined();
    expect(store.list('sessions')).toHaveLength(0);
    expect(()=>auth.login('owner','old-strong-password')).toThrow('INVALID_CREDENTIALS');
    expect(auth.login('owner','new-strong-password').token).toBeTruthy();
    expect(store.get('tasks','keep')).toEqual({id:'keep'});expect(store.getSecret('preserve')).toBe('encrypted-value');
    expect(store.db.prepare("SELECT count(*) AS n FROM audit_events WHERE action='auth.recover'").get()!.n).toBe(1);
    expect(JSON.stringify(store.db.prepare('SELECT * FROM audit_events').all())).not.toContain('new-strong-password');
    expect(store.list<{passwordHash:string}>('users')[0]!.passwordHash).toMatch(/^scrypt\$v1\$/);
  } finally {store.close();}
});

it('refuses both real ownership and database locks held by another process',async()=>{
  const {dir,file,token}=fixture();const release=await acquireOwnership(dir);
  try {expect(command(dir,file).status).not.toBe(0);} finally {await release();}
  const store=new ControlStore(dir);
  try {expect(command(dir,file).status).not.toBe(0);expect(new AuthService(store).authenticate(token)).toBeDefined();} finally {store.close();}
});

it('rejects weak passwords, wrong owners, missing confirmation and unsafe files without changing credentials',()=>{
  const {dir,file,token}=fixture();
  writeFileSync(file,'short');expect(command(dir,file).status).not.toBe(0);
  writeFileSync(file,'new-strong-password');expect(command(dir,file,['--confirm-reset'],'other').status).not.toBe(0);
  expect(command(dir,file,[]).status).not.toBe(0);
  chmodSync(file,0o644);expect(command(dir,file).status).not.toBe(0);chmodSync(file,0o600);
  const link=join(dir,'link');symlinkSync(file,link);expect(command(dir,link).status).not.toBe(0);
  writeFileSync(file,Buffer.alloc(4097,97));expect(command(dir,file).status).not.toBe(0);
  expect(command(dir,dir).status).not.toBe(0);
  const store=new ControlStore(dir);try {const auth=new AuthService(store);expect(auth.authenticate(token)).toBeDefined();expect(auth.login('owner','old-strong-password').token).toBeTruthy();}finally{store.close();}
});

it('does not create a database or replace a missing master key',()=>{
  const {dir,file,token}=fixture();const key=join(dir,'master.key');const original=readFileSync(key);unlinkSync(key);
  expect(command(dir,file).status).not.toBe(0);expect(()=>readFileSync(key)).toThrow();
  writeFileSync(key,original,{mode:0o600});const store=new ControlStore(dir);try {expect(new AuthService(store).authenticate(token)).toBeDefined();expect(store.getSecret('preserve')).toBe('encrypted-value');}finally{store.close();}
  const empty=mkdtempSync(join(tmpdir(),'admin-empty-'));dirs.push(empty);expect(command(empty,file).status).not.toBe(0);expect(()=>readFileSync(join(empty,'app.sqlite'))).toThrow();expect(()=>readFileSync(join(empty,'master.key'))).toThrow();
});
