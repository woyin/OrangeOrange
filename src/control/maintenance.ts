import { statfsSync, statSync, mkdirSync, lstatSync, chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ControlStore } from './store.js';

type RecordData = Record<string, any>;
export interface DiskSpace { totalBytes:number; freeBytes:number }
export interface MaintenanceHooks {
  diskProbe?:(path:string)=>DiskSpace|Promise<DiskSpace>;
  onProtection?:(protectedMode:boolean)=>void;
}
export interface RetentionResult { sessions:number; tasks:number; events:number; memories:number; cutoff:number; eventFloor:number }
export interface ResourceMetrics {
  rss:number; cpuUserMicros:number; cpuSystemMicros:number; uptimeSeconds:number;
  disk:DiskSpace|null; diskLow:boolean; diskProbeAvailable:boolean; dbBytes:number|null;
  runningTasks:number; queueDepth:number; failedTasks:number; terminalTasks:number; failureRate:number|null;
  pendingOutbox:number; uncertainOperations:number; modelErrors:number; imLatencyMs:number|null;
}
const terminal = new Set(['SUCCEEDED','FAILED','CANCELLED']);
const taskId=(r:RecordData):unknown=>r.taskId??r.task_id;
const time=(v:unknown):number=>typeof v==='string'?Date.parse(v):typeof v==='number'?v:NaN;
const status=(r:RecordData):string=>String(r.state??r.status??'');
// Free-form labels, prompts, endpoints and arbitrary nested configuration are deliberately absent.
const enums=(v:unknown,allowed:string[]):string|undefined=>typeof v==='string'&&allowed.includes(v)?v:undefined;
const finite=(v:unknown):number|undefined=>typeof v==='number'&&Number.isFinite(v)?v:undefined;
export class MaintenanceService {
  constructor(private getStore:()=>ControlStore, private dataDir:string, private hooks:MaintenanceHooks={}) {}
  retention(now=Date.now()):RetentionResult {
    const s=this.getStore();
    const config=s.setting<RecordData>('config',{});
    const configured=s.setting<unknown>('retentionDays',config.retentionDays??30);
    if(typeof configured!=='number'||!Number.isInteger(configured)||configured<1||configured>3650)throw new Error('INVALID_RETENTION_DAYS');
    const cutoff=now-configured*86400000;
    const result:RetentionResult={sessions:0,tasks:0,events:0,memories:0,cutoff,eventFloor:0};
    s.transaction(()=>{
      for(const row of s.db.prepare('SELECT id,value FROM entities WHERE kind=?').all('sessions')) {
        const session=JSON.parse(String(row.value));
        if(time(session.expiresAt??session.expires_at)<=now){s.remove('sessions',String(row.id));result.sessions++;}
      }
      const children=['task_steps','operations','outbox','model_usage'];
      const records=Object.fromEntries(children.map(kind=>[kind,s.list<RecordData>(kind)]));
      const approvals=s.list<RecordData>('approvals');
      for(const task of s.list<RecordData>('tasks')) {
        if(!terminal.has(task.status)||!(time(task.updatedAt??task.updated_at)<cutoff))continue;
        if(approvals.some(a=>taskId(a)===task.id&&['PENDING','WAITING_APPROVAL'].includes(status(a))))continue;
        if(records.operations!.some(o=>taskId(o)===task.id&&!['CONFIRMED','FAILED','CANCELLED'].includes(status(o))))continue;
        if(records.outbox!.some(o=>taskId(o)===task.id&&!['SENT','FAILED','CANCELLED'].includes(status(o))))continue;
        if(records.task_steps!.some(o=>taskId(o)===task.id&&['RUNNING','WAITING_APPROVAL','SENDING','UNCERTAIN'].includes(status(o))))continue;
        for(const kind of children)for(const item of records[kind]!.filter(r=>taskId(r)===task.id))s.remove(kind,item.id);
        s.remove('tasks',task.id);result.tasks++;
      }
      // Inbox/API idempotency records and their unique dedupe keys survive task removal.
      for(const row of s.db.prepare('SELECT id,value FROM entities WHERE kind=?').all('memories')) {
        const m=JSON.parse(String(row.value));
        if(m.status==='active'&&time(m.expiresAt??m.expires_at)<=now){
          s.put('memories',String(row.id),{...m,status:'expired',updated_at:now},'maintenance');result.memories++;
        }
      }
      result.events=Number(s.db.prepare('DELETE FROM events WHERE at < ?').run(cutoff).changes);
      const floor=s.db.prepare('SELECT MIN(seq) AS seq FROM events').get();
      const last=s.db.prepare("SELECT seq FROM sqlite_sequence WHERE name='events'").get();
      result.eventFloor=floor?.seq==null?Number(last?.seq??0)+1:Number(floor.seq);
      s.setSetting('eventRetentionFloor',result.eventFloor);
    });
    return result;
  }
  async metrics():Promise<ResourceMetrics> {
    const s=this.getStore();const tasks=s.list<RecordData>('tasks');const out=s.list<RecordData>('outbox');
    let disk:DiskSpace|null=null;
    try {const d=await (this.hooks.diskProbe?.(this.dataDir)??(()=>{const v=statfsSync(this.dataDir);return {totalBytes:v.blocks*v.bsize,freeBytes:v.bavail*v.bsize};})());if(Number.isFinite(d.totalBytes)&&Number.isFinite(d.freeBytes)&&d.totalBytes>0&&d.freeBytes>=0&&d.freeBytes<=d.totalBytes)disk=d;}catch{}
    const diskLow=!disk||disk.freeBytes<64*1024*1024||disk.freeBytes/disk.totalBytes<0.05;
    this.hooks.onProtection?.(diskLow);
    let dbBytes:number|null=null;
    try {dbBytes=statSync(s.dbPath).size;for(const suffix of ['-wal','-shm']){try{dbBytes+=statSync(s.dbPath+suffix).size;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}}catch{dbBytes=null;}
    const cpu=process.cpuUsage();const done=tasks.filter(t=>terminal.has(t.status)).length;const failed=tasks.filter(t=>t.status==='FAILED').length;
    return {rss:process.memoryUsage().rss,cpuUserMicros:cpu.user,cpuSystemMicros:cpu.system,uptimeSeconds:process.uptime(),disk,diskLow,diskProbeAvailable:disk!==null,dbBytes,runningTasks:tasks.filter(t=>t.status==='RUNNING').length,queueDepth:tasks.filter(t=>['CREATED','QUEUED','RETRY_WAIT'].includes(t.status)).length,failedTasks:failed,terminalTasks:done,failureRate:done?failed/done:null,pendingOutbox:out.filter(o=>!['SENT','FAILED','CANCELLED'].includes(status(o))).length,uncertainOperations:s.list<RecordData>('operations').filter(o=>['SENDING','UNCERTAIN'].includes(status(o))).length,modelErrors:s.list<RecordData>('model_usage').filter(u=>u.errorCode||u.status==='FAILED').length,imLatencyMs:null};
  }
  exportConfig():object {
    const s=this.getStore();const c=s.setting<RecordData>('config',{});
    const tz=s.setting<unknown>('timezone',c.timezone);let timezone:string|undefined;
    if(typeof tz==='string'&&/^[A-Za-z_+/-]{1,64}$/.test(tz)){try{new Intl.DateTimeFormat('en',{timeZone:tz});timezone=tz;}catch{}}
    return {version:1,settings:{timezone,language:enums(c.language,['zh-CN','en']),retentionDays:finite(s.setting('retentionDays',c.retentionDays)),maxConcurrentRuns:finite(c.maxConcurrentRuns),maxQueueLength:finite(c.maxQueueLength),dailyBudget:finite(c.dailyBudget)},providers:s.list<RecordData>('providers').map(p=>({vendor:enums(p.vendor,['openai','anthropic','google','azure','ollama']),priority:finite(p.priority),dailyBudget:finite(p.dailyBudget),taskBudget:finite(p.taskBudget)})),channels:s.list<RecordData>('channels').map(c=>({type:enums(c.type,['telegram','discord','feishu']),enabled:typeof c.enabled==='boolean'?c.enabled:undefined})),toolPolicy:s.list<RecordData>('tools').map(t=>({enabled:typeof t.enabled==='boolean'?t.enabled:undefined,sideEffect:enums(t.sideEffect,['read_only','idempotent_write','non_idempotent_write','high_risk']),permission:enums(t.permission,['allow','deny','approval'])}))};
  }
  logs(limit=100):object[] {
    const s=this.getStore();const count=Number.isFinite(limit)?Math.min(1000,Math.max(1,Math.trunc(limit))):100;
    return s.db.prepare('SELECT seq,type,entity_id,at FROM events ORDER BY seq DESC LIMIT ?').all(count).map(r=>({eventId:Number(r.seq),code:'CONTROL_EVENT',correlationId:/^[a-f0-9-]{36}$/i.test(String(r.entity_id))?String(r.entity_id):undefined,at:Number(r.at)}));
  }
  async diagnostics():Promise<object> {return {version:1,schemaVersion:this.getStore().schemaVersion,maintenance:this.getStore().maintenance,metrics:await this.metrics(),logs:this.logs(),config:this.exportConfig()};}
  rotateAudit():{file:string;lastSeq:number} {
    const s=this.getStore();const dir=join(this.dataDir,'audit-snapshots');
    if(lstatSync(this.dataDir).isSymbolicLink())throw new Error('UNSAFE_AUDIT_DIRECTORY');
    mkdirSync(dir,{recursive:true,mode:0o700});if(lstatSync(dir).isSymbolicLink()||!lstatSync(dir).isDirectory())throw new Error('UNSAFE_AUDIT_DIRECTORY');chmodSync(dir,0o700);
    const rows=s.db.prepare('SELECT * FROM audit_events ORDER BY seq').all();
    const file=join(dir,randomUUID()+'.json');writeFileSync(file,JSON.stringify({version:1,rows}),{mode:0o600,flag:'wx'});
    return {file,lastSeq:Number(rows.at(-1)?.seq??0)};
  }
}
