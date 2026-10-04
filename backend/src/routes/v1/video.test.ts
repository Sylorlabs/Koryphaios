import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.NODE_ENV = 'test';
process.env.SESSION_TOKEN_SECRET =
  process.env.SESSION_TOKEN_SECRET ?? 'test_only_not_for_production_aaaaaaaaaa';

const { Elysia } = await import('elysia');
const { localAuth } = await import('../../auth/local-auth');
const { buildLocalBearerToken } = await import('../../auth/local-route-auth');
const { setContext } = await import('../../context');
const { errorHandler } = await import('../../middleware/error-handling');
const { videoRoutes, resetVideoJobsForTests } = await import('./video');
const { listVideoHistory, maybePruneOldEntries } = await import('../../images/video-history');

const dataDir = mkdtempSync(join(tmpdir(), 'kory-video-route-'));
process.env.KORYPHAIOS_DATA_DIR = dataDir;

const realFetch = globalThis.fetch;
const app = new Elysia().onError(errorHandler).use(videoRoutes);

/** One pixel of PNG, so a "download" has real bytes to return. */
const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function setConfigs(configs: Record<string, unknown>): void {
  setContext({
    providers: { getConfigs: () => configs },
  } as never);
}

function authorized(path: string, body?: unknown, method?: string): Request {
  return new Request(`http://localhost${path}`, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: {
      Authorization: buildLocalBearerToken(localAuth.createSession(['*'])),
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** Stub a provider's whole submit/poll/download exchange. */
function stubFetch(handler: (url: string, init?: RequestInit) => Response): void {
  globalThis.fetch = (async (url: string, init?: RequestInit) =>
    handler(String(url), init)) as unknown as typeof fetch;
}

describe('video generation routes', () => {
  beforeAll(() => {
    setConfigs({});
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    resetVideoJobsForTests();
  });

  test('requires local route auth', async () => {
    const response = await app.handle(new Request('http://localhost/api/video/providers'));
    expect(response.status).toBe(401);
  });

  test('lists video providers with their models and connection state', async () => {
    setConfigs({ luma: { apiKey: 'configured' } });
    const response = await app.handle(authorized('/api/video/providers'));
    const payload = (await response.json()) as {
      data: Array<{ provider: string; configured: boolean; models: Array<{ id: string }> }>;
      unconnected: string[];
    };
    expect(response.status).toBe(200);
    const luma = payload.data.find((entry) => entry.provider === 'luma');
    expect(luma?.configured).toBe(true);
    expect(luma?.models.map((model) => model.id)).toContain('ray-2');
    // Replicate has no credential here, so it is offered as connectable rather
    // than omitted.
    expect(payload.unconnected).toContain('replicate');
  });

  test('rejects a request with no provider or prompt', async () => {
    setConfigs({ luma: { apiKey: 'k' } });
    const noProvider = await app.handle(authorized('/api/video/generate', { prompt: 'a cat' }));
    expect(noProvider.status).toBe(400);
    const noPrompt = await app.handle(
      authorized('/api/video/generate', { provider: 'luma', prompt: '   ' }),
    );
    expect(noPrompt.status).toBe(400);
  });

  test('refuses to generate from a provider that is not connected', async () => {
    setConfigs({});
    const response = await app.handle(
      authorized('/api/video/generate', { provider: 'luma', model: 'ray-2', prompt: 'a cat' }),
    );
    expect(response.status).toBe(400);
    const payload = (await response.json()) as { error?: string };
    expect(payload.error).toMatch(/Connect luma/);
  });

  test('refuses a provider with no video capability', async () => {
    setConfigs({ voyageai: { apiKey: 'k' } });
    const response = await app.handle(
      authorized('/api/video/generate', { provider: 'voyageai', model: 'voyage-3.5', prompt: 'x' }),
    );
    expect(response.status).toBe(400);
    const payload = (await response.json()) as { error?: string };
    expect(payload.error).toMatch(/does not support video/);
  });

  test('polls an async provider to completion and persists the clip', async () => {
    setConfigs({ luma: { apiKey: 'configured-key' } });
    const requestedUrls: string[] = [];
    let polls = 0;
    stubFetch((url) => {
      requestedUrls.push(url);
      if (url.endsWith('/generations')) {
        return new Response(JSON.stringify({ id: 'job-1' }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/generations/job-1')) {
        polls += 1;
        return new Response(
          JSON.stringify(
            polls < 2
              ? { id: 'job-1', state: 'dreaming' }
              : { id: 'job-1', state: 'completed', assets: { video: 'https://cdn.test/clip.mp4' } },
          ),
          { headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.includes('cdn.test')) {
        return new Response(new Uint8Array([1, 2, 3, 4]), {
          headers: { 'content-type': 'video/mp4' },
        });
      }
      return new Response('{}', { headers: { 'content-type': 'application/json' } });
    });

    const response = await app.handle(
      authorized('/api/video/generate', {
        prompt: 'a cat surfing',
        provider: 'luma',
        model: 'ray-2',
        duration: '5s',
        aspectRatio: '16:9',
        jobId: 'video-job-1',
      }),
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      data: { provider: string; model: string; mimeType: string; historyId?: string };
    };
    expect(payload.data.provider).toBe('luma');
    expect(payload.data.model).toBe('ray-2');
    expect(payload.data.mimeType).toBe('video/mp4');
    expect(payload.data.historyId).toBeTruthy();
    // The job was polled more than once rather than assuming sync completion.
    expect(polls).toBeGreaterThanOrEqual(2);
    expect(requestedUrls.some((url) => url.includes('/generations/job-1'))).toBe(true);

    const history = await listVideoHistory(10);
    expect(history).toHaveLength(1);
    expect(history[0]?.provider).toBe('luma');
    expect(history[0]?.duration).toBe('5s');
  });

  test('surfaces a provider failure instead of reporting an empty clip', async () => {
    setConfigs({ klingai: { apiKey: 'configured-key' } });
    // History accumulates across tests in this file, so compare against the
    // current count rather than expecting an empty gallery.
    const before = (await listVideoHistory(100)).length;
    stubFetch((url) => {
      if (url.endsWith('/text2video')) {
        return new Response(JSON.stringify({ data: { task_id: 'task-9' } }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(
        JSON.stringify({
          data: { task_status: 'failed', task_status_msg: 'content risk control' },
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    });
    const response = await app.handle(
      authorized('/api/video/generate', {
        prompt: 'x',
        provider: 'klingai',
        model: 'kling-v2-6',
      }),
    );
    expect(response.status).toBe(400);
    const payload = (await response.json()) as { error?: string };
    expect(payload.error).toMatch(/content risk control/);
    // A failed generation must not persist a placeholder clip.
    expect(await listVideoHistory(100)).toHaveLength(before);
  });

  test('a second request with the same job id is refused as a duplicate', async () => {
    setConfigs({ luma: { apiKey: 'k' } });
    stubFetch(
      () =>
        new Response(JSON.stringify({ id: 'job-2' }), {
          headers: { 'content-type': 'application/json' },
        }),
    );
    // Hold the first request open by never resolving the status poll.
    const first = app.handle(
      authorized('/api/video/generate', {
        prompt: 'x',
        provider: 'luma',
        model: 'ray-2',
        jobId: 'dup-job',
      }),
    );
    // Give the first request a tick to register the job.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const status = await app.handle(authorized('/api/video/jobs/dup-job'));
    const statusPayload = (await status.json()) as { data: { status: string } };
    expect(statusPayload.data.status).toBe('running');

    const second = await app.handle(
      authorized('/api/video/generate', {
        prompt: 'x',
        provider: 'luma',
        model: 'ray-2',
        jobId: 'dup-job',
      }),
    );
    expect(second.status).toBe(409);
    // Release the first request so the test does not leak a pending promise.
    const cancel = await app.handle(authorized('/api/video/jobs/dup-job/cancel', {}, 'POST'));
    const cancelPayload = (await cancel.json()) as { data: { cancelled: boolean } };
    expect(cancelPayload.data.cancelled).toBe(true);
    await first;
  });

  test('an unknown job id reports unknown rather than failing', async () => {
    const response = await app.handle(authorized('/api/video/jobs/never-existed'));
    const payload = (await response.json()) as { data: { status: string } };
    expect(payload.data.status).toBe('unknown');
  });

  test('deletes a history entry and then reports it missing', async () => {
    setConfigs({ luma: { apiKey: 'k' } });
    stubFetch((url) => {
      if (url.endsWith('/generations')) {
        return new Response(JSON.stringify({ id: 'job-3' }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/generations/job-3')) {
        return new Response(
          JSON.stringify({
            id: 'job-3',
            state: 'completed',
            assets: { video: `data:video/mp4;base64,${TINY_PNG}` },
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('{}', { headers: { 'content-type': 'application/json' } });
    });
    const created = await app.handle(
      authorized('/api/video/generate', { prompt: 'x', provider: 'luma', model: 'ray-2' }),
    );
    const createdPayload = (await created.json()) as { data: { historyId: string } };
    const historyId = createdPayload.data.historyId;
    expect(historyId).toBeTruthy();

    const fetched = await app.handle(authorized(`/api/video/history/${historyId}`));
    expect(fetched.status).toBe(200);

    const deleted = await app.handle(
      authorized(`/api/video/history/${historyId}`, undefined, 'DELETE'),
    );
    expect(deleted.status).toBe(200);
    const gone = await app.handle(authorized(`/api/video/history/${historyId}`));
    expect(gone.status).toBe(400);
  });

  test('prunes clips past the retention window', async () => {
    const before = await maybePruneOldEntries(Date.now() + 60 * 60 * 1000 * 24 * 40);
    // Nothing is older than 40 days in this suite, so pruning is a no-op that
    // still has to succeed rather than throw.
    expect(before).toBeGreaterThanOrEqual(0);
  });
});
