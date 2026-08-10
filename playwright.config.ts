import { defineConfig, devices } from '@playwright/test';

const backendPort = 3011;
const frontendPort = 5174;
const backendUrl = `http://127.0.0.1:${backendPort}`;
const frontendOrigins = [
  `http://127.0.0.1:${frontendPort}`,
  `http://localhost:${frontendPort}`,
].join(',');
const dataDirectory = `/tmp/koryphaios-playwright-${process.pid}`;
const testKmsPassphrase = 'koryphaios-e2e-isolated-local-kms-v1';

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
      // The startup sentinel intentionally calls the backend directly, so the
      // isolated browser origin must be admitted explicitly. The synthetic
      // passphrase protects this run's disposable local KMS without weakening
      // the production fail-closed default.
      command: `KORYPHAIOS_PORT=${backendPort} KORYPHAIOS_DATA_DIR=${dataDirectory} CORS_ORIGINS=${frontendOrigins} KORYPHAIOS_KMS_PASSPHRASE=${testKmsPassphrase} KORY_DISABLE_CLI_AUTODETECT=1 bun run --cwd backend dev`,
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
