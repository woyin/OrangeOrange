import { randomUUID } from 'node:crypto';
import { mkdir, statfs, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { CronExpressionParser } from 'cron-parser';
import { ControlStore, hash } from './store.js';
import { MaintenanceService } from './maintenance.js';
import { OperationsService, recoverInterruptedRestore } from './operations.js';
import { acquireOwnership } from '../ownership.js';
import { AuthService } from './security.js';
import { PolicyGateway, type ToolCall, type ToolDescriptor, type Approval } from './policy.js';
import { PiAdapter, type RuntimeOptions } from '../pi-adapter.js';
import { config } from '../config.js';
import { telegramAdapter } from '../channels/telegram.js';
import { chunks, SendFailure, type Inbound } from '../channels/types.js';
export class ApiError extends Error {
    constructor(public status: number, public code: string, message = code) { super(message); }
}
export type RecordData = Record<string, any>;
export interface ServiceOptions {
    dataDir: string;
    workspace?: string;
    runtimeOptions?: RuntimeOptions;
    diskProbe?: () => Promise<number>;
    minFreeBytes?: number;
    fetcher?: typeof fetch;
    tickMs?: number;
}
const terminal = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED']);
const transitions: Record<string, string[]> = { CREATED: ['QUEUED', 'FAILED'], QUEUED: ['RUNNING', 'PAUSED', 'CANCELLED', 'FAILED'], RUNNING: ['PAUSED', 'WAITING_APPROVAL', 'RETRY_WAIT', 'SUCCEEDED', 'FAILED', 'CANCELLED'], WAITING_APPROVAL: ['PAUSED', 'RUNNING', 'FAILED', 'CANCELLED'], RETRY_WAIT: ['QUEUED', 'CANCELLED', 'FAILED'], PAUSED: ['QUEUED', 'RUNNING', 'WAITING_APPROVAL', 'CANCELLED', 'FAILED'], FAILED: [], SUCCEEDED: [], CANCELLED: [] };
export const fields = (body: RecordData, allowed: string[]) => { if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => !allowed.includes(k)))
    throw new ApiError(400, 'INVALID_FIELDS'); };
export const string = (v: unknown, max = 32000) => { if (typeof v !== 'string' || !v.trim() || v.length > max)
    throw new ApiError(400, 'INVALID_INPUT'); return v; };
const positive = (v: unknown, min = 1, max = 1e9) => { if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max)
    throw new ApiError(400, 'INVALID_NUMBER'); return v; };
