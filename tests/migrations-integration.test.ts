import { expect, test } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, zstdCompressSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { ControlStore } from '../src/control/store.js';
import { MigrationService, compatibilityMatrix } from '../src/migrations/index.js';

function zip(files:Record<string,Buffer>):Buffer {
  const local:Buffer[]=[],central:Buffer[]=[];let offset=0;
  for(const [name,data] of Object.entries(files)){const n=Buffer.from(name),c=crc32(data),h=Buffer.alloc(30),d=Buffer.alloc(46);
    h.writeUInt32LE(0x04034b50);h.writeUInt16LE(20,4);h.writeUInt16LE(0x800,6);h.writeUInt32LE(c,14);h.writeUInt32LE(data.length,18);h.writeUInt32LE(data.length,22);h.writeUInt16LE(n.length,26);
    d.writeUInt32LE(0x02014b50);d.writeUInt16LE(0x314,4);d.writeUInt16LE(20,6);d.writeUInt16LE(0x800,8);d.writeUInt32LE(c,16);d.writeUInt32LE(data.length,20);d.writeUInt32LE(data.length,24);d.writeUInt16LE(n.length,28);d.writeUInt32LE((0o100644<<16)>>>0,38);d.writeUInt32LE(offset,42);
    local.push(h,n,data);central.push(d,n);offset+=h.length+n.length+data.length;
  }
  const cd=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(central.length/2,8);end.writeUInt16LE(central.length/2,10);end.writeUInt32LE(cd.length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...local,cd,end]);
}

test('OpenClaw ZIP 扫描恢复并查询冷归档文本',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'migration-cold-integration-'));let store:ControlStore|undefined;
  try{const event=JSON.stringify({type:'message',message:{role:'user',content:'冷归档中文历史'}});const lines=[{kind:'header',version:1,sessionId:'s',generation:'g'},{kind:'event',row:{seq:1,event_json:event,created_at:1}}];const cold=zstdCompressSync(Buffer.from(lines.map(line=>JSON.stringify(line)).join('\n')+'\n'));const sha=createHash('sha256').update(cold).digest('hex');const name=sha+'.jsonl.zst';
    const dbPath=join(dir,'agent.sqlite'),db=new DatabaseSync(dbPath);db.exec(readFileSync('tests/fixtures/migrations/openclaw/agent-schema41.sql','utf8'));db.exec("INSERT INTO schema_meta VALUES('primary','agent',41,'main','2026.11.2',1,1); INSERT INTO session_nodes(session_key,current_session_id,entry_json,updated_at,created_at) VALUES('main','s','{}',1,1); INSERT INTO session_windows(session_id,session_key,created_at,updated_at) VALUES('s','main',1,1); ALTER TABLE session_transcript_cold_archives ADD COLUMN archive_sha256 TEXT; ALTER TABLE session_transcript_cold_archives ADD COLUMN event_count INTEGER; ALTER TABLE session_transcript_cold_archives ADD COLUMN raw_bytes INTEGER; ALTER TABLE session_transcript_cold_archives ADD COLUMN archive_bytes INTEGER; ALTER TABLE session_transcript_cold_archives ADD COLUMN last_seq INTEGER; ALTER TABLE session_transcript_cold_archives ADD COLUMN archived_at INTEGER; ALTER TABLE session_transcript_cold_archives ADD COLUMN storage TEXT; ALTER TABLE session_transcript_cold_archives ADD COLUMN archive_blob BLOB");db.prepare('INSERT INTO session_transcript_cold_archives(session_id,generation,archive_name,archive_sha256,event_count,raw_bytes,archive_bytes,last_seq,archived_at,storage) VALUES(?,?,?,?,?,?,?,?,?,?)').run('s','g',name,sha,1,Buffer.byteLength(event),cold.length,1,1,'file');db.close();
    const archive=zip({'agents/main/agent/openclaw-agent.sqlite':readFileSync(dbPath),['agents/main/sessions/cold/'+name]:cold});store=new ControlStore(join(dir,'target'));const service=new MigrationService(store,{readonlyRoots:[]});const inventory=await service.probe({system:'openclaw',instanceId:'stable',archive});service.validate(inventory);expect(inventory).toMatchObject({system:'openclaw',sourceVersion:null,formatVersion:'openclaw:agent-schema-41'});const item=inventory.items.find(i=>i.type==='archive');expect(item?.content).toMatchObject({bodyAvailable:true,bodyDecoded:true});expect(inventory.items.some(i=>i.type==='message'&&JSON.stringify(i.content).includes('冷归档中文历史'))).toBe(true);const plan=service.plan(inventory);service.stage(plan);service.apply(plan.id,plan.hash);const history=service.listHistory('冷归档中文历史');expect(history).toHaveLength(1);expect(service.continuation(history[0]!.id).messages).toContainEqual({sourceRole:'user',text:'冷归档中文历史'});
  }finally{store?.close();rmSync(dir,{recursive:true,force:true});}
});

