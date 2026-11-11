import { test, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { controlFixture } from './control-fixture.js';

test('AT-017 OpenAPI每个受保护method/path未登录均拒绝，包含SSE', async () => {
    const f = await controlFixture();
    try {
        await f.setup();
        const spec = JSON.parse(await readFile(new URL('../docs/openapi.json', import.meta.url), 'utf8'));
        const tested: string[] = [];
        for (const [path, operations] of Object.entries(spec.paths)) for (const method of Object.keys(operations as object)) {
            if (!['get', 'post', 'patch', 'put', 'delete'].includes(method) || ['/setup', '/setup/status', '/auth/login'].includes(path) || (operations as Record<string, any>)[method]?.security?.length === 0) continue;
            const route = path.replace(/\{[^}]+\}/g, 'missing').slice(1);
            const r = await f.request(route, method.toUpperCase(), method === 'get' ? undefined : {}, { Cookie: '' });
            expect([401, 403], `${method} ${path}`).toContain(r.response.status);
            expect(r.json.data).toBeUndefined();
            tested.push(`${method} ${path}`);
        }
        expect(tested.length).toBeGreaterThan(30);
        expect(tested).toContain('get /events/stream');
    } finally { await f.close(); }
});

test('写路由在CSRF/Origin失败时不落库，同幂等键跨路由冲突且重开后保留', async () => {
    const f = await controlFixture();
    try {
        await f.setup();
        for (const [path, body] of [['conversations', { name: 'unsafe' }], ['settings', { language: 'unsafe' }]] as const) {
            const method = path === 'settings' ? 'PATCH' : 'POST';
            for (const headers of ([{ 'X-CSRF-Token': '' }, { Origin: 'https://evil.example' }, { Origin: '' }] as Record<string, string>[])) expect((await f.request(path, method, body, headers)).response.status).toBe(403);
        }
        expect(f.app.service.list('conversations')).toHaveLength(0);
        expect((await f.request('settings')).json.data.language).not.toBe('unsafe');
        const key = randomUUID();
        expect((await f.request('conversations', 'POST', { name: 'safe' }, { 'Idempotency-Key': key })).response.status).toBe(200);
        await f.reopen();
        expect((await f.request('settings', 'PATCH', { language: 'unsafe' }, { 'Idempotency-Key': key })).response.status).toBe(409);
        expect((await f.request('settings')).json.data.language).not.toBe('unsafe');
    } finally { await f.close(); }
});
