import {expect,test} from 'vitest';
import {controlFixture,CONTROL_TEST_PASSWORD} from './control-fixture.js';

test('SYS-002 short setup password has a specific error and leaves initialization retryable',async()=>{
 const f=await controlFixture();
 try{
  const r=await f.request('setup','POST',{username:'owner',password:'too-short',timezone:'UTC'});
  expect(r.response.status).toBe(400);expect(r.json.error.code).toBe('WEAK_PASSWORD');
  expect(f.app.service.store.setting('initialized',false)).toBe(false);expect(f.app.service.store.list('users')).toHaveLength(0);
  await f.setup();expect(f.app.service.store.list('users')).toHaveLength(1);
 }finally{await f.close();}
});


test('SYS-002 invalid optional configuration rolls back setup and allows retry',async()=>{
 const f=await controlFixture();
 try{
  const base={username:'owner',password:CONTROL_TEST_PASSWORD,timezone:'UTC'};
  for(const optional of [{provider:{vendor:'unsupported',model:'test',apiKey:'secret'}},{provider:{vendor:'openai',model:'test',apiKey:'secret'},telegram:{token:'token',allowedUsers:['bad-id']}}]){
   const r=await f.request('setup','POST',{...base,...optional});expect(r.response.status).toBe(400);
   expect(f.app.service.store.setting('initialized',false)).toBe(false);
   expect(f.app.service.store.list('users')).toHaveLength(0);expect(f.app.service.store.list('providers')).toHaveLength(0);expect(f.app.service.store.list('channels')).toHaveLength(0);
  }
  await f.setup();expect(f.app.service.store.list('users')).toHaveLength(1);
 }finally{await f.close();}
});
