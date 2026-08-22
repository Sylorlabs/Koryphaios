import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';

process.env.NODE_ENV = 'test';
process.env.SESSION_TOKEN_SECRET =
  process.env.SESSION_TOKEN_SECRET ?? 'test_only_not_for_production_aaaaaaaaaa';

const { Elysia } = await import('elysia');
const { localAuth } = await import('../../auth/local-auth');
const { buildLocalBearerToken } = await import('../../auth/local-route-auth');
const { setContext } = await import('../../context');
const { errorHandler } = await import('../../middleware/error-handling');
const { imageRoutes } = await import('./images');

const app = new Elysia().onError(errorHandler).use(imageRoutes);
const realFetch = globalThis.fetch;
let requestBody: Record<string, unknown> | undefined;

function authorizedRequest(path: string, body?: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      Authorization: buildLocalBearerToken(localAuth.createSession(['*'])),
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeAll(() => {
  setContext({
    providers: {
      getConfigs: () => ({ openai: { apiKey: 'test-key', baseUrl: 'https://api.openai.com/v1' } }),
    },
  } as never);
  globalThis.fetch = mock(async (_input: string | URL | Request, init?: RequestInit) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return Response.json({ data: [{ b64_json: 'aW1hZ2U=', revised_prompt: 'Revised' }] });
  }) as unknown as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

describe('image generation routes', () => {
  test('reports configured providers', async () => {
    const response = await app.handle(authorizedRequest('/api/images/providers'));
    const payload = (await response.json()) as {
      data: Array<{ id: string; name: string; configured: boolean }>;
    };
    expect(response.status).toBe(200);
    expect(payload.data).toEqual([{ id: 'openai', name: 'OpenAI Images', configured: true }]);
  });

  test('generates a base64 image with the selected effect and options', async () => {
    const response = await app.handle(
      authorizedRequest('/api/images/generate', {
        prompt: 'A mountain observatory',
        effect: 'neon',
        size: '1536x1024',
        quality: 'high',
        outputFormat: 'webp',
      }),
    );
    const payload = (await response.json()) as { data: { imageBase64: string; mimeType: string } };
    expect(response.status).toBe(200);
    expect(payload.data).toMatchObject({ imageBase64: 'aW1hZ2U=', mimeType: 'image/webp' });
    expect(requestBody).toMatchObject({
      model: 'gpt-image-1',
      size: '1536x1024',
      quality: 'high',
      output_format: 'webp',
    });
    expect(String(requestBody?.prompt)).toContain('Neon glow');
  });
});
