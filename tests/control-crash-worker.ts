import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider, fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
import { ControlService } from '../src/control/service.js';

function waitForAbort(signal?: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    signal?.addEventListener('abort', () => resolve(), { once: true });
  });
}
const dir = process.env.CRASH_DIR!;
const effect = (kind: string) => {
  appendFileSync(join(dir, 'effects.jsonl'), JSON.stringify({ kind }) + '\n');
  process.send?.({ effect: kind });
};
const models = createModels();
const faux = fauxProvider();
models.setProvider(faux.provider);
faux.setResponses(Array.from({ length: 30 }, () => async (_context, options) => {
  process.send?.({ model: true });
  if (process.env.HANG_MODEL === '1') await waitForAbort(options?.signal);
  return fauxAssistantMessage('恢复后的回答');
}));
const fetcher: typeof fetch = async (input, init) => {
  if (String(input).endsWith('getUpdates')) return new Response(JSON.stringify({ ok: true, result: [] }));
  if (String(input).endsWith('sendMessage')) {
    effect('send');
    if (process.env.HANG_SEND === '1') await waitForAbort(init?.signal ?? undefined);
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
  }
  throw new Error('UNEXPECTED_REQUEST');
};
const service = await ControlService.open({ dataDir: join(dir, 'data'), workspace: join(dir, 'workspace'), runtimeOptions: { models, provider: 'faux' }, fetcher, diskProbe: async () => 1e9, tickMs: 20 });
process.on('message', async (message: any) => {
  const { key, method, params = {} } = message;
  try {
    let result: any;
    if (method === 'conversation') result = await service.conversation({ name: '崩溃恢复' });
    else if (method === 'submit') result = service.createTask(params.conversationId, '恢复验证', 'web', 'stable-control-input');
    else if (method === 'snapshot') result = { tasks: service.list('tasks'), operations: service.list('operations'), outbox: service.list('outbox') };
    else if (method === 'history') result = await service.adapter.dispatch('history.list', { id: params.id, limit: 100 });
    else if (method === 'input') result = await service.adapter.dispatch('input.get', { id: params.id });
    else if (method === 'execute') {
      const task = service.get('tasks', params.taskId);
      service.policy.register({ name: 'crash_effect', version: '1', inputSchema: {}, sideEffect: 'non_idempotent_write', permission: 'crash_effect', timeoutMs: 8000, idempotent: false, executor: 'test', enabled: true });
      const call = { name: 'crash_effect', args: { value: 1 }, taskId: task.id, principalId: 'owner' };
      if (!service.list('operations').length) {
        const approval = service.policy.requestApproval(call);
        service.policy.decide(approval.id, 'APPROVED');
      }
      result = await service.tool({ name: call.name, args: call.args, callId: 'stable-effect', scope: 'owner', conversationId: service.get('conversations', task.conversationId).piConversationId, taskId: 0, requestIds: [task.id], signal: new AbortController().signal }, async () => {
        effect('executor');
        await waitForAbort();
        return { done: true };
      });
    } else if (method === 'outbound') {
      const channel = service.channel({ name: 'test', type: 'telegram', token: '123:test', allowedUsers: ['123'], enabled: true });
      service.store.put('outbox', 'stable-outbound', { id: 'stable-outbound', dedupe_key: 'stable-outbound', channelId: channel.id, threadId: '123', content: 'delivery', state: 'PENDING', attempts: 0, nextRetryAt: 0 });
      result = true;
    } else if (method === 'tick') { await service.tick(); result = true; }
    else throw new Error('UNKNOWN_METHOD');
    process.send?.({ key, result });
  } catch (error) { process.send?.({ key, error: (error as Error).message }); }
});
process.on('SIGTERM', () => { void service.close().then(() => process.exit(0)); });
process.send?.({ ready: true });