export class ControlService {
    store: ControlStore;
    auth: AuthService;
    policy: PolicyGateway;
    adapter!: PiAdapter;
    private timer?: ReturnType<typeof setInterval>;
    private busy = false;
    private closed = false;
    private stopped = false;
    private storeClosed = false;
    private operationsService?: OperationsService;
    private releaseOwnership?: () => Promise<void>;
    private abort = new AbortController();
    private observers = new Map<string, () => void>();
    private pollBusy = new Set<string>();
    diskLow = false;
    adapterReady = false;
    lastError?: string;
    readonly workspace: string;
    get maintenance() { return new MaintenanceService(() => this.store, this.options.dataDir); }
    private constructor(readonly options: ServiceOptions) { this.workspace = resolve(options.workspace ?? join(options.dataDir, '..', 'workspace')); this.store = new ControlStore(options.dataDir); this.auth = new AuthService(this.store); this.policy = new PolicyGateway(this.store); }
    static async open(options: ServiceOptions) {
        const release = await acquireOwnership(options.dataDir);
        let s: ControlService | undefined;
        try {
            await recoverInterruptedRestore(options.dataDir);
            s = new ControlService(options);
            s.releaseOwnership = release;
            await mkdir(s.workspace, { recursive: true });
            await s.openAdapter();
            await s.reconcile();
            await s.probeDisk();
            s.timer = setInterval(() => void s!.tick(), options.tickMs ?? 250);
            return s;
        } catch (error) {
            await s?.adapter?.close().catch(() => {});
            s?.store.close();
            await release();
            throw error;
        }
    }
    private async openAdapter() { const cfg = config({ ORANGE_DATA_DIR: join(this.options.dataDir, 'pi'), ORANGE_WORKSPACE: this.workspace, ORANGE_MODEL: this.options.runtimeOptions?.provider === 'faux' ? 'faux-1' : 'gpt-4.1-mini' }); this.adapter = await PiAdapter.open(cfg, { ...this.options.runtimeOptions, disableLegacyAutomation: true, privatePaths: [this.options.dataDir, ...(process.env.HDA_MASTER_KEY_FILE ? [process.env.HDA_MASTER_KEY_FILE] : []), ...(this.options.runtimeOptions?.privatePaths ?? [])], toolGateway: (call, execute) => this.tool(call, execute), modelFailure: r => this.recordModelFailure(r), modelGate: r => this.gateModel(r), modelAdmission: r => this.admitModel(r) }); await this.configureProviders(); for (const t of await this.adapter.tools()) {
        if (!this.store.get('tools', t.name))
            this.policy.register({ ...t, enabled: true, permission: t.name, sideEffect: t.sideEffect === 'read_only' ? 'read' : t.sideEffect } as ToolDescriptor);
    } this.adapterReady = true; }
    async configureProviders() { const providers = this.store.list<RecordData>('providers'); if (providers.length)
        await this.adapter.configureProviders(providers.map(p => ({ id: p.id, vendor: p.vendor, model: p.model, priority: p.priority, apiKey: this.store.getSecret(`provider:${p.id}`) }))); }
    requireWrite() { if (this.store.maintenance || this.diskLow || this.stopped)
        throw new ApiError(503, 'READ_ONLY_PROTECTION'); }
    async probeDisk() { try {
        const free = this.options.diskProbe ? await this.options.diskProbe() : await statfs(this.options.dataDir).then(s => s.bavail * s.bsize);
        this.diskLow = free < (this.options.minFreeBytes ?? 64 * 1024 * 1024);
    }
    catch {
        this.diskLow = true;
    } return !this.diskLow; }
    list(kind: string) { return this.store.list<RecordData>(kind); }
    get(kind: string, id: string) { const value = this.store.get<RecordData>(kind, id); if (!value)
        throw new ApiError(404, 'NOT_FOUND'); return value; }
    change(task: RecordData, status: string, reason?: string):RecordData { if (task.status === status)
        return task; if (!transitions[task.status]?.includes(status))
        throw new ApiError(409, 'INVALID_TASK_TRANSITION'); const next = { ...task, status, updatedAt: Date.now(), ...(reason ? { error: reason } : {}) }; this.store.transaction(() => { this.store.put('tasks', task.id, next); this.store.put('task_steps', randomUUID(), { id: randomUUID(), taskId: task.id, from: task.status, status, at: Date.now(), reason }); this.store.event('task.changed', task.id, { status }); }); return next; }
    async conversation(body: RecordData) { fields(body, ['name', 'model']); const id = randomUUID(); const record = { id, name: body.name ? string(body.name, 100) : '新会话', status: 'active', createdAt: Date.now(), model: body.model }; this.store.put('conversations', id, record); return this.ensureConversation(record); }
    async ensureConversation(c: RecordData): Promise<RecordData> { if (c.piConversationId)
        return c; const pi = await this.adapter.createConversation({ externalId: `control:${c.id}`, name: c.name, scope: c.scope ?? 'owner', channel: c.channelId ? 'telegram' : 'web', workspace: this.workspace, model: c.model }); const next = { ...c, piConversationId: pi.id }; this.store.put('conversations', c.id, next); return next; }
    createTask(conversationId: string, content: string, source = 'web', key: string = randomUUID(), extra: RecordData = {}) { this.requireWrite(); return this.store.transaction(() => { const existing = this.store.get<RecordData>('inbox_events', key); if (existing?.taskId) {
        const task = this.store.get<RecordData>('tasks', existing.taskId);
        if (!task) throw new ApiError(410, 'TASK_HISTORY_EXPIRED');
        return task;
    } if (this.list('tasks').filter(t => ['CREATED', 'QUEUED', 'RETRY_WAIT'].includes(t.status)).length >= 100)
        throw new ApiError(429, 'QUEUE_FULL'); const c = this.get('conversations', conversationId); if (c.status !== 'active')
        throw new ApiError(409, 'CONVERSATION_ARCHIVED'); const id = randomUUID(); const settings = this.store.setting<RecordData>('config', {}); const budget = { maxTokens: settings.tokenBudget ?? 32768, maxOutputTokens: 4096, maxTools: 20, maxTurns: 8, maxDurationMs: 300000, maxCost: settings.taskBudget ?? 1, ...extra.budget }; const t = { id, conversationId, source, ownerId: 'owner', principalId: extra.principalId ?? 'owner', goal: string(content), promptVersion:settings.version??0,systemPrompt:settings.systemPrompt,status: 'CREATED', budget, usage: { reservedTokens: 0, reservedCost: 0, toolCalls: 0, modelCalls: 0 }, createdAt: Date.now(), updatedAt: Date.now(), attempt: 0, ...extra }; this.store.put('inbox_events', key, { id: key, dedupe_key: key, state: 'RECEIVED', taskId: id, conversationId, source }); this.store.put('tasks', id, t); const queued = this.change(t, 'QUEUED'); this.store.put('inbox_events', key, { id: key, dedupe_key: key, state: 'APPLIED', taskId: id }); return queued; }); }
    async reconcile() { if (this.store.maintenance)
        return; for (const op of this.list('operations'))
        if (op.state === 'SENDING')
            this.store.put('operations', op.id, { ...op, state: 'UNCERTAIN' }); for (const out of this.list('outbox'))
        if (out.state === 'SENDING')
            this.store.put('outbox', out.id, { ...out, state: 'DELIVERY_UNCERTAIN' }); for (const c of this.list('conversations'))
        await this.ensureConversation(c); for (const t of this.list('tasks'))
        if (['RUNNING', 'WAITING_APPROVAL'].includes(t.status)) {
            if (!t.piSubmissionId) {
                const c = this.get('conversations', t.conversationId);
                const submitted = await this.adapter.dispatch('input.submit', { conversationId: c.piConversationId, requestId: t.piRequestId??t.id, content: t.goal });
                this.store.put('tasks', t.id, { ...t, piSubmissionId: submitted.id });
            }
            await this.observe(this.get('tasks', t.id));
        } }
    private recordModelFailure(request: { conversationId: number; code: string; retryable: boolean }) {
        if (this.closed || this.stopped) return;
        const task = this.list('tasks').find(t => ['RUNNING', 'WAITING_APPROVAL', 'PAUSED'].includes(t.status) && request.conversationId === this.get('conversations', t.conversationId).piConversationId);
        if (task) this.store.put('tasks', task.id, { ...task, modelFailure: { code: request.code, retryable: request.retryable } });
    }
    private async waitForTask(id: string, signal?: AbortSignal) {
        while (true) {
            if (this.closed || signal?.aborted) throw new Error('TASK_INTERRUPTED');
            const task = this.get('tasks', id);
            if (terminal.has(task.status)) throw new Error('TASK_NOT_RUNNING');
            if (!this.stopped && task.status !== 'PAUSED') return task;
            await new Promise<void>((resolve, reject) => {
                const abort = () => { clearTimeout(timer); reject(new Error('TASK_INTERRUPTED')); };
                const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, 50);
                signal?.addEventListener('abort', abort, { once: true });
                if (signal?.aborted) abort();
            });
        }
    }
    private async gateModel(request: { conversationId: number; signal?: AbortSignal }) {
        const task = this.list('tasks').find(t => ['RUNNING', 'WAITING_APPROVAL', 'PAUSED'].includes(t.status) && t.piSubmissionId !== null && request.conversationId === this.get('conversations', t.conversationId).piConversationId);
        if (!task) throw new Error('BUDGET_TASK_UNRESOLVED');
        await this.waitForTask(task.id, request.signal);
    }
    private admitModel(request: {
        model: unknown;
        context: unknown;
        options: unknown;
        conversationId:number;
    }) { this.requireWrite(); const candidates = this.list('tasks').filter(t => ['RUNNING', 'WAITING_APPROVAL'].includes(t.status)); const task = candidates.find(t => request.conversationId === this.get('conversations',t.conversationId).piConversationId); if (!task)
        throw new Error('BUDGET_TASK_UNRESOLVED'); const model = request.model as RecordData; const input = Buffer.byteLength(JSON.stringify(request.context ?? {}), 'utf8') + 1024; const output = Math.min(task.budget.maxOutputTokens, task.budget.maxTokens - task.usage.reservedTokens - input); const cost = model?.cost; if (!cost || !Number.isFinite(cost.input) || !Number.isFinite(cost.output))
        throw new Error('BUDGET_PRICE_UNKNOWN'); const reserve = (input * Math.max(cost.input,cost.cacheRead??0,cost.cacheWrite??0) + Math.max(0, output) * cost.output) / 1e6; const day = new Date().toISOString().slice(0, 10); const daily = this.store.setting<number>(`cost:${day}`, 0); const limit = this.store.setting<RecordData>('config', {}).dailyBudget ?? 10; if (output < 1 || task.usage.reservedCost + reserve > task.budget.maxCost || daily + reserve > limit || task.usage.modelCalls >= task.budget.maxTurns || Date.now() - task.startedAt > task.budget.maxDurationMs)
        {this.change(task,'FAILED','BUDGET_EXHAUSTED');throw new Error('BUDGET_EXHAUSTED');} this.store.transaction(() => { this.store.put('tasks', task.id, { ...task, usage: { ...task.usage, reservedTokens: task.usage.reservedTokens + input + output, reservedCost: task.usage.reservedCost + reserve, modelCalls: task.usage.modelCalls + 1 } }); this.store.setSetting(`cost:${day}`, daily + reserve); }); return { maxTokens: output }; }
    async tool(call: Parameters<NonNullable<RuntimeOptions['toolGateway']>>[0], execute: () => Promise<any>) {
        const found = this.list('tasks').find(t => call.requestIds.some(id=>id===t.id||id===t.piRequestId));
        if (!found?.principalId)
            throw new Error('PRINCIPAL_REQUIRED');
        let task: RecordData = await this.waitForTask(found.id, call.signal);
        this.requireWrite();
        if (!['RUNNING', 'WAITING_APPROVAL'].includes(task.status))
            throw new Error('TASK_NOT_RUNNING');
        if(call.name==='skill_load'&&this.store.get<RecordData>('skill_settings',String((call.args as RecordData).name))?.enabled===false)throw new Error('SKILL_DISABLED');
        const input: ToolCall = { name: call.name, args: call.args, taskId: task.id, principalId: task.principalId };
        const decision = this.policy.check(input);
        if (decision.decision === 'DENY')
            throw new Error(decision.reason);
        const opId = hash({ taskId: task.id, callId: call.callId, operationHash: decision.operationHash });
        const uncertain = this.list('operations').find(o => o.taskId === task.id && o.operationHash === decision.operationHash && ['SENDING', 'UNCERTAIN'].includes(o.state));
        if (uncertain)
            throw new Error('OPERATION_UNCERTAIN');
        const previous = this.store.get<RecordData>('operations', opId);
        if (previous?.state === 'CONFIRMED')
            return previous.receipt;
        if (previous && ['SENDING', 'UNCERTAIN'].includes(previous.state))
            throw new Error('OPERATION_UNCERTAIN');
        let approval: Approval | undefined;
        if (decision.decision === 'APPROVAL_REQUIRED') {
            approval = this.list('approvals').find(a => a.operationHash === decision.operationHash && a.status === 'APPROVED') as Approval | undefined;
            if (!approval) {
                approval = this.policy.requestApproval(input);
                if (task.status === 'RUNNING')
                    task = this.change(task, 'WAITING_APPROVAL');
                while (!this.closed && !call.signal?.aborted) {
                    const a = this.get('approvals', approval.id);
                    if (a.status === 'APPROVED') {
                        approval = a as Approval;
                        break;
                    }
                    if (a.status !== 'PENDING' || a.expiresAt <= Date.now())
                        throw new Error('APPROVAL_REJECTED_OR_EXPIRED');
                    await new Promise(r => setTimeout(r, 100));
                }
                if (this.closed || call.signal?.aborted)
                    throw new Error('APPROVAL_INTERRUPTED');
            }
        }
        task = await this.waitForTask(task.id, call.signal);
        if (!['RUNNING', 'WAITING_APPROVAL'].includes(task.status))
            throw new Error('TASK_NOT_RUNNING');
        if (task.usage.toolCalls >= task.budget.maxTools || Date.now() - task.startedAt > task.budget.maxDurationMs)
            {this.change(task,'FAILED','TOOL_BUDGET_EXHAUSTED');throw new Error('TOOL_BUDGET_EXHAUSTED');}
        this.store.transaction(() => { if (approval && !this.policy.consume(approval.id, input))
            throw new Error('APPROVAL_INVALID'); if (task.status === 'WAITING_APPROVAL')
            task = this.change(task, 'RUNNING'); this.store.put('tasks', task.id, { ...task, usage: { ...task.usage, toolCalls: task.usage.toolCalls + 1 } }); this.store.put('operations', opId, { id: opId, taskId: task.id, callId: call.callId, operationHash: decision.operationHash, state: 'SENDING', risk: this.get('tools', call.name).sideEffect }); });
        try {
            let receipt: any;
            const memoryScope = this.get('conversations', task.conversationId).scope ?? 'owner';
            if(call.name==='memory_list')receipt=this.list('memories').filter(m=>m.status==='active'&&m.scope===memoryScope&&(!m.expires_at||m.expires_at>Date.now()));
            else if (call.name === 'memory_search')
                receipt = this.store.searchMemories(String((call.args as RecordData).query), memoryScope);
            else if (call.name === 'memory_save') {
                if (task.principalId !== 'owner')
                    throw new Error('MEMORY_WRITE_REQUIRES_OWNER');
                receipt = this.memory({ kind: 'semantic', scope: 'owner', content: (call.args as RecordData).content, source: `task:${task.id}`, confidence: 1 });
            }
            else if (call.name === 'memory_delete') {
                if(task.principalId!=='owner')throw new Error('MEMORY_WRITE_REQUIRES_OWNER');
                this.store.remove('memories', String((call.args as RecordData).id));
                receipt = { deleted: true };
            }
            else
                receipt = await execute();
            this.store.put('operations', opId, { ...this.get('operations', opId), state: 'CONFIRMED', receipt });
            return receipt;
        }
        catch (e) {
            this.store.put('operations', opId, { ...this.get('operations', opId), state: this.get('tools', call.name).sideEffect === 'non_idempotent_write' ? 'UNCERTAIN' : 'FAILED' });
            throw e;
        }
    }
    private async observe(t: RecordData) { if (this.observers.has(t.id))
        return; const c = this.get('conversations', t.conversationId); const observation = await this.adapter.observe(c.piConversationId, () => { if (!this.closed && !this.stopped && !this.store.maintenance && !this.diskLow)
        this.store.event('conversation.changed', c.id, { taskId: t.id }); }); this.observers.set(t.id, observation.detach); }
    async tick() { if (this.busy || this.closed)
        return; this.busy = true; try {
        await this.probeDisk();
        if (this.diskLow || this.store.maintenance || this.stopped)
            return;
        await this.finishTasks();
        for(const t of this.list('tasks').filter(t=>t.status==='RETRY_WAIT'&&t.nextRetryAt<=Date.now()))this.change(t,'QUEUED');
        for(const [id,detach] of this.observers)if(terminal.has(this.get('tasks',id).status)){detach();this.observers.delete(id);}
        this.cleanup();
        await this.automate();
        const active = this.list('tasks').filter(t => ['RUNNING', 'WAITING_APPROVAL'].includes(t.status) || (t.status === 'PAUSED' && t.piSubmissionId));
        for (const t of this.list('tasks').filter(t => t.status === 'QUEUED')) {
            if (active.length >= 2)
                break;
            if (active.some(a => a.conversationId === t.conversationId))
                continue;
            let running = this.change(t, 'RUNNING');
            running = { ...running, startedAt: t.startedAt??Date.now() };
            this.store.put('tasks', t.id, running);
            active.push(running);
            try {
                const c = await this.ensureConversation(this.get('conversations', t.conversationId));
                await this.adapter.dispatch('conversation.configure',{id:c.piConversationId,maxTurns:Math.min(12,t.budget.maxTurns),...(t.retryProvider?{provider:t.retryProvider.id,model:t.retryProvider.model}:{}),...(t.systemPrompt?{systemPrompt:t.systemPrompt}:{})});
                const submitted = await this.adapter.dispatch('input.submit', { conversationId: c.piConversationId, requestId: t.piRequestId??t.id, content: t.goal });
                this.store.put('tasks', t.id, { ...this.get('tasks', t.id), piSubmissionId: submitted.id });
                await this.observe(this.get('tasks', t.id));
            }
            catch {
                this.change(this.get('tasks', t.id), 'FAILED', 'SUBMISSION_FAILED');
            }
        }
        await this.channels();
        for(const task of this.list('tasks').filter(t=>t.channelId&&terminal.has(t.status))){const deliveries=this.list('outbox').filter(o=>o.taskId===task.id);if(!deliveries.length)continue;const status=deliveries.every(o=>o.state==='SENT')?'SENT':deliveries.some(o=>o.state==='DELIVERY_UNCERTAIN')?'DELIVERY_UNCERTAIN':deliveries.some(o=>o.state==='FAILED')?'FAILED':'PENDING';if(task.deliveryStatus!==status){this.store.put('tasks',task.id,{...task,deliveryStatus:status});this.store.event('delivery.changed',task.id,{status});}}
    }
    catch {
        this.lastError = 'WORKER_ERROR';
    }
    finally {
        this.busy = false;
    } }
    private async finishTasks() { for (const t of this.list('tasks').filter(t => ['RUNNING', 'WAITING_APPROVAL'].includes(t.status) && t.piSubmissionId)) {
        const result = await this.adapter.dispatch('input.get', { id: t.piSubmissionId });
        if (['done', 'unanswered', 'withdrawn'].includes(result.status)) {
            const retryable=result.status==='unanswered'&&result.reason==='model_error'&&(t.modelFailure?.retryable===true||/\b429\b|\b5\d\d\b|timeout|timed out/i.test(String(result.detail??'')));
            const unsafe=this.list('operations').some(o=>o.taskId===t.id&&o.risk!=='read');
            if(retryable&&!unsafe&&t.attempt<2&&Date.now()-t.startedAt<t.budget.maxDurationMs){const providers=this.list('providers').sort((a,b)=>(a.priority??0)-(b.priority??0));const retry=this.change(t,'RETRY_WAIT','TRANSIENT_MODEL_ERROR');const attempt=t.attempt+1;this.store.put('tasks',t.id,{...retry,attempt,piSubmissionId:undefined,piRequestId:`${t.id}:attempt:${attempt}`,retryProvider:providers[Math.min(attempt,providers.length-1)],nextRetryAt:Date.now()+500*2**t.attempt+Math.floor(Math.random()*100)});this.observers.get(t.id)?.();this.observers.delete(t.id);continue;}
            const next = this.change(t, result.status === 'done' ? 'SUCCEEDED' : result.status === 'withdrawn' ? 'CANCELLED' : 'FAILED', result.status === 'unanswered' ? 'MODEL_OR_BUDGET_FAILURE' : undefined);
            const live = await this.adapter.dispatch('conversation.live', { id: this.get('conversations', t.conversationId).piConversationId });
            this.store.put('tasks', t.id, { ...next, result: result.answerText, piUsage: live.usage, deliveryStatus: t.channelId ? 'PENDING' : 'NOT_REQUIRED' });
            this.store.put('model_usage', t.id, { id: t.id, taskId: t.id, conversationId: t.conversationId, usage: live.usage, at: Date.now() });
            this.observers.get(t.id)?.();
            this.observers.delete(t.id);
            if (t.channelId && result.answerText) {
                const automation = t.scheduleId ? this.store.get<RecordData>('schedules', t.scheduleId) : t.heartbeatId ? this.store.get<RecordData>('heartbeats', t.heartbeatId) : undefined;
                const digest = hash(result.answerText);
                if (!automation?.onlyOnChange || automation.lastResultHash !== digest)
                    this.enqueueOutbox(t, result.answerText);
                if (automation)
                    this.store.put(t.scheduleId ? 'schedules' : 'heartbeats', automation.id, { ...automation, lastResultHash: digest });
            }
        }
        else if (Date.now() - t.startedAt > t.budget.maxDurationMs) {
            await this.adapter.dispatch('conversation.cancel', { id: this.get('conversations', t.conversationId).piConversationId });
            this.change(t, 'FAILED', 'TIME_BUDGET_EXHAUSTED');
        }
    } }
    private cleanup(){const now=Date.now();if(this.store.setting<number>('lastCleanup',0)>now-3600000)return;this.maintenance.retention(now);this.store.setSetting('lastCleanup',now);}
    async taskAction(id: string, action: string) { const t = this.get('tasks', id); if (action === 'pause') {
        const paused = this.change(t, 'PAUSED');
        this.store.put('tasks', id, { ...paused, pausedFrom: t.status });
        return this.get('tasks', id);
    } if (action === 'resume')
        return this.change(t, t.piSubmissionId ? (t.pausedFrom === 'WAITING_APPROVAL' ? 'WAITING_APPROVAL' : 'RUNNING') : 'QUEUED'); if (action === 'cancel') {
        const cancelled = this.change(t, 'CANCELLED');
        if (t.piSubmissionId && ['RUNNING', 'WAITING_APPROVAL', 'PAUSED'].includes(t.status))
            await this.adapter.dispatch('conversation.cancel', { id: this.get('conversations', t.conversationId).piConversationId });
        return cancelled;
    } if (action === 'retry') {
        if (!terminal.has(t.status))
            throw new ApiError(409, 'TASK_NOT_TERMINAL');
        if (this.list('operations').some(o => o.taskId === id && ['UNCERTAIN', 'SENDING'].includes(o.state)))
            throw new ApiError(409, 'OPERATION_UNCERTAIN');
        return this.createTask(t.conversationId, t.goal, t.source, randomUUID(), { principalId: t.principalId, retryOf: id });
    } throw new ApiError(400, 'INVALID_ACTION'); }
    preview(expression: string, timezone: string, start = Date.now()) { try {
        return CronExpressionParser.parse(expression, { tz: timezone, currentDate: new Date(start) }).take(5).map(d => d.toISOString());
    }
    catch {
        throw new ApiError(400, 'INVALID_CRON');
    } }
    async schedule(body: RecordData, id?: string) { fields(body, ['name', 'expression', 'timezone', 'prompt', 'misfirePolicy', 'overlapPolicy', 'channelId', 'threadId', 'onlyOnChange', 'enabled', 'conversationId']); const old = id ? this.get('schedules', id) : {}; const value: RecordData = { ...old, ...body, id: id ?? randomUUID() }; string(value.name, 100); string(value.prompt); value.timezone ??= this.store.setting('timezone', 'UTC'); value.misfirePolicy ??= 'skip'; value.overlapPolicy ??= 'skip_if_running'; if (!['skip', 'coalesce', 'catch-up-one'].includes(value.misfirePolicy) || !['skip_if_running', 'queue_one'].includes(value.overlapPolicy))
        throw new ApiError(400, 'INVALID_POLICY'); value.nextFireAt = Date.parse(this.preview(string(value.expression, 200), value.timezone)[0]!); value.enabled ??= true; if (!value.conversationId)
        value.conversationId = (await this.conversation({ name: value.name })).id;
    else
        this.get('conversations', value.conversationId); this.store.put('schedules', value.id, value); return value; }
    heartbeat(body: RecordData, id?: string) { fields(body, ['conversationId', 'intervalSeconds', 'prompt', 'onlyOnChange', 'enabled', 'channelId', 'threadId']); const v: RecordData = { ...(id ? this.get('heartbeats', id) : {}), ...body, id: id ?? randomUUID() }; this.get('conversations', string(v.conversationId)); positive(v.intervalSeconds, 10, 31536000); string(v.prompt); v.enabled ??= true; v.nextFireAt = Date.now() + v.intervalSeconds * 1000; this.store.put('heartbeats', v.id, v); return v; }
    private async automate() { const tasks = this.list('tasks'); for (const s of this.list('schedules').filter(s => s.enabled && s.nextFireAt <= Date.now())) {
        const active = tasks.some(t => t.scheduleId === s.id && !terminal.has(t.status));
        const late = Date.now() - s.nextFireAt > 60000;
        const key = `cron:${s.id}:${s.nextFireAt}`;
        if (active) {
            if (s.overlapPolicy === 'queue_one')
                s.pending = true;
        }
        else if (!late || s.misfirePolicy !== 'skip')
            this.createTask(s.conversationId, s.prompt, 'cron', key, { scheduleId: s.id, channelId: s.channelId, threadId: s.threadId });
        this.store.put('schedules', s.id, { ...s, nextFireAt: Date.parse(this.preview(s.expression, s.timezone)[0]!) });
    } for (const s of this.list('schedules').filter(s => s.enabled && s.pending)) {
        if (!this.list('tasks').some(t => t.scheduleId === s.id && !terminal.has(t.status))) {
            this.createTask(s.conversationId, s.prompt, 'cron', `coalesced:${s.id}:${s.nextFireAt}`, { scheduleId: s.id, channelId: s.channelId, threadId: s.threadId });
            this.store.put('schedules', s.id, { ...s, pending: false });
        }
    } for (const h of this.list('heartbeats').filter(h => h.enabled && (h.pending || h.nextFireAt <= Date.now()))) {
        const busy = this.list('tasks').some(t => t.conversationId === h.conversationId && !terminal.has(t.status));
        if (busy)
            this.store.put('heartbeats', h.id, { ...h, pending: true, nextFireAt: Date.now() + h.intervalSeconds * 1000 });
        else {
            this.createTask(h.conversationId, h.prompt, 'heartbeat', `heartbeat:${h.id}:${h.nextFireAt}`, { heartbeatId: h.id, channelId: h.channelId, threadId: h.threadId });
            this.store.put('heartbeats', h.id, { ...h, pending: false, lastFireAt: Date.now(), nextFireAt: Date.now() + h.intervalSeconds * 1000 });
        }
    } }
    memory(body: RecordData, id?: string) { fields(body, ['kind', 'scope', 'content', 'source', 'confidence', 'expiresAt', 'status']); const old = id ? this.get('memories', id) : {}; const v: RecordData = { ...old, ...body, id: id ?? randomUUID(), created_at: old.created_at ?? Date.now(), updated_at: Date.now() }; if (!['working', 'episodic', 'semantic', 'procedural'].includes(v.kind))
        throw new ApiError(400, 'INVALID_MEMORY_KIND'); string(v.scope, 200); string(v.content, 10000); string(v.source, 500); v.confidence=positive(v.confidence ?? 1, 0, 1); v.status ??= 'active'; if (!['active', 'blocked', 'expired', 'deleted'].includes(v.status))
        throw new ApiError(400, 'INVALID_STATUS'); if (v.expiresAt != null) {
        const n = Date.parse(v.expiresAt);
        if (!Number.isFinite(n))
            throw new ApiError(400, 'INVALID_EXPIRY');
        v.expires_at = n;
        delete v.expiresAt;
    } this.store.put('memories', v.id, v, 'owner'); return v; }
    async provider(body: RecordData, id?: string) { if(this.list('tasks').some(t=>['RUNNING','WAITING_APPROVAL'].includes(t.status)))throw new ApiError(409,'PROVIDER_CHANGE_REQUIRES_IDLE'); fields(body, ['name', 'vendor', 'model', 'apiKey', 'priority', 'dailyBudget', 'taskBudget']); const value: RecordData = { ...(id ? this.get('providers', id) : {}), ...body, id: id ?? randomUUID(), status: 'unverified' }; string(value.model, 100); if (value.vendor !== 'openai')
        throw new ApiError(400, 'UNSUPPORTED_PROVIDER'); if (body.apiKey !== undefined) {
        this.store.setSecret(`provider:${value.id}`, string(body.apiKey, 2000));
        delete value.apiKey;
    } this.store.put('providers', value.id, value); await this.configureProviders(); return { ...value, configured: !!this.store.getSecret(`provider:${value.id}`) }; }
    channel(body: RecordData, id?: string) { fields(body, ['name', 'type', 'token', 'allowedUsers', 'enabled']);if(body.enabled!==undefined&&typeof body.enabled!=='boolean')throw new ApiError(400,'INVALID_INPUT'); const v: RecordData = { ...(id ? this.get('channels', id) : {}), ...body, id: id ?? randomUUID(), status: 'disabled' }; if (v.type !== 'telegram' || !Array.isArray(v.allowedUsers) || v.allowedUsers.some((u: unknown) => typeof u !== 'string' || !/^\d+$/.test(u)))
        throw new ApiError(400, 'INVALID_CHANNEL'); if (body.token !== undefined) {
        this.store.setSecret(`channel:${v.id}`, string(body.token, 300));
        delete v.token;
    } v.enabled ??= false; v.status = v.enabled ? 'reconnecting' : 'disabled'; this.store.put('channels', v.id, v); return v; }
    async inbound(channelId: string, m: Inbound) { this.requireWrite(); const c = this.get('channels', channelId); if (!c.allowedUsers.includes(m.user)) {
        this.store.audit('external', 'inbound.denied', m.user, 'denied');
        return;
    } if (m.text.length > 32000)
        throw new ApiError(413, 'MESSAGE_TOO_LARGE'); const principalId = `telegram:${m.account}:${m.user}`; this.store.put('principals', principalId, { id: principalId, allowed: true, permissions: ['current_time', 'memory_search', 'read_file', 'web_fetch', 'web_search'] }); const thread = `telegram:${channelId}:${m.chat}`; let conversation = this.list('conversations').find(v => v.threadKey === thread); if (!conversation) {
        conversation = { id: randomUUID(), name: 'Telegram', status: 'active', channelId, threadKey: thread, scope: principalId };
        this.store.put('conversations', conversation.id, conversation);
        conversation = await this.ensureConversation(conversation);
    } return this.createTask(conversation.id, m.text, 'telegram', `telegram:${m.account}:${m.id}`, { principalId, channelId, threadId: m.chat }); }
    private enqueueOutbox(t: RecordData, text: string) { chunks(text, 3500).forEach((content, index) => { const id = `${t.id}:${index}`; if (!this.store.get('outbox', id))
        this.store.put('outbox', id, { id, dedupe_key: id, taskId: t.id, channelId: t.channelId, threadId: t.threadId, content, state: 'PENDING', attempts: 0, nextRetryAt: 0 }); }); }
    private async channels() { for (const c of this.list('channels').filter(c => c.enabled)) {
        const token = this.store.getSecret(`channel:${c.id}`);
        if (!token)
            continue;
        const adapter = telegramAdapter(token, c.allowedUsers, undefined, this.options.fetcher);
        if (!this.pollBusy.has(c.id)) {
            this.pollBusy.add(c.id);
            void adapter.poll!(this.store.setting(`cursor:${c.id}`, ''), this.abort.signal).then(async (page) => { if (this.closed || this.diskLow || this.stopped)
                return; for (const m of page.messages)
                await this.inbound(c.id, m); if (!this.closed) {
                this.store.setSetting(`cursor:${c.id}`, page.cursor);
                this.store.put('channels', c.id, { ...this.get('channels', c.id), status: 'connected' });
            } }).catch(() => { if (!this.closed && !this.stopped && !this.diskLow)
                this.store.put('channels', c.id, { ...this.get('channels', c.id), status: 'reconnecting', lastError: 'POLL_FAILED' }); }).finally(() => this.pollBusy.delete(c.id));
        }
        for (const out of this.list('outbox').filter(o => o.channelId === c.id && ['PENDING', 'RETRY_WAIT'].includes(o.state) && o.nextRetryAt <= Date.now())) {
            const current = this.get('channels', c.id);
            if (!current.enabled || !current.allowedUsers.includes(out.threadId)) {
                this.store.put('outbox', out.id, { ...out, state: 'FAILED', lastError: 'RECIPIENT_NOT_ALLOWED' });
                this.store.audit('system', 'outbound.denied', out.id, 'denied');
                continue;
            }
            this.store.put('outbox', out.id, { ...out, state: 'SENDING', attempts: out.attempts + 1 });
            try {
                const receipt = await adapter.send({ key: '', platform: 'telegram', account: adapter.account, chat: out.threadId, user: '', scope: '', conversationId: 0, contextToken: '', lastInboundAt: 0 }, out.content, out.id, this.abort.signal);
                this.store.put('outbox', out.id, { ...out, state: 'SENT', externalId: receipt.id });
            }
            catch (e) {
                const safe = e instanceof SendFailure && e.kind === 'rate_limited';
                this.store.put('outbox', out.id, { ...out, attempts: out.attempts + 1, state: safe && out.attempts < 4 ? 'RETRY_WAIT' : e instanceof SendFailure && e.kind === 'rejected' ? 'FAILED' : 'DELIVERY_UNCERTAIN', nextRetryAt: Date.now() + Math.min(3600000, 1000 * 2 ** out.attempts) });
            }
        }
    } }
    summary() { const tasks = this.list('tasks'); return { adapter: this.adapterReady ? 'ready' : 'unavailable', maintenance: this.store.maintenance, diskLow: this.diskLow, readOnly: this.stopped || this.diskLow || this.store.maintenance, runningTasks: tasks.filter(t => ['RUNNING', 'WAITING_APPROVAL'].includes(t.status)).length, queueDepth: tasks.filter(t => t.status === 'QUEUED').length, pendingApprovals: this.list('approvals').filter(a => a.status === 'PENDING').length, providers: this.list('providers').map(p => ({ id: p.id, status: p.status ?? 'unverified', configured: !!this.store.getSecret(`provider:${p.id}`) })), rss: process.memoryUsage().rss, lastError: this.lastError, schemaVersion: this.store.schemaVersion }; }
    private async closeAdapter() {
        if (!this.adapterReady) return;
        for (const detach of this.observers.values()) detach();
        this.observers.clear();
        await this.adapter.close();
        this.adapterReady = false;
    }
    private get operations() {
        return this.operationsService ??= new OperationsService(() => this.store, this.options.dataDir, {
            quiesce: async () => {
                this.requireWrite();
                this.stopped = true;
                let closing = false;
                try {
                    const deadline = Date.now() + 30000;
                    while (this.busy) {
                        if (Date.now() >= deadline) throw new ApiError(409, 'WORKER_BUSY');
                        await new Promise(r => setTimeout(r, 20));
                    }
                    closing = true;
                    await this.closeAdapter();
                } catch (error) { if (!closing) this.stopped = false; throw error; }
            },
            piBackup: async destination => {
                const reader = new DatabaseSync(join(this.options.dataDir, 'pi', 'state.sqlite'), { readOnly: true });
                try { await backup(reader, destination); } finally { reader.close(); }
            },
            closeStores: async () => {
                await this.closeAdapter();
                this.store.close();
                this.storeClosed = true;
                for (const suffix of ['', '-wal', '-shm'])
                    await rm(join(this.options.dataDir, 'pi', 'history.sqlite' + suffix), { force: true });
            },
            reopenStores: async () => {
                if (this.storeClosed) {
                    this.store = new ControlStore(this.options.dataDir);
                    this.storeClosed = false;
                    this.auth = new AuthService(this.store);
                    this.policy = new PolicyGateway(this.store);
                }
                if (!this.adapterReady) await this.openAdapter();
            },
            resume: async () => {
                if (!this.adapterReady) await this.openAdapter();
                await this.reconcile();
                this.stopped = false;
            },
        });
    }
    async listBackups() { return this.operations.listBackups(); }
    async snapshot() { return this.operations.createBackup(); }
    async restore(id: string) { return this.operations.restore(id); }
    get maintenanceActive() { return this.stopped; }
    async close() {
        this.closed = true;
        clearInterval(this.timer);
        this.abort.abort();
        try { await this.closeAdapter(); } finally {
            try { this.store.close(); } finally { await this.releaseOwnership?.(); }
        }
    }

}
