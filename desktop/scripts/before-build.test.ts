import { describe, expect, test } from 'bun:test';

import { planBeforeBuild } from './before-build';

const HOST = 'aarch64-apple-darwin';

describe('beforeBuildCommand payload plan', () => {
  test('a prebuilt payload only rebuilds the packaged frontend', () => {
    expect(planBeforeBuild({ KORY_EMBEDDED_BACKEND: 'prebuilt' }, HOST)).toEqual({
      mode: 'prebuilt',
      steps: ['packaged-frontend'],
    });
  });

  test('a local build writes the hash, then the backend, then the frontend', () => {
    expect(planBeforeBuild({}, HOST)).toEqual({
      mode: 'local',
      steps: ['compat-hash', 'embedded-backend', 'packaged-frontend'],
    });
    // A host-matched explicit --target still takes the local path.
    expect(planBeforeBuild({ TAURI_ENV_TARGET_TRIPLE: HOST }, HOST).mode).toBe('local');
  });

  test('a foreign target triple without a prebuilt payload fails', () => {
    expect(() =>
      planBeforeBuild({ TAURI_ENV_TARGET_TRIPLE: 'x86_64-pc-windows-msvc' }, HOST),
    ).toThrow('KORY_EMBEDDED_BACKEND=prebuilt');
  });
});
