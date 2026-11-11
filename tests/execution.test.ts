import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ControlStore } from '../src/control/store.js';
import { PolicyGateway, type ToolDescriptor } from '../src/control/policy.js';
import { ExecutionCoordinator, ToolExecutorBackend, type BackendContext, type ExecutionBackend, type ExecutionAction, type ExecutionMethod } from '../src/execution/index.js';

const dirs:string[]=[];const stores:ControlStore[]=[];
afterEach(()=>{vi.useRealTimers();for(const store of stores.splice(0))store.close();for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});
const methods:ExecutionMethod[]=['provision','start','observe','act','stop','checkpoint','cleanup'];
class FakeBackend implements ExecutionBackend {
  capabilities={methods,tools:['read','send']}; events:string[]=[];calls=0;
  handler: (context:BackendContext,action:ExecutionAction)=>Promise<unknown> = async (_c,a)=>({value:a.args});
  async provision(c:BackendContext){this.events.push(`provision:${c.sessionId}`);}
  async start(c:BackendContext){this.events.push(`start:${c.sessionId}`);}
  async observe(c:BackendContext){this.events.push(`observe:${c.sessionId}`);return {visible:true};}
  async act(c:BackendContext,a:ExecutionAction){this.calls++;return this.handler(c,a);}
  async stop(c:BackendContext){this.events.push(`stop:${c.sessionId}`);}
  async checkpoint(c:BackendContext){this.events.push(`checkpoint:${c.sessionId}`);return {step:1};}
  async cleanup(c:BackendContext){this.events.push(`cleanup:${c.sessionId}`);}
}
function setup(backend:ExecutionBackend=new FakeBackend()) {
  const dir=mkdtempSync(join(tmpdir(),'hda-execution-'));dirs.push(dir);const store=new ControlStore(dir);stores.push(store);
  store.put('tasks','t1',{id:'t1',principalId:'owner',tenantId:'a',status:'RUNNING'});store.put('tasks','t2',{id:'t2',principalId:'owner',tenantId:'b',status:'RUNNING'});
  const policy=new PolicyGateway(store);
  const descriptor:ToolDescriptor={name:'read',version:'1',inputSchema:{type:'object'},sideEffect:'read',permission:'data.read',timeoutMs:1000,idempotent:true,executor:'local',enabled:true};
  policy.register(descriptor);policy.register({...descriptor,name:'send',sideEffect:'non_idempotent_write',permission:'data.send',idempotent:false});
  const coordinator=new ExecutionCoordinator(store,policy,backend);
  const grant=(taskId='t1',tenantId='a')=>coordinator.issueGrant({taskId,tenantId,principalId:'owner',methods:[...methods],tools:['read','send'],expiresAt:Date.now()+60000});
  return {dir,store,policy,coordinator,grant};
}
async function session(c:ExecutionCoordinator,token:string){const id=await c.provision(token);await c.start(token,id);return id;}

