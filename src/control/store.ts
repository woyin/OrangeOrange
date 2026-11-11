import { DatabaseSync } from 'node:sqlite';
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdirSync, readFileSync, writeFileSync, existsSync, openSync, closeSync, chmodSync } from 'node:fs';
import { flockSync } from 'fs-ext';
import { join } from 'node:path';
import { randomBytes, createCipheriv, createDecipheriv, createHash, randomUUID } from 'node:crypto';

export interface ControlEvent { event_id:number; type:string; entity_id:string; occurred_at:number; payload:unknown }
export const hash = (value:unknown):string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
// Encode character bigrams as FTS tokens so Chinese and punctuation share literal search semantics.
function memoryTokens(text:string):string {
  const chars=Array.from(text.toLowerCase());
  const grams=[...chars,...chars.slice(0,-1).map((c,i)=>c+chars[i+1])];
  return [...new Set(grams.map(c=>Buffer.from(c).toString('hex')))].map(t=>'x'+t).join(' ');
}
export class ControlStore {
  readonly db:DatabaseSync;
  readonly dbPath:string;
  schemaVersion=0;
  maintenance=false;
  maintenanceReason?:string;
  private key:Buffer;
  private depth=0;
  private lockFd:number;
  private closed=false;
  private transactionContext=new AsyncLocalStorage<{active:boolean}>();
  constructor(readonly dataDir:string) {
    mkdirSync(dataDir,{recursive:true,mode:0o700});
    const keyFile=process.env.HDA_MASTER_KEY_FILE ?? join(dataDir,'master.key');
    if(!existsSync(keyFile)) {
      if(process.env.HDA_MASTER_KEY_FILE||existsSync(join(dataDir,'app.sqlite'))) throw new Error('MASTER_KEY_MISSING');
      writeFileSync(keyFile,randomBytes(32),{mode:0o600,flag:'wx'});
    }
    this.key=readFileSync(keyFile);
    if(this.key.length!==32) throw new Error('MASTER_KEY_INVALID');
    this.dbPath=join(dataDir,'app.sqlite');
    this.lockFd=openSync(join(dataDir,'app.lock'),'a',0o600);
    try {flockSync(this.lockFd,'exnb');} catch {closeSync(this.lockFd);throw new Error('APP_DATABASE_ALREADY_OWNED');}
    try {
      const dbFd=openSync(this.dbPath,'a',0o600);closeSync(dbFd);chmodSync(this.dbPath,0o600);
      this.db=new DatabaseSync(this.dbPath);
    } catch(error) {closeSync(this.lockFd);throw error;}
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
    try {
      this.schemaVersion=Number(this.db.prepare('PRAGMA user_version').get()!.user_version);
      if(this.schemaVersion>1) throw new Error('SCHEMA_NEWER_THAN_APPLICATION');
      this.db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS entities(kind TEXT NOT NULL,id TEXT NOT NULL,value TEXT NOT NULL,dedupe_key TEXT,PRIMARY KEY(kind,id),UNIQUE(kind,dedupe_key));
        CREATE TABLE IF NOT EXISTS secrets(name TEXT PRIMARY KEY,nonce BLOB NOT NULL,tag BLOB NOT NULL,cipher BLOB NOT NULL);
        CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,type TEXT NOT NULL,entity_id TEXT NOT NULL,at INTEGER NOT NULL,payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS audit_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,actor TEXT,action TEXT,target TEXT,result TEXT,request_id TEXT,at INTEGER);
        CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit_events BEGIN SELECT RAISE(ABORT,'APPEND_ONLY'); END;
        CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit_events BEGIN SELECT RAISE(ABORT,'APPEND_ONLY'); END;
        CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(id UNINDEXED,scope UNINDEXED,content);
        PRAGMA user_version=1; COMMIT;`);
      this.schemaVersion=1;
      this.refreshMemories();
    } catch(error) {
      try {this.db.exec('ROLLBACK');} catch {}
      this.maintenance=true;
      this.maintenanceReason=error instanceof Error?error.message:'MIGRATION_FAILED';
      this.db.exec('PRAGMA query_only=ON');
    }
  }
  private writable():void {
    if(this.maintenance) throw new Error('MAINTENANCE');
    if(this.transactionContext.getStore()?.active===false) throw new Error('ASYNC_TRANSACTION_FORBIDDEN');
  }
  transaction<T>(fn:()=>T):T {
    this.writable();
    const save=`nested_${this.depth++}`;
    this.db.exec(`SAVEPOINT ${save}`);
    const context={active:true};
    try {
      const value=this.transactionContext.run(context,fn);
      if(value && typeof (value as {then?:unknown}).then==='function') {
        void Promise.resolve(value).catch(()=>{});
        throw new Error('ASYNC_TRANSACTION_FORBIDDEN');
      }
      this.db.exec(`RELEASE ${save}`);return value;
    } catch(error) {this.db.exec(`ROLLBACK TO ${save}; RELEASE ${save}`);throw error;}
    finally {context.active=false;this.depth--;}
  }
  get<T>(kind:string,id:string):T|undefined {
    const row=this.db.prepare('SELECT value FROM entities WHERE kind=? AND id=?').get(kind,id);
    return row?JSON.parse(String(row.value)) as T:undefined;
  }
  list<T>(kind:string):T[] {return this.db.prepare('SELECT value FROM entities WHERE kind=? ORDER BY rowid').all(kind).map(r=>JSON.parse(String(r.value)) as T);}
  put(kind:string,id:string,value:unknown,actor='system'):void {
    this.transaction(()=>{
      const old=this.get(kind,id);
      const record=value as Record<string,unknown>;
      if(kind==='memories'&&record.id!==id)throw new Error('MEMORY_ID_MISMATCH');
      const dedupe=(kind==='inbox_events'||kind==='outbox')?String(record.dedupe_key??record.dedupeKey??id):null;
      this.db.prepare('INSERT INTO entities(kind,id,value,dedupe_key) VALUES(?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET value=excluded.value,dedupe_key=excluded.dedupe_key').run(kind,id,JSON.stringify(value),dedupe);
      if(kind==='memories') {
        const rev={id:randomUUID(),memory_id:id,actor,action:old?'edit':'create',old_hash:old?hash(old):null,new_hash:hash(value),before:old??null,after:value,at:Date.now()};
        this.db.prepare('INSERT INTO entities(kind,id,value) VALUES(?,?,?)').run('memory_revisions',rev.id,JSON.stringify(rev));
        this.indexMemory(id,record);
      }
      this.audit(actor,'put',`${kind}:${id}`,hash(value));
    });
  }
  remove(kind:string,id:string,actor='system'):void {
    this.transaction(()=>{
      const old=this.get<Record<string,unknown>>(kind,id);
      if(kind==='memories'&&old) this.put(kind,id,{...old,status:'deleted',updated_at:Date.now()},actor);
      else this.db.prepare('DELETE FROM entities WHERE kind=? AND id=?').run(kind,id);
      this.audit(actor,'remove',`${kind}:${id}`,'ok');
    });
  }
  setting<T>(key:string,fallback:T):T {return this.get<T>('settings',key)??fallback;}
  setSetting(key:string,value:unknown):void {this.put('settings',key,value);}
  event(type:string,entityId:string,payload:unknown={}):number {
    this.writable();
    // Durable events contain only a digest. Clients fetch authenticated resource state.
    return Number(this.db.prepare('INSERT INTO events(type,entity_id,at,payload) VALUES(?,?,?,?)').run(type,entityId,Date.now(),JSON.stringify({hash:hash(payload)})).lastInsertRowid);
  }
  events(after=0,limit=100):ControlEvent[] {
    return this.db.prepare('SELECT * FROM events WHERE seq>? ORDER BY seq LIMIT ?').all(after,Math.min(1000,Math.max(1,limit))).map(r=>({event_id:Number(r.seq),type:String(r.type),entity_id:String(r.entity_id),occurred_at:Number(r.at),payload:JSON.parse(String(r.payload))}));
  }
  audit(actor:string,action:string,target:string,result:string,requestId?:string):void {
    this.writable();
    this.db.prepare('INSERT INTO audit_events(actor,action,target,result,request_id,at) VALUES(?,?,?,?,?,?)').run(hash(actor),/^[a-z][a-z0-9_.:-]{0,63}$/i.test(action)?action:hash(action),hash(target),hash(result),requestId?hash(requestId):null,Date.now());
  }
  setSecret(name:string,value:string):void {
    this.writable();const nonce=randomBytes(12);const cipher=createCipheriv('aes-256-gcm',this.key,nonce);cipher.setAAD(Buffer.from(name));
    const encrypted=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);
    this.transaction(()=>{
      this.db.prepare('INSERT INTO secrets VALUES(?,?,?,?) ON CONFLICT(name) DO UPDATE SET nonce=excluded.nonce,tag=excluded.tag,cipher=excluded.cipher').run(name,nonce,cipher.getAuthTag(),encrypted);
      this.audit('owner','secret.set',name,'configured');
    });
  }
  getSecret(name:string):string|undefined {
    const row=this.db.prepare('SELECT * FROM secrets WHERE name=?').get(name);if(!row)return;
    const cipher=createDecipheriv('aes-256-gcm',this.key,row.nonce as Uint8Array);cipher.setAAD(Buffer.from(name));cipher.setAuthTag(row.tag as Uint8Array);
    return Buffer.concat([cipher.update(row.cipher as Uint8Array),cipher.final()]).toString('utf8');
  }
  deleteSecret(name:string):void {this.transaction(()=>{this.db.prepare('DELETE FROM secrets WHERE name=?').run(name);this.audit('owner','secret.delete',name,'deleted');});}
  tasksWithStatuses(statuses: string[]): any[] {
    if (!statuses.length) return [];
    const marks = statuses.map(() => '?').join(',');
    return this.db.prepare(`SELECT value FROM entities WHERE kind='tasks' AND json_extract(value,'$.status') IN (${marks})`).all(...statuses).map(r => JSON.parse(String(r.value)));
  }
  tasksAwaitingDelivery(): any[] {
    return this.db.prepare("SELECT value FROM entities WHERE kind='tasks' AND json_extract(value,'$.channelId') IS NOT NULL AND json_extract(value,'$.status') IN ('SUCCEEDED','FAILED','CANCELLED')").all().map(r => JSON.parse(String(r.value)));
  }
  secretMetadata():{name:string,configured:boolean}[] {return this.db.prepare('SELECT name FROM secrets').all().map(r=>({name:String(r.name),configured:true}));}
  private indexMemory(id:string,m:Record<string,unknown>):void {
    this.db.prepare('DELETE FROM memory_fts WHERE id=?').run(id);
    const expiry=m.expires_at??m.expiresAt;
    const at=typeof expiry==='string'?Date.parse(expiry):Number(expiry);
    if(m.status==='active'&&!m.secret&&(!m.sensitive||m.sensitiveApproved===true)&&m.kind!=='secret'&&(expiry==null||at>Date.now())) this.db.prepare('INSERT INTO memory_fts(id,scope,content) VALUES(?,?,?)').run(id,String(m.scope??'global'),memoryTokens(String(m.content??'')));
  }
  // Internal get/list remain trusted APIs. Expose full history only after explicit Owner authorization.
  memoryRevisions(memoryId:string,principalId:string):unknown[] {
    if(principalId!=='owner')throw new Error('OWNER_REQUIRED');
    return this.list<{memory_id:string}>('memory_revisions').filter(r=>r.memory_id===memoryId);
  }
  private refreshMemories():void {this.db.exec('DELETE FROM memory_fts');for(const m of this.list<Record<string,unknown>>('memories'))this.indexMemory(String(m.id),m);}
  searchMemories(query:string,scope?:string):any[] {
    if(!query.trim())return [];
    const match=memoryTokens(query).split(' ').map(token=>'"'+token+'"').join(' AND ');
    const sql='SELECT id FROM memory_fts WHERE memory_fts MATCH ?'+(scope?' AND scope=?':'')+' ORDER BY rank';
    const drop = (id:string) => { this.db.prepare('DELETE FROM memory_fts WHERE id=?').run(id); return undefined; };
    return this.db.prepare(sql).all(...(scope?[match,scope]:[match])).map(r => ({ id: String(r.id), m: this.get<Record<string,unknown>>('memories', String(r.id)) })).map(({ id, m }) => {
      if (!m) return drop(id);
      if (m.status !== 'active' || m.secret || (m.sensitive && m.sensitiveApproved !== true) || m.kind === 'secret') return drop(id);
      const expiry = m.expires_at ?? m.expiresAt;
      if (expiry != null && !((typeof expiry === 'string' ? Date.parse(expiry) : Number(expiry)) > Date.now())) return drop(id);
      return m;
    }).filter((m): m is Record<string,unknown> => !!m && String(m.content ?? '').toLowerCase().includes(query.toLowerCase())).slice(0,100);
  }
  close():void {if(this.closed)return;this.db.close();closeSync(this.lockFd);this.closed=true;}
}
