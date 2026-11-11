import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ControlStore } from '../src/control/store.js';
import { BudgetService } from '../src/control/budgets.js';

const dirs: string[] = [];
function fixture(config: Record<string, unknown> = {}, provider: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'budget-')); dirs.push(dir);
  const store = new ControlStore(dir);
  store.setSetting('config', { dailyBudget: 10, ...config });
  store.put('tasks', 't', { id: 't', budget: { maxTokens: 1000, maxCost: 10 }, usage: { reservedTokens: 0, reservedCost: 0, modelCalls: 0 } });
  store.put('providers', 'p', { id: 'p', ...provider });
  return { store, service: new BudgetService(store), dir };
}
afterEach(() => { vi.useRealTimers(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const request = { taskId: 't', providerId: 'p', reservedTokens: 100, reservedCost: 1, reservationId: 'r' };

test('硬限额及零 provider 限额拒绝且不写入，软阈值达到时安全拒绝', () => {
  for (const [config, provider, code] of [
    [{}, { dailyBudget: 0 }, 'BUDGET_EXHAUSTED'],
    [{}, { taskBudget: 0 }, 'BUDGET_EXHAUSTED'],
    [{ dailyBudget: 0 }, {}, 'BUDGET_EXHAUSTED'],
    [{ softDailyBudget: 1 }, {}, 'BUDGET_SOFT_LIMIT'],
    [{ softTaskBudget: 1 }, {}, 'BUDGET_SOFT_LIMIT'],
  ] as const) {
    const { store, service } = fixture(config, provider);
    const before = store.list('tasks');
    expect(() => service.reserve(request)).toThrow(code);
    expect(store.list('tasks')).toEqual(before);
    expect(store.list('budget_reservations')).toEqual([]);
    store.close();
  }
});

test('重复预留幂等，跨重开及跨日结算只调整原日、原 provider 和任务', () => {
  const { store, service, dir } = fixture();
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-01-01T23:59:59Z'));
  const now = Date.now();
  const result = service.reserve(request);
  expect(service.reserve(request)).toEqual(result);
  expect(() => service.reserve({ ...request, providerId: 'other' })).toThrow('BUDGET_RESERVATION_CONFLICT');
  store.close();
  const reopened = new ControlStore(dir); const next = new BudgetService(reopened);
  vi.setSystemTime(new Date('2026-01-02T00:00:01Z'));
  next.settle('r', { actualTokens: 25, actualCost: 0.25 });
  next.settle('r', { actualTokens: 25, actualCost: 0.25 });
  const task = reopened.get<any>('tasks', 't')!;
  expect(task.usage.reservedTokens).toBe(25);
  expect(task.usage.reservedCost).toBeCloseTo(0.25);
  expect(task.usage.modelCalls).toBe(1);
  expect(next.reserve(request).state).toBe('settled');
  expect(reopened.setting('cost:2026-01-02', 0)).toBe(0);
  expect(reopened.setting<number>(`cost:${new Date(now).toISOString().slice(0, 10)}`, 0)).toBeCloseTo(0.25);
  expect(() => next.settle('r', { actualTokens: 50, actualCost: 0.5 })).toThrow('BUDGET_SETTLEMENT_CONFLICT');
  reopened.close();
});

test('未知、零和缺失 cost 均不能释放预留；之后可用可信用量结算', () => {
  const { store, service } = fixture(); service.reserve(request);
  service.settle('r', { unknown: true }); service.settle('r', { unknown: true });
  service.settle('r', { actualTokens: 20, actualCost: 0 });
  expect(store.get<any>('tasks', 't').usage.reservedCost).toBe(1);
  service.settle('r', { actualTokens: 20, actualCost: 0.2 });
  expect(store.get<any>('tasks', 't').usage.reservedCost).toBeCloseTo(0.2);
  store.close();
});

test('跨 provider 和任务的计数分离，超额实际用量保留在原账目', () => {
  const { store, service } = fixture({}, { dailyBudget: 2, taskBudget: 1.5 });
  store.put('providers', 'q', { id: 'q', dailyBudget: 1 });
  store.put('tasks', 'u', { id: 'u', budget: { maxTokens: 1000, maxCost: 10 }, usage: {} });
  service.reserve(request);
  service.reserve({ ...request, providerId: 'q', reservationId: 'q1' });
  expect(() => service.reserve({ ...request, taskId: 'u', reservationId: 'p2', reservedCost: 1.1 })).toThrow('BUDGET_EXHAUSTED');
  service.settle('r', { actualTokens: 120, actualCost: 1.25 });
  expect(store.get<any>('tasks', 't').usage.reservedTokens).toBe(220);
  expect(() => service.reserve({ ...request, reservationId: 'p3', reservedCost: 0.3 })).toThrow('BUDGET_EXHAUSTED');
  expect(() => service.reserve({ ...request, providerId: 'q', taskId: 'u', reservationId: 'q2', reservedCost: 0.1 })).toThrow('BUDGET_EXHAUSTED');
  store.close();
});

test('多个请求和 provider/task 限额共同计量，失败回滚', async () => {
  const { store, service } = fixture({}, { taskBudget: 1.5 });
  const results = await Promise.allSettled([Promise.resolve().then(() => service.reserve(request)), Promise.resolve().then(() => service.reserve({ ...request, reservationId: 'r2' }))]);
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  expect(store.list('budget_reservations')).toHaveLength(1);
  expect(store.get<any>('tasks', 't').usage.reservedCost).toBe(1);
  store.close();
});
