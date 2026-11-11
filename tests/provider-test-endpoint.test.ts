import {test,expect} from 'vitest';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {controlFixture} from './control-fixture.js';

test('provider connection test probes the configured endpoint, not api.openai.com',async()=>{
 const seen:{url?:string;authorization?:string}[]=[];let reply=200;
 const server=createServer((req,res)=>{seen.push({url:req.url,authorization:req.headers.authorization});res.writeHead(reply,{'Content-Type':'application/json'});res.end(JSON.stringify({data:[{id:'vendor/model'}]}));});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const port=(server.address() as {port:number}).port,key=randomUUID(),f=await controlFixture();
 try{
  await f.setup();
  const created=await f.request('providers','POST',{vendor:'openai',model:'vendor/model',baseUrl:`http://127.0.0.1:${port}/v1`,apiKey:key});
  expect(created.response.status).toBe(200);
  const id=created.json.data.id;
  const ok=await f.request(`providers/${id}/test`,'POST',{});
  expect(ok.response.status).toBe(200);expect(ok.json.data.status).toBe('online');
  expect(seen).toHaveLength(1);expect(seen[0]!.url).toBe('/v1/models');expect(seen[0]!.authorization).toBe('Bearer '+key);
  reply=401;
  const denied=await f.request(`providers/${id}/test`,'POST',{});
  expect(denied.json.data.status).toBe('invalid_credentials');
  expect(seen[1]!.url).toBe('/v1/models');
 }finally{await f.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
