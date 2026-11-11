import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fixture } from './server.js';

const password='browser-owner-password';
async function navigate(page:Page,name:string){
 await page.getByRole('navigation').getByRole('button',{name,exact:true}).click();
 await expect(page.getByRole('heading',{name,exact:true,level:2})).toBeVisible();
 await expect(page.getByText('正在读取服务端数据…')).toBeHidden();
}
async function download(page:Page,button:string,path:string,filename:string){
 const response=page.waitForResponse(r=>r.url().endsWith('/api/v1/'+path)&&r.request().method()==='GET');
 const event=page.waitForEvent('download');
 await page.getByRole('button',{name:button}).click();
 const [result,file]=await Promise.all([response,event]);
 expect(result.ok()).toBeTruthy();
 expect(file.suggestedFilename()).toBe(filename);
 const data=(await result.json()).data;
 expect(JSON.parse(await readFile((await file.path())!,'utf8'))).toEqual(data);
 return data;
}
async function noOverflow(page:Page){expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(await page.evaluate(()=>document.documentElement.clientWidth));}

test('真实总览、版本、JSON 下载和系统指令历史',async({page})=>{
 const app=await fixture(false);
 try{
  const setup=await fetch(app.url+'/api/v1/setup',{method:'POST',headers:{Origin:app.url,'Content-Type':'application/json'},body:JSON.stringify({username:'owner',password,timezone:'UTC'})});
  expect(setup.ok).toBeTruthy();
  const day=new Date().toISOString().slice(0,10);
  app.service.store.put('budget_reservations','settled',{id:'settled',day,state:'settled',actualTokens:12,actualCost:0.01});
  app.service.store.put('budget_reservations','pending',{id:'pending',day,state:'reserved',reservedTokens:8,reservedCost:0.02});
  app.service.store.put('channels','browser-channel',{id:'browser-channel',name:'浏览器通道',status:'error',lastError:'测试连接错误'});
  app.service.memory({kind:'semantic',scope:'owner',source:'owner',content:'导出的浏览器记忆'});
  await page.goto(app.url);
  await page.getByLabel('管理员用户名').fill('owner');await page.getByLabel('密码').fill(password);
  await page.getByRole('button',{name:'登录',exact:true}).click();
  const usage=page.locator('article').filter({has:page.getByRole('heading',{name:'今日用量'})});
  await expect(usage).toContainText(day);await expect(usage).toContainText('Token：20');await expect(usage).toContainText('估算成本：0.03');await expect(usage).toContainText('预留估价');
  const channels=page.locator('article').filter({has:page.getByRole('heading',{name:'消息通道',exact:true})});
  await expect(channels).toContainText('浏览器通道');await expect(channels).toContainText('browser-channel');await expect(channels).toContainText('error');await expect(channels).toContainText('测试连接错误');await noOverflow(page);
  const patch=await page.evaluate(async key=>{const session=await fetch('/api/v1/auth/session').then(r=>r.json());return fetch('/api/v1/settings',{method:'PATCH',headers:{'Content-Type':'application/json','X-CSRF-Token':session.data.csrf,'Idempotency-Key':key},body:JSON.stringify({systemPrompt:'历史中的系统指令'})}).then(r=>r.status);},randomUUID());
  expect(patch).toBe(200);
  await navigate(page,'设置');
  const history=page.locator('section').filter({has:page.getByRole('heading',{name:'系统指令版本历史'})});
  await expect(history).toContainText('历史中的系统指令');await expect(history).toContainText('保存时间：');await noOverflow(page);
  await navigate(page,'长期记忆');
  const memories=await download(page,'导出记忆 JSON','memories/export','memories.json');
  expect(memories.version).toBe(1);expect(memories.exportedAt).toBeTruthy();expect(memories.items).toEqual(expect.arrayContaining([expect.objectContaining({content:'导出的浏览器记忆'})]));await noOverflow(page);
  await navigate(page,'系统');
  const summary=await page.evaluate(()=>fetch('/api/v1/system').then(r=>r.json()).then(r=>r.data));
  for(const [label,value] of [['应用版本',summary.version],['Pi 版本',summary.piVersion],['数据库版本',summary.schemaVersion]] as const){
   await expect(page.locator('article').filter({has:page.getByRole('heading',{name:label,exact:true})})).toContainText(String(value));
  }
  await expect(page.getByText(/升级前确认目标版本/)).toBeVisible();
  await download(page,'下载诊断 JSON','system/diagnostics','diagnostics.json');
  await download(page,'下载配置 JSON','config/export','config.json');await noOverflow(page);
  const conversation=await app.service.conversation({name:'Heartbeat 会话'});
  const heartbeat=app.service.heartbeat({conversationId:conversation.id,intervalSeconds:3600,prompt:'Heartbeat 浏览器检查'});
  await navigate(page,'自动化');
  await page.getByRole('button',{name:'Heartbeat',exact:true}).click();
  const row=page.locator('.records article').filter({has:page.getByRole('heading',{name:heartbeat.id,exact:true})});
  await expect(row).toBeVisible();
  page.once('dialog',dialog=>dialog.accept());
  const run=page.waitForResponse(r=>r.url().endsWith('/api/v1/heartbeats/'+heartbeat.id+'/actions')&&r.request().method()==='POST');
  await row.getByRole('button',{name:'立即执行'}).click();
  const result=await run;expect(result.ok()).toBeTruthy();const task=(await result.json()).data;
  await expect(row.getByRole('button',{name:'查看详情'})).toBeEnabled();
  const historyResponse=page.waitForResponse(r=>r.url().endsWith('/api/v1/heartbeats/'+heartbeat.id+'/history'));
  await row.getByRole('button',{name:'查看详情'}).click();
  expect((await historyResponse).ok()).toBeTruthy();
  await expect(page.locator('.detail')).toContainText(task.id);
 }finally{await page.close();await app.cleanup();}
});
