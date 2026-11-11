import { randomUUID } from 'node:crypto';
import type { ControlStore } from './store.js';

type RecordData = Record<string, any>;
export type BudgetRequest = { taskId: string; providerId: string; reservedTokens: number; reservedCost: number; reservationId?: string };
export type BudgetUsage = { actualTokens: number; actualCost: number } | { unknown: true };
type Reservation = { id: string; taskId: string; providerId: string; day: string; reservedTokens: number; reservedCost: number; state: 'reserved' | 'unknown' | 'settled'; actualTokens?: number; actualCost?: number };

function amount(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= 0; }
function limit(value: unknown, fallback = Infinity): number {
  if (value === undefined || value === null) return fallback;
  if (!amount(value)) throw new Error('BUDGET_INVALID');
  return value;
}
function count(value: unknown): number {
  if (value === undefined) return 0;
  if (!amount(value)) throw new Error('BUDGET_INVALID');
  return value;
}
const key = (...parts: string[]) => JSON.stringify(parts);

export class BudgetService {
  constructor(private readonly store: ControlStore) {}

  reserve(request: BudgetRequest): { reservationId: string; state: Reservation['state'] } {
    if (!request.taskId || !request.providerId || (request.reservationId !== undefined && !request.reservationId) || !Number.isSafeInteger(request.reservedTokens) || request.reservedTokens <= 0 || !amount(request.reservedCost)) throw new Error('BUDGET_INVALID');
    const id = request.reservationId ?? randomUUID();
    return this.store.transaction(() => {
      const existing = this.store.get<Reservation>('budget_reservations', id);
      if (existing) {
        if (existing.taskId !== request.taskId || existing.providerId !== request.providerId || existing.reservedTokens !== request.reservedTokens || existing.reservedCost !== request.reservedCost) throw new Error('BUDGET_RESERVATION_CONFLICT');
        return { reservationId: id, state: existing.state };
      }
      const task = this.store.get<RecordData>('tasks', request.taskId);
      const provider = this.store.get<RecordData>('providers', request.providerId) ?? this.store.get<RecordData>('budget_provider_profiles', request.providerId);
      if (!task || !provider) throw new Error('BUDGET_ENTITY_NOT_FOUND');
      const budget = task.budget ?? {};
      const usage = task.usage ?? {};
      const config = this.store.setting<RecordData>('config', {});
      const global = config.global ?? config;
      const day = new Date().toISOString().slice(0, 10);
      const daily = count(this.store.setting<number>(`cost:${day}`, 0));
      const providerDayKey = key('day', request.providerId, day);
      const providerTaskKey = key('task', request.providerId, request.taskId);
      const providerDay = count(this.store.get<number>('budget_counters', providerDayKey));
      const providerTask = count(this.store.get<number>('budget_counters', providerTaskKey));
      const taskTokens = count(usage.reservedTokens);
      const taskCost = count(usage.reservedCost);
      const nextCost = taskCost + request.reservedCost;
      const nextDaily = daily + request.reservedCost;
      if (taskTokens + request.reservedTokens > limit(budget.maxTokens) || nextCost > limit(budget.maxCost) || nextDaily > limit(global.dailyBudget, 10) || providerDay + request.reservedCost > limit(provider.dailyBudget) || providerTask + request.reservedCost > limit(provider.taskBudget)) throw new Error('BUDGET_EXHAUSTED');
      if (nextDaily >= limit(global.softDailyBudget) || nextCost >= limit(global.softTaskBudget)) throw new Error('BUDGET_SOFT_LIMIT');
      const reservation: Reservation = { id, taskId: request.taskId, providerId: request.providerId, day, reservedTokens: request.reservedTokens, reservedCost: request.reservedCost, state: 'reserved' };
      this.store.put('budget_reservations', id, reservation);
      this.store.put('tasks', request.taskId, { ...task, usage: { ...usage, reservedTokens: taskTokens + request.reservedTokens, reservedCost: nextCost, modelCalls: count(usage.modelCalls) + 1 } });
      this.store.setSetting(`cost:${day}`, nextDaily);
      this.store.put('budget_counters', providerDayKey, providerDay + request.reservedCost);
      this.store.put('budget_counters', providerTaskKey, providerTask + request.reservedCost);
      return { reservationId: id, state: 'reserved' };
    });
  }

  settle(reservationId: string, usage: BudgetUsage): { state: 'unknown' | 'settled' } {
    return this.store.transaction(() => {
      const reservation = this.store.get<Reservation>('budget_reservations', reservationId);
      if (!reservation) throw new Error('BUDGET_RESERVATION_NOT_FOUND');
      const known = usage && 'actualTokens' in usage && Number.isSafeInteger(usage.actualTokens) && usage.actualTokens > 0 && amount(usage.actualCost) && usage.actualCost > 0;
      if (reservation.state === 'settled') {
        if (!known || reservation.actualTokens !== usage.actualTokens || reservation.actualCost !== usage.actualCost) throw new Error('BUDGET_SETTLEMENT_CONFLICT');
        return { state: 'settled' };
      }
      if (!known) {
        if (reservation.state !== 'unknown') this.store.put('budget_reservations', reservationId, { ...reservation, state: 'unknown' });
        return { state: 'unknown' };
      }
      const task = this.store.get<RecordData>('tasks', reservation.taskId);
      if (!task) throw new Error('BUDGET_ENTITY_NOT_FOUND');
      const taskUsage = task.usage ?? {};
      const costDelta = usage.actualCost - reservation.reservedCost;
      const tokenDelta = usage.actualTokens - reservation.reservedTokens;
      const daily = count(this.store.setting<number>(`cost:${reservation.day}`, 0));
      const dayKey = key('day', reservation.providerId, reservation.day);
      const taskKey = key('task', reservation.providerId, reservation.taskId);
      const providerDay = count(this.store.get<number>('budget_counters', dayKey));
      const providerTask = count(this.store.get<number>('budget_counters', taskKey));
      const newTaskTokens = count(taskUsage.reservedTokens) + tokenDelta;
      const newTaskCost = count(taskUsage.reservedCost) + costDelta;
      if (newTaskTokens < 0 || newTaskCost < -1e-10 || daily + costDelta < -1e-10 || providerDay + costDelta < -1e-10 || providerTask + costDelta < -1e-10) throw new Error('BUDGET_LEDGER_INVALID');
      this.store.put('tasks', reservation.taskId, { ...task, usage: { ...taskUsage, reservedTokens: newTaskTokens, reservedCost: Math.max(0, newTaskCost) } });
      this.store.setSetting(`cost:${reservation.day}`, Math.max(0, daily + costDelta));
      this.store.put('budget_counters', dayKey, Math.max(0, providerDay + costDelta));
      this.store.put('budget_counters', taskKey, Math.max(0, providerTask + costDelta));
      this.store.put('budget_reservations', reservationId, { ...reservation, state: 'settled', actualTokens: usage.actualTokens, actualCost: usage.actualCost });
      return { state: 'settled' };
    });
  }
}
