import { randomUUID } from 'node:crypto';
import { ControlStore, hash } from './store.js';
export interface ToolDescriptor {name:string;version:string;inputSchema:Record<string,unknown>;sideEffect:'read'|'idempotent_write'|'non_idempotent_write'|'high_risk';permission:string;timeoutMs:number;idempotent:boolean;executor:string;enabled:boolean;description?:string}
export interface ToolCall {name:string;args:unknown;taskId:string;principalId?:string}
export interface PolicyDecision {decision:'ALLOW'|'DENY'|'APPROVAL_REQUIRED';reason:string;operationHash:string}
export interface Approval {id:string;taskId:string;toolName:string;principalId?:string;operationHash:string;risk:string;status:'PENDING'|'APPROVED'|'REJECTED'|'EXPIRED'|'REVOKED'|'CONSUMED';expiresAt:number;createdAt:number;decidedBy?:string;decidedAt?:number;consumedAt?:number;summary:{tool:string;argumentsHash:string;impact:string}}
function canonical(value:unknown):unknown {
  if(Array.isArray(value))return value.map(canonical);
  if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical((value as Record<string,unknown>)[k])]));
  return value;
}
export class PolicyGateway {
  constructor(private store:ControlStore) {}
  register(tool:ToolDescriptor):void {
    if(!tool.name||!tool.version||!tool.inputSchema||!['read','idempotent_write','non_idempotent_write','high_risk'].includes(tool.sideEffect)||!tool.permission||!tool.executor||!Number.isFinite(tool.timeoutMs)||tool.timeoutMs<=0||typeof tool.enabled!=='boolean'||typeof tool.idempotent!=='boolean')throw new Error('INVALID_TOOL_DESCRIPTOR');
    this.store.put('tools',tool.name,tool);
  }
  list():ToolDescriptor[] {return this.store.list('tools');}
  operationHash(call:ToolCall):string {return hash(canonical({name:call.name,args:call.args,taskId:call.taskId,principalId:call.principalId??null}));}
  check(call:ToolCall):PolicyDecision {
    const operationHash=this.operationHash(call);const tool=this.store.get<ToolDescriptor>('tools',call.name);
    const result=(decision:PolicyDecision['decision'],reason:string):PolicyDecision=>({decision,reason,operationHash});
    if(!tool||!tool.enabled)return result('DENY','TOOL_DISABLED_OR_UNKNOWN');
    if(tool.sideEffect==='high_risk'||/shell|host|docker|openwrt|network.admin/i.test(tool.permission))return result('DENY','HIGH_RISK_DENIED');
    if(!call.principalId)return result('DENY','PRINCIPAL_REQUIRED');
    if(call.principalId!=='owner') {
      const principal=this.store.get<{allowed:boolean;permissions:string[]}>('principals',call.principalId);
      if(!principal?.allowed||!principal.permissions?.includes(tool.permission))return result('DENY','PRINCIPAL_PERMISSION_DENIED');
    }
    if(tool.sideEffect==='non_idempotent_write')return result('APPROVAL_REQUIRED','EXTERNAL_SIDE_EFFECT');
    return result('ALLOW','POLICY_ALLOWED');
  }
  requestApproval(call:ToolCall,expiresAt=Date.now()+10*60_000):Approval {
    return this.store.transaction(()=>{
      const decision=this.check(call);if(decision.decision!=='APPROVAL_REQUIRED')throw new Error('APPROVAL_NOT_APPLICABLE');
      if(expiresAt<=Date.now()||expiresAt>Date.now()+24*3600_000)throw new Error('INVALID_APPROVAL_EXPIRY');
      const existing=this.store.list<Approval>('approvals').find(a=>a.operationHash===decision.operationHash&&a.status==='PENDING'&&a.expiresAt>Date.now());
      if(existing)return existing;
      const a:Approval={id:randomUUID(),taskId:call.taskId,toolName:call.name,principalId:call.principalId,operationHash:decision.operationHash,risk:'non_idempotent_write',status:'PENDING',expiresAt,createdAt:Date.now(),summary:{tool:call.name,argumentsHash:hash(canonical(call.args)),impact:'对外执行一次非幂等写入；参数以摘要绑定'}};
      this.store.put('approvals',a.id,a);return a;
    });
  }
  decide(id:string,decision:'APPROVED'|'REJECTED'|'REVOKED',actor='owner'):Approval {
    const result=this.store.transaction(()=>{
      const a=this.store.get<Approval>('approvals',id);if(!a)throw new Error('APPROVAL_NOT_FOUND');
      if(a.expiresAt<=Date.now()&&(a.status==='PENDING'||a.status==='APPROVED')) {this.store.put('approvals',id,{...a,status:'EXPIRED'});return undefined;}
      if(!['APPROVED','REJECTED','REVOKED'].includes(decision)||!(a.status==='PENDING'||(a.status==='APPROVED'&&decision==='REVOKED')))throw new Error('INVALID_APPROVAL_TRANSITION');
      const updated:Approval={...a,status:decision,decidedBy:actor,decidedAt:Date.now()};this.store.put('approvals',id,updated,actor);return updated;
    });
    if(!result)throw new Error('APPROVAL_EXPIRED');return result;
  }
  consume(id:string,call:ToolCall):boolean {
    return this.store.transaction(()=>{
      const a=this.store.get<Approval>('approvals',id);if(!a)return false;
      if(a.expiresAt<=Date.now()) {if(a.status==='PENDING'||a.status==='APPROVED')this.store.put('approvals',id,{...a,status:'EXPIRED'});return false;}
      const policy=this.check(call);
      if(a.status!=='APPROVED'||a.operationHash!==policy.operationHash||policy.decision!=='APPROVAL_REQUIRED')return false;
      this.store.put('approvals',id,{...a,status:'CONSUMED',consumedAt:Date.now()});return true;
    });
  }
}
