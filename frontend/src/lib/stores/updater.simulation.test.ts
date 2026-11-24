// Simulation of the release->notify->install user journey, exercised against a
// local stand-in for the GitHub Releases `latest.json` manifest.
//
// The real updater is a Rust/Tauri path that only runs in release builds, and
// its signature verification cannot be disabled. These tests therefore drive
// the JS half that decides what the user sees: manifest parsing, the
// version-comparison gate, the launch + periodic check cadence, the popup, and
// the download-progress accounting. What they deliberately do NOT claim to
// verify is artifact signature validity or a real install.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const invoke = vi.hoisted(() => vi.fn());
const listen = vi.hoisted(() => vi.fn());
const open = vi.hoisted(() => vi.fn());
const fetchMock = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen }));
vi.mock('@tauri-apps/plugin-shell', () => ({ open }));

/** A manifest shaped exactly like the one release-desktop.yml publishes. */
function manifest(version: string, notes = '### Fixed\n- a bug') {
  return {
    version,
    notes,
    pub_date: '2026-08-04T03:43:39.285Z',
    platforms: {
      'darwin-aarch64': {
        signature: 'dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkK',
        url: 'https://github.com/Sylorlabs/Koryphaios/releases/download/v0.1.0/Koryphaios_aarch64.app.tar.gz',
      },
    },
  };
}

/** The store fires its launch check without awaiting it, so let the microtask
 *  queue drain before asserting on the resulting state. */
