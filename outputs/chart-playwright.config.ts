import { defineConfig } from '../node_modules/@playwright/test/index';
export default defineConfig({
  testDir: '../e2e', testMatch: 'project-activity.spec.ts', timeout: 60_000,
  expect: { timeout: 15_000 }, workers: 1, reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:5174', headless: true, viewport: { width: 1440, height: 1000 } },
});
