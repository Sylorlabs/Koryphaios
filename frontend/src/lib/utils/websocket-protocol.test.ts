import { describe, expect, test } from 'vitest';
import {
  createWebSocketPong,
  isWebSocketPing,
  nextWebSocketCandidateIndex,
  prepareAuthenticatedWebSocketUrl,
  redactWebSocketUrl,
} from './websocket-protocol';

describe('websocket protocol boundary', () => {
  test('answers only a valid application heartbeat', () => {
    expect(isWebSocketPing({ type: 'ping', timestamp: 42 })).toBe(true);
    expect(isWebSocketPing({ type: 'ping', timestamp: '42' })).toBe(false);
    expect(createWebSocketPong(43)).toEqual({ type: 'pong', timestamp: 43 });
  });

  test('removes bearer material and every query parameter from diagnostics', () => {
    const secret = 'Bearer-local-secret-that-must-not-be-logged';
    const label = redactWebSocketUrl(
      `ws://127.0.0.1:3001/ws?auth=${encodeURIComponent(secret)}&other=value`,
    );
    expect(label).toBe('ws://127.0.0.1:3001/ws');
    expect(label).not.toContain(secret);
    expect(label).not.toContain('auth');
  });

  test('refreshes a stale bearer before reconnecting directly after a backend restart', async () => {
    let token = 'synthetic-stale-session';
    const ensureSession = async () => {
      token = 'synthetic-refreshed-session';
      return true;
    };

    const prepared = await prepareAuthenticatedWebSocketUrl(
      'ws://127.0.0.1:3021/ws',
      ensureSession,
      () => token,
    );

    expect(prepared).not.toBeNull();
    expect(new URL(prepared!).searchParams.get('auth')).toBe('synthetic-refreshed-session');
    expect(nextWebSocketCandidateIndex(0, 2, true)).toBe(0);
    expect(nextWebSocketCandidateIndex(0, 2, false)).toBe(1);
  });

  test('fails closed when websocket session refresh is unavailable', async () => {
    expect(
      await prepareAuthenticatedWebSocketUrl(
        'ws://127.0.0.1:3021/ws',
        async () => false,
        () => 'synthetic-stale-session',
      ),
    ).toBeNull();
  });
});
