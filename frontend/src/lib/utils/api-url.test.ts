import { afterEach, describe, expect, it, vi } from 'vitest';
import { getWsCandidates } from './api-url';

function enterTauri() {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
}

function leaveTauri() {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
}

describe('api-url production candidates', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    leaveTauri();
  });

  it('never advertises the baked VITE endpoint in a production Tauri build', () => {
    enterTauri();
    vi.stubEnv('DEV', false);
    // Simulate a build that still had dev values baked into the bundle.
    vi.stubEnv('VITE_BACKEND_URL', 'http://vite-baked.invalid:5999');
    vi.stubEnv('VITE_BACKEND_WS_URL', 'ws://vite-baked.invalid:5999/ws');

    for (const candidate of getWsCandidates()) {
      expect(candidate).not.toContain('vite-baked.invalid');
    }
  });

  it('keeps the VITE endpoint reachable in dev', () => {
    enterTauri();
    vi.stubEnv('DEV', true);
    vi.stubEnv('VITE_BACKEND_WS_URL', 'ws://vite-baked.invalid:5999/ws');

    expect(getWsCandidates()).toContain('ws://vite-baked.invalid:5999/ws');
  });
});
