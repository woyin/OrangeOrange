import { test, expect, type Page } from '@playwright/test';
import { controlFixture, CONTROL_TEST_PASSWORD } from '../control-fixture.js';
import { hermesFixtureArchive } from '../control-migration-fixture.js';
import { GMAIL_SEND_SCOPE } from '../../src/connectors/oauth.js';

const redirectUri = 'https://hda.example/api/v1/oauth/google/callback';
async function login(page: Page, url: string) {
  await page.goto(url);
  await page.getByLabel('管理员用户名').fill('owner');
  await page.getByLabel(/^密码(?: \*)?$/).fill(CONTROL_TEST_PASSWORD);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('button', { name: '注销会话' })).toBeVisible();
}
async function navigate(page: Page, name: string) {
  await page.getByRole('navigation').getByRole('button', { name, exact: true }).click();
  await expect(page.getByRole('heading', { name, exact: true, level: 2 })).toBeVisible();
}

test('真实迁移批次与 Memory 审查', async ({ page }) => {
  const f = await controlFixture({ webDir: 'apps/web/dist' });
  try {
    await f.setup();
    await login(page, f.app.url);
    await navigate(page, '数据迁移');
    await page.getByLabel('来源实例标识').fill('browser-hermes');
    await page.getByLabel('来源系统').selectOption('hermes');
    await page.getByLabel('ZIP 文件').setInputFiles({ name: 'hermes.zip', mimeType: 'application/zip', buffer: await hermesFixtureArchive('Imported apple preference') });
    const scanResponse = page.waitForResponse(r => r.url().endsWith('/api/v1/migrations') && r.request().method() === 'POST');
    await page.getByRole('button', { name: '扫描来源' }).click();
    const scan = await scanResponse;
    expect(scan.ok(), await scan.text()).toBeTruthy();
    await expect(page.getByText('扫描完成，请检查服务端报告。')).toBeVisible();
    await page.getByLabel('管理员密码', { exact: true }).fill(CONTROL_TEST_PASSWORD);
    await page.getByLabel('我已检查计划或回滚影响，并确认操作').check();
    const appliedResponse = page.waitForResponse(r => r.url().endsWith('/apply') && r.request().method() === 'POST');
    await page.getByRole('button', { name: '按此哈希执行迁移' }).click();
    const applied = await appliedResponse;
    expect(applied.ok(), await applied.text()).toBeTruthy();
    const table = page.getByRole('table');
    const memory = table.getByRole('row').filter({ has: page.getByRole('cell', { name: 'memory', exact: true }) }).first();
    await expect(memory).toBeVisible();
    await memory.getByRole('button', { name: '审查对象' }).click();
    await page.getByLabel('审查后内容').fill('Approved browser apple preference');
    const responsePromise = page.waitForResponse(r => r.url().endsWith('/memory') && r.request().method() === 'POST');
    await page.getByRole('button', { name: '批准并保存 Memory' }).click();
    const response = await responsePromise;
    expect(response.ok(), await response.text()).toBeTruthy();
    await expect(page.getByText('Memory 已审查并保存。')).toBeVisible();
    expect(f.app.service.store.searchMemories('apple', 'owner').map(m => m.content)).toContain('Approved browser apple preference');
  } finally { await page.close(); await f.close(); }
});