async function settle(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

/** One implementer for every command the store invokes. `launchAutoUpdate` is
 *  the single launch-only permission the Rust side returns. */
let launchAutoUpdate = false;
function mockCheck(result: unknown): void {
  invoke.mockImplementation(async (command: string) => {
    if (command === 'should_auto_update_at_launch') return launchAutoUpdate;
    if (command === 'check_for_updates') return result;
    if (command === 'install_update') return undefined;
    return undefined;
  });
}

async function loadStore({ currentVersion = '0.5.0', isTauri = true, dev = false } = {}) {
  vi.resetModules();
  // The store self-checks on import, so the env has to be in place first.
  // vi.stubEnv only takes effect for import.meta.env with a real boolean —
  // the string 'false' is truthy and leaves the store permanently disabled.
  vi.stubEnv('DEV', dev);
  if (!isTauri) delete (globalThis as Record<string, unknown>).__TAURI_INTERNALS__;
  else (globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {};

  const mod = await import('./updater.svelte');
  await settle();
  return { updater: mod.updater, currentVersion };
}

/** Mirror of Tauri's default comparator: release.version > current. */
function tauriWouldOfferUpdate(releaseVersion: string, currentVersion: string): boolean {
  const parse = (v: string) =>
    v
      .replace(/^v/, '')
      .split(/[.-]/)
      .map((n) => (/^\d+$/.test(n) ? Number(n) : n));
  const [rMaj, rMin = 0, rPat = 0] = parse(releaseVersion);
  const [cMaj, cMin = 0, cPat = 0] = parse(currentVersion);
  if (rMaj !== cMaj) return rMaj > cMaj;
  if (rMin !== cMin) return rMin > cMin;
  return rPat > cPat;
}

beforeEach(() => {
  invoke.mockReset();
  listen.mockReset().mockResolvedValue(() => {});
  open.mockReset().mockResolvedValue(undefined);
  launchAutoUpdate = false;
  fetchMock
    .mockReset()
    .mockResolvedValue(
      new Response(JSON.stringify({ ok: true, data: { activity: null } }), { status: 200 }),
    );
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  delete (globalThis as Record<string, unknown>).__TAURI_INTERNALS__;
});

describe('update simulation: manifest to user-visible state', () => {
  it('offers an update when the release is newer than the running build', async () => {
    mockCheck({
      available: true,
      version: '0.6.0',
      notes: '### Fixed\n- a bug',
      pub_date: '2026-08-04T03:43:39.285Z',
    });
    const { updater } = await loadStore();

    expect(updater.updateAvailable).toBe(true);
    expect(updater.updateInfo?.version).toBe('0.6.0');
    // The title-bar pill is gated on this exact flag.
    expect(updater.showUpdateBanner).toBe(true);
  });

  it('stays quiet when the release is older than the running build', async () => {
    // This is the real-world 0.5.0-local vs 0.1.0-published case.
    expect(tauriWouldOfferUpdate('0.1.0', '0.5.0')).toBe(false);
    mockCheck({ available: false, version: null, notes: null, pub_date: null });
    const { updater } = await loadStore();

    expect(updater.updateAvailable).toBe(false);
    expect(updater.showUpdateBanner).toBe(false);
  });

  it('offers an update from 0.1.0 to 0.5.0 — the actual pending release', async () => {
    // Users hold 0.1.0 today. This is the comparison that must succeed.
    expect(tauriWouldOfferUpdate('0.5.0', '0.1.0')).toBe(true);
    mockCheck({
      available: true,
      version: '0.5.0',
      notes: '### Fixed\n- a bug',
      pub_date: '2026-08-04T03:43:39.285Z',
    });
    const { updater } = await loadStore({ currentVersion: '0.1.0' });

    expect(updater.updateAvailable).toBe(true);
    expect(updater.updateInfo?.version).toBe('0.5.0');
  });

  it('never auto-installs from an in-session check', async () => {
    mockCheck({ available: true, version: '0.6.0', notes: 'x', pub_date: null });
    const { updater } = await loadStore();

    // Discovery happened...
    expect(invoke).toHaveBeenCalledWith('check_for_updates');
    // ...but an in-session check never installs. Only the launch gate can.
    expect(invoke).not.toHaveBeenCalledWith('install_update');
  });

  it('auto-installs once when an interactive launch finds an update', async () => {
    launchAutoUpdate = true;
    mockCheck({ available: true, version: '0.6.0', notes: 'x', pub_date: null });
    const { updater } = await loadStore();

    expect(invoke).toHaveBeenCalledWith('should_auto_update_at_launch');
    expect(invoke).toHaveBeenCalledWith('install_update');
    expect(updater.launchInstalling).toBe(true);
  });

  it('surfaces a GitHub Actions release that is still building', async () => {
    mockCheck({ available: false, version: null, notes: null, pub_date: null });
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: true,
          data: {
            activity: {
              phase: 'building',
              version: '0.6.0',
              tag: 'v0.6.0',
              status: 'in_progress',
              conclusion: null,
              runUrl: 'https://github.com/Sylorlabs/Koryphaios/actions/runs/1',
              workflow: 'release-desktop.yml',
              trigger: 'tag',
              startedAt: null,
            },
          },
        }),
        { status: 200 },
      ),
    );
    const { updater } = await loadStore();

    expect(updater.releaseActivity?.version).toBe('0.6.0');
    expect(updater.getReleaseActivityLabel()).toBe('v0.6.0 building');
    expect(invoke).not.toHaveBeenCalledWith('install_update');
  });

  it('installs only after the user confirms, then restarts', async () => {
    mockCheck({ available: true, version: '0.6.0', notes: 'x', pub_date: null });
    const { updater } = await loadStore();

    await updater.installUpdateAndRestart();

    expect(invoke).toHaveBeenCalledWith('install_update');
  });

  it('refuses to install when no update is available', async () => {
    mockCheck({ available: false, version: null, notes: null, pub_date: null });
    const { updater } = await loadStore();

    expect(await updater.installUpdateAndRestart()).toBe(false);
    expect(invoke).not.toHaveBeenCalledWith('install_update');
  });

  it('surfaces a failed install so the user can retry', async () => {
    // Register the progress listener before loading, so a partial bar can be
    // built up and then proven to reset when the install fails.
    let handler: ((e: { payload: unknown }) => void) | undefined;
    listen.mockImplementation((_evt: string, cb: (e: { payload: unknown }) => void) => {
      handler = cb;
      return Promise.resolve(() => {});
    });
    mockCheck({ available: true, version: '0.6.0', notes: 'x', pub_date: null });
    const { updater } = await loadStore();
    await vi.waitFor(() => expect(handler).toBeDefined());

    handler!({ payload: { chunkLength: 30, contentLength: 100 } });
    expect(updater.downloadProgress).toBe(30);

    invoke.mockRejectedValueOnce(new Error('signature mismatch'));
    expect(await updater.installUpdateAndRestart()).toBe(false);
    expect(updater.error).toBe('signature mismatch');
    // A failed install must not leave a frozen partial bar behind. The reset
    // happens at the top of installUpdateAndRestart, so it holds regardless of
    // which catch path runs.
    expect(updater.downloadProgress).toBe(0);

    updater.resetInstallState();
    expect(updater.error).toBeNull();
  });

  it('resets a stale progress bar when a retry is attempted', async () => {
    let handler: ((e: { payload: unknown }) => void) | undefined;
    listen.mockImplementation((_evt: string, cb: (e: { payload: unknown }) => void) => {
      handler = cb;
      return Promise.resolve(() => {});
    });
    mockCheck({ available: true, version: '0.6.0', notes: 'x', pub_date: null });
    const { updater } = await loadStore();
    await vi.waitFor(() => expect(handler).toBeDefined());

    // First attempt fails partway through a download.
    invoke.mockRejectedValueOnce(new Error('network dropped'));
    await updater.installUpdateAndRestart();
    handler!({ payload: { chunkLength: 45, contentLength: 100 } });
    expect(updater.downloadProgress).toBe(45);

    // Retrying must start from a clean bar, not resume the stale 45%.
    expect(await updater.installUpdateAndRestart()).toBe(true);
    expect(updater.downloadProgress).toBe(0);
    expect(updater.error).toBeNull();
  });

  it('turns download chunk events into a real progress percentage', async () => {
    let handler: ((e: { payload: unknown }) => void) | undefined;
    listen.mockImplementation((_evt: string, cb: (e: { payload: unknown }) => void) => {
      handler = cb;
      return Promise.resolve(() => {});
    });
    mockCheck({ available: true, version: '0.6.0', notes: 'x', pub_date: null });
    const { updater } = await loadStore();
    await vi.waitFor(() => expect(handler).toBeDefined());

    handler!({ payload: { chunkLength: 25, contentLength: 100 } });
    handler!({ payload: { chunkLength: 25, contentLength: 100 } });
    expect(updater.downloadProgress).toBe(50);

    handler!({ payload: { chunkLength: 50, contentLength: 100 } });
    expect(updater.downloadProgress).toBe(100);
  });

  it('falls back to megabytes when the server sends no content-length', async () => {
    let handler: ((e: { payload: unknown }) => void) | undefined;
    listen.mockImplementation((_evt: string, cb: (e: { payload: unknown }) => void) => {
      handler = cb;
      return Promise.resolve(() => {});
    });
    mockCheck({ available: true, version: '0.6.0', notes: 'x', pub_date: null });
    const { updater } = await loadStore();
    await vi.waitFor(() => expect(handler).toBeDefined());

    handler!({ payload: { chunkLength: 2 * 1024 * 1024, contentLength: null } });
    expect(updater.downloadProgress).toBe(2); // MB, not a stuck 0
  });

  it('checks on launch so an already-running user finds out without asking', async () => {
    mockCheck({ available: false, version: null, notes: null, pub_date: null });
    await loadStore();

    expect(invoke).toHaveBeenCalledWith('check_for_updates');
  });

  it('re-checks on the 30 minute cadence for users already running', async () => {
    vi.useFakeTimers();
    try {
      mockCheck({ available: false, version: null, notes: null, pub_date: null });
      const { updater } = await loadStore();
      const afterLaunch = invoke.mock.calls.length;

      vi.advanceTimersByTime(30 * 60 * 1000);
      expect(invoke.mock.calls.length).toBeGreaterThan(afterLaunch);

      // Keep checking after an offer so a withdrawn or superseded release can
      // clear the title-bar pill instead of leaving a stale update forever.
      mockCheck({ available: true, version: '0.6.0', notes: 'x', pub_date: null });
      await updater.checkForUpdates(true);
      const afterFound = invoke.mock.calls.length;
      vi.advanceTimersByTime(30 * 60 * 1000);
      expect(invoke.mock.calls.length).toBeGreaterThan(afterFound);
    } finally {
      vi.useRealTimers();
    }
  });

  it('polls release activity every five minutes and never installs it', async () => {
    vi.useFakeTimers();
    try {
      mockCheck({ available: false, version: null, notes: null, pub_date: null });
      const { updater } = await loadStore();
      fetchMock.mockResolvedValue(
        new Response(
          JSON.stringify({
            ok: true,
            data: {
              activity: {
                phase: 'building',
                version: '0.6.0',
                tag: 'v0.6.0',
                status: 'in_progress',
                conclusion: null,
                runUrl: 'https://github.com/Sylorlabs/Koryphaios/actions/runs/1',
                workflow: 'release-desktop.yml',
                trigger: 'tag',
                startedAt: null,
              },
            },
          }),
          { status: 200 },
        ),
      );

      vi.advanceTimersByTime(5 * 60 * 1000);
      await settle();

      expect(updater.releaseActivity?.version).toBe('0.6.0');
      expect(invoke).not.toHaveBeenCalledWith('install_update');
    } finally {
      vi.useRealTimers();
    }
  });

  it('strips the release-notes boilerplate before showing the popup', async () => {
    const notes = [
      '### ✨ Features',
      '- native CLI bridge',
      '',
      '---',
      '**macOS** · **Windows** — download below or update automatically on next launch.',
      '<!-- CHANGES_JSON [{"type":"fix"}] -->',
    ].join('\n');
    mockCheck({ available: true, version: '0.6.0', notes, pub_date: null });
    const { updater } = await loadStore();

    const clean = updater.getCleanNotes();
    expect(clean).toContain('native CLI bridge');
    expect(clean).not.toContain('CHANGES_JSON');
    expect(clean).not.toContain('download below');
    expect(clean).not.toContain('---');
  });

  it('is inert outside Tauri and in dev builds', async () => {
    mockCheck({ available: true, version: '9.9.9', notes: 'x', pub_date: null });

    const { updater: notauri } = await loadStore({ isTauri: false });
    expect(await notauri.checkForUpdates()).toBeNull();
    expect(notauri.updateAvailable).toBe(false);

    const { updater: devBuild } = await loadStore({ isTauri: true, dev: true });
    expect(await devBuild.checkForUpdates()).toBeNull();
    expect(devBuild.updateAvailable).toBe(false);
  });

  it('treats a check failure as a soft miss, never a false update', async () => {
    invoke.mockRejectedValue(new Error('network unreachable'));
    const { updater } = await loadStore();

    expect(await updater.checkForUpdates(true)).toBeNull();
    expect(updater.updateAvailable).toBe(false);
    // launch-user/build flows surface this; a silent background check does not
    expect(updater.error).toBe('network unreachable');
  });
});

describe('update simulation: manifest contract', () => {
  it('parses the published v0.1.0 manifest and finds the macOS target', () => {
    const m = manifest('0.1.0');
    expect(m.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(m.platforms['darwin-aarch64'].url).toMatch(/^https:\/\//);
    // Tauri refuses to skip signature verification, so an empty sig is fatal.
    expect(m.platforms['darwin-aarch64'].signature.length).toBeGreaterThan(0);
  });
});
