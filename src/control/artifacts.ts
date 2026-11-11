import { createHash, randomUUID } from 'node:crypto';
import type { ControlStore } from './store.js';

export interface ManagedArtifact { id:string; filename:string; mimeType:string; sha256:string; sizeBytes:number; createdAt:number }
type StoredArtifact = ManagedArtifact & { base64:string };
const allowedTypes = new Set(['text/plain','text/csv','application/json','application/pdf','image/png','image/jpeg']);
export const MAX_ARTIFACT_BYTES=8*1024*1024;
export class ArtifactError extends Error { constructor(readonly code:string){super(code);} }
export function decodeBase64(value:unknown,maxBytes:number):Buffer {
  if(typeof value!=='string'||value.length>Math.ceil(maxBytes/3)*4||!value.length||value.length%4!==0||!/^[A-Za-z0-9+/]*={0,2}$/.test(value))throw new ArtifactError('INVALID_BASE64');
  const bytes=Buffer.from(value,'base64');
  if(bytes.length>maxBytes||bytes.toString('base64')!==value)throw new ArtifactError('INVALID_BASE64');
  return bytes;
}
export class ArtifactStore {
  constructor(private store:ControlStore){}
  put(input:{filename:string;mimeType:string;base64:string;sha256:string}):ManagedArtifact {
    if(Object.keys(input).some(k=>!['filename','mimeType','base64','sha256'].includes(k)))throw new ArtifactError('INVALID_ARTIFACT_FIELDS');
    if(typeof input.filename!=='string'||!input.filename.trim()||input.filename.length>180||/[\\/\x00-\x1f\x7f]/.test(input.filename)||input.filename==='.'||input.filename.includes('..'))throw new ArtifactError('INVALID_ARTIFACT_FILENAME');
    if(!allowedTypes.has(input.mimeType))throw new ArtifactError('ARTIFACT_TYPE_DENIED');
    const bytes=decodeBase64(input.base64,MAX_ARTIFACT_BYTES);
    if(createHash('sha256').update(bytes).digest('hex')!==input.sha256)throw new ArtifactError('ARTIFACT_HASH_MISMATCH');
    if(input.mimeType==='application/pdf'&&!bytes.subarray(0,5).equals(Buffer.from('%PDF-')))throw new ArtifactError('ARTIFACT_TYPE_MISMATCH');
    if(input.mimeType==='image/png'&&!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw new ArtifactError('ARTIFACT_TYPE_MISMATCH');
    if(input.mimeType==='image/jpeg'&&!(bytes[0]===255&&bytes[1]===216&&bytes[2]===255))throw new ArtifactError('ARTIFACT_TYPE_MISMATCH');
    if(['text/plain','text/csv','application/json'].includes(input.mimeType)){try{new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{throw new ArtifactError('ARTIFACT_TYPE_MISMATCH');}}
    if(input.mimeType==='application/json'){try{JSON.parse(bytes.toString('utf8'));}catch{throw new ArtifactError('ARTIFACT_TYPE_MISMATCH');}}
    return this.store.transaction(()=>{
      const items=this.store.list<StoredArtifact>('artifacts');
      if(items.length>=256||items.reduce((n,a)=>n+a.sizeBytes,0)+bytes.length>100*1024*1024)throw new ArtifactError('ARTIFACT_QUOTA_EXCEEDED');
      const metadata={id:randomUUID(),filename:input.filename,mimeType:input.mimeType,sha256:input.sha256,sizeBytes:bytes.length,createdAt:Date.now()};
      this.store.put('artifacts',metadata.id,{...metadata,base64:input.base64},'owner');this.store.event('artifact.created',metadata.id);
      return metadata;
    });
  }
  read(id:string):ManagedArtifact & {bytes:Buffer}{
    const item=this.store.get<StoredArtifact>('artifacts',id);if(!item)throw new ArtifactError('ARTIFACT_NOT_FOUND');
    const {base64,...metadata}=item;const bytes=decodeBase64(base64,MAX_ARTIFACT_BYTES);
    if(createHash('sha256').update(bytes).digest('hex')!==metadata.sha256)throw new ArtifactError('ARTIFACT_HASH_MISMATCH');
    return {...metadata,bytes};
  }
  list():ManagedArtifact[]{return this.store.list<StoredArtifact>('artifacts').map(({base64,...m})=>m);}
}
