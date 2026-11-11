import type { ControlStore } from '../control/store.js';
import { MigrationEngine, type MigrationInventory, type MigrationPlan, type MigrationBatch, type VerificationReport, type RollbackReport } from './core.js';
import { openMigrationSource } from './source.js';
import { parseOpenClaw, parseHermes } from './importers.js';

export * from './core.js';
export { compatibilityMatrix } from './compatibility.js';
export type { CompatibilityEntry } from './compatibility.js';
export type MigrationSourceInput = ({ system:'openclaw'|'hermes'; instanceId:string } & ({archive:Buffer;directory?:never;workspace?:never}|{archive?:never;directory:string;workspace?:string}));
export interface MigrationServiceOptions { readonlyRoots:readonly string[] }
export interface SourceImporter {
  probe(input:MigrationSourceInput):Promise<MigrationInventory>;
  inventory(input:MigrationSourceInput):Promise<MigrationInventory>;
  validate(inventory:MigrationInventory):void;
  plan(inventory:MigrationInventory):MigrationPlan;
  stage(plan:MigrationPlan):MigrationBatch;
  apply(id:string,approvedPlanHash:string):MigrationBatch;
  verify(id:string):VerificationReport;
  rollback(id:string):RollbackReport;
}

/** 目录来源只允许部署时配置的只读挂载；上传 ZIP 不访问宿主路径。 */
export class MigrationService extends MigrationEngine implements SourceImporter {
  constructor(store:ControlStore, private readonly options:MigrationServiceOptions){super(store);}
  probe(input:MigrationSourceInput):Promise<MigrationInventory> {return this.scan(input);}
  inventory(input:MigrationSourceInput):Promise<MigrationInventory> {return this.scan(input);}
  validate(inventory:MigrationInventory):void {
    if(!['openclaw','hermes'].includes(inventory.system)||!inventory.instanceId||!inventory.version)throw new Error('MIGRATION_SOURCE_ID_REQUIRED');
    const seen=new Set<string>();for(const item of inventory.items){const key=JSON.stringify([item.type,item.sourceId]);if(!item.type||!item.sourceId||seen.has(key))throw new Error('MIGRATION_DUPLICATE_SOURCE_ID');seen.add(key);}
  }
  async scan(input:MigrationSourceInput):Promise<MigrationInventory> {
    if(!input.instanceId||input.instanceId.length>200)throw new Error('MIGRATION_SOURCE_ID_REQUIRED');
    if(input.system!=='openclaw'&&input.system!=='hermes')throw new Error('MIGRATION_INVALID_SYSTEM');
    const request=input.archive!==undefined?{archive:input.archive}:{directory:input.directory!,workspace:input.workspace};
    const source=await openMigrationSource(request,{allowedRoots:this.options.readonlyRoots,requireReadOnlyMount:true,policy:{links:'reject'}});
    const files=new Map<string,Buffer>();
    const fileItems:MigrationInventory['items']=[];
    const skippedSecrets:string[]=[];
    let assetBytes=0;
    for(const entry of source.entries){
      if(entry.kind!=='file')continue;
      const path=entry.mount==='workspace'?'workspace/'+entry.path:entry.path;
      const secret=/(^|\/)(?:\.env(?:\..*)?|auth(?:-profiles)?\.json|credentials?|cookies?|tokens?|oauth|.*\.(?:key|pem|p12|pfx))($|\/)/i.test(path);
      if(secret){skippedSecrets.push(path);fileItems.push({sourceId:`file:${path}`,type:'reauthorization',content:{path,reason:'sensitive_file_not_copied'}});continue;}
      const metadata={path,bytes:entry.size,sha256:entry.sha256};
      const item:MigrationInventory['items'][number]={sourceId:`file:${path}`,type:'file_inventory',content:{...metadata,status:'not_mapped'}};
      fileItems.push(item);
      // 解析器只接收经过白名单筛选的文件；journal/WAL 用于拒绝不一致快照。
      if(/(^|\/)(openclaw\.json|config\.yaml|state\.db(?:-wal|-shm|-journal)?|openclaw-agent\.sqlite(?:-wal|-shm|-journal)?|sessions\.json|[^/]+\.jsonl|[a-f0-9]{64}\.jsonl\.zst|AGENTS\.md|SOUL\.md|USER\.md|MEMORY\.md|IDENTITY\.md|SKILL\.md|jobs\.json)$/i.test(path)){
        files.set(path,await source.read(entry));(item.content as Record<string,unknown>).status='parser_input';continue;
      }
      if(/(^|\/)(mcp(?:_config)?\.json)$/i.test(path)){
        if(entry.size>1024*1024){(item.content as Record<string,unknown>).status='mcp_too_large';continue;}
        const raw=await source.read(entry,{maxBytes:1024*1024});
        try {const data=JSON.parse(raw.toString('utf8')) as Record<string,unknown>;const servers=data.mcpServers;
          if(servers&&typeof servers==='object'&&!Array.isArray(servers)){for(const [name,value] of Object.entries(servers as Record<string,unknown>)){if(!/^[\w.-]{1,80}$/.test(name))continue;const record=value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};const type=['stdio','sse','http','streamable-http'].includes(String(record.type))?record.type:'unknown';fileItems.push({sourceId:`mcp:${path}:${name}`,type:'mcp',content:{name,type,enabled:false,reviewRequired:true,source:path,omittedFields:Object.keys(record).sort()}});if(record.env!==undefined||record.headers!==undefined){skippedSecrets.push(`${path}:${name}`);fileItems.push({sourceId:`reauth:mcp:${path}:${name}`,type:'reauthorization',content:{source:path,server:name,reason:'mcp_credentials_not_copied'}});}}}
          (item.content as Record<string,unknown>).status='partial_mcp_draft';
        } catch {(item.content as Record<string,unknown>).status='mcp_unreadable';}
        continue;
      }
      // 图片附件以受限二进制形式保存在 ControlStore。脚本只记录哈希，不运行。
      if(/\.(png|jpe?g)$/i.test(path)&&entry.size<=1024*1024){
        const bytes=await source.read(entry);const png=bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'));const jpeg=bytes.length>=3&&bytes[0]===0xff&&bytes[1]===0xd8&&bytes[2]===0xff;
        const containsCredential=/(?:sk-[A-Za-z0-9_-]{16,}|(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password)\s*[:=]\s*[^\s]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/i.test(bytes.toString('latin1'));
        if((png||jpeg)&&!containsCredential&&assetBytes+bytes.length<=8*1024*1024){assetBytes+=bytes.length;fileItems.push({sourceId:`asset:${path}`,type:'attachment',content:{...metadata,mediaType:png?'image/png':'image/jpeg',encoding:'base64',data:bytes.toString('base64'),trust:'untrusted'}});(item.content as Record<string,unknown>).status='asset';}
        else if(containsCredential){skippedSecrets.push(path);fileItems.push({sourceId:`reauth:asset:${path}`,type:'reauthorization',content:{path,reason:'sensitive_asset_not_copied'}});(item.content as Record<string,unknown>).status='sensitive_not_copied';}
      }
    }
    const parsed=input.system==='openclaw'?parseOpenClaw(files,input.instanceId):parseHermes(files,input.instanceId);
    // 冷归档正文可能不在解析器白名单；用扫描清单纠正存在性，并保留未解码损失。
    const archives=parsed.items.filter(i=>i.type==='archive'&&i.sourceId.startsWith('cold_archive:'));
    for(const archive of archives){const content=archive.content as Record<string,unknown>;if(content.bodyAvailable||typeof content.archiveName!=='string')continue;const name=content.archiveName;const matches=fileItems.filter(i=>i.type==='file_inventory'&&((i.content as Record<string,unknown>).path===name||String((i.content as Record<string,unknown>).path).endsWith('/'+name)));if(matches.length!==1)continue;const metadata=matches[0]!.content as Record<string,unknown>;content.bodyAvailable=true;content.body={path:metadata.path,bytes:metadata.bytes,sha256:metadata.sha256};content.losses=[...(Array.isArray(content.losses)?content.losses.filter((l:{field?:string})=>!l.field?.startsWith('archive_body')):[]),{field:'archive_body',reason:'archive_content_not_retained'},{field:'archive_body.messages',reason:'archive_container_not_decoded'}];archive.warnings=(archive.warnings??[]).filter(w=>w!=='cold_archive_body_missing');archive.warnings.push('cold_archive_not_retained');}
    if(archives.length){parsed.warnings=parsed.warnings.filter(w=>!w.startsWith('cold_archive_body_missing:'));const missing=archives.filter(a=>!(a.content as Record<string,unknown>).bodyAvailable).length;if(missing)parsed.warnings.push(`cold_archive_body_missing:${missing}`);}
    for(const skill of parsed.items.filter(i=>i.type==='skill')){const content=skill.content as Record<string,unknown>;const base=typeof content.path==='string'?content.path.replace(/[^/]+$/,''):'';if(base)content.files=fileItems.filter(i=>i.type==='file_inventory'&&String((i.content as Record<string,unknown>).path).startsWith(base)).map(i=>i.content);}
    const summary={files:source.entries.filter(e=>e.kind==='file').length,bytes:source.totalBytes,indexed:fileItems.filter(i=>i.type==='file_inventory').length,assets:fileItems.filter(i=>i.type==='attachment').length,reauthorization:skippedSecrets.length,unmapped:fileItems.filter(i=>i.type==='file_inventory'&&(i.content as Record<string,unknown>).status==='not_mapped').length};
    const inventory:MigrationInventory={...parsed,sourceVersion:null,formatVersion:parsed.version,summary,manifestHash:source.manifestHash,items:[...parsed.items,...fileItems],warnings:[...parsed.warnings,...skippedSecrets.map(path=>`reauthorization_required:${path}`),...source.warnings.map(w=>`${w.code}:${w.mount}:${w.path}`)]};
    // 扫描只返回脱敏清单；来源元数据由 stage 与批次一起事务保存。
    return inventory;
  }
}
