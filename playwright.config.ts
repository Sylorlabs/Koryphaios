import { defineConfig, devices } from '@playwright/test';

const backendPort = 3011;
const frontendPort = 5174;
const backendUrl = `http://127.0.0.1:${backendPort}`;
const dataDirectory = `/tmp/koryphaios-playwright-${process.pid}`;

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 8_000 },
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: `http://127.0.0.1:${frontendPort}`,
    trace: 'retain-on-failure',
    ...devices['Desktop Chrome'],
  },
  webServer: [
    {
      command: `KORYPHAIOS_PORT=${backendPort} KORYPHAIOS_DATA_DIR=${dataDirectory} bun run --cwd backend dev`,
      url: `${backendUrl}/api/health`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: `KORYPHAIOS_PORT=${backendPort} bun run --cwd frontend dev --host 127.0.0.1 --port ${frontendPort}`,
      url: `http://127.0.0.1:${frontendPort}`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
