import { test, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider, fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
import { startControlServer } from '../../src/control/server.js';

const password = 'browser-owner-password';

test('聊天取消正在运行的模型任务', async ({ page }) => {
  const dir = await mkdtemp(join(tmpdir(), 'orange-chat-cancel-'));
  const models = createModels();
  const faux = fauxProvider();
  models.setProvider(faux.provider);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  faux.setResponses([async () => { await held; return fauxAssistantMessage('不应完成'); }]);
  const app = await startControlServer({ dataDir: join(dir, 'data'), workspace: join(dir, 'workspace'), webDir: 'apps/web/dist', port: 0, runtimeOptions: { models, provider: 'faux' }, diskProbe: async () => 1e9 });
  try {
    const setup = await fetch(app.url + '/api/v1/setup', { method: 'POST', headers: { Origin: app.url, 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'owner', password, timezone: 'UTC' }) });
    expect(setup.status).toBe(200);
    const conversation = await app.service.conversation({ name: '取消测试会话' });
    await app.service.conversation({ name: '另一个会话' });
    await page.goto(app.url);
    await page.getByLabel('管理员用户名').fill('owner');
    await page.getByLabel('密码').fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.getByRole('navigation').getByRole('button', { name: '对话', exact: true }).click();
    await expect(page.getByRole('heading', { name: '取消测试会话', exact: true })).toBeVisible();
    await page.locator('.records article').filter({ has: page.getByRole('heading', { name: '取消测试会话', exact: true }) }).getByRole('button', { name: '查看详情' }).click();
    await page.getByLabel('消息', { exact: true }).fill('等待取消的请求');
    await page.getByRole('button', { name: '发送消息' }).click();
    await expect.poll(() => app.service.list('tasks').find(t => t.conversationId === conversation.id)?.status).toBe('RUNNING');
    await expect.poll(() => faux.state.callCount).toBe(1);
    const cancel = page.getByRole('button', { name: '取消当前任务' });
    await expect(cancel).toBeVisible();
    let releaseResponse!: () => void;
    let intercepted!: () => void;
    const responseGate = new Promise<void>(resolve => { releaseResponse = resolve; });
    const responseStarted = new Promise<void>(resolve => { intercepted = resolve; });
    let delayed = false;
    await page.route('**/api/v1/tasks?conversationId=*', async route => {
      if (delayed) return route.continue();
      delayed = true;
      const response = await route.fetch();
      intercepted();
      await responseGate;
      await route.fulfill({ response });
    });
    await page.getByRole('button', { name: '刷新', exact: true }).click();
    await responseStarted;
    await page.locator('.records article').filter({ has: page.getByRole('heading', { name: '另一个会话', exact: true }) }).getByRole('button', { name: '查看详情' }).click();
    await expect(page.locator('.detail h3')).toHaveText('另一个会话');
    await expect(cancel).toBeHidden();
    releaseResponse();
    await page.unrouteAll({ behavior: 'wait' });
    await expect(page.locator('.detail h3')).toHaveText('另一个会话');
    await expect(cancel).toBeHidden();
    await page.locator('.records article').filter({ has: page.getByRole('heading', { name: '取消测试会话', exact: true }) }).getByRole('button', { name: '查看详情' }).click();
    await expect(cancel).toBeVisible();
    page.once('dialog', dialog => dialog.accept());
    await cancel.click();
    await expect.poll(() => app.service.list('tasks').find(t => t.conversationId === conversation.id)?.status).toBe('CANCELLED');
    await expect(cancel).toBeHidden();
  } finally {
    release();
    await page.close();
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
