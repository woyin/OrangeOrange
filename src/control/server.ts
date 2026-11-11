import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { ControlService, ApiError, fields, string, type RecordData, type ServiceOptions } from './service.js';
import { hash } from './store.js';
import { ArtifactError, decodeBase64 } from './artifacts.js';
import { compatibilityMatrix } from '../migrations/index.js';
import { MigrationSourceError } from '../migrations/source.js';
import { MigrationImportError } from '../migrations/importers.js';
import { AppError } from './apps.js';
import { OAuthError, MimeError } from '../connectors/index.js';
export interface ServerOptions extends ServiceOptions {
    host?: string;
    port?: number;
    webDir?: string;
    publicOrigin?: string;
    trustProxy?: boolean;
}
const equal = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export async function startControlServer(options: ServerOptions) {
    const service = await ControlService.open({ ...options, oauthRedirectUris: options.oauthRedirectUris ?? (options.publicOrigin ? [new URL('/api/v1/oauth/google/callback', options.publicOrigin).href] : []) });
    const streams = new Set<ServerResponse>();
    const inflight = new Map<string, Promise<any>>();
    const server = createServer((req, res) => void handle(req, res));
    let base = '';
    const send = (res: ServerResponse, status: number, value: unknown, id: string) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(status >= 400 ? { error: value, requestId: id } : { data: value, requestId: id })); };
    async function body(req: IncomingMessage, maxBytes = 65536) { let size = 0; const chunks: Buffer[] = []; for await (const chunk of req) {
        size += chunk.length;
        if (size > maxBytes)
            throw new ApiError(413, 'BODY_TOO_LARGE');
        chunks.push(chunk);
    } try {
        const b = JSON.parse(Buffer.concat(chunks).toString() || '{}');
        if (!b || typeof b !== 'object' || Array.isArray(b))
            throw new Error();
        return b as RecordData;
    }
    catch {
        throw new ApiError(400, 'INVALID_JSON');
    } }
    function token(req: IncomingMessage) { return /(?:^|;\s*)hda_session=([^;]+)/.exec(req.headers.cookie ?? '')?.[1] ?? ''; }
    function rate(req: IncomingMessage, path: string) { const key = `${req.socket.remoteAddress}:${path.includes('/auth/') ? 'auth' : 'write'}`; const now = Date.now(); const old = service.store.get<RecordData>('rate_limits', key); const next = old && old.until > now ? { ...old, count: old.count + 1 } : { count: 1, until: now + 60000 }; if (next.count > (path.includes('/auth/') ? 12 : 120))
        throw new ApiError(429, 'RATE_LIMITED'); if (!service.store.maintenance)
        service.store.put('rate_limits', key, next); }
    function origin(req: IncomingMessage) { const expected = options.publicOrigin ?? `http://${req.headers.host}`; const supplied = req.headers.origin; if (!supplied || supplied !== expected)
        throw new ApiError(403, 'ORIGIN_REJECTED'); const u = new URL(expected); if (u.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname))
        throw new ApiError(403, 'HTTPS_REQUIRED'); }
    function cookie(res: ServerResponse, value: string, req: IncomingMessage, clear = false) { const secure = (options.publicOrigin ?? base).startsWith('https:'); res.setHeader('Set-Cookie', `hda_session=${value}; HttpOnly; SameSite=Strict; Path=/; ${secure ? 'Secure; ' : ''}Max-Age=${clear ? 0 : 86400}`); }
    async function handle(req: IncomingMessage, res: ServerResponse) {
        const requestId = randomUUID();
        let path = '';
        try {
            const url = new URL(req.url ?? '/', base);
            path = url.pathname;
            const method = req.method ?? 'GET';
            const write = !['GET', 'HEAD'].includes(method);
            res.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'");
            if (path === '/health/live') {
                send(res, 200, { status: 'live' }, requestId);
                return;
            }
            if (path === '/health/ready') {
                const ready = service.ready();
                send(res, ready ? 200 : 503, { status: ready ? 'ready' : 'protected' }, requestId);
                return;
            }
            if (!path.startsWith('/api/v1/')) {
                if (write)
                    throw new ApiError(405, 'METHOD_NOT_ALLOWED');
                if (!options.webDir)
                    throw new ApiError(404, 'NOT_FOUND');
                const root = resolve(options.webDir);
                let file = resolve(root, '.' + decodeURIComponent(path));
                if (file !== root && !file.startsWith(root + sep))
                    throw new ApiError(403, 'PATH_DENIED');
                try {
                    if (!(await stat(file)).isFile())
                        file = resolve(root, 'index.html');
                }
                catch {
                    file = resolve(root, 'index.html');
                }
                const data = await readFile(file);
                res.writeHead(200, { 'Content-Type': ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' } as Record<string, string>)[extname(file)] ?? 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' });
                res.end(data);
                return;
            }
            const route = path.slice('/api/v1/'.length);
            if (service.maintenanceActive) throw new ApiError(503, 'MAINTENANCE_BUSY');
            if (route === 'setup/status' && method === 'GET') {
                send(res, 200, { initialized: service.store.setting('initialized', false) }, requestId);
                return;
            }
            if (write) {
                origin(req);
                rate(req, path);
            }
            if ((route === 'setup' || route === 'auth/login') && method === 'POST') {
                const b = await body(req);
                if (route === 'setup') {
                    fields(b, ['username', 'password', 'timezone', 'provider', 'telegram']);
                    service.requireWrite();
                    service.auth.setup({ username: string(b.username, 100), password: string(b.password, 1024), timezone: string(b.timezone, 100) });
                    if (b.provider)
                        await service.provider({ ...b.provider, name: '主模型' });
                    if (b.telegram)
                        service.channel({ type: 'telegram', name: 'Telegram', token: b.telegram.token, allowedUsers: b.telegram.allowedUsers, enabled: true });
                }
                else
                    fields(b, ['username', 'password']);
                const login = service.auth.login(string(b.username, 100), string(b.password, 1024));
                cookie(res, login.token, req);
                send(res, 200, { username: b.username, csrf: login.csrf }, requestId);
                return;
            }
            if (route === 'oauth/google/callback' && method === 'GET') {
                rate(req, path);
                res.setHeader('Referrer-Policy', 'no-referrer');
                if (url.searchParams.has('error')) await service.externalOperation(() => service.apps.cancelAuthorization(string(url.searchParams.get('state'), 512)));
                else await service.externalOperation(() => service.apps.complete(string(url.searchParams.get('state'), 512), string(url.searchParams.get('code'), 4096)));
                res.writeHead(303, { Location: '/', 'Cache-Control': 'no-store' }); res.end(); return;
            }
            const session = service.auth.authenticate(token(req));
            if (!session)
                throw new ApiError(401, 'AUTH_REQUIRED');
            if (write && !equal(String(req.headers['x-csrf-token'] ?? ''), session.csrf))
                throw new ApiError(403, 'CSRF_REJECTED');
            if (route === 'auth/session' && method === 'GET') {
                send(res, 200, { username: service.get('users', session.userId).username, csrf: session.csrf }, requestId);
                return;
            }
            if (route === 'events/stream' && method === 'GET') {
                let cursor = Number(url.searchParams.get('cursor') ?? req.headers['last-event-id'] ?? 0);
                if (!Number.isSafeInteger(cursor) || cursor < 0)
                    throw new ApiError(400, 'INVALID_CURSOR');
                res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
                streams.add(res);res.flushHeaders();
                const first = service.store.events(0, 1)[0];
                const latest=Number(service.store.db.prepare("SELECT seq FROM sqlite_sequence WHERE name='events'").get()?.seq??0);
                if (cursor>latest || (cursor>0&&(first?cursor<first.event_id-1:cursor<latest))) {
                    res.write('event: reset\ndata: {"reason":"CURSOR_EXPIRED"}\n\n');
                    cursor = 0;
                }
                const flush = () => { if (service.maintenanceActive) return; if (!service.auth.authenticate(token(req))) {
                    res.end();
                    return;
                } const events = service.store.events(cursor, 1000); for (const event of events) {
                    res.write(`id: ${event.event_id}\nevent: message\ndata: ${JSON.stringify(event)}\n\n`);
                    cursor = event.event_id;
                } };
                flush();
                const interval = setInterval(flush, 500);
                req.on('close', () => { clearInterval(interval); streams.delete(res); });
                return;
            }
            const b = write ? await body(req, route === 'artifacts' ? 12 * 1024 * 1024 : route === 'migrations' ? 24 * 1024 * 1024 : 65536) : {};
            if (write && route !== 'auth/logout' && route !== 'auth/password')
                service.requireWrite();
            const action = async () => {
                const p = route.split('/');
                const [resource, id, sub] = p;
                if (resource === 'migrations') {
                    if (id === 'compatibility' && method === 'GET') return { items: compatibilityMatrix, nextCursor: null };
                    if (id === 'history') {
                        if (!sub && method === 'GET') return { items: service.migrations.engine.listHistory(url.searchParams.get('search') ?? ''), nextCursor: null };
                        if (sub && p[3] === 'continue' && method === 'POST') {
                            fields(b, ['name', 'messageLimit']);
                            const background = service.migrations.engine.continuation(sub, b.messageLimit ?? 10);
                            const c = await service.conversation({ name: b.name ? string(b.name, 100) : '从迁移历史继续' });
                            const next = { ...c, continuedFromImportedConversationId: sub, importedBackground: JSON.stringify(background).slice(0, 8000) };
                            service.store.put('conversations', c.id, next, 'owner'); return next;
                        }
                        if (sub && method === 'GET') {
                            const history = service.migrations.engine.listHistory().find(h => h.id === sub); if (!history) throw new ApiError(404, 'MIGRATION_HISTORY_NOT_FOUND'); return history;
                        }
                    }
                    if (id === 'objects' && sub && p[3] === 'memory' && method === 'POST') {
                        fields(b, ['approved', 'scope', 'content']);
                        service.memoryPolicy.assertOwnerWrite({ principalId: 'owner', scope: string(b.scope, 200), content: string(b.content, 10000), kind: 'semantic', source: 'migration-review' }, b.approved === true);
                        return service.migrations.engine.promoteMemory(sub, { approved: b.approved, scope: string(b.scope, 200), content: string(b.content, 10000) });
                    }
                    if (id === 'objects' && sub && p[3] === 'draft' && method === 'POST') {
                        fields(b, ['toolMap', 'requiredTools']); if (b.requiredTools !== undefined && (!Array.isArray(b.requiredTools) || b.requiredTools.some((t: unknown) => typeof t !== 'string'))) throw new ApiError(400, 'INVALID_REQUIRED_TOOLS'); return service.migrations.engine.nativeDraft(sub, { toolMap: b.toolMap, requiredTools: b.requiredTools });
                    }
                    if (id === 'objects' && sub && p[3] === 'review' && method === 'POST') return service.externalOperation(() => service.reviewMigrationObject(sub, b));
                    if (id === 'objects' && sub && p[3] === 'activate' && method === 'POST') { fields(b, ['confirm']); if (b.confirm !== true) throw new ApiError(400, 'CONFIRMATION_REQUIRED'); return service.activateMigrationObject(sub); }
                    if (!id && method === 'GET') return { items: service.migrations.list(), nextCursor: null };
                    if (!id && method === 'POST') {
                        fields(b, ['system', 'instanceId', 'archiveBase64', 'sha256', 'directory', 'workspace']);
                        const instanceId = string(b.instanceId, 200);
                        if (!['openclaw', 'hermes'].includes(b.system)) throw new ApiError(400, 'MIGRATION_INVALID_SYSTEM');
                        if (b.archiveBase64 !== undefined) {
                            if (b.directory !== undefined || b.workspace !== undefined) throw new ApiError(400, 'INVALID_MIGRATION_SOURCE');
                            const archive = decodeBase64(b.archiveBase64, 16 * 1024 * 1024);
                            if (createHash('sha256').update(archive).digest('hex') !== b.sha256) throw new ApiError(409, 'MIGRATION_SOURCE_HASH_MISMATCH');
                            return service.externalOperation(() => service.migrations.scan({ system: b.system, instanceId, archive }));
                        }
                        return service.externalOperation(() => service.migrations.scan({ system: b.system, instanceId, directory: string(b.directory, 4096), ...(b.workspace ? { workspace: string(b.workspace, 4096) } : {}) }));
                    }
                    if (id && sub === 'plan' && method === 'POST') { fields(b, ['choices']); return service.migrations.plan(id, b.choices); }
                    if (id && ['apply', 'rollback'].includes(sub!) && method === 'POST') {
                        fields(b, sub === 'apply' ? ['planHash', 'password', 'confirm'] : ['password', 'confirm']);
                        if (b.confirm !== true || !service.auth.verifyPassword(session.userId, string(b.password, 1024))) throw new ApiError(403, 'REAUTH_REQUIRED');
                        return sub === 'apply' ? service.migrations.apply(id, string(b.planHash, 64)) : service.migrations.rollback(id);
                    }
                    if (id && !sub && method === 'GET') return service.migrations.get(id);
                }
                if (resource === 'app-connections') {
                    if (!id && method === 'GET') return { items: service.apps.list(), nextCursor: null };
                    if (!id && method === 'POST') {
                        fields(b, ['provider', 'label', 'account', 'accountConfirmed', 'clientId', 'clientSecret', 'redirectUri']);
                        return service.apps.create(b as any);
                    }
                    if (id && sub === 'oauth' && p[3] === 'start' && method === 'POST') {
                        fields(b, []); return service.externalOperation(() => service.apps.start(id));
                    }
                    if (id && sub === 'test' && method === 'POST') {
                        fields(b, []); return service.externalOperation(() => service.apps.test(id));
                    }
                    if (id && method === 'DELETE') {
                        fields(b, ['password', 'confirm']);
                        if (b.confirm !== true || !service.auth.verifyPassword(session.userId, string(b.password, 1024))) throw new ApiError(403, 'REAUTH_REQUIRED');
                        return service.externalOperation(() => service.apps.revoke(id));
                    }
                }
                if (resource === 'action-intents') {
                    if (!id && method === 'GET') return { items: service.apps.intents(), nextCursor: null };
                    if (!id && method === 'POST') {
                        fields(b, ['connectionId', 'action', 'input', 'taskId', 'templateId']);
                        return service.proposeWebMail(b);
                    }
                    if (id && sub === 'decision' && method === 'GET') return service.apps.preview(id);
                    if (id && sub === 'decision' && method === 'POST') {
                        fields(b, ['decision', 'inputHash']);
                        if (service.apps.preview(id).intent.inputHash !== b.inputHash) throw new ApiError(409, 'OPERATION_HASH_CONFLICT');
                        if (b.decision === 'APPROVED') return service.apps.approve(id, string(b.inputHash, 64));
                        if (b.decision === 'REJECTED') return service.cancelMailIntent(id);
                        throw new ApiError(400, 'INVALID_DECISION');
                    }
                    if (id && sub === 'send' && method === 'POST') {
                        fields(b, ['inputHash']);
                        return service.externalOperation(() => service.sendMailIntent(id, string(b.inputHash, 64)));
                    }
                    if (id && sub === 'cancel' && method === 'POST') { fields(b, []); return service.cancelMailIntent(id); }
                    if (id && sub === 'dry-run' && method === 'POST') { fields(b, []); return service.apps.dryRun(id); }
                }
                if (resource === 'app-rules') {
                    if (!id && method === 'GET') return { items: service.apps.rules(), nextCursor: null };
                    if (!id && method === 'POST') {
                        fields(b, ['connectionId', 'profileId', 'workflowId', 'templateId', 'templateHash', 'recipients', 'domains', 'minIntervalMs', 'dailyLimit', 'expiresAt', 'forbiddenTypes', 'enabled']);
                        return service.apps.rule(b as any);
                    }
                    if (id && method === 'PATCH') {
                        fields(b, ['enabled']); if (typeof b.enabled !== 'boolean') throw new ApiError(400, 'INVALID_INPUT');
                        const prior = service.apps.rules().find(r => r.id === id); if (!prior) throw new ApiError(404, 'NOT_FOUND');
                        return service.apps.rule({ ...prior, enabled: b.enabled }, id);
                    }
                }
                if (resource === 'app-grants' && method === 'GET') return { items: service.apps.grants(), nextCursor: null };
                if (resource === 'app-grants' && id && method === 'PATCH') { fields(b, ['enabled']); if (typeof b.enabled !== 'boolean') throw new ApiError(400, 'INVALID_INPUT'); return service.apps.setGrantEnabled(id, b.enabled); }
                if (resource === 'app-grants' && method === 'POST') {
                    fields(b, ['connectionId', 'principalId', 'profileId', 'taskId', 'workflowId', 'enabled']);
                    if (b.taskId === '*') {
                        const principal = service.get('principals', string(b.principalId, 200));
                        if (!principal.allowed || b.profileId !== b.principalId || !string(b.workflowId, 200)) throw new ApiError(403, 'PRINCIPAL_PERMISSION_DENIED');
                    } else {
                        const task = service.get('tasks', string(b.taskId, 200));
                        if (task.principalId !== b.principalId) throw new ApiError(403, 'TASK_PRINCIPAL_MISMATCH');
                    }
                    return service.apps.grant(b as any);
                }
                if (resource === 'artifacts') {
                    if (!id && method === 'POST') {
                        fields(b, ['filename', 'mimeType', 'base64', 'sha256']);
                        return service.artifacts.put(b as any);
                    }
                    if (!id && method === 'GET') return { items: service.artifacts.list(), nextCursor: null };
                    if (id && method === 'GET') {
                        const { bytes, ...metadata } = service.artifacts.read(id);
                        return metadata;
                    }
                }
                if (route === 'auth/logout' && method === 'POST') {
                    service.auth.logout(token(req));
                    cookie(res, '', req, true);
                    return { loggedOut: true };
                }
                if (route === 'auth/password' && method === 'POST') {
                    fields(b, ['current', 'next']);
                    service.auth.changePassword(session.userId, string(b.current, 1024), string(b.next, 1024));
                    cookie(res, '', req, true);
                    return { changed: true };
                }
                if (['system/summary', 'system', 'summary'].includes(route) && method === 'GET')
                    return service.summary();
                if (route === 'settings') {
                    if (method === 'GET')
                        return service.store.setting('config', {});
                    if (method === 'PATCH') {
                        fields(b, ['timezone', 'language', 'notifications', 'dailyBudget', 'taskBudget', 'retentionDays', 'systemPrompt', 'tokenBudget', 'maxConcurrentRuns', 'maxQueueLength', 'gmailBodyRetentionDays', 'artifactRetentionDays', 'auditSnapshotRetentionDays', 'softDailyBudget', 'softTaskBudget']);
                        for (const key of ['artifactRetentionDays', 'auditSnapshotRetentionDays']) if (b[key] !== undefined && (!Number.isInteger(b[key]) || b[key] < 1 || b[key] > 3650)) throw new ApiError(400, 'INVALID_SETTING');
                        if (b.gmailBodyRetentionDays !== undefined && (!Number.isInteger(b.gmailBodyRetentionDays) || b.gmailBodyRetentionDays < 0 || b.gmailBodyRetentionDays > 365)) throw new ApiError(400, 'INVALID_SETTING');
                        for (const [key, cap] of [['maxConcurrentRuns', 2], ['maxQueueLength', 100]] as const)
                            if (b[key] !== undefined && (!Number.isInteger(b[key]) || b[key] < 1 || b[key] > cap))
                                throw new ApiError(400, 'INVALID_SETTING');
                        if (b.timezone)
                            new Intl.DateTimeFormat('en', { timeZone: b.timezone });
                        for (const key of ['dailyBudget', 'taskBudget', 'retentionDays', 'tokenBudget', 'softDailyBudget', 'softTaskBudget'])
                            if (b[key] !== undefined && (typeof b[key] !== 'number' || b[key] < 0 || !Number.isFinite(b[key])))
                                throw new ApiError(400, 'INVALID_SETTING');
                        if (b.retentionDays !== undefined && (!Number.isInteger(b.retentionDays) || b.retentionDays < 1 || b.retentionDays > 3650))
                            throw new ApiError(400, 'INVALID_SETTING');
                        const value = { ...service.store.setting<RecordData>('config', {}), ...b, version: Date.now() };
                        if (b.systemPrompt !== undefined) {
                            string(b.systemPrompt, 32000);
                            service.store.put('prompt_revisions', randomUUID(), { version: value.version, content: b.systemPrompt, at: Date.now() });
                        }
                        service.store.setSetting('config', value);
                        if (b.timezone)
                            service.store.setSetting('timezone', b.timezone);
                        return value;
                    }
                }
                if (route === 'system/audit' && method === 'GET')
                    return { items: service.store.db.prepare('SELECT * FROM audit_events ORDER BY seq DESC LIMIT 100').all(), nextCursor: null };
                if (route === 'system/logs' && method === 'GET')
                    return { items: service.maintenance.logs(), nextCursor: null };
                if (route === 'system/metrics' && method === 'GET')
                    return service.maintenance.metrics();
                if (route === 'system/diagnostics' && method === 'GET')
                    return service.maintenance.diagnostics();
                if (route === 'config/export' && method === 'GET')
                    return service.maintenance.exportConfig();
                if (resource === 'conversations') {
                    if (!id && method === 'POST')
                        return service.conversation(b);
                    if (id && sub === 'messages') {
                        const c = service.get('conversations', id);
                        if (method === 'POST') {
                            fields(b, ['content']);
                            return service.createTask(id, string(b.content), 'web', String(req.headers['idempotency-key']));
                        }
                        if (method === 'GET') {
                            const h = await service.adapter.dispatch('history.list', { id: c.piConversationId, limit: 100 });
                            return { items: h.items, nextCursor: h.before ?? null };
                        }
                    }
                    if (id && sub === 'live' && method === 'GET')
                        return service.adapter.dispatch('conversation.live', { id: service.get('conversations', id).piConversationId });
                    if (id && method === 'PATCH') {
                        fields(b, ['name', 'status']);
                        if (b.name)
                            string(b.name, 100);
                        if (b.status && !['active', 'archived'].includes(b.status))
                            throw new ApiError(400, 'INVALID_STATUS');
                        const value = { ...service.get('conversations', id), ...b };
                        service.store.put(resource, id, value);
                        return value;
                    }
                }
                if (resource === 'tasks' && id) {
                    if (sub === 'actions' && method === 'POST') {
                        fields(b, ['action']);
                        return service.taskAction(id, string(b.action, 30));
                    }
                    if (method === 'GET')
                        return { ...service.get('tasks', id), actionIntents: service.list('gmail_intents').filter(i => i.taskId === id), steps: service.list('task_steps').filter(s => s.taskId === id), operations: service.list('operations').filter(s => s.taskId === id), deliveries: service.list('outbox').filter(s => s.taskId === id) };
                }
                if (resource === 'schedules') {
                    if (id === 'preview' && method === 'GET')
                        return { items: service.preview(string(url.searchParams.get('expression'), 200), url.searchParams.get('timezone') ?? 'UTC'), nextCursor: null };
                    if (!id && method === 'POST')
                        return service.schedule(b);
                    if (id && method === 'PATCH')
                        return service.schedule(b, id);
                    if (id && sub === 'history' && method === 'GET')
                        return { items: service.list('tasks').filter(t => t.scheduleId === id), nextCursor: null };
                    if (id && sub === 'actions' && method === 'POST') {
                        fields(b, ['action']);
                        const s = service.get('schedules', id);
                        if (b.action === 'run')
                            return service.createTask(s.conversationId, s.prompt, 'cron', randomUUID(), { scheduleId: id, channelId: s.channelId, threadId: s.threadId });
                        if (!['pause', 'resume'].includes(b.action))
                            throw new ApiError(400, 'INVALID_ACTION');
                        service.store.put('schedules', id, { ...s, enabled: b.action === 'resume' });
                        return service.get('schedules', id);
                    }
                }
                if (resource === 'heartbeats' && ['POST', 'PATCH'].includes(method))
                    return service.heartbeat(b, id);
                if (resource === 'memory-policy') {
                    if (method === 'GET') return service.store.get('memory_policy_blocked_categories', 'owner') ?? { principalId: 'owner', categories: [] };
                    if (method === 'PATCH') { fields(b, ['categories']); service.memoryPolicy.setBlockedCategories('owner', b.categories); return { categories: b.categories }; }
                }
                if (resource === 'memory-candidates') {
                    const scope = url.searchParams.get('scope') ?? 'owner';
                    if (!id && method === 'GET') return { items: service.memoryPolicy.listCandidates('owner', scope), nextCursor: null };
                    if (id && sub === 'decision' && method === 'POST') {
                        fields(b, ['scope', 'exactHash', 'decision']);
                        return service.memoryPolicy.decide({ principalId: 'owner', scope: string(b.scope, 200), id, exactHash: string(b.exactHash, 64), decision: b.decision });
                    }
                }
                if (resource === 'memories') {
                    if (['POST', 'PATCH'].includes(method))
                        return service.memory(b, id);
                    if (id && sub === 'revisions' && method === 'GET')
                        return { items: service.list('memory_revisions').filter(r => r.memory_id === id), nextCursor: null };
                    if (!id && method === 'GET' && url.searchParams.has('q'))
                        return { items: service.store.searchMemories(url.searchParams.get('q')!, url.searchParams.get('scope') ?? undefined), nextCursor: null };
                }
                if (resource === 'approvals' && id && sub === 'decisions' && method === 'POST') {
                    fields(b, ['decision', 'operationHash']);
                    const a = service.get('approvals', id);
                    if (!b.operationHash || b.operationHash !== a.operationHash)
                        throw new ApiError(409, 'OPERATION_HASH_CONFLICT');
                    return service.policy.decide(id, b.decision, 'owner');
                }
                if (resource === 'providers' && ['POST', 'PATCH'].includes(method) && !sub)
                    return service.provider(b, id);
                if (resource === 'providers' && id && sub === 'test' && method === 'POST') {
                    fields(b, []);
                    const key = service.store.getSecret(`provider:${id}`);
                    if (!key)
                        throw new ApiError(409, 'PROVIDER_UNCONFIGURED');
                    const response = await (options.fetcher ?? fetch)('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10000) });
                    const value = { ...service.get('providers', id), status: response.ok ? 'online' : response.status === 401 ? 'invalid_credentials' : 'unavailable', testedAt: Date.now() };
                    service.store.put('providers', id, value);
                    return value;
                }
                if (resource === 'channels' && ['POST', 'PATCH'].includes(method) && !sub)
                    return service.channel(b, id);
                if (resource === 'channels' && id && sub === 'test' && method === 'POST') {
                    const key = service.store.getSecret(`channel:${id}`);
                    if (!key)
                        throw new ApiError(409, 'CHANNEL_UNCONFIGURED');
                    const response = await (options.fetcher ?? fetch)(`https://api.telegram.org/bot${key}/getMe`, { signal: AbortSignal.timeout(10000) });
                    const data = await response.json() as RecordData;
                    const value = { ...service.get('channels', id), status: data.ok ? 'connected' : 'invalid_credentials' };
                    service.store.put('channels', id, value);
                    return value;
                }
                if (resource === 'channels' && id && sub === 'outbox' && p[4] === 'confirm' && method === 'POST') {
                    fields(b, ['delivered', 'externalId', 'confirm']);
                    const out = service.get('outbox', p[3]!);
                    if (out.channelId !== id || out.state !== 'DELIVERY_UNCERTAIN' || b.confirm !== true)
                        throw new ApiError(409, 'DELIVERY_CONFIRMATION_REQUIRED');
                    const next = { ...out, state: b.delivered ? 'SENT' : 'FAILED', externalId: b.externalId, confirmedBy: 'owner' };
                    service.store.put('outbox', out.id, next);
                    return next;
                }
                if (resource === 'tools' && id && method === 'PATCH') {
                    fields(b, ['enabled']);
                    if (typeof b.enabled !== 'boolean')
                        throw new ApiError(400, 'INVALID_INPUT');
                    const t = service.get('tools', id);
                    service.policy.register({ ...t, ...b } as any);
                    return service.get('tools', id);
                }
                if (resource === 'skills') {
                    const skills:RecordData[] = [...await service.adapter.dispatch('skill.list'), ...service.list('reviewed_imported_skills')];
                    const imported = id ? service.store.get<RecordData>('reviewed_imported_skills', id) : undefined;
                    if (imported && method === 'GET') return imported;
                    if (imported && method === 'PATCH') {
                        fields(b, ['enabled']); if (typeof b.enabled !== 'boolean') throw new ApiError(400, 'INVALID_INPUT');
                        if (b.enabled) return service.activateMigrationObject(imported.sourceObjectId);
                        const value = { ...imported, enabled: false };
                        service.store.transaction(() => { service.store.put('reviewed_imported_skills', id!, value, 'owner'); service.store.put('skill_settings', id!, { id, enabled: false }); const promotion = service.get('migration_native_promotions', imported.sourceObjectId); service.store.put('migration_native_promotions', promotion.id, { ...promotion, hash: hash(value) }); });
                        return value;
                    }

                    if(id&&!skills.some(s=>s.name===id))throw new ApiError(404,'NOT_FOUND');
                    if(id&&method==='PATCH'){fields(b,['enabled']);if(typeof b.enabled!=='boolean')throw new ApiError(400,'INVALID_INPUT');await service.adapter.dispatch('skill.toggle',{name:id,enabled:b.enabled});service.store.put('skill_settings',id,{id,enabled:b.enabled});return {id,name:id,enabled:b.enabled};}
                    if(id&&method==='GET')return {name:id,...await service.adapter.dispatch('skill.load',{name:id}),enabled:service.store.get<RecordData>('skill_settings',id)?.enabled!==false};
                    if(method==='GET')return {items:skills.map(({path,...s})=>({...s,enabled:service.store.get<RecordData>('skill_settings',s.name)?.enabled!==false})),nextCursor:null};
                }
                if (['backup', 'restore'].includes(route) && method === 'POST') {
                    fields(b, route === 'restore' ? ['password', 'confirm', 'backupId'] : ['password', 'confirm']);
                    if (b.confirm !== true)
                        throw new ApiError(400, 'CONFIRMATION_REQUIRED');
                    if (!service.auth.verifyPassword(session.userId, string(b.password, 1024)))
                        throw new ApiError(403, 'REAUTH_REQUIRED');
                    return route === 'backup' ? service.snapshot() : service.restore(string(b.backupId, 100));
                }
                if (route === 'backups' && method === 'GET') return { items: await service.listBackups(), nextCursor: null };
                const resources = ['conversations', 'tasks', 'schedules', 'heartbeats', 'memories', 'approvals', 'providers', 'channels', 'tools', 'backups', 'model_usage', 'prompt_revisions'];
                if (resources.includes(resource!)) {
                    if (!id && method === 'GET') {
                        let items = service.list(resource!);
                        if (resource === 'providers')
                            items = items.map(p => ({ ...p, configured: !!service.store.getSecret(`provider:${p.id}`) }));
                        if (resource === 'tasks')
                            for (const k of ['status', 'source'])
                                if (url.searchParams.has(k))
                                    items = items.filter(t => t[k] === url.searchParams.get(k));
                        return { items, nextCursor: null };
                    }
                    if (id && method === 'GET')
                        return service.get(resource!, id);
                    if (id && method === 'DELETE' && ['schedules', 'heartbeats', 'memories', 'providers', 'channels'].includes(resource!)) {
                        service.get(resource!, id);
                        if (resource === 'providers')
                            service.store.deleteSecret(`provider:${id}`);
                        if (resource === 'channels')
                            service.store.deleteSecret(`channel:${id}`);
                        service.store.remove(resource!, id);
                        if (resource === 'providers')
                            await service.configureProviders();
                        return { deleted: true };
                    }
                }
                throw new ApiError(404, 'NOT_FOUND');
            };
            let result: unknown;
            if (write) {
                const key = string(req.headers['idempotency-key'], 200);
                const identity = hash({ userId: session.userId, key });
                const requestHash = hash({ method, path, body: b });
                const prior = service.store.get<RecordData>('idempotency', identity);
                if (prior && prior.requestHash !== requestHash)
                    throw new ApiError(409, 'IDEMPOTENCY_CONFLICT');
                if (prior?.state === 'DONE')
                    result = prior.result;
                else if (prior && !inflight.has(identity))
                    throw new ApiError(409, 'IDEMPOTENCY_UNCERTAIN');
                else if (inflight.has(identity))
                    result = await inflight.get(identity);
                else {
                    service.store.put('idempotency', identity, { requestHash, state: 'PENDING' });
                    const promise = action();
                    inflight.set(identity, promise);
                    try {
                        result = await promise;
                        service.store.put('idempotency', identity, { requestHash, state: 'DONE', result });
                        service.store.event('resource.changed', path);
                    }
                    catch (e) {
                        service.store.remove('idempotency', identity);
                        throw e;
                    }
                    finally {
                        inflight.delete(identity);
                    }
                }
            }
            else
                result = await action();
            send(res, 200, result, requestId);
        }
        catch (e) {
            const domainCode = e instanceof AppError || e instanceof OAuthError || e instanceof MimeError || e instanceof ArtifactError || e instanceof MigrationSourceError || e instanceof MigrationImportError ? e.code : e instanceof Error && /^[A-Z][A-Z0-9_]{2,70}$/.test(e.message) ? e.message : undefined;
            const error = e instanceof ApiError ? e : e instanceof ArtifactError ? new ApiError(e.code === 'ARTIFACT_NOT_FOUND' ? 404 : 400, e.code) : domainCode ? new ApiError(/NOT_FOUND/.test(domainCode) ? 404 : /UNCERTAIN|CONFLICT|HASH_MISMATCH|APPROVAL_INVALID/.test(domainCode) ? 409 : /OWNER_REQUIRED|PERMISSION_DENIED|SCOPE_NOT_ALLOWED/.test(domainCode) ? 403 : 400, domainCode) : new ApiError(400, 'REQUEST_FAILED');
            if (!res.headersSent)
                send(res, error.status, { code: error.code, message: error.message }, requestId);
            else
                res.end();
        }
    }
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? 8787, options.host ?? '127.0.0.1', resolve); });
    const address = server.address() as {
        port: number;
    };
    base = `http://127.0.0.1:${address.port}`;
    return { url: base, service, get store() { return service.store; }, async close() { for (const stream of streams)
            stream.end(); server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); await service.close(); } };
}
