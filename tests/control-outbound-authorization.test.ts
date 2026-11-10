import { test, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { ControlService } from '../src/control/service.js';

test('Telegram待投递在allowlist撤销后拒绝发送，仍允许当前授权私聊', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hda-outbound-auth-'));
    const models = createModels();
    models.setProvider(fauxProvider().provider);
    const sent: string[] = [];
    const fetcher: typeof fetch = async (input, init) => {
        if (String(input).endsWith('getUpdates')) return new Response(JSON.stringify({ ok: true, result: [] }));
        if (String(input).endsWith('sendMessage')) {
            sent.push(String(JSON.parse(String(init?.body)).chat_id));
            return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
        }
        throw new Error('UNEXPECTED_REQUEST');
    };
    const service = await ControlService.open({ dataDir: join(dir, 'data'), workspace: join(dir, 'workspace'), runtimeOptions: { models, provider: 'faux' }, fetcher, tickMs: 60000 });
    try {
        const channel = service.channel({ name: 'test', type: 'telegram', token: '123:test', allowedUsers: ['123', '456'], enabled: true });
        for (const user of ['123', '456']) service.store.put('outbox', user, { id: user, dedupe_key: user, channelId: channel.id, threadId: user, content: 'private result', state: 'PENDING', attempts: 0, nextRetryAt: 0 });
        service.channel({ allowedUsers: ['456'] }, channel.id);
        await service.tick();
        expect(sent).toEqual(['456']);
        expect(service.get('outbox', '123')).toMatchObject({ state: 'FAILED', lastError: 'RECIPIENT_NOT_ALLOWED', attempts: 0 });
        expect(service.get('outbox', '456').state).toBe('SENT');
        await service.tick();
        expect(sent).toEqual(['456']);
    } finally {
        await service.close();
        await rm(dir, { recursive: true, force: true });
    }
});
