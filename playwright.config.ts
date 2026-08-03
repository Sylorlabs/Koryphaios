import { defineConfig, devices } from '@playwright/test';
import { resolve } from 'node:path';

// Keep the isolated backend state inside the test output directory. This is
// portable across Windows, macOS, and Linux (unlike a hard-coded /tmp path).
const e2eDataDir = resolve(process.cwd(), 'test-results', 'koryphaios-playwright');

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 8_000 },
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://127.0.0.1:5173',
    trace: 'retain-on-failure',
    ...devices['Desktop Chrome'],
  },
  // Start an isolated backend before Vite. E2E must never accidentally target
  // a developer's stale desktop backend on :3001: it makes results depend on
  // the host machine and can hide a real frontend/backend compatibility issue.
  webServer: [
    {
      command: 'bun backend/src/server.ts',
      url: 'http://127.0.0.1:3011/api/health',
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        KORYPHAIOS_HOST: '127.0.0.1',
        KORYPHAIOS_PORT: '3011',
        KORYPHAIOS_DATA_DIR: e2eDataDir,
        SESSION_TOKEN_SECRET: 'playwright-only-not-a-production-secret',
        NODE_ENV: 'test',
      },
    },
    {
      command: 'bun run --cwd frontend dev --host 127.0.0.1 --port 5173',
      url: 'http://127.0.0.1:5173',
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        KORYPHAIOS_PORT: '3011',
      },
    },
  ],
});
