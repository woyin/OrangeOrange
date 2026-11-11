import {expect,test,vi} from 'vitest';
import {controlFixture} from './control-fixture.js';

test('SYS-005 readiness probes database while liveness remains independent',async()=>{
 const f=await controlFixture();
 try{
  expect((await fetch(f.app.url+'/health/ready')).status).toBe(200);
  const probe=vi.spyOn(f.app.service.store.db,'prepare').mockImplementation(()=>{throw new Error('database unavailable');});
  try{
   expect((await fetch(f.app.url+'/health/ready')).status).toBe(503);
   expect((await fetch(f.app.url+'/health/live')).status).toBe(200);
  }finally{probe.mockRestore();}
  expect((await fetch(f.app.url+'/health/ready')).status).toBe(200);
  f.app.service.adapterReady=false;
  expect((await fetch(f.app.url+'/health/ready')).status).toBe(503);
  expect((await fetch(f.app.url+'/health/live')).status).toBe(200);
 }finally{await f.close();}
});
