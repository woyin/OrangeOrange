import { test, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { startControlServer } from '../src/control/server.js';

test('维护接口必须认证且脱敏，定时清理保留入站墓碑并拒绝重新执行', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hda-maint-http-'));
    const models = createModels(); models.setProvider(fauxProvider().provider);
    const app = await startControlServer({ dataDir: join(dir, 'data'), workspace: join(dir, 'workspace'), port: 0, runtimeOptions: { models, provider: 'faux' }, tickMs: 60000 });
    let cookie = '', csrf = '';
    const request = async (path: string, method = 'GET', body?: unknown) => {
        const response = await fetch(app.url + '/api/v1/' + path, { method, headers: { Origin: app.url, Cookie: cookie, 'X-CSRF-Token': csrf, 'Idempotency-Key': randomUUID(), 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        return { response, json: await response.json() };
    };
    try {
        for (const path of ['system/metrics', 'system/diagnostics', 'config/export', 'system/logs']) expect((await request(path)).response.status).toBe(401);
        const init = await request('setup', 'POST', { username: 'owner', password: 'maintenance-test-password-5678', timezone: 'UTC' });
        expect(init.response.status).toBe(200);
        cookie = init.response.headers.get('set-cookie')!.split(';')[0]!; csrf = init.json.data.csrf;
        const marker = 'secret-body-marker-do-not-export';
        app.service.store.setSetting('config', { systemPrompt: marker, retentionDays: 1 });
        app.service.store.setSecret('test-key', marker);
        for (const path of ['system/metrics', 'system/diagnostics', 'config/export', 'system/logs']) {
            const result = await request(path);
            expect(result.response.status).toBe(200);
            expect(JSON.stringify(result.json)).not.toContain(marker);
        }
        expect((await request('system/metrics')).json.data.rss).toBeGreaterThan(0);
        for (const days of [0, 0.5, 3651]) expect((await request('settings', 'PATCH', { retentionDays: days })).response.status).toBe(400);
        const c = await app.service.conversation({ name: 'retention' });
        const task = app.service.createTask(c.id, 'old', 'web', 'stable-inbox');
        app.service.change(task, 'FAILED');
        app.service.store.put('tasks', task.id, { ...app.service.get('tasks', task.id), updatedAt: 0 });
        app.service.store.setSetting('lastCleanup', 0);
        await app.service.tick();
        expect(app.service.store.get('tasks', task.id)).toBeUndefined();
        expect(() => app.service.createTask(c.id, 'old', 'web', 'stable-inbox')).toThrow('TASK_HISTORY_EXPIRED');
        expect(app.service.list('tasks')).toHaveLength(0);
    } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
});
