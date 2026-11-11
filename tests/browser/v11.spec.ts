import { test, expect, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { fixture } from './server.js';

const password = 'browser-owner-password';
async function login(page: Page, url: string) {
  const setup = await fetch(url + '/api/v1/setup', { method: 'POST', headers: { Origin: url, 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'owner', password, timezone: 'UTC' }) });
  expect(setup.ok).toBeTruthy();
  await page.goto(url);
  await page.getByLabel('管理员用户名').fill('owner');
  await page.getByLabel(/^密码(?: \*)?$/).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('button', { name: '注销会话' })).toBeVisible();
}
async function navigate(page: Page, name: string) {
  await page.getByRole('navigation').getByRole('button', { name, exact: true }).click();
  await expect(page.getByRole('heading', { name, exact: true, level: 2 })).toBeVisible();
}

test('迁移扫描发送 ZIP 哈希并显示真实错误', async ({ page }) => {
  const app = await fixture(false);
  try {
    await login(page, app.url);
    await navigate(page, '数据迁移');
    const bytes = Buffer.from('invalid zip for rejection');
    await page.getByLabel('来源实例标识').fill('test-source');
    await page.getByLabel('ZIP 文件').setInputFiles({ name: 'invalid.zip', mimeType: 'application/zip', buffer: bytes });
    const responsePromise = page.waitForResponse(r => r.url().endsWith('/api/v1/migrations') && r.request().method() === 'POST');
    await page.getByRole('button', { name: '扫描来源' }).click();
    const response = await responsePromise;
    const body = response.request().postDataJSON();
    expect(body.archiveBase64).toBe(bytes.toString('base64'));
    expect(body.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(response.ok()).toBeFalsy();
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.getByText('扫描完成，请检查服务端报告。')).toHaveCount(0);
  } finally { await page.close(); await app.cleanup(); }
});

test('应用中心通过真实接口上传受管附件并适配键盘和窄屏', async ({ page }) => {
  const app = await fixture(false);
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page, app.url);
    await navigate(page, '应用中心');
    const bytes = Buffer.from('browser attachment');
    await page.getByLabel('受管附件（最大 8 MiB）').setInputFiles({ name: 'note.txt', mimeType: 'text/plain', buffer: bytes });
    const responsePromise = page.waitForResponse(r => r.url().endsWith('/api/v1/artifacts') && r.request().method() === 'POST');
    await page.getByRole('button', { name: '上传附件' }).click();
    const response = await responsePromise;
    expect(response.ok()).toBeTruthy();
    const payload = response.request().postDataJSON();
    expect(payload.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(payload.base64).toBe(bytes.toString('base64'));
    const artifact = (await response.json()).data;
    await expect(page.getByText(artifact.sha256)).toBeVisible();
    await page.getByLabel('主题', { exact: true }).focus();
    await page.keyboard.type('键盘');
    await expect(page.getByLabel('主题', { exact: true })).toHaveValue('键盘');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(await page.evaluate(() => document.documentElement.clientWidth));
    await expect(page.locator('body')).not.toContainText(password);
  } finally { await page.close(); await app.cleanup(); }
});
