import { beforeEach, describe, expect, test } from 'bun:test';
import type { UpdateReleaseDeps } from '../update-release-status';
import {
  getUpdateReleaseStatus,
  isVersionNewer,
  resetUpdateReleaseStatusCache,
} from '../update-release-status';

interface FakeRun {
  head_branch?: string | null;
  head_sha?: string | null;
  status?: string | null;
  conclusion?: string | null;
  event?: string | null;
  html_url?: string | null;
  created_at?: string | null;
  run_started_at?: string | null;
  head_commit?: { message?: string } | null;
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function transport(input: { release?: FakeRun[]; prepare?: FakeRun[]; version?: string | null }) {
  const calls: string[] = [];
  const fetchImpl = (async (url: string | URL | Request) => {
    const href = String(url);
    calls.push(href);
    if (href.includes('/actions/workflows/release-desktop.yml/runs')) {
      return json({ workflow_runs: input.release ?? [] });
    }
    if (href.includes('/actions/workflows/auto-release.yml/runs')) {
      return json({ workflow_runs: input.prepare ?? [] });
    }
    if (href.includes('raw.githubusercontent.com')) {
      return input.version
        ? json({ version: input.version })
        : new Response('missing', { status: 404 });
    }
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function deps(fetchImpl: typeof fetch): UpdateReleaseDeps {
  return { fetch: fetchImpl, now: () => 1_000 };
}

const RUN_URL = 'https://github.com/Sylorlabs/Koryphaios/actions/runs/1';

beforeEach(() => resetUpdateReleaseStatusCache());

describe('release activity', () => {
  test('detects a tag-run build and reports its version', async () => {
    const { fetchImpl } = transport({
      release: [
        {
          head_branch: 'v0.6.0',
          status: 'in_progress',
          event: 'push',
          html_url: RUN_URL,
          created_at: '2026-11-23T00:00:00Z',
          run_started_at: '2026-11-23T00:01:00Z',
        },
      ],
    });

    const status = await getUpdateReleaseStatus({ deps: deps(fetchImpl), force: true });

    expect(status.activity?.phase).toBe('building');
    expect(status.activity?.version).toBe('0.6.0');
    expect(status.activity?.tag).toBe('v0.6.0');
    expect(status.activity?.trigger).toBe('tag');
    expect(status.activity?.status).toBe('in_progress');
    expect(status.activity?.startedAt).toBe('2026-11-23T00:01:00Z');
  });

  test('resolves a manually dispatched preparation from its commit', async () => {
    const { fetchImpl } = transport({
      prepare: [
        {
          head_sha: 'abcdef1234567',
          status: 'queued',
          event: 'workflow_dispatch',
          html_url: RUN_URL,
          created_at: '2026-11-23T00:00:00Z',
        },
      ],
      version: '0.6.0',
    });

    const status = await getUpdateReleaseStatus({ deps: deps(fetchImpl), force: true });

    expect(status.activity?.phase).toBe('preparing');
    expect(status.activity?.version).toBe('0.6.0');
    expect(status.activity?.trigger).toBe('manual');
    expect(status.activity?.tag).toBeNull();
  });

  test('detects the /update commit trigger and ignores ordinary pushes', async () => {
    const update = transport({
      prepare: [
        {
          head_sha: 'abcdef1234567',
          status: 'in_progress',
          event: 'push',
          head_commit: { message: 'fix: ship the release\n\n/update' },
          html_url: RUN_URL,
          created_at: '2026-11-23T00:00:00Z',
        },
      ],
      version: '0.6.0',
    });

    expect(
      (await getUpdateReleaseStatus({ deps: deps(update.fetchImpl), force: true })).activity
        ?.trigger,
    ).toBe('commit');

    resetUpdateReleaseStatusCache();
    const ordinary = transport({
      prepare: [
        {
          head_sha: 'abcdef1234567',
          status: 'in_progress',
          event: 'push',
          head_commit: { message: 'fix: ship without a release' },
          html_url: RUN_URL,
          created_at: '2026-11-23T00:00:00Z',
        },
      ],
      version: '0.6.0',
    });

    expect(
      (await getUpdateReleaseStatus({ deps: deps(ordinary.fetchImpl), force: true })).activity,
    ).toBeNull();
  });

  test('ignores runs that are not newer than the running build', async () => {
    const { fetchImpl } = transport({
      release: [
        {
          head_branch: 'v0.5.0',
          status: 'in_progress',
          event: 'push',
          html_url: RUN_URL,
          created_at: '2026-11-23T00:00:00Z',
        },
      ],
    });

    const status = await getUpdateReleaseStatus({ deps: deps(fetchImpl), force: true });

    expect(status.activity).toBeNull();
  });

  test('a failed probe is a soft miss, never an update', async () => {
    const fetchImpl = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;

    const status = await getUpdateReleaseStatus({ deps: deps(fetchImpl), force: true });

    expect(status.activity).toBeNull();
    expect(status.error).toBe('Release status temporarily unavailable.');
  });

  test('caches successful probes and force refreshes', async () => {
    const { fetchImpl, calls } = transport({ release: [] });
    const config = deps(fetchImpl);

    await getUpdateReleaseStatus({ deps: config });
    const afterFirst = calls.length;
    await getUpdateReleaseStatus({ deps: config });
    expect(calls.length).toBe(afterFirst);

    await getUpdateReleaseStatus({ deps: config, force: true });
    expect(calls.length).toBeGreaterThan(afterFirst);
  });
});

describe('isVersionNewer', () => {
  test('compares core versions and treats stable as newer than prerelease', () => {
    expect(isVersionNewer('0.6.0', '0.5.0')).toBe(true);
    expect(isVersionNewer('0.5.0', '0.5.0')).toBe(false);
    expect(isVersionNewer('0.5.1', '0.5.0')).toBe(true);
    expect(isVersionNewer('0.5.0-beta.1', '0.5.0')).toBe(false);
    expect(isVersionNewer('0.5.0', '0.5.0-beta.1')).toBe(true);
  });
});