describe('CUA-001 执行后端契约',()=>{
  it('执行完整生命周期并声明能力',async()=>{
    const backend=new FakeBackend();const {coordinator,grant}=setup(backend);const token=grant();const id=await session(coordinator,token);
    expect(await coordinator.observe(token,id)).toEqual({visible:true});expect(await coordinator.checkpoint(token,id)).toEqual({step:1});
    expect(await coordinator.act(token,id,'op1',{name:'read',args:{q:1}})).toEqual({value:{q:1}});
    expect(await coordinator.act(token,id,'op1',{name:'read',args:{q:1}})).toEqual({value:{q:1}});expect(backend.calls).toBe(1);
    await coordinator.stop(token,id);await coordinator.cleanup(token,id);expect(backend.events.map(e=>e.split(':')[0])).toEqual(['provision','start','observe','checkpoint','stop','cleanup']);
    expect(()=>coordinator.observe(token,id)).toThrow('EXECUTION_INVALID_STATE');
  });
  it('校验任务、主体、租户、能力、会话和有效期',async()=>{
    vi.useFakeTimers();const {coordinator,grant}=setup();const token=grant();const id=await session(coordinator,token);const other=grant('t2','b');
    expect(()=>coordinator.issueGrant({taskId:'t1',tenantId:'b',principalId:'owner',methods,tools:['read'],expiresAt:Date.now()+1})).toThrow('EXECUTION_TASK_SCOPE_DENIED');
    expect(()=>coordinator.issueGrant({taskId:'t1',tenantId:'a',principalId:'other',methods,tools:['read'],expiresAt:Date.now()+1})).toThrow('EXECUTION_TASK_SCOPE_DENIED');
    expect(()=>coordinator.observe(other,id)).toThrow('EXECUTION_SESSION_DENIED');
    const restricted=coordinator.issueGrant({taskId:'t1',tenantId:'a',principalId:'owner',methods:['provision','start','act'],tools:['read'],expiresAt:Date.now()+10});
    const sid=await session(coordinator,restricted);expect(()=>coordinator.observe(restricted,sid)).toThrow('EXECUTION_CAPABILITY_DENIED');
    await expect(coordinator.act(restricted,sid,'x',{name:'send',args:{}})).rejects.toThrow('EXECUTION_CAPABILITY_DENIED');
    vi.advanceTimersByTime(11);expect(()=>coordinator.policyCall(restricted,sid,'x',{name:'read',args:{}})).toThrow('EXECUTION_UNAUTHORIZED');
  });
  it('审批绑定操作参数并只消费一次，策略停用后拒绝',async()=>{
    const backend=new FakeBackend();const {coordinator,grant,policy}=setup(backend);const token=grant();const id=await session(coordinator,token);const action={name:'send',args:{message:'hello'}};
    const call=coordinator.policyCall(token,id,'send1',action);const approval=policy.requestApproval(call);policy.decide(approval.id,'APPROVED');
    await expect(coordinator.act(token,id,'send1',{name:'send',args:{message:'changed'}},{approvalId:approval.id})).rejects.toThrow('EXECUTION_APPROVAL_REQUIRED');
    expect(await coordinator.act(token,id,'send1',action,{approvalId:approval.id})).toEqual({value:{message:'hello'}});expect(backend.calls).toBe(1);
    await expect(coordinator.act(token,id,'send2',action,{approvalId:approval.id})).rejects.toThrow('EXECUTION_APPROVAL_REQUIRED');
    const descriptor=policy.list().find(t=>t.name==='read')!;policy.register({...descriptor,enabled:false});await expect(coordinator.act(token,id,'other',{name:'read',args:{}})).rejects.toThrow('TOOL_DISABLED_OR_UNKNOWN');
  });
  it('故障后即使重开数据库或更换操作编号也不重放不确定副作用',async()=>{
    const backend=new FakeBackend();backend.handler=async()=>{throw new Error('连接中断');};const {dir,store,policy,coordinator,grant}=setup(backend);const token=grant();const id=await session(coordinator,token);const action={name:'read',args:{x:1}};
    await expect(coordinator.act(token,id,'op',action)).rejects.toThrow('连接中断');await expect(coordinator.act(token,id,'next',action)).rejects.toThrow('EXECUTION_OPERATION_UNCERTAIN');
    store.close();const reopened=new ControlStore(dir);stores.push(reopened);const next=new ExecutionCoordinator(reopened,new PolicyGateway(reopened),backend);const fresh=next.issueGrant({taskId:'t1',tenantId:'a',principalId:'owner',methods,tools:['read'],expiresAt:Date.now()+60000});const sid=await session(next,fresh);
    await expect(next.act(fresh,sid,'new-id',action)).rejects.toThrow('EXECUTION_OPERATION_UNCERTAIN');expect(backend.calls).toBe(1);expect(policy).toBeDefined();
  });
  it('发送中进程丢失时持久化的 SENDING 阻止重放',async()=>{
    const backend=new FakeBackend();let finish!:(value:unknown)=>void;backend.handler=()=>new Promise(resolve=>{finish=resolve;});
    const {dir,store,coordinator,grant}=setup(backend);const token=grant(), id=await session(coordinator,token);const action={name:'read',args:{crash:true}};
    const inFlight=coordinator.act(token,id,'before-crash',action);store.close();const reopened=new ControlStore(dir);stores.push(reopened);
    const next=new ExecutionCoordinator(reopened,new PolicyGateway(reopened),backend);const fresh=next.issueGrant({taskId:'t1',tenantId:'a',principalId:'owner',methods,tools:['read'],expiresAt:Date.now()+60000});const sid=await session(next,fresh);
    await expect(next.act(fresh,sid,'after-crash',action)).rejects.toThrow('EXECUTION_OPERATION_UNCERTAIN');finish({ok:true});await expect(inFlight).rejects.toThrow();expect(backend.calls).toBe(1);
  });
  it('取消只影响指定会话，即使后端忽略取消也标记结果不确定',async()=>{
    const backend=new FakeBackend();const pending=new Map<string,(v:unknown)=>void>();backend.handler=(c)=>new Promise(resolve=>pending.set(c.sessionId,resolve));
    const {coordinator,grant}=setup(backend);const a=grant(),b=grant('t2','b');const one=await session(coordinator,a),two=await session(coordinator,b);
    const first=coordinator.act(a,one,'op',{name:'read',args:{a:1}});const second=coordinator.act(b,two,'op',{name:'read',args:{a:1}});
    await coordinator.stop(a,one);pending.get(one)!({ok:true});pending.get(two)!({ok:true});await expect(first).rejects.toThrow('EXECUTION_CANCELLED');expect(await second).toEqual({ok:true});
    await coordinator.cleanup(a,one);expect(await coordinator.observe(b,two)).toEqual({visible:true});
  });
  it('授权到期或撤销时取消执行，不接受迟到结果',async()=>{
    vi.useFakeTimers();const backend=new FakeBackend();const pending:Array<(value:unknown)=>void>=[];backend.handler=()=>new Promise(resolve=>pending.push(resolve));
    const {coordinator}=setup(backend);const make=()=>coordinator.issueGrant({taskId:'t1',tenantId:'a',principalId:'owner',methods,tools:['read'],expiresAt:Date.now()+100});
    const token=make(), id=await session(coordinator,token);const result=coordinator.act(token,id,'expiry',{name:'read',args:{n:1}});
    vi.advanceTimersByTime(101);pending[0]!({ok:true});await expect(result).rejects.toThrow('EXECUTION_CANCELLED');
    const next=make(), sid=await session(coordinator,next);const revoked=coordinator.act(next,sid,'revoke',{name:'read',args:{n:2}});coordinator.revokeGrant(next);pending[1]!({ok:true});await expect(revoked).rejects.toThrow('EXECUTION_CANCELLED');
  });
  it('普通工具回调通过实际策略与持久化协调器执行',async()=>{
    const calls:unknown[]=[];const backend=new ToolExecutorBackend({read:async(args,context)=>{calls.push({args,task:context.taskId});return {output:'完成'};},send:async()=>({output:'发送'})});
    const {coordinator,grant}=setup(backend);const token=grant();const id=await session(coordinator,token);
    expect(await coordinator.act(token,id,'call-1',{name:'read',args:{query:'a'}})).toEqual({output:'完成'});expect(calls).toEqual([{args:{query:'a'},task:'t1'}]);
  });
});
