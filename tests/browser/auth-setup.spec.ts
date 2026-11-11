import {test,expect} from '@playwright/test';
import {randomUUID} from 'node:crypto';
import {fixture} from './server.js';

test('首次配置密码校验、失败重试和重新登录',async({page})=>{
 const app=await fixture(false),password=randomUUID(),secret=randomUUID();
 try{
  await page.goto(app.url);
  const username=page.getByLabel('管理员用户名'),passwordInput=page.getByLabel('密码',{exact:false}).first();
  await expect(passwordInput).toHaveAttribute('minlength','12');
  await expect(page.getByText('至少 12 个字符，用于管理员登录。')).toBeVisible();
  await username.fill('owner');await passwordInput.fill('too-short');
  await page.getByLabel('模型提供商').selectOption('openai');await page.getByLabel('API 地址（可选）').fill('https://proxy.example/v1');await page.getByLabel('模型 ID').fill('gpt-4.1-mini');await page.getByLabel('模型密钥').fill(secret);
  let posts=0;page.on('request',r=>{if(r.url().endsWith('/api/v1/setup')&&r.method()==='POST')posts++;});
  await page.getByRole('button',{name:'完成配置'}).click();
  expect(await passwordInput.evaluate((input:HTMLInputElement)=>input.validity.tooShort)).toBe(true);expect(posts).toBe(0);
  await passwordInput.evaluate(input=>input.removeAttribute('minlength'));
  const rejected=page.waitForResponse(r=>r.url().endsWith('/api/v1/setup')&&r.request().method()==='POST');
  await page.getByRole('button',{name:'完成配置'}).click();expect((await rejected).status()).toBe(400);
  await expect(page.getByRole('alert')).toContainText('管理员密码至少需要 12 个字符');
  await expect(username).toHaveValue('owner');await expect(passwordInput).toHaveValue('too-short');await expect(page.getByLabel('模型密钥')).toHaveValue(secret);
  expect(app.service.store.setting('initialized',false)).toBe(false);
  await passwordInput.fill(password);await page.getByRole('button',{name:'完成配置'}).click();await expect(page.getByRole('button',{name:'注销会话'})).toBeVisible();
  await page.getByRole('button',{name:'注销会话'}).click();await expect(page.getByRole('heading',{name:'登录家庭 Agent'})).toBeVisible();
  await username.fill('owner');await passwordInput.fill('wrong-password');await page.getByRole('button',{name:'登录',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('管理员用户名或密码不正确');await expect(username).toHaveValue('owner');
  await passwordInput.fill(password);await page.getByRole('button',{name:'登录',exact:true}).click();await expect(page.getByRole('button',{name:'注销会话'})).toBeVisible();
 }finally{await page.close();await app.cleanup();}
});
