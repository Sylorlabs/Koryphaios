import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearProjectIconAssetCache, projectIconAssetUrl } from './project-icon-assets.svelte';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('$lib/api.svelte', () => ({ apiFetch: mocks.apiFetch }));
vi.mock('$lib/utils/api-url', () => ({ apiUrl: (path: string) => `http://backend.test${path}` }));

const ASSET = '/api/workspace/project-icon/asset_1';

async function flushMicrotasks() {
  // loadAsset starts on a microtask; a few turns let its awaits settle.
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

describe('projectIconAssetUrl', () => {
  beforeEach(() => {
    mocks.apiFetch.mockReset();
    clearProjectIconAssetCache();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('passes data: URLs through without fetching', () => {
    expect(projectIconAssetUrl('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA');
    expect(mocks.apiFetch).not.toHaveBeenCalled();
  });

  it('retries a transient failure after the backoff', async () => {
    vi.useFakeTimers();
    mocks.apiFetch.mockResolvedValue(new Response('unavailable', { status: 503 }));

    expect(projectIconAssetUrl(ASSET)).toBeNull();
    await vi.advanceTimersByTimeAsync(0);
    await flushMicrotasks();
    expect(mocks.apiFetch).toHaveBeenCalledTimes(1);

    // The failed entry is cached until the backoff elapses.
    projectIconAssetUrl(ASSET);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(mocks.apiFetch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(projectIconAssetUrl(ASSET)).toBeNull();
    await vi.advanceTimersByTimeAsync(0);
    await flushMicrotasks();
    expect(mocks.apiFetch).toHaveBeenCalledTimes(2);
  });

  it('does not retry a definitive 404', async () => {
    vi.useFakeTimers();
    mocks.apiFetch.mockResolvedValue(new Response('not found', { status: 404 }));

    projectIconAssetUrl(ASSET);
    await vi.advanceTimersByTimeAsync(0);
    await flushMicrotasks();
    expect(mocks.apiFetch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    projectIconAssetUrl(ASSET);
    await vi.advanceTimersByTimeAsync(0);
    await flushMicrotasks();
    expect(mocks.apiFetch).toHaveBeenCalledTimes(1);
  });

  it('does not retry a non-PNG response', async () => {
    vi.useFakeTimers();
    mocks.apiFetch.mockResolvedValue(
      new Response('<html></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    );

    projectIconAssetUrl(ASSET);
    await vi.advanceTimersByTimeAsync(0);
    await flushMicrotasks();
    expect(mocks.apiFetch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    projectIconAssetUrl(ASSET);
    await vi.advanceTimersByTimeAsync(0);
    await flushMicrotasks();
    expect(mocks.apiFetch).toHaveBeenCalledTimes(1);
  });
});
