import {expect,test} from 'vitest';
import {errorText,label,riskText,roleText,scalar,statusText,testOutcome} from '../apps/web/src/present.js';

test('technical codes are never shown to users',()=>{
 expect(statusText('SUCCEEDED')).toBe('已完成');
 expect(statusText('DELIVERY_UNCERTAIN')).toBe('待人工核对');
 expect(statusText('invalid_credentials')).toBe('凭据无效');
 expect(errorText('BUDGET_PRICE_UNKNOWN')).toContain('单价');
 expect(errorText('SOME_UNKNOWN_CODE')).toBe('操作未完成，请查看技术详情或系统日志。');
 expect(errorText('SOME_UNKNOWN_CODE')).not.toContain('SOME_UNKNOWN_CODE');
 expect(riskText('non_idempotent_write')).toBe('不可重复的外部操作');
 expect(roleText('assistant')).toBe('助手');
 expect(label('ownerId')).toBe('所有者');
 expect(scalar(true)).toBe('是');
 expect(scalar(3)).toBe('3');
 expect(scalar([1,2])).toBe('2 项');
});

test('connection outcomes explain the cause in plain language',()=>{
 const denied=testOutcome('provider',{status:'invalid_credentials'});
 expect(denied.ok).toBe(false);expect(denied.title).toContain('拒绝');
 expect(JSON.stringify(denied)).not.toContain('invalid_credentials');
 expect(testOutcome('provider',{status:'online'}).ok).toBe(true);
 expect(testOutcome('channel',{status:'unavailable'}).title).toContain('无法连接');
});
