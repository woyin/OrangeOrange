import { test, expect } from 'vitest';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { controlFixture } from './control-fixture.js';

test('AT-011 真实Pi工具预算为零时在executor前拒绝且终止任务', async () => {
    const f = await controlFixture();
    try {
        await f.setup();
        f.faux.setResponses([fauxAssistantMessage(fauxToolCall('current_time', {}), { stopReason: 'toolUse' }), fauxAssistantMessage('done')]);
        const c = await f.app.service.conversation({ name: 'tool-budget' });
        const t = f.app.service.createTask(c.id, 'time', 'web', 'tool-budget', { budget: { maxTokens: 32768, maxOutputTokens: 4096, maxTools: 0, maxTurns: 8, maxDurationMs: 300000, maxCost: 1 } });
        await f.until(() => f.app.service.get('tasks', t.id).status === 'FAILED');
        expect(f.app.service.get('tasks', t.id).usage.toolCalls).toBe(0);
        expect(f.app.service.list('operations')).toHaveLength(0);
        expect(f.faux.state.callCount).toBe(1);
    } finally { await f.close(); }
});

test('真实RUNNING任务pause/resume保留执行并阻止暂停期间后续模型步骤', async () => {
    const f = await controlFixture();
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    try {
        await f.setup();
        f.faux.setResponses([async () => { await gate; return fauxAssistantMessage(fauxToolCall('current_time', {}), { stopReason: 'toolUse' }); }, fauxAssistantMessage('resumed')]);
        const c = await f.app.service.conversation({ name: 'pause' });
        const t = f.app.service.createTask(c.id, 'time');
        await f.until(() => f.faux.state.callCount === 1);
        const paused = await f.request(`tasks/${t.id}/actions`, 'POST', { action: 'pause' });
        expect(paused.response.status).toBe(200);
        expect(paused.json.data.status).toBe('PAUSED');
        release();
        await new Promise(r => setTimeout(r, 100));
        await f.app.service.tick();
        expect(f.faux.state.callCount).toBe(1);
        expect((await f.request(`tasks/${t.id}/actions`, 'POST', { action: 'resume' })).response.status).toBe(200);
        await f.until(() => f.app.service.get('tasks', t.id).status === 'SUCCEEDED');
        expect(f.app.service.get('tasks', t.id).result).toBe('resumed');
    } finally { release(); await f.close(); }
});

test('真实RUNNING任务cancel后不执行新工具或模型步骤', async () => {
    const f = await controlFixture();
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    try {
        await f.setup();
        f.faux.setResponses([async () => { await gate; return fauxAssistantMessage(fauxToolCall('current_time', {}), { stopReason: 'toolUse' }); }, fauxAssistantMessage('must not run')]);
        const c = await f.app.service.conversation({ name: 'cancel' });
        const t = f.app.service.createTask(c.id, 'time');
        await f.until(() => f.faux.state.callCount === 1);
        const cancelled = f.request(`tasks/${t.id}/actions`, 'POST', { action: 'cancel' });
        await new Promise(r => setTimeout(r, 30));
        release();
        expect((await cancelled).response.status).toBe(200);
        await new Promise(r => setTimeout(r, 100));
        await f.app.service.tick();
        expect(f.app.service.get('tasks', t.id).status).toBe('CANCELLED');
        expect(f.app.service.list('operations')).toHaveLength(0);
        expect(f.faux.state.callCount).toBe(1);
    } finally { release(); await f.close(); }
});

