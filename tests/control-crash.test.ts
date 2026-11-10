import { expect, test } from 'vitest';
import { fork } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { until } from './helpers.js';

async function worker(dir: string, extra: Record<string, string> = {}) {
  const child = fork(new URL('./control-crash-worker.ts', import.meta.url), [], { execArgv: ['--import', 'tsx'], env: { ...process.env, CRASH_DIR: dir, ...extra }, silent: true });
  const messages: any[] = [];
  let logs = '', seq = 0;
  child.stderr!.on('data', b => { logs += b; });
  child.on('message', m => messages.push(m));
  async function stop() {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('SIGKILL exit deadline')), 8000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      child.kill('SIGKILL');
    });
  }
  try {
    await until(async () => {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`worker exited: ${logs}`);
      return messages.some(m => m.ready);
    }, Boolean);
  } catch (error) { await stop(); throw error; }
  return {
    messages, stop,
    async call(method: string, params: Record<string, unknown> = {}) {
      const key = ++seq;
      return new Promise<any>((resolve, reject) => {
        const cleanup = () => { clearTimeout(timer); child.off('message', listener); child.off('exit', exited); };
        const timer = setTimeout(() => { cleanup(); reject(new Error(`IPC deadline ${method}: ${logs}`)); }, 8000);
        const listener = (m: any) => { if (m.key !== key) return; cleanup(); m.error ? reject(new Error(m.error)) : resolve(m.result); };
        const exited = () => { cleanup(); reject(new Error(`worker exited during ${method}: ${logs}`)); };
        child.on('message', listener);
        child.once('exit', exited);
        child.send({ key, method, params });
      });
    },
  };
}
type Worker = Awaited<ReturnType<typeof worker>>;
async function effects(dir: string) { return (await readFile(join(dir, 'effects.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line).kind); }

test('Control模型inflight SIGKILL恢复稳定task/input并去重', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'control-crash-model-'));
  let w: Worker | undefined;
  try {
    w = await worker(dir, { HANG_MODEL: '1' });
    const c = await w.call('conversation');
    const task = await w.call('submit', { conversationId: c.id });
    await until(async () => w!.messages.some(m => m.model), Boolean);
    const before = (await w.call('snapshot')).tasks[0];
    expect(before.piSubmissionId).toBeDefined();
    await w.stop();
    w = await worker(dir);
    expect((await w.call('submit', { conversationId: c.id })).id).toBe(task.id);
    const after = await until(async () => (await w!.call('snapshot')).tasks[0], t => ['SUCCEEDED', 'FAILED'].includes(t.status));
    const recoveredInput = await w.call('input', { id: after.piSubmissionId });
    expect({ status: after.status, input: recoveredInput }, JSON.stringify(recoveredInput)).toMatchObject({ status: 'SUCCEEDED', input: { status: 'done' } });
    expect(after.piSubmissionId).toBe(before.piSubmissionId);
    expect(after.result).toBe('恢复后的回答');
    expect((await w.call('input', { id: after.piSubmissionId })).status).toBe('done');
    const history = await w.call('history', { id: c.piConversationId });
    expect(history.items.filter((e: any) => e.kind === 'pi.user')).toHaveLength(1);
    expect((await w.call('snapshot')).tasks).toHaveLength(1);
  } finally { await w?.stop(); await rm(dir, { recursive: true, force: true }); }
}, 25000);

test('Control非幂等executor副作用后confirm前SIGKILL恢复UNCERTAIN且拒绝重放', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'control-crash-effect-'));
  let w: Worker | undefined;
  try {
    w = await worker(dir, { HANG_MODEL: '1' });
    const c = await w.call('conversation');
    const task = await w.call('submit', { conversationId: c.id });
    await until(async () => w!.messages.some(m => m.model), Boolean);
    const pending = w.call('execute', { taskId: task.id }).catch(e => e);
    await until(async () => w!.messages.some(m => m.effect === 'executor'), Boolean);
    expect((await w.call('snapshot')).operations[0].state).toBe('SENDING');
    await w.stop();
    await pending;
    w = await worker(dir, { HANG_MODEL: '1' });
    expect((await w.call('snapshot')).operations).toEqual([expect.objectContaining({ taskId: task.id, state: 'UNCERTAIN' })]);
    await expect(w.call('execute', { taskId: task.id })).rejects.toThrow('OPERATION_UNCERTAIN');
    expect(await effects(dir)).toEqual(['executor']);
  } finally { await w?.stop(); await rm(dir, { recursive: true, force: true }); }
}, 25000);

test('Control出站send后响应前SIGKILL恢复DELIVERY_UNCERTAIN且不重发', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'control-crash-send-'));
  let w: Worker | undefined;
  try {
    w = await worker(dir, { HANG_SEND: '1' });
    await w.call('outbound');
    await until(async () => w!.messages.some(m => m.effect === 'send'), Boolean);
    expect((await w.call('snapshot')).outbox[0]).toMatchObject({ state: 'SENDING', attempts: 1 });
    await w.stop();
    w = await worker(dir);
    for (let i = 0; i < 3; i++) await w.call('tick');
    expect((await w.call('snapshot')).outbox).toEqual([expect.objectContaining({ id: 'stable-outbound', state: 'DELIVERY_UNCERTAIN', attempts: 1 })]);
    expect(await effects(dir)).toEqual(['send']);
    expect(w.messages.some(m => m.effect === 'send')).toBe(false);
  } finally { await w?.stop(); await rm(dir, { recursive: true, force: true }); }
}, 25000);
