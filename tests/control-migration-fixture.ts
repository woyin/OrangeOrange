import { DatabaseSync } from 'node:sqlite';
import { mkdtemp,readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';
export function zipFixture(files:Record<string,Buffer|string>):Buffer{
  const parts:Buffer[]=[],central:Buffer[]=[];let offset=0;
  for(const [path,value]of Object.entries(files)){
    const name=Buffer.from(path),bytes=Buffer.isBuffer(value)?value:Buffer.from(value),checksum=crc32(bytes);
    const header=Buffer.alloc(30);header.writeUInt32LE(0x04034b50);header.writeUInt16LE(20,4);header.writeUInt16LE(0x800,6);header.writeUInt32LE(checksum,14);header.writeUInt32LE(bytes.length,18);header.writeUInt32LE(bytes.length,22);header.writeUInt16LE(name.length,26);
    parts.push(header,name,bytes);
    const entry=Buffer.alloc(46);entry.writeUInt32LE(0x02014b50);entry.writeUInt16LE(0x314,4);entry.writeUInt16LE(20,6);entry.writeUInt16LE(0x800,8);entry.writeUInt32LE(checksum,16);entry.writeUInt32LE(bytes.length,20);entry.writeUInt32LE(bytes.length,24);entry.writeUInt16LE(name.length,28);entry.writeUInt32LE((0o100600<<16)>>>0,38);entry.writeUInt32LE(offset,42);central.push(entry,name);offset+=header.length+name.length+bytes.length;
  }
  const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(Object.keys(files).length,8);end.writeUInt16LE(Object.keys(files).length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...parts,directory,end]);
}
export async function hermesFixtureArchive(memory='Imported memory'){
  const dir=await mkdtemp(join(tmpdir(),'hda-http-source-')),path=join(dir,'state.db');
  try{
    const db=new DatabaseSync(path);
    try{
      db.exec(await readFile(new URL('./fixtures/migrations/hermes/state-schema33.sql',import.meta.url),'utf8'));
      db.exec("INSERT INTO schema_version VALUES(33); INSERT INTO sessions(id,source,title,started_at,message_count) VALUES('old-session','cli','Imported conversation',1700000000,2); INSERT INTO messages(session_id,role,content,timestamp) VALUES('old-session','user','Original history marker',1700000001); INSERT INTO messages(session_id,role,content,tool_name,timestamp) VALUES('old-session','tool','Old tool result; do not replay','read_file',1700000002);");
    }finally{db.close();}
    return zipFixture({'state.db':await readFile(path),'config.yaml':'model: gpt-4.1-mini\n','memories/MEMORY.md':memory,'skills/unsafe/SKILL.md':'# Imported skill\nOnly a draft.','skills/unsafe/run.sh':'touch /tmp/NEVER_EXECUTE_IMPORTED_CODE','.env':'TOKEN=should-not-copy-secret'});
  }finally{await rm(dir,{recursive:true,force:true});}
}
