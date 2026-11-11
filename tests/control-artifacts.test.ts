import { test, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { controlFixture } from './control-fixture.js';

test('NFR-015 受管附件真实HTTP鉴权、类型/配额/路径/hash约束且响应不回显内容',async()=>{
  const f=await controlFixture();
  const bytes=Buffer.from('private attachment body');
  const good={filename:'report.txt',mimeType:'text/plain',base64:bytes.toString('base64'),sha256:createHash('sha256').update(bytes).digest('hex')};
  try{
    expect((await f.request('artifacts')).response.status).toBe(401);
    await f.setup();
    const result=await f.request('artifacts','POST',good);
    expect(result.response.status).toBe(200);
    expect(result.json.data).toMatchObject({filename:'report.txt',sizeBytes:bytes.length,sha256:good.sha256});
    expect(JSON.stringify(result.json)).not.toContain(good.base64);
    expect(f.app.service.artifacts.read(result.json.data.id).bytes).toEqual(bytes);
    for(const bad of [{filename:'../private.txt'},{filename:'bad\r\nheader.txt'},{mimeType:'image/svg+xml'},{mimeType:'image/png'},{sha256:'0'.repeat(64)},{base64:'%%%bad'}])expect((await f.request('artifacts','POST',{...good,...bad})).response.status).toBe(400);
    const listed=await f.request('artifacts');
    expect(listed.json.data.items).toHaveLength(1);
    expect(JSON.stringify(listed.json)).not.toContain(good.base64);
    expect((await f.request(`artifacts/${result.json.data.id}`)).json.data).toMatchObject({id:result.json.data.id});
    expect((await f.request('artifacts/nonexistent')).response.status).toBe(404);
    await f.reopen();
    expect(f.app.service.artifacts.read(result.json.data.id).bytes).toEqual(bytes);
  }finally{await f.close();}
});

test('NFR-015 单附件8MiB以及总量/计数硬配额，不能从任意路径解析附件',async()=>{
  const f=await controlFixture();
  try{
    const bytes=Buffer.from('one'),input={filename:'ok.txt',mimeType:'text/plain',base64:bytes.toString('base64'),sha256:createHash('sha256').update(bytes).digest('hex')};
    expect(()=>f.app.service.artifacts.put({...input,base64:'A'.repeat(12*1024*1024)})).toThrow('INVALID_BASE64');
    expect(()=>f.app.service.artifacts.put({...input,path:'/etc/passwd'} as any)).toThrow('INVALID_ARTIFACT_FIELDS');
    const first=f.app.service.artifacts.put(input);
    f.app.service.store.put('artifacts',first.id,{...first,sizeBytes:100*1024*1024,base64:input.base64});
    expect(()=>f.app.service.artifacts.put(input)).toThrow('ARTIFACT_QUOTA_EXCEEDED');
  }finally{await f.close();}
});
