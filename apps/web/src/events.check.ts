import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEvent } from './events.ts';
test('SSE保留单调ID、命名类型及多行正文',()=>{assert.deepEqual(parseEvent(': keepalive\nid: 42\nevent: task.changed\ndata: first\ndata: second'),{id:'42',type:'task.changed',data:'first\nsecond'});});
test('SSE注释不触发刷新，默认事件可解析',()=>{assert.equal(parseEvent(': heartbeat'),undefined);assert.deepEqual(parseEvent('id: 43\ndata: {}'),{id:'43',type:'message',data:'{}'});});
test('SSE游标过期控制事件可解析',()=>{assert.deepEqual(parseEvent('event: reset\ndata: {"reason":"cursor_expired"}'),{id:'',type:'reset',data:'{"reason":"cursor_expired"}'});});
