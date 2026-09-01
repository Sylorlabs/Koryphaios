import { beforeEach, describe, expect, test } from 'vitest';
import {
  clearRecoverableDeviceAuthFlow,
  loadRecoverableDeviceAuthFlows,
  saveRecoverableDeviceAuthFlow,
} from './device-auth-recovery';

const future = Date.now() + 60_000;

describe('short-lived device auth recovery', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  test('uses sessionStorage only and returns an unexpired transaction', () => {
    expect(
      saveRecoverableDeviceAuthFlow('copilot', {
        deviceCode: 'device-code',
        userCode: 'ABCD-EFGH',
        verificationUri: 'https://github.com/login/device',
        expiresAt: future,
        intervalMs: 5_000,
      }),
    ).toBe(true);

    expect(loadRecoverableDeviceAuthFlows()).toEqual({
      copilot: {
        deviceCode: 'device-code',
        userCode: 'ABCD-EFGH',
        verificationUri: 'https://github.com/login/device',
        expiresAt: future,
        intervalMs: 5_000,
      },
    });
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(1);
  });

  test('fails closed for expired or malformed flows', () => {
    expect(
      saveRecoverableDeviceAuthFlow('kimicode', {
        deviceCode: 'device-code',
        userCode: 'ABCD',
        verificationUri: 'not-a-url',
        expiresAt: Date.now() - 1,
        intervalMs: 5_000,
      }),
    ).toBe(false);
    expect(loadRecoverableDeviceAuthFlows()).toEqual({});
  });

  test('removes a completed flow', () => {
    saveRecoverableDeviceAuthFlow('codex-auth', {
      deviceCode: 'device-code',
      userCode: 'ABCD',
      verificationUri: 'https://chatgpt.com/device',
      expiresAt: future,
      intervalMs: 1_500,
    });
    clearRecoverableDeviceAuthFlow('codex-auth');
    expect(loadRecoverableDeviceAuthFlows()).toEqual({});
  });
});