test('AT-013 owner/Telegram真实memory_search隔离，删除后工具不召回', async () => {
    const f = await controlFixture();
    const seen: string[] = [];
    try {
        await f.setup();
        const secret = f.app.service.memory({ kind: 'semantic', scope: 'owner', content: 'probe UniqueOwnerSecret', source: 'owner' });
        f.app.service.memory({ kind: 'semantic', scope: 'telegram:bot:123', content: 'probe UniqueTelegramSecret', source: 'owner' });
        const responses = () => [fauxAssistantMessage(fauxToolCall('memory_search', { query: 'probe' }), { stopReason: 'toolUse' }), (context: any) => { seen.push(JSON.stringify(context)); return fauxAssistantMessage('searched'); }];
        f.faux.setResponses(responses());
        const c = await f.app.service.conversation({ name: 'owner-memory' });
        const first = f.app.service.createTask(c.id, 'search memory');
        await f.until(() => f.app.service.get('tasks', first.id).status === 'SUCCEEDED');
        expect(seen[0]).toContain('UniqueOwnerSecret');
        expect(seen[0]).not.toContain('UniqueTelegramSecret');
        const channel = f.app.service.channel({ name: 'tg', type: 'telegram', allowedUsers: ['123'], enabled: false });
        f.faux.setResponses(responses());
        const tg = await f.app.service.inbound(channel.id, { platform: 'telegram', account: 'bot', user: '123', chat: '123', id: 'memory-search', text: 'search memory', timestamp: Date.now() });
        await f.until(() => f.app.service.get('tasks', tg!.id).status === 'SUCCEEDED');
        expect(seen[1]).toContain('UniqueTelegramSecret');
        expect(seen[1]).not.toContain('UniqueOwnerSecret');
        expect((await f.request(`memories/${secret.id}`, 'DELETE')).response.status).toBe(200);
        f.faux.setResponses(responses());
        const fresh = await f.app.service.conversation({ name: 'after-delete' });
        const last = f.app.service.createTask(fresh.id, 'search memory');
        await f.until(() => f.app.service.get('tasks', last.id).status === 'SUCCEEDED');
        expect(seen[2]).not.toContain('UniqueOwnerSecret');
    } finally { await f.close(); }
});

test.each(['429', '503', 'timeout'])('AT-012 模型%s最多重试两次并终止', async error => {
    const f = await controlFixture();
    try {
        await f.setup();
        f.faux.setResponses(Array.from({ length: 4 }, () => fauxAssistantMessage('', { stopReason: 'error', errorMessage: error })));
        const c = await f.app.service.conversation({ name: 'retry' });
        const t = f.app.service.createTask(c.id, 'retry', 'web', 'retry', { budget: { maxTokens: 262144, maxOutputTokens: 4096, maxTools: 20, maxTurns: 8, maxDurationMs: 300000, maxCost: 1 } });
        await f.until(() => ['FAILED', 'SUCCEEDED'].includes(f.app.service.get('tasks', t.id).status), 8000);
        expect(f.app.service.get('tasks', t.id), JSON.stringify(await f.app.service.adapter.dispatch('input.get', { id: f.app.service.get('tasks', t.id).piSubmissionId }))).toMatchObject({ status: 'FAILED', attempt: 2 });
        expect(f.faux.state.callCount).toBe(3);
    } finally { await f.close(); }
});

test('AT-022 真实工具审批重开仍等待，篡改哈希拒绝且不产生写入', async () => {
    const f = await controlFixture();
    try {
        await f.setup();
        const descriptor = f.app.service.get('tools', 'memory_save');
        f.app.service.policy.register({ ...descriptor, sideEffect: 'non_idempotent_write', idempotent: false } as any);
        f.faux.setResponses([fauxAssistantMessage(fauxToolCall('memory_save', { content: 'ApprovedMemory', id: 'approved' }), { stopReason: 'toolUse' }), fauxAssistantMessage('saved')]);
        const c = await f.app.service.conversation({ name: 'approval-recovery' });
        const t = f.app.service.createTask(c.id, 'remember');
        await f.until(() => f.app.service.get('tasks', t.id).status === 'WAITING_APPROVAL');
        const approval = f.app.service.list('approvals')[0]!;
        expect(f.app.service.list('memories')).toHaveLength(0);
        await f.reopen();
        expect(f.app.service.get('tasks', t.id).status).toBe('WAITING_APPROVAL');
        expect((await f.request(`approvals/${approval.id}/decisions`, 'POST', { decision: 'APPROVED', operationHash: 'tampered' })).response.status).toBe(409);
        await f.app.service.tick();
        expect(f.app.service.list('memories')).toHaveLength(0);
        expect(f.app.service.get('approvals', approval.id).status).toBe('PENDING');
        expect((await f.request(`approvals/${approval.id}/decisions`, 'POST', { decision: 'APPROVED', operationHash: approval.operationHash })).response.status).toBe(200);
        await f.until(() => f.app.service.get('tasks', t.id).status === 'SUCCEEDED');
        expect(f.app.service.list('memories')).toEqual([expect.objectContaining({ content: 'ApprovedMemory' })]);
    } finally { await f.close(); }
});

