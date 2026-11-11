import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ControlStore } from '../src/control/store.js';
import { MemoryPolicyService } from '../src/control/memory-policy.js';

const opened: ControlStore[] = [];
afterEach(() => { for (const s of opened.splice(0)) { s.close(); rmSync(s.dataDir, { recursive: true, force: true }); } });
function fixture() { const s = new ControlStore(mkdtempSync(join(tmpdir(), 'memory-policy-'))); opened.push(s); return { s, p: new MemoryPolicyService(s) }; }
const base = { principalId: 'alice', scope: 'project:a', content: 'Prefers green tea', kind: 'semantic', source: 'model' };

describe('memory policy', () => {
  it('applies ordinary candidates, deduplicates exact content and detects key conflicts', () => {
    const { s, p } = fixture();
    const a = p.propose({ ...base, key: 'drink' });
    expect(a.state).toBe('APPLIED');
    expect(s.searchMemories('green tea', base.scope)).toHaveLength(1);
    expect(p.propose({ ...base, key: 'drink' })).toMatchObject({ state: 'DUPLICATE', id: a.id });
    const conflict = p.propose({ ...base, content: 'Prefers coffee', key: 'drink' });
    expect(conflict.state).toBe('CONFLICT');
    expect(s.searchMemories('coffee', base.scope)).toHaveLength(0);
    expect(p.propose({ ...base, principalId: 'bob', content: 'Prefers coffee', key: 'drink' }).state).toBe('APPLIED');
    expect(p.propose({ ...base, scope: 'project:b', content: 'Prefers coffee', key: 'drink' }).state).toBe('APPLIED');
  });
  it('rejects blocked categories and secrets, and reviews sensitive facts despite untrusted source', () => {
    const { s, p } = fixture();
    p.setBlockedCategories('alice', ['health']);
    expect(p.propose({ ...base, content: 'Has diabetes' }).state).toBe('REJECTED');
    expect(p.propose({ ...base, content: 'Bank balance is 100', source: 'owner approved' }).state).toBe('PENDING_REVIEW');
    expect(p.propose({ ...base, content: 'ordinary text', category: 'password' }).state).toBe('REJECTED');
    expect(s.list('memories')).toHaveLength(0);
  });
  it('binds review to exact hash, principal and scope and rechecks policy', () => {
    const { s, p } = fixture();
    const r = p.propose({ ...base, content: 'Health: diabetes' });
    expect(r.state).toBe('PENDING_REVIEW');
    expect(p.listCandidates('bob', base.scope)).toEqual([]);
    expect(() => p.decide({ principalId: 'alice', scope: base.scope, id: r.id, exactHash: 'wrong', decision: 'approve' })).toThrow();
    expect(() => p.decide({ principalId: 'bob', scope: base.scope, id: r.id, exactHash: r.exactHash!, decision: 'approve' })).toThrow();
    p.setBlockedCategories('alice', ['health']);
    expect(p.decide({ principalId: 'alice', scope: base.scope, id: r.id, exactHash: r.exactHash!, decision: 'approve' }).state).toBe('REJECTED');
    expect(s.list('memories')).toHaveLength(0);
  });
  it('persists candidates and rejects modified content hashes and stale conflicts', () => {
    const { s, p } = fixture();
    const first = p.propose({ ...base, key: 'drink' });
    const c = p.propose({ ...base, key: 'drink', content: 'Prefers coffee' });
    expect(p.listCandidates('alice', base.scope)).toHaveLength(1);
    expect(p.decide({ principalId: 'alice', scope: base.scope, id: c.id, exactHash: c.exactHash!, decision: 'approve' }).state).toBe('CONFLICT');
    const saved = s.get<Record<string, unknown>>('memory_policy_candidates', c.id)!;
    s.put('memory_policy_candidates', c.id, { ...saved, content: 'Changed after review' });
    expect(() => p.decide({ principalId: 'alice', scope: base.scope, id: c.id, exactHash: c.exactHash!, decision: 'approve' })).toThrow('CANDIDATE_HASH_MISMATCH');
    s.put('memory_policy_candidates', c.id, saved);
    s.remove('memories', first.id, 'owner');
    expect(new MemoryPolicyService(s).decide({ principalId: 'alice', scope: base.scope, id: c.id, exactHash: c.exactHash!, decision: 'approve' }).state).toBe('APPLIED');
    expect(p.listCandidates('alice', base.scope)).toEqual([]);
  });
  it('tracks trusted owner origin separately and honors explicit category', () => {
    const { s, p } = fixture();
    const auto = p.propose({ ...base, source: 'owner' });
    const explicit = p.writeOwner({ ...base, content: 'Prefers oolong', source: 'owner' });
    expect(s.get<Record<string, unknown>>('memories', auto.id)?.origin).toBe('model');
    expect(s.get<Record<string, unknown>>('memories', explicit.id)?.origin).toBe('owner');
    expect(p.writeOwner({ ...base, content: 'A private fact', category: 'health' }).state).toBe('PENDING_REVIEW');
    expect(p.propose({ ...base, content: 'A private fact', category: 'identity' }).state).toBe('PENDING_REVIEW');
    expect(p.propose({ ...base, content: 'A private fact', category: 'secret' }).state).toBe('REJECTED');
  });
  it('indexes only explicitly approved sensitive content, rejects conflicts, and ignores deleted or expired records', () => {
    const { s, p } = fixture();
    const pending = p.propose({ ...base, content: 'Health: diabetes' });
    expect(s.searchMemories('diabetes', base.scope)).toEqual([]);
    expect(p.decide({ principalId: 'alice', scope: base.scope, id: pending.id, exactHash: pending.exactHash!, decision: 'approve' }).state).toBe('APPLIED');
    expect(s.searchMemories('diabetes', base.scope)).toEqual([expect.objectContaining({id:pending.id,sensitiveApproved:true})]);
    const a = p.propose({ ...base, key: 'drink' });
    const c = p.propose({ ...base, content: 'Prefers coffee', key: 'drink' });
    expect(p.decide({ principalId: 'alice', scope: base.scope, id: c.id, exactHash: c.exactHash!, decision: 'reject' }).state).toBe('REJECTED');
    s.remove('memories', a.id, 'owner');
    expect(s.searchMemories('green tea', base.scope)).toEqual([]);
    expect(p.propose({ ...base, key: 'drink' }).state).toBe('APPLIED');
    const m = s.get<Record<string, unknown>>('memories', a.id)!;
    s.put('memories', a.id, { ...m, status: 'active', expires_at: Date.now() - 1 });
    expect(s.searchMemories('green tea', base.scope).map(x => x.id)).not.toContain(a.id);
  });
});
