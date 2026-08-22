import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.NODE_ENV = 'test';
process.env.SESSION_TOKEN_SECRET =
  process.env.SESSION_TOKEN_SECRET ?? 'test_only_not_for_production_aaaaaaaaaa';
process.env.KORYPHAIOS_DATA_DIR = join(tmpdir(), `koryphaios-voice-route-${process.pid}`);

const { Elysia } = await import('elysia');
const { localAuth } = await import('../../auth/local-auth');
const { buildLocalBearerToken } = await import('../../auth/local-route-auth');
const { errorHandler } = await import('../../middleware/error-handling');
const { voiceRoutes } = await import('./voice');

const app = new Elysia().onError(errorHandler).use(voiceRoutes);
const realFetch = globalThis.fetch;
let networkCalls = 0;

function authorizedRequest(path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: {
      Authorization: buildLocalBearerToken(localAuth.createSession(['*'])),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  networkCalls = 0;
  globalThis.fetch = mock(async () => {
    networkCalls += 1;
    throw new Error('Unexpected network request');
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('voice routes validate locally before provider requests', () => {
  test.each([
    ['/api/voice/transcribe', { audioBase64: '' }, 'Recorded audio is required'],
    ['/api/voice/synthesize', { text: '' }, 'Text is required'],
    ['/api/voice/packs/not-a-pack/download', {}, 'Unknown voice pack'],
  ] as const)('%s rejects invalid input without a network request', async (path, body, message) => {
    const response = await app.handle(authorizedRequest(path, body));
    const payload = (await response.json()) as { ok: boolean; code: string; error: string };
    expect(response.status).toBe(400);
    expect(payload.ok).toBe(false);
    expect(payload.code).toBe('VALIDATION_ERROR');
    expect(payload.error).toContain(message);
    expect(networkCalls).toBe(0);
  });
});
