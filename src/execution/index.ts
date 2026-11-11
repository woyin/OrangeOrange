import { randomBytes, randomUUID } from 'node:crypto';
import { ControlStore, hash } from '../control/store.js';
import { PolicyGateway, type ToolCall } from '../control/policy.js';

export type ExecutionMethod = 'provision' | 'start' | 'observe' | 'act' | 'stop' | 'checkpoint' | 'cleanup';
export interface ExecutionScope { taskId:string; principalId:string; tenantId:string }
export interface BackendContext extends ExecutionScope { sessionId:string; signal:AbortSignal }
export interface ExecutionAction { name:string; args:unknown }
export interface ExecutionBackend {
  readonly capabilities: { methods:ExecutionMethod[]; tools:string[] };
  provision(context:BackendContext):Promise<void>;
  start(context:BackendContext):Promise<void>;
  observe(context:BackendContext):Promise<unknown>;
  act(context:BackendContext, action:ExecutionAction):Promise<unknown>;
  stop(context:BackendContext):Promise<void>;
  checkpoint(context:BackendContext):Promise<unknown>;
  cleanup(context:BackendContext):Promise<void>;
}
export interface Grant extends ExecutionScope { methods:ExecutionMethod[]; tools:string[]; expiresAt:number }
interface StoredGrant extends Grant { id:string; tokenHash:string }
interface Session extends ExecutionScope { id:string; grantId:string; state:'PROVISIONING'|'READY'|'STARTING'|'RUNNING'|'STOPPING'|'STOPPED'|'CLEANING'|'CLEANED'|'BROKEN' }
interface Operation { id:string; sessionId:string; operationHash:string; intentHash:string; state:'SENDING'|'CONFIRMED'|'UNCERTAIN'; receipt?:unknown }
const grantKind='execution_grants', sessionKind='execution_sessions', operationKind='execution_operations';
const liveTask = new Set(['RUNNING','WAITING_APPROVAL']);
function snapshot(value:unknown):unknown {
  const seen=new Set<object>();
  const visit=(v:unknown):void=>{
    if(v===null || typeof v==='string' || typeof v==='boolean')return;
    if(typeof v==='number' && Number.isFinite(v))return;
    if(typeof v!=='object' || seen.has(v as object))throw new Error('INVALID_JSON_VALUE');
    if(!Array.isArray(v) && Object.getPrototypeOf(v)!==Object.prototype)throw new Error('INVALID_JSON_VALUE');
    seen.add(v as object);
    if(Array.isArray(v)) { for(let i=0;i<v.length;i++) { if(!(i in v))throw new Error('INVALID_JSON_VALUE'); visit(v[i]); } }
    else for(const item of Object.values(v as Record<string,unknown>))visit(item);
    seen.delete(v as object);
  };
  visit(value);return JSON.parse(JSON.stringify(value));
}