test('AT-011 模型预算不足在真实provider调用前终止', async () => {
    const f = await controlFixture();
    try {
        await f.setup();
        const c = await f.app.service.conversation({ name: 'model-budget' });
        const t = f.app.service.createTask(c.id, 'no budget', 'web', 'model-budget', { budget: { maxTokens: 1, maxOutputTokens: 1, maxTools: 20, maxTurns: 8, maxDurationMs: 300000, maxCost: 1 } });
        await f.until(() => f.app.service.get('tasks', t.id).status === 'FAILED');
        expect(f.faux.state.callCount).toBe(0);
        expect(f.app.service.get('tasks', t.id).error).toBe('BUDGET_EXHAUSTED');
    } finally { await f.close(); }
});

test('任务总时限到期后不允许模型结果产生新工具步骤', async () => {
    const f = await controlFixture();
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    try {
        await f.setup();
        f.faux.setResponses([async () => { await gate; return fauxAssistantMessage(fauxToolCall('current_time', {}), { stopReason: 'toolUse' }); }, fauxAssistantMessage('must not run')]);
        const c = await f.app.service.conversation({ name: 'timeout' });
        const t = f.app.service.createTask(c.id, 'time', 'web', 'duration', { budget: { maxTokens: 32768, maxOutputTokens: 4096, maxTools: 20, maxTurns: 8, maxDurationMs: 80, maxCost: 1 } });
        await f.until(() => f.faux.state.callCount === 1);
        await new Promise(r => setTimeout(r, 90));
        const tick = f.app.service.tick();
        await new Promise(r => setTimeout(r, 20));
        release();
        await tick;
        await f.until(() => f.app.service.get('tasks', t.id).status === 'FAILED');
        expect(f.faux.state.callCount).toBe(1);
        expect(f.app.service.list('operations')).toHaveLength(0);
    } finally { release(); await f.close(); }
});

test('已确认写入后模型503不切换provider或重放工具', async () => {
    const f = await controlFixture();
    try {
        await f.setup();
        f.faux.setResponses([fauxAssistantMessage(fauxToolCall('memory_save', { content: 'one effect', id: 'one' }), { stopReason: 'toolUse' }), ...Array.from({ length: 10 }, () => fauxAssistantMessage('', { stopReason: 'error', errorMessage: '503' }))]);
        const c = await f.app.service.conversation({ name: 'unsafe-retry' });
        const t = f.app.service.createTask(c.id, 'remember');
        await f.until(() => f.app.service.get('tasks', t.id).status === 'FAILED');
        expect(f.app.service.get('tasks', t.id).attempt).toBe(0);
        expect(f.app.service.list('memories')).toHaveLength(1);
        expect(f.app.service.list('operations')).toEqual([expect.objectContaining({ state: 'CONFIRMED', risk: 'idempotent_write' })]);
    } finally { await f.close(); }
});

test('PAUSED任务重开不发送模型，resume保留原submission且仅执行一次工具', async () => {
    const f = await controlFixture();
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    try {
        await f.setup();
        f.faux.setResponses([async () => { await gate; return fauxAssistantMessage(fauxToolCall('current_time', {}), { stopReason: 'toolUse' }); }, fauxAssistantMessage('resumed after reopen')]);
        const c = await f.app.service.conversation({ name: 'pause-reopen' });
        const t = f.app.service.createTask(c.id, 'time');
        await f.until(() => f.faux.state.callCount === 1);
        const submitted = f.app.service.get('tasks', t.id).piSubmissionId;
        expect(submitted).toBeDefined();
        expect((await f.request(`tasks/${t.id}/actions`, 'POST', { action: 'pause' })).response.status).toBe(200);
        release();
        await new Promise(r => setTimeout(r, 60));
        await f.reopen();
        await f.app.service.tick();
        await new Promise(r => setTimeout(r, 60));
        expect(f.app.service.get('tasks', t.id)).toMatchObject({ status: 'PAUSED', piSubmissionId: submitted });
        expect(f.faux.state.callCount).toBe(1);
        expect(f.app.service.list('operations')).toHaveLength(0);
        expect((await f.request(`tasks/${t.id}/actions`, 'POST', { action: 'resume' })).response.status).toBe(200);
        await f.until(() => f.app.service.get('tasks', t.id).status === 'SUCCEEDED');
        expect(f.app.service.get('tasks', t.id)).toMatchObject({ piSubmissionId: submitted, result: 'resumed after reopen' });
        expect(f.faux.state.callCount).toBe(2);
        expect(f.app.service.list('operations')).toEqual([expect.objectContaining({ state: 'CONFIRMED' })]);
    } finally { release(); await f.close(); }
});
