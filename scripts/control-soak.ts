import { mkdtemp, mkdir, rm, writeFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider, fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
import { ControlService } from '../src/control/service.js';

// Real control plane and SQLite; only upstream model/Telegram services are synthetic.
const option = (name: string, fallback: string) => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const duration = Number(option('duration-seconds', '259200')) * 1000;
const interval = Number(option('interval-seconds', '30')) * 1000;
if (!Number.isFinite(duration) || duration < 1000 || !Number.isFinite(interval) || interval < 1000) throw new Error('INVALID_SOAK_DURATION');
const output = resolve(option('output', 'artifacts/control-soak.json'));
const dir = await mkdtemp(join(tmpdir(), 'control-soak-'));
const models = createModels(), faux = fauxProvider(); models.setProvider(faux.provider);
let sends = 0, lostConfirmations = 0;
const fetcher: typeof fetch = async input => {
 if (String(input).endsWith('getUpdates')) return new Response(JSON.stringify({ ok: true, result: [] }));
 if (String(input).endsWith('sendMessage')) {
  sends++;
  if (sends % 7 === 0) { lostConfirmations++; throw new Error('INJECTED_LOST_CONFIRMATION'); }
  return new Response(JSON.stringify({ ok: true, result: { message_id: sends } }));
 }
 throw new Error('UNEXPECTED_REQUEST');
};
let interrupted = false;
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { interrupted = true; });
const start = process.hrtime.bigint();
const elapsed = () => Number(process.hrtime.bigint() - start) / 1e6;
let created = 0, peakRss = 0, peakQueue = 0, peakRuns = 0, lastSaved = -60000, nextTask = 0;
let failure: string | null = null;
const service = await ControlService.open({ dataDir: join(dir, 'data'), workspace: join(dir, 'workspace'), runtimeOptions: { models, provider: 'faux' }, fetcher, tickMs: 60000 });
service.store.setSetting('config', { tokenBudget: 262144, retentionDays: 1 });
const channel = service.channel({ name: 'soak', type: 'telegram', token: '123:synthetic-test', allowedUsers: ['123'], enabled: true });
async function report(final: boolean) {
 const tasks = service.list('tasks'), outbox = service.list('outbox');
 const result = { schema: 1, scope: 'synthetic-upstreams-real-control-sqlite', final, interrupted, failure, requestedDurationMs: duration, elapsedMs: elapsed(), full72Hours: final && !interrupted && failure === null && elapsed() >= 259200000, realModelVerified: false, realTelegramVerified: false, created, retainedTasks: tasks.length, succeeded: tasks.filter(t => t.status === 'SUCCEEDED').length, failed: tasks.filter(t => t.status === 'FAILED').length, unfinished: tasks.filter(t => !['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(t.status)).length, peakRss, peakQueue, peakRuns, sends, lostConfirmations, uncertainDeliveries: outbox.filter(o => o.state === 'DELIVERY_UNCERTAIN').length };
 await mkdir(dirname(output), { recursive: true });
 await writeFile(output + '.tmp', JSON.stringify(result, null, 2) + '\n', { mode: 0o600 }); await rename(output + '.tmp', output);
 return result;
}
try {
 while (elapsed() < duration && !interrupted) {
  const pending = service.list('tasks').some(t => !['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(t.status));
  if (elapsed() >= nextTask && !pending) {
   created++;
   faux.setResponses([...(created % 5 === 0 ? [fauxAssistantMessage('', { stopReason: 'error', errorMessage: '503 INJECTED_OUTAGE' })] : []), fauxAssistantMessage('synthetic-soak-result')]);
   await service.inbound(channel.id, { platform: 'telegram', account: 'soak', user: '123', chat: '123', id: String(created), text: 'perform bounded test', timestamp: Date.now() });
   nextTask = elapsed() + interval;
  }
  await service.tick();
  const summary = service.summary();
  peakRss = Math.max(peakRss, process.memoryUsage().rss); peakQueue = Math.max(peakQueue, summary.queueDepth); peakRuns = Math.max(peakRuns, summary.runningTasks);
  if (peakRss > 1024 ** 3 || peakQueue > 100 || peakRuns > 2 || summary.lastError) throw new Error('SOAK_RESOURCE_OR_WORKER_FAILURE');
  if (elapsed() - lastSaved >= 60000) { await report(false); lastSaved = elapsed(); }
  await new Promise(r => setTimeout(r, 250));
 }
 // Drain only already admitted work, bounded independently of the requested duration.
 const deadline = elapsed() + 15000;
 while (!interrupted && elapsed() < deadline && service.list('tasks').some(t => !['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(t.status))) { await service.tick(); await new Promise(r => setTimeout(r, 100)); }
 if (!interrupted && service.list('tasks').some(t => !['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(t.status))) throw new Error('SOAK_UNDRAINED_TASKS');
} catch (error) { failure = (error as Error).message; process.exitCode = 1; }
finally {
 if (interrupted) process.exitCode = 1;
 console.log(JSON.stringify(await report(true)));
 await service.close(); await rm(dir, { recursive: true, force: true });
}
