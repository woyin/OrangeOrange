import { defineConfig } from '@playwright/test';
export default defineConfig({
 testDir: './tests/browser', timeout: 90000, expect: { timeout: 10000 }, fullyParallel: false, workers: 1,
 reporter: 'list', use: { trace: 'retain-on-failure' },
 projects: [{ name: 'desktop', use: { viewport: { width: 1280, height: 900 } } }, { name: 'mobile', use: { viewport: { width: 390, height: 844 } } }]
});