test('真实本地邮件审批发送一次，取消后的意图不能发送', async ({ page }) => {
  let sends = 0;
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    if (url === 'https://oauth2.googleapis.com/token') return new Response(JSON.stringify({ access_token: 'fake-access', refresh_token: 'fake-refresh', expires_in: 3600, token_type: 'Bearer', scope: GMAIL_SEND_SCOPE }));
    if (url === 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send') { sends++; return new Response(JSON.stringify({ id: 'fake-message', threadId: 'fake-thread' })); }
    if (url === 'https://oauth2.googleapis.com/revoke') return new Response('');
    throw new Error('Unexpected upstream: ' + url);
  };
  const f = await controlFixture({ webDir: 'apps/web/dist', oauthRedirectUris: [redirectUri], fetcher });
  try {
    await f.setup();
    await login(page, f.app.url);
    await navigate(page, '应用中心');
    await page.getByLabel('连接名称').fill('Browser Gmail');
    await page.getByLabel('发送邮箱地址').fill('sender@example.com');
    await page.getByLabel('我确认此地址属于授权账号或其已验证别名。标签不是 Google 身份验证结果。').check();
    await page.getByLabel('OAuth Client ID').fill('test.apps.googleusercontent.com');
    await page.getByLabel('OAuth Client Secret').fill('fake-client-secret');
    await page.getByLabel('HTTPS 回调地址').fill(redirectUri);
    const createdResponse = page.waitForResponse(r => r.url().endsWith('/app-connections') && r.request().method() === 'POST');
    await page.getByRole('button', { name: '保存连接配置' }).click();
    const created = await createdResponse;
    expect(created.ok(), await created.text()).toBeTruthy();
    const id = (await created.json()).data.id;
    const start = await f.request(`app-connections/${id}/oauth/start`, 'POST', {});
    expect(start.response.ok, JSON.stringify(start.json)).toBeTruthy();
    const state = new URL(start.json.data.authorizationUrl).searchParams.get('state')!;
    const callback = await fetch(`${f.app.url}/api/v1/oauth/google/callback?${new URLSearchParams({ state, code: 'controlled-code' })}`, { redirect: 'manual' });
    expect(callback.status).toBe(303);
    await page.getByRole('button', { name: '刷新状态' }).click();
    await expect(page.locator('option').filter({ hasText: 'Browser Gmail · CONNECTED' })).toHaveCount(1);
    await page.getByLabel('发送账号').selectOption({ label: 'Browser Gmail · CONNECTED' });
    await page.getByLabel('收件人 To（逗号或换行分隔）').fill('recipient@example.com');
    await page.getByLabel('主题', { exact: true }).fill('Browser mail');
    await page.getByLabel('纯文本正文').fill('Local approval body');
    const proposedResponse = page.waitForResponse(r => r.url().endsWith('/action-intents') && r.request().method() === 'POST');
    await page.getByRole('button', { name: '提交草稿供审核' }).click();
    const proposed = await proposedResponse;
    expect(proposed.ok(), await proposed.text()).toBeTruthy();
    const intent = (await proposed.json()).data;
    await expect(page.getByText('已提交本地待审批意图，尚未发送。')).toBeVisible();
    expect(sends).toBe(0);
    await page.getByRole('button', { name: '从预览生成规则草稿' }).click();
    const preview = (await f.request(`action-intents/${intent.id}/decision`)).json.data;
    await expect(page.getByLabel('模板哈希')).toHaveValue(preview.templateHash);
    await expect(page.getByLabel('允许收件人')).toHaveValue('recipient@example.com');
    await expect(page.getByLabel('启用规则')).not.toBeChecked();
    await page.getByRole('button', { name: '批准此哈希' }).click();
    await expect(page.getByRole('button', { name: '确认发送' })).toBeEnabled();
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: '确认发送' }).click();
    await expect(page.getByRole('button', { name: '确认发送' })).toBeDisabled();
    await expect(page.getByRole('button', { name: /CONFIRMED/ })).toBeVisible();
    expect(sends).toBe(1);
    await page.getByRole('button', { name: '提交草稿供审核' }).click();
    await expect(page.getByText('已提交本地待审批意图，尚未发送。')).toBeVisible();
    await page.getByRole('button', { name: '取消意图' }).click();
    await expect(page.getByRole('button', { name: /CANCELLED/ })).toBeVisible();
    await expect(page.getByRole('button', { name: '确认发送' })).toBeDisabled();
    expect(sends).toBe(1);
  } finally { await page.close(); await f.close(); }
});

test('记忆禁记策略与敏感候选内容审核使用真实HTTP', async({page})=>{
 const f=await controlFixture({webDir:'apps/web/dist'});
 try{
  await f.setup();await page.goto(f.app.url);await page.getByLabel('管理员用户名').fill('owner');await page.getByLabel(/^密码(?: \*)?$/).fill(CONTROL_TEST_PASSWORD);await page.getByRole('button',{name:'登录',exact:true}).click();
  await page.getByRole('navigation').getByRole('button',{name:'长期记忆',exact:true}).click();
  const policy=page.getByRole('region',{name:'记忆策略与候选'});
  await policy.getByLabel('禁止记住的类别（逗号分隔）').fill('finance');await policy.getByRole('button',{name:'保存禁记策略'}).click();
  await expect.poll(()=>f.app.service.store.get<any>('memory_policy_blocked_categories','owner')?.categories).toEqual(['finance']);
  const candidate=f.app.service.memoryPolicy.propose({principalId:'owner',scope:'owner',kind:'semantic',source:'browser-review',content:'健康 browser-medical-marker'});
  expect(candidate.state).toBe('PENDING_REVIEW');await policy.getByRole('button',{name:'刷新待审候选'}).click();await expect(policy).toContainText('browser-medical-marker');
  page.once('dialog',d=>d.accept());await policy.getByRole('button',{name:'批准此记忆内容'}).click();
  await expect(policy).toContainText('APPLIED');await expect.poll(()=>f.app.service.store.searchMemories('browser-medical-marker','owner').length).toBe(1);
 }finally{await page.close();await f.close();}
});
