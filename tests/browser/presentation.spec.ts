import {test,expect} from '@playwright/test';
import {createServer} from 'node:http';
import {controlFixture,CONTROL_TEST_PASSWORD} from '../control-fixture.js';

test('连接测试与状态以中文说明呈现，原始记录默认折叠',async({page})=>{
 const seen:string[]=[];
 const upstream=createServer((req,res)=>{seen.push(String(req.url));res.writeHead(401,{'Content-Type':'application/json'});res.end('{"error":"invalid key"}');});
 await new Promise<void>(resolve=>upstream.listen(0,'127.0.0.1',resolve));
 const port=(upstream.address() as {port:number}).port,f=await controlFixture({webDir:'apps/web/dist'});
 try{
  await f.setup();
  await f.request('providers','POST',{vendor:'openai',model:'vendor/model',baseUrl:`http://127.0.0.1:${port}/v1`,apiKey:'placeholder-key'});
  await page.goto(f.app.url);
  await page.getByLabel('管理员用户名').fill('owner');
  await page.getByLabel(/^密码/).fill(CONTROL_TEST_PASSWORD);
  await page.getByRole('button',{name:'登录',exact:true}).click();
  await page.getByRole('navigation').getByRole('button',{name:'模型与预算',exact:true}).click();
  await page.getByRole('button',{name:'测试连接'}).click();
  await expect(page.getByRole('status').filter({hasText:'模型服务拒绝了密钥'})).toBeVisible();
  expect(seen).toEqual(['/v1/models']);
  await expect(page.getByText('请确认密钥正确、未过期',{exact:false}).first()).toBeVisible();
  const raw=page.locator('details.technical pre').first();
  await expect(raw).toBeHidden();
  await expect(raw).toContainText('invalid_credentials');
  const detail=page.locator('details.technical').first();
  await expect(detail).not.toHaveAttribute('open');
  await detail.locator('summary').click();
  await expect(raw).toBeVisible();await expect(raw).toContainText('invalid_credentials');
 }finally{await page.close();await f.close();upstream.closeAllConnections();await new Promise<void>(resolve=>upstream.close(()=>resolve()));}
});
