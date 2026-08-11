import { describe, expect, it } from 'bun:test';
import { resolve } from 'node:path';
import {
  isLauncherBackendReady,
  mergeCorsOriginEnv,
  resolveFrontendCorsOrigins,
  type LauncherBackendHealth,
} from './desktop-launcher-cors';

const HEALTHY_BACKEND: LauncherBackendHealth = {
  ok: true,
  data: {
    id: 'koryphaios',
    pid: 1234,
    version: '0.2.0',
    compat: { serverStartedAt: 1 },
  },
};

describe('native desktop launcher CORS contract', () => {
  it('pre-optimizes every Tauri module used by the native WebView', async () => {
    const viteConfig = await Bun.file(
      resolve(import.meta.dir, '../frontend/vite.config.ts'),
    ).text();
    for (const entry of [
      '@tauri-apps/api/app',
      '@tauri-apps/api/core',
      '@tauri-apps/api/event',
      '@tauri-apps/api/window',
      '@tauri-apps/plugin-clipboard-manager',
      '@tauri-apps/plugin-notification',
      '@tauri-apps/plugin-process',
      '@tauri-apps/plugin-shell',
    ]) {
      expect(viteConfig).toContain(`'${entry}'`);
    }
  });

  it('allows both exact loopback browser origins for the default native dev port', () => {
    expect(resolveFrontendCorsOrigins('http://127.0.0.1:3003')).toEqual([
      'http://127.0.0.1:3003',
      'http://localhost:3003',
    ]);
    expect(resolveFrontendCorsOrigins('http://localhost:3003')).toEqual([
      'http://localhost:3003',
      'http://127.0.0.1:3003',
    ]);
  });

  it('merges resolved origins without erasing or duplicating configured origins', () => {
    expect(
      mergeCorsOriginEnv('https://app.example.test,http://127.0.0.1:3003', [
        'http://127.0.0.1:3003',
        'http://localhost:3003',
      ]),
    ).toBe('https://app.example.test,http://127.0.0.1:3003,http://localhost:3003');
  });

  it('never injects a wildcard origin', () => {
    expect(() => mergeCorsOriginEnv(undefined, ['*'])).toThrow('wildcard CORS origin');
    expect(mergeCorsOriginEnv(undefined, ['http://127.0.0.1:3003'])).not.toContain('*');
  });

  it('requires ACAO proof before a fresh or reused backend is considered ready', () => {
    const origin = 'http://127.0.0.1:3003';
    expect(isLauncherBackendReady(HEALTHY_BACKEND, origin, origin)).toBe(true);
    expect(isLauncherBackendReady(HEALTHY_BACKEND, null, origin)).toBe(false);
    expect(isLauncherBackendReady(HEALTHY_BACKEND, 'http://localhost:3003', origin)).toBe(false);
    expect(
      isLauncherBackendReady(
        { ...HEALTHY_BACKEND, data: { ...HEALTHY_BACKEND.data, id: 'another-service' } },
        origin,
        origin,
      ),
    ).toBe(false);
  });
});