/** Trusted in-process boundary. Callers must authenticate the issuer and protect the bearer token. */
export class ExecutionCoordinator {
  private readonly controllers=new Map<string,Set<AbortController>>();
  private readonly ownedSessions=new Set<string>();
  constructor(private readonly store:ControlStore, private readonly policy:PolicyGateway, private readonly backend:ExecutionBackend) {}
  issueGrant(grant:Grant):string {
    if(!grant.taskId || !grant.principalId || !grant.tenantId || !Number.isSafeInteger(grant.expiresAt) || grant.expiresAt<=Date.now() || grant.expiresAt>Date.now()+24*60*60_000 || !Array.isArray(grant.methods) || !Array.isArray(grant.tools) || grant.methods.some(m=>!this.backend.capabilities.methods.includes(m)) || grant.tools.some(t=>!this.backend.capabilities.tools.includes(t)))throw new Error('INVALID_EXECUTION_GRANT');
    this.checkTask(grant,true);
    const token=randomBytes(32).toString('base64url'), id=randomUUID();
    this.store.put(grantKind,id,{...grant,id,tokenHash:hash(token)} satisfies StoredGrant,grant.principalId);
    return token;
  }
  revokeGrant(token:string):void {
    const grant=this.findGrant(token);this.store.remove(grantKind,grant.id,grant.principalId);
    for(const session of this.store.list<Session>(sessionKind).filter(s=>s.grantId===grant.id))this.abort(session.id);
  }
  private findGrant(token:string):StoredGrant {
    if(typeof token!=='string' || !token)throw new Error('EXECUTION_UNAUTHORIZED');
    const grant=this.store.list<StoredGrant>(grantKind).find(g=>g.tokenHash===hash(token));
    if(!grant || grant.expiresAt<=Date.now())throw new Error('EXECUTION_UNAUTHORIZED');
    return grant;
  }
  private checkTask(scope:ExecutionScope, running:boolean):void {
    const task=this.store.get<{principalId?:string;tenantId?:string;status?:string}>('tasks',scope.taskId);
    if(!task || task.principalId!==scope.principalId || (task.tenantId ?? 'default')!==scope.tenantId || (running && !liveTask.has(task.status ?? '')))throw new Error('EXECUTION_TASK_SCOPE_DENIED');
  }
  private authorize(token:string, method:ExecutionMethod, sessionId?:string, tool?:string):{grant:StoredGrant;session?:Session} {
    const grant=this.findGrant(token);
    if(!grant.methods.includes(method) || !this.backend.capabilities.methods.includes(method) || (tool!==undefined && (!grant.tools.includes(tool) || !this.backend.capabilities.tools.includes(tool))))throw new Error('EXECUTION_CAPABILITY_DENIED');
    this.checkTask(grant,!['stop','cleanup'].includes(method));
    const session=sessionId ? this.store.get<Session>(sessionKind,sessionId):undefined;
    if(sessionId && (!session || !this.ownedSessions.has(sessionId) || session.grantId!==grant.id || session.taskId!==grant.taskId || session.principalId!==grant.principalId || session.tenantId!==grant.tenantId))throw new Error('EXECUTION_SESSION_DENIED');
    return {grant,session};
  }
  private abort(id:string):void { for(const controller of this.controllers.get(id) ?? [])controller.abort(); }
  private async invoke<T>(session:Session, fn:(context:BackendContext)=>Promise<T>, signal?:AbortSignal):Promise<T> {
    const grant=this.store.get<StoredGrant>(grantKind,session.grantId);if(!grant || grant.expiresAt<=Date.now())throw new Error('EXECUTION_UNAUTHORIZED');
    const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),Math.max(0,grant.expiresAt-Date.now()));const set=this.controllers.get(session.id) ?? new Set<AbortController>();set.add(controller);this.controllers.set(session.id,set);
    const combined=signal ? AbortSignal.any([signal,controller.signal]) : controller.signal;
    try { if(combined.aborted)throw new Error('EXECUTION_CANCELLED');const result=await fn({taskId:session.taskId,principalId:session.principalId,tenantId:session.tenantId,sessionId:session.id,signal:combined});if(combined.aborted)throw new Error('EXECUTION_CANCELLED');return result; }
    finally {clearTimeout(timer);set.delete(controller);if(!set.size)this.controllers.delete(session.id);}
  }
  async provision(token:string, signal?:AbortSignal):Promise<string> {
    const {grant}=this.authorize(token,'provision');const session:Session={id:randomUUID(),grantId:grant.id,taskId:grant.taskId,principalId:grant.principalId,tenantId:grant.tenantId,state:'PROVISIONING'};
    this.store.put(sessionKind,session.id,session);this.ownedSessions.add(session.id);
    try {await this.invoke(session,c=>this.backend.provision(c),signal);this.store.put(sessionKind,session.id,{...session,state:'READY'});return session.id;}
    catch(e){this.store.put(sessionKind,session.id,{...session,state:'BROKEN'});throw e;}
  }
  private async transition(token:string,id:string,method:'start'|'stop'|'cleanup',from:Session['state'][],pending:Session['state'],done:Session['state']):Promise<void> {
    const session=this.authorize(token,method,id).session!;if(!from.includes(session.state))throw new Error('EXECUTION_INVALID_STATE');
    this.store.put(sessionKind,id,{...session,state:pending});
    if(method==='stop'||method==='cleanup')this.abort(id);
    try {await this.invoke(session,c=>this.backend[method](c));this.store.put(sessionKind,id,{...session,state:done});}
    catch(e){this.store.put(sessionKind,id,{...session,state:'BROKEN'});throw e;}
  }
  start(token:string,id:string):Promise<void> {return this.transition(token,id,'start',['READY'],'STARTING','RUNNING');}
  stop(token:string,id:string):Promise<void> {return this.transition(token,id,'stop',['RUNNING','READY','BROKEN'],'STOPPING','STOPPED');}
  cleanup(token:string,id:string):Promise<void> {return this.transition(token,id,'cleanup',['STOPPED','BROKEN'],'CLEANING','CLEANED');}
  observe(token:string,id:string,signal?:AbortSignal):Promise<unknown> {const s=this.authorize(token,'observe',id).session!;if(s.state!=='RUNNING')throw new Error('EXECUTION_INVALID_STATE');return this.invoke(s,c=>this.backend.observe(c),signal);}
  checkpoint(token:string,id:string,signal?:AbortSignal):Promise<unknown> {const s=this.authorize(token,'checkpoint',id).session!;if(s.state!=='RUNNING')throw new Error('EXECUTION_INVALID_STATE');return this.invoke(s,c=>this.backend.checkpoint(c),signal);}
  /** Use this exact call for PolicyGateway.check/requestApproval. */
  policyCall(token:string,id:string,operationId:string,action:ExecutionAction):ToolCall {
    if(!operationId || !action?.name)throw new Error('INVALID_EXECUTION_OPERATION');
    const s=this.authorize(token,'act',id,action.name).session!;if(s.state!=='RUNNING')throw new Error('EXECUTION_INVALID_STATE');
    return {name:action.name,taskId:s.taskId,principalId:s.principalId,args:{tenantId:s.tenantId,sessionId:id,operationId,args:snapshot(action.args)}};
  }
  async act(token:string,id:string,operationId:string,action:ExecutionAction,options:{approvalId?:string;signal?:AbortSignal}={}):Promise<unknown> {
    const call=this.policyCall(token,id,operationId,action);const s=this.authorize(token,'act',id,action.name).session!;
    const decision=this.policy.check(call);if(decision.decision==='DENY')throw new Error(decision.reason);
    const opId=hash({taskId:s.taskId,tenantId:s.tenantId,operationId});
    const intentHash=this.policy.operationHash({...call,args:{tenantId:s.tenantId,args:(call.args as {args:unknown}).args}});
    const previous=this.store.get<Operation>(operationKind,opId);
    if(previous) {if(previous.operationHash!==decision.operationHash)throw new Error('EXECUTION_OPERATION_CONFLICT');if(previous.state==='CONFIRMED')return previous.receipt;throw new Error('EXECUTION_OPERATION_UNCERTAIN');}
    if(this.store.list<Operation>(operationKind).some(o=>o.intentHash===intentHash && o.state!=='CONFIRMED'))throw new Error('EXECUTION_OPERATION_UNCERTAIN');
    if(options.signal?.aborted)throw new Error('EXECUTION_CANCELLED');
    this.store.transaction(()=>{
      this.authorize(token,'act',id,action.name);
      if(decision.decision==='APPROVAL_REQUIRED' && (!options.approvalId || !this.policy.consume(options.approvalId,call)))throw new Error('EXECUTION_APPROVAL_REQUIRED');
      this.store.put(operationKind,opId,{id:opId,sessionId:id,operationHash:decision.operationHash,intentHash,state:'SENDING'} satisfies Operation);
    });
    try {
      const result=await this.invoke(s,c=>this.backend.act(c,{name:call.name,args:(call.args as {args:unknown}).args}),options.signal);
      this.checkTask(s,true);this.findGrant(token);
      const current=this.store.get<Session>(sessionKind,id);if(options.signal?.aborted || current?.state!=='RUNNING')throw new Error('EXECUTION_CANCELLED');
      const receipt=snapshot(result);this.store.put(operationKind,opId,{id:opId,sessionId:id,operationHash:decision.operationHash,intentHash,state:'CONFIRMED',receipt} satisfies Operation);return receipt;
    } catch(e) {this.store.put(operationKind,opId,{id:opId,sessionId:id,operationHash:decision.operationHash,intentHash,state:'UNCERTAIN'} satisfies Operation);throw e;}
  }
}

/** In-process backend for already registered ordinary tools. No shell or browser is implied. */
export class ToolExecutorBackend implements ExecutionBackend {
  readonly capabilities:ExecutionBackend['capabilities'];
  constructor(private readonly executors:Record<string,(args:unknown,context:BackendContext)=>Promise<unknown>>) {this.capabilities={methods:['provision','start','observe','act','stop','checkpoint','cleanup'],tools:Object.keys(executors)};}
  async provision(_context:BackendContext):Promise<void> {}
  async start(_context:BackendContext):Promise<void> {}
  async observe(_context:BackendContext):Promise<unknown> {return {kind:'tool-executor'};}
  async act(context:BackendContext,action:ExecutionAction):Promise<unknown> {const execute=Object.hasOwn(this.executors,action.name) ? this.executors[action.name] : undefined;if(!execute)throw new Error('EXECUTION_TOOL_UNKNOWN');return execute(action.args,context);}
  async stop(_context:BackendContext):Promise<void> {}
  async checkpoint(_context:BackendContext):Promise<unknown> {return {kind:'tool-executor'};}
  async cleanup(_context:BackendContext):Promise<void> {}
}
