import { test, expect } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider, fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
import { startControlServer } from '../src/control/server.js';
async function fixture(fetcher?:typeof fetch) { const dir = await mkdtemp(join(tmpdir(), 'hda-api-')); const models = createModels(); const faux = fauxProvider(); models.setProvider(faux.provider); let free = 1e9; const options = { dataDir: join(dir, 'data'), workspace: join(dir, 'workspace'), port: 0, runtimeOptions: { models, provider: 'faux' }, diskProbe: async () => free, tickMs: 10000,fetcher }; let app = await startControlServer(options); let cookie = ''; let csrf = ''; async function request(path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) { const response = await fetch(app.url + '/api/v1/' + path, { method, headers: { Origin: app.url, Cookie: cookie, 'X-CSRF-Token': csrf, 'Idempotency-Key': randomUUID(), 'Content-Type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); const json = await response.json(); return { response, json }; } return { dir, faux, get app() { return app; }, request, setFree(n: number) { free = n; }, async setup() { const r = await request('setup', 'POST', { username: 'owner', password: 'long-safe-password', timezone: 'UTC' }); expect(r.response.status).toBe(200); cookie = r.response.headers.get('set-cookie')!.split(';')[0]!; csrf = r.json.data.csrf; }, async reopen() { await app.close(); app = await startControlServer(options); }, async close() { await app.close(); await rm(dir, { recursive: true, force: true }); } }; }
test('Owner初始化、持久cookie会话、CSRF/Origin与秘密API边界', async () => { const f = await fixture(); try {
    expect((await f.request('tasks')).response.status).toBe(401);
    expect((await f.request('events/stream')).response.status).toBe(401);
    await f.setup();
    expect((await f.request('conversations', 'POST', { name: '会话' }, { 'X-CSRF-Token': 'bad' })).response.status).toBe(403);
    expect((await f.request('conversations', 'POST', { name: '会话' }, { Origin: 'https://evil.example' })).response.status).toBe(403);
    expect((await f.request('conversations', 'POST', { name: '会话', workspace: '/data' })).response.status).toBe(400);
    await f.reopen();
    expect((await f.request('auth/session')).json.data.username).toBe('owner');
    expect((await f.request('setup', 'POST', { username: 'x', password: 'long-safe-password', timezone: 'UTC' })).response.status).toBe(400);
}
finally {
    await f.close();
} });
test('幂等同键同body重放且冲突409，队列100与暂停状态真实持久化', async () => { const f = await fixture(); try {
    await f.setup();
    const key = randomUUID();
    const a = await f.request('conversations', 'POST', { name: 'A' }, { 'Idempotency-Key': key });
    const b = await f.request('conversations', 'POST', { name: 'A' }, { 'Idempotency-Key': key });
    expect(b.json.data.id).toBe(a.json.data.id);
    expect((await f.request('conversations', 'POST', { name: 'B' }, { 'Idempotency-Key': key })).response.status).toBe(409);
    const id = a.json.data.id;
    const t = await f.request(`conversations/${id}/messages`, 'POST', { content: 'test' });
    expect(t.json.data.status).toBe('QUEUED');
    expect((await f.request(`tasks/${t.json.data.id}/actions`, 'POST', { action: 'pause' })).json.data.status).toBe('PAUSED');
    expect((await f.request(`tasks/${t.json.data.id}/actions`, 'POST', { action: 'resume' })).json.data.status).toBe('QUEUED');
    for (let i = 1; i < 100; i++)
        f.app.service.createTask(id, 'queue');
    expect(() => f.app.service.createTask(id, 'overflow')).toThrow('QUEUE_FULL');
    await f.reopen();
    expect(f.app.service.list('tasks')).toHaveLength(100);
}
finally {
    await f.close();
} });
test('磁盘低水位拒绝业务写，仍可登录及读取诊断', async () => { const f = await fixture(); try {
    await f.setup();
    f.setFree(0);
    await f.app.service.probeDisk();
    expect((await f.request('conversations', 'POST', { name: 'blocked' })).response.status).toBe(503);
    expect((await f.request('system/summary')).json.data.diskLow).toBe(true);
    expect((await f.request('auth/login', 'POST', { username: 'owner', password: 'long-safe-password' })).response.status).toBe(200);
}
finally {
    await f.close();
} });
test('Cron preview5、DST、Heartbeat绑定、Memory修订与禁用召回', async () => { const f = await fixture(); try {
    await f.setup();
    const preview = await f.request('schedules/preview?expression=30%202%20*%20*%20*&timezone=America%2FNew_York');
    expect(preview.json.data.items).toHaveLength(5);
    const schedule = await f.request('schedules', 'POST', { name: 'daily', expression: '30 8 * * *', timezone: 'Asia/Shanghai', prompt: 'report', misfirePolicy: 'coalesce', overlapPolicy: 'queue_one' });
    expect(schedule.json.data.conversationId).toBeTruthy();
    const heartbeat = await f.request('heartbeats', 'POST', { conversationId: schedule.json.data.conversationId, intervalSeconds: 10, prompt: 'check', onlyOnChange: true });
    expect(heartbeat.response.status).toBe(200);
    const m = await f.request('memories', 'POST', { kind: 'semantic', scope: 'owner', content: 'apples preference', source: 'owner', confidence: 1 });
    expect(m.response.status).toBe(200);
    expect((await f.request('memories?q=apples&scope=owner')).json.data.items).toHaveLength(1);
    await f.request(`memories/${m.json.data.id}`, 'PATCH', { status: 'blocked' });
    expect((await f.request('memories?q=apples&scope=owner')).json.data.items).toHaveLength(0);
    expect((await f.request(`memories/${m.json.data.id}/revisions`)).json.data.items).toHaveLength(2);
}
finally {
    await f.close();
} });
test('审批哈希绑定、非幂等receipt重放与崩溃SENDING转UNCERTAIN', async () => { const f = await fixture(); try {
    await f.setup();
    const c = await f.app.service.conversation({ name: 'ops' });
    let t = f.app.service.createTask(c.id, 'send');
    t = f.app.service.change(t, 'RUNNING');
    f.app.store.put('tasks', t.id, { ...t, startedAt: Date.now() });
    f.app.service.policy.register({ name: 'external_send', version: '1', inputSchema: {}, sideEffect: 'non_idempotent_write', permission: 'external.send', timeoutMs: 1000, idempotent: false, executor: 'test', enabled: true });
    const call = { name: 'external_send', args: { recipient: 'x' }, scope: 'owner', conversationId: c.piConversationId, taskId: 1, requestIds: [t.id], callId: 'stable' };
    const approval = f.app.service.policy.requestApproval({ name: call.name, args: call.args, taskId: t.id, principalId: 'owner' });
    expect((await f.request(`approvals/${approval.id}/decisions`, 'POST', { decision: 'APPROVED', operationHash: 'changed' })).response.status).toBe(409);
    expect((await f.request(`approvals/${approval.id}/decisions`, 'POST', { decision: 'APPROVED', operationHash: approval.operationHash })).response.status).toBe(200);
    let effects = 0;
    const execute = async () => ({ receipt: ++effects });
    expect(await f.app.service.tool(call, execute)).toEqual({ receipt: 1 });
    expect(await f.app.service.tool(call, execute)).toEqual({ receipt: 1 });
    expect(effects).toBe(1);
    const op = f.app.service.list('operations')[0]!;
    f.app.store.put('operations', op.id, { ...op, state: 'SENDING' });
    await f.reopen();
    expect(f.app.service.get('operations', op.id).state).toBe('UNCERTAIN');
    await expect(f.app.service.tool(call, execute)).rejects.toThrow('OPERATION_UNCERTAIN');
    expect(effects).toBe(1);
}
finally {
    await f.close();
} });
test('Telegram allowlist与十次update去重及出站不确定恢复', async () => { const f = await fixture(); try {
    await f.setup();
    const c = f.app.service.channel({ name: 'test', type: 'telegram', allowedUsers: ['123'], enabled: false });
    const message = { platform: 'telegram' as const, account: 'bot', user: '123', chat: '123', id: 'one', text: 'hello', timestamp: Date.now() };
    expect(await f.app.service.inbound(c.id, { ...message, user: '999' })).toBeUndefined();
    for (let i = 0; i < 10; i++)
        await f.app.service.inbound(c.id, message);
    expect(f.app.service.list('tasks')).toHaveLength(1);
    f.app.store.put('outbox', 'delivery', { id: 'delivery', dedupe_key: 'delivery', channelId: c.id, state: 'SENDING' });
    await f.reopen();
    expect(f.app.service.get('outbox', 'delivery').state).toBe('DELIVERY_UNCERTAIN');
}
finally {
    await f.close();
} });
test('在线双库备份/恢复要求确认和再认证，并保留回滚快照', async () => { const f = await fixture(); try {
    await f.setup();
    const c = await f.app.service.conversation({ name: 'before' });
    expect((await f.request('backup', 'POST', { confirm: false, password: 'long-safe-password' })).response.status).toBe(400);
    expect((await f.request('backup', 'POST', { confirm: true, password: 'wrong' })).response.status).toBe(403);
    const snapshot = await f.request('backup', 'POST', { confirm: true, password: 'long-safe-password' });
    expect(snapshot.response.status).toBe(200);
    await f.request(`conversations/${c.id}`, 'PATCH', { name: 'after' });
    const restored = await f.request('restore', 'POST', { confirm: true, password: 'long-safe-password', backupId: snapshot.json.data.id });
    expect(restored.response.status).toBe(200);
    expect(f.app.service.get('conversations', c.id).name).toBe('before');
    expect(restored.json.data.rollbackId).toBeTruthy();
}
finally {
    await f.close();
} });
test('真实faux任务完成、预算发送前预留、SSE断线cursor补偿', async () => { const f = await fixture(); try {
    await f.setup();
    f.faux.setResponses([fauxAssistantMessage('真实回答')]);
    const c = await f.app.service.conversation({ name: 'live' });
    const t = f.app.service.createTask(c.id, 'hello');
    await f.app.service.tick();
    for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 20));
        await f.app.service.tick();
        if (['SUCCEEDED', 'FAILED'].includes(f.app.service.get('tasks', t.id).status))
            break;
    }
    const result = f.app.service.get('tasks', t.id);
    expect(result.status).toBe('SUCCEEDED');
    expect(result.result).toBe('真实回答');
    expect(result.usage.reservedTokens).toBeGreaterThan(0);
    expect(f.faux.state.callCount).toBe(1);
    const events = f.app.store.events();
    expect(events.length).toBeGreaterThan(0);
    const cursor = events[0]!.event_id;
    const ctrl = new AbortController();
    const session = f.app.store.list<any>('sessions')[0];
    const login = await f.request('auth/login', 'POST', { username: 'owner', password: 'long-safe-password' });
    const cookie = login.response.headers.get('set-cookie')!.split(';')[0]!;
    const response = await fetch(`${f.app.url}/api/v1/events/stream?cursor=${cursor}`, { headers: { Cookie: cookie }, signal: ctrl.signal });
    const read = await response.body!.getReader().read();
    const text = new TextDecoder().decode(read.value);
    expect(text).toContain('event: message');
    expect(text).not.toContain('真实回答');
    ctrl.abort();
}
finally {
    await f.close();
} });

test('并发最多2且同会话串行，预算不足在provider发送前拒绝',async()=>{const f=await fixture();let release!:()=>void;const gate=new Promise<void>(r=>{release=r});try{await f.setup();f.faux.setResponses([async()=>{await gate;return fauxAssistantMessage('one')},async()=>{await gate;return fauxAssistantMessage('two')},fauxAssistantMessage('three')]);const a=await f.app.service.conversation({name:'a'});const b=await f.app.service.conversation({name:'b'});const c=await f.app.service.conversation({name:'c'});f.app.service.createTask(a.id,'first');const serial=f.app.service.createTask(a.id,'serial');f.app.service.createTask(b.id,'second');f.app.service.createTask(c.id,'third');await f.app.service.tick();expect(f.app.service.summary().runningTasks).toBe(2);expect(f.app.service.get('tasks',serial.id).status).toBe('QUEUED');release();for(let i=0;i<30;i++){await new Promise(r=>setTimeout(r,20));await f.app.service.tick();if(!f.app.service.summary().runningTasks&&!f.app.service.summary().queueDepth)break;}const calls=f.faux.state.callCount;const budget=f.app.service.createTask(c.id,'budget','web',randomUUID(),{budget:{maxTokens:1,maxCost:0}});await f.app.service.tick();await new Promise(r=>setTimeout(r,30));await f.app.service.tick();expect(f.app.service.get('tasks',budget.id).status).toBe('FAILED');expect(f.faux.state.callCount).toBe(calls);}finally{release();await f.close();}});
test('Heartbeat忙时合并一次，Cron queue_one与misfire skip跨重开保持',async()=>{const f=await fixture();try{await f.setup();const s=await f.app.service.schedule({name:'cron',expression:'* * * * *',timezone:'UTC',prompt:'run',overlapPolicy:'queue_one',misfirePolicy:'skip'});const busy=f.app.service.createTask(s.conversationId,'busy','web',randomUUID(),{scheduleId:s.id});f.app.service.change(busy,'RUNNING');const h=f.app.service.heartbeat({conversationId:s.conversationId,intervalSeconds:10,prompt:'pulse'});f.app.store.put('heartbeats',h.id,{...h,nextFireAt:Date.now()-100});f.app.store.put('schedules',s.id,{...s,nextFireAt:Date.now()-120000});await f.app.service.tick();await f.app.service.tick();expect(f.app.service.get('heartbeats',h.id).pending).toBe(true);expect(f.app.service.get('schedules',s.id).pending).toBe(true);expect(f.app.service.list('tasks')).toHaveLength(1);f.app.service.change(f.app.service.get('tasks',busy.id),'CANCELLED');await f.app.service.tick();expect(f.app.service.list('tasks').filter(t=>t.heartbeatId===h.id)).toHaveLength(0);for(const task of f.app.service.list('tasks').filter(t=>t.scheduleId===s.id&&!['CANCELLED','FAILED','SUCCEEDED'].includes(t.status)))await f.app.service.taskAction(task.id,'cancel');await f.app.service.tick();expect(f.app.service.list('tasks').filter(t=>t.heartbeatId===h.id)).toHaveLength(1);expect(f.app.service.get('heartbeats',h.id).pending).toBe(false);}finally{await f.close();}});
test('SSE保留窗口过期明确reset，清理不删除不确定operation',async()=>{const f=await fixture();try{await f.setup();const c=await f.app.service.conversation({name:'cleanup'});const task=f.app.service.createTask(c.id,'old');const failed=f.app.service.change(f.app.service.change(task,'RUNNING'),'FAILED');f.app.store.put('tasks',task.id,{...failed,updatedAt:0});f.app.store.put('operations','uncertain',{id:'uncertain',taskId:task.id,state:'UNCERTAIN'});const old=f.app.store.event('old','old');f.app.store.db.prepare('UPDATE events SET at=0').run();f.app.store.setSetting('lastCleanup',0);await f.app.service.tick();expect(f.app.service.get('tasks',task.id)).toBeDefined();const latest=f.app.store.event('new','new');expect(latest).toBeGreaterThan(old);const login=await f.request('auth/login','POST',{username:'owner',password:'long-safe-password'});const controller=new AbortController();const response=await fetch(`${f.app.url}/api/v1/events/stream?cursor=1`,{headers:{Cookie:login.response.headers.get('set-cookie')!.split(';')[0]!},signal:controller.signal});const read=await response.body!.getReader().read();expect(new TextDecoder().decode(read.value)).toContain('event: reset');controller.abort();}finally{await f.close();}});

test('跨库RUNNING缺少Pi提交引用重开后按稳定requestId对账',async()=>{const f=await fixture();try{await f.setup();f.faux.setResponses([fauxAssistantMessage('恢复成功')]);const c=await f.app.service.conversation({name:'recover'});const t=f.app.service.createTask(c.id,'recover');const running=f.app.service.change(t,'RUNNING');f.app.store.put('tasks',t.id,{...running,startedAt:Date.now()});await f.reopen();for(let i=0;i<30;i++){await new Promise(r=>setTimeout(r,20));await f.app.service.tick();if(f.app.service.get('tasks',t.id).status==='SUCCEEDED')break;}const saved=f.app.service.get('tasks',t.id);expect(saved.status).toBe('SUCCEEDED');expect(f.app.service.list('tasks')).toHaveLength(1);expect((await f.app.service.adapter.dispatch('input.submit',{conversationId:c.piConversationId,requestId:t.id,content:'recover'})).id).toBe(saved.piSubmissionId);}finally{await f.close();}});
test('Telegram发送后响应丢失变DELIVERY_UNCERTAIN且后续tick不重发',async()=>{let sends=0;const fetcher:typeof fetch=async(input)=>{const url=String(input);if(url.endsWith('getUpdates'))return new Response(JSON.stringify({ok:true,result:[]}));if(url.endsWith('sendMessage')){sends++;throw new Error('response lost');}throw new Error('unexpected');};const f=await fixture(fetcher);try{await f.setup();const c=f.app.service.channel({name:'telegram',type:'telegram',token:'123:test',allowedUsers:['123'],enabled:true});f.app.store.put('outbox','lost',{id:'lost',dedupe_key:'lost',channelId:c.id,threadId:'123',content:'sent',state:'PENDING',attempts:0,nextRetryAt:0});await f.app.service.tick();expect(f.app.service.get('outbox','lost').state).toBe('DELIVERY_UNCERTAIN');await f.app.service.tick();expect(sends).toBe(1);}finally{await f.close();}});
