import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { startControlServer, type ServerOptions } from '../src/control/server.js';
export const CONTROL_TEST_PASSWORD = "a-long-test-password";
export async function controlFixture(overrides: Partial<ServerOptions> = {}) {
    const dir = await mkdtemp(join(tmpdir(), 'control-extended-'));
    const models = createModels();
    const faux = fauxProvider();
    models.setProvider(faux.provider);
    const options = { dataDir: join(dir, 'data'), workspace: join(dir, 'workspace'), port: 0, runtimeOptions: { models, provider: 'faux' }, diskProbe: async () => 1e9, tickMs: 60000, ...overrides };
    let app = await startControlServer(options);
    let cookie = '', csrf = '';
    return {
        faux, get app() { return app; },
        async request(path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) {
            const response = await fetch(`${app.url}/api/v1/${path}`, { method, headers: { Origin: app.url, Cookie: cookie, 'X-CSRF-Token': csrf, 'Idempotency-Key': randomUUID(), 'Content-Type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
            return { response, json: await response.json() };
        },
        async setup() {
            const response = await fetch(`${app.url}/api/v1/setup`, { method: 'POST', headers: { Origin: app.url, 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'owner', password: CONTROL_TEST_PASSWORD, timezone: 'UTC' }) });
            if (response.status !== 200) throw new Error(`SETUP_FAILED:${response.status}`);
            cookie = response.headers.get('set-cookie')!.split(';')[0]!;
            csrf = (await response.json()).data.csrf;
        },
        async until(check: () => boolean, timeoutMs = 5000) {
            const deadline = Date.now() + timeoutMs;
            while (!check() && Date.now() < deadline) { await app.service.tick(); await new Promise(r => setTimeout(r, 15)); }
            if (!check()) throw new Error('CONDITION_TIMEOUT');
        },
        async reopen() { await app.close(); app = await startControlServer(options); },
        async close() { await app.close(); await rm(dir, { recursive: true, force: true }); },
    };
}