test('ZIP 扫描保存文件清单和受控附件，并关联真实解析的会话',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'migration-integration-'));let store:ControlStore|undefined;
  try{const dbPath=join(dir,'state.db'),db=new DatabaseSync(dbPath);db.exec(readFileSync('tests/fixtures/migrations/hermes/state-schema33.sql','utf8'));db.exec("INSERT INTO schema_version VALUES(33); INSERT INTO sessions(id,source,started_at) VALUES('s','cli',1); INSERT INTO messages(session_id,role,content,timestamp) VALUES('s','user','中文历史',2)");db.close();
    const secret='sk-'+ 'abcdefghijklmnopqrstuv';const image=Buffer.from('89504e470d0a1a0a00112233','hex');const archive=zip({'state.db':readFileSync(dbPath),'memories/MEMORY.md':Buffer.from('喜欢橙子'),'skills/demo/SKILL.md':Buffer.from('---\nname: demo\n---\n描述'),'skills/demo/run.sh':Buffer.from('echo hello'),'.env':Buffer.from(secret),'mcp.json':Buffer.from('{"mcpServers":{"test":{"type":"stdio","command":"node","env":{"TOKEN":"hidden"}}}}'),'attachment.png':image,'sensitive.png':Buffer.concat([image,Buffer.from(secret)])});
    store=new ControlStore(join(dir,'target'));const service=new MigrationService(store,{readonlyRoots:[]});const inventory=await service.inventory({system:'hermes',instanceId:'stable-owner-id',archive});service.validate(inventory);expect(inventory).toMatchObject({system:'hermes',sourceVersion:null,formatVersion:'hermes:state-schema-33'});expect(inventory.summary).toMatchObject({files:8,assets:1,reauthorization:3});expect(inventory.items.some(i=>i.type==='reauthorization'&&i.sourceId.startsWith('reauth:mcp:'))).toBe(true);expect(JSON.stringify(inventory)).not.toContain(secret);expect(JSON.stringify(inventory)).not.toContain('hidden');expect(inventory.items.some(i=>i.type==='mcp')).toBe(true);expect(inventory.items.some(i=>i.type==='attachment'&&(i.content as {data:string}).data===image.toString('base64'))).toBe(true);
    const skill=inventory.items.find(i=>i.type==='skill');expect(JSON.stringify(skill)).toContain('run.sh');expect(JSON.stringify(skill)).not.toContain('echo hello');
    expect(store.list('migration_sources')).toHaveLength(0);const plan=service.plan(inventory);service.stage(plan);expect(store.list('migration_sources')).toHaveLength(1);service.apply(plan.id,plan.hash);const history=service.listHistory('中文历史');expect(history).toHaveLength(1);expect(service.continuation(history[0]!.id).messages).toContainEqual({sourceRole:'user',text:'中文历史'});expect(compatibilityMatrix.every(e=>e.status==='unverified')).toBe(true);
  }finally{store?.close();rmSync(dir,{recursive:true,force:true});}
});
