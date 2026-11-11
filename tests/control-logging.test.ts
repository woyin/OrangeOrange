import {expect,test,vi} from 'vitest';
import {log,redact,describeError} from '../src/control/log.js';
import {controlFixture} from './control-fixture.js';

test('log records are JSON lines and redact secrets',()=>{
 const lines:string[]=[];
 log('error','task.submit_failed',{taskId:'t1',apiKey:'sk-live-secret',token:'bot-token','error':'boom'},(line)=>lines.push(line));
 const record=JSON.parse(lines[0]!);
 expect(record.event).toBe('task.submit_failed');expect(record.level).toBe('error');expect(record.taskId).toBe('t1');
 expect(JSON.stringify(record)).not.toContain('sk-live-secret');expect(JSON.stringify(record)).not.toContain('bot-token');
 expect(redact({nested:{password:'p'}})).toEqual({nested:{password:'已隐藏'}});
 expect(describeError(new Error('x')).length).toBeGreaterThan(0);
});

test('submit failure keeps the cause in the log while the task records its code',async()=>{
 const lines:string[]=[],spy=vi.spyOn(console,'error').mockImplementation((line)=>{lines.push(String(line));});
 const f=await controlFixture();
 try{
  await f.setup();
  const conversation=await f.request('conversations','POST',{name:'logging'});
  const dispatch=f.app.service.adapter.dispatch.bind(f.app.service.adapter);
  f.app.service.adapter.dispatch=(async(method:string,params:Record<string,unknown>)=>{if(method==='input.submit')throw new Error('upstream refused with apiKey sk-should-not-leak');return dispatch(method,params);}) as typeof f.app.service.adapter.dispatch;
  await f.request(`conversations/${conversation.json.data.id}/messages`,'POST',{content:'hello'});
  for(let i=0;i<40 && !f.app.service.list('tasks').some(t=>t.status==='FAILED');i++)await f.app.service.tick();
  const record=lines.map(l=>JSON.parse(l)).find(r=>r.event==='task.submit_failed');
  expect(record).toBeTruthy();expect(record.error).toContain('upstream refused');expect(record.taskId).toBeTruthy();
  expect(lines.join('\n')).not.toContain('sk-should-not-leak');
  expect(f.app.service.list('tasks')[0]!.error).toBe('SUBMISSION_FAILED');
 }finally{spy.mockRestore();await f.close();}
});
