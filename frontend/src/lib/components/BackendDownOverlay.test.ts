import { fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import BackendDownOverlay from './BackendDownOverlay.svelte';

const relaunch = vi.fn();

vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: () => relaunch() }));

const healthState = vi.hoisted(() => ({
  status: 'unhealthy' as string,
  reason: 'unreachable' as string | null,
  consecutiveFailures: 275,
  lastCheckedAt: 0,
  failureDetail: 'Could not reach http://127.0.0.1:3001/api/health' as string | null,
  frontendVersion: '0.5.0',
  startupPhase: null as string | null,
  startupDetail: null as string | null,
  startupElapsedMs: null as number | null,
}));

vi.mock('$lib/stores/backend-health.svelte', () => ({
  POLL_INTERVAL_MS: 5_000,
  recheckBackendHealth: vi.fn(),
  backendHealth: healthState,
}));

vi.mock('$lib/demo-flags', () => ({ isDemoMode: false }));

vi.mock('$lib/utils/clipboard', () => ({ copyText: vi.fn() }));

vi.mock('$lib/utils/error-monitor', () => ({
  getStallSnapshot: () => ({ worstFrameGapMs: 0, longTaskCount: 0, recentStalls: [] }),
}));

/** The "Restart app" button, which is the control under test. */
function restartButton(): HTMLElement {
  return screen.getByRole('button', { name: /Restart(ing)?( app|…)/ });
}

function isPending(button: HTMLElement): boolean {
  return button.hasAttribute('disabled') && /Restarting/.test(button.textContent ?? '');
}

/** Click and let the handler's dynamic import settle before asserting. */
async function clickRestart(button: HTMLElement) {
  await fireEvent.click(button);
  await vi.advanceTimersByTimeAsync(0);
}

describe('BackendDownOverlay restart app', () => {
  beforeEach(() => {
    relaunch.mockReset();
    Object.assign(healthState, {
      status: 'unhealthy',
      reason: 'unreachable',
      consecutiveFailures: 275,
      lastCheckedAt: Date.now(),
      failureDetail: 'Could not reach http://127.0.0.1:3001/api/health',
      startupPhase: null,
      startupDetail: null,
      startupElapsedMs: null,
    });
    // Pretend this is a packaged build inside the Tauri shell, which is the
    // only configuration where a relaunch can actually succeed.
    vi.stubEnv('DEV', false);
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('leaves the button usable when the relaunch never settles', async () => {
    // relaunch() only settles if the shell tears this document down. When the
    // shell cannot answer it never settles, and an unbounded await pinned the
    // button in its disabled "Restarting…" state with no way back.
    vi.useFakeTimers();
    relaunch.mockReturnValue(new Promise<void>(() => {}));

    render(BackendDownOverlay);
    const button = restartButton();
    expect(isPending(button)).toBe(false);

    await clickRestart(button);
    expect(relaunch).toHaveBeenCalledOnce();
    expect(isPending(button)).toBe(true);

    // Let the restart time-out elapse.
    await vi.advanceTimersByTimeAsync(8_000);

    // The attempt gave up instead of leaving the button disabled forever, and it
    // explains itself rather than failing silently.
    expect(isPending(button)).toBe(false);
    expect(button).toBeEnabled();
    expect(screen.getByRole('status').textContent).toMatch(/could not be restarted/i);
  });

  it('recovers when the relaunch rejects', async () => {
    vi.useFakeTimers();
    relaunch.mockRejectedValue(new Error('restart denied'));

    render(BackendDownOverlay);
    const button = restartButton();

    await clickRestart(button);

    expect(button).toBeEnabled();
    expect(screen.getByRole('status').textContent).toMatch(/could not be restarted/i);
  });

  it('lets the user retry after a failed restart', async () => {
    vi.useFakeTimers();
    relaunch.mockRejectedValueOnce(new Error('restart denied'));

    render(BackendDownOverlay);
    await clickRestart(restartButton());

    relaunch.mockReturnValue(new Promise<void>(() => {}));
    await clickRestart(restartButton());
    expect(relaunch).toHaveBeenCalledTimes(2);
  });

  it('does not relaunch in a dev build, and names the real recovery step', async () => {
    // A dev build's window is served by the Vite dev server, a separate process
    // that relaunch() does not restart, so relaunching only strands the user
    // with an empty window.
    vi.stubEnv('DEV', true);
    relaunch.mockReturnValue(new Promise<void>(() => {}));

    render(BackendDownOverlay);
    const button = restartButton();
    await fireEvent.click(button);

    expect(relaunch).not.toHaveBeenCalled();
    expect(button).toBeEnabled();
    expect(screen.getByRole('status').textContent).toMatch(/bun run dev/);
  });

  it('reloads the page when there is no Tauri shell to relaunch', async () => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    const reload = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, reload },
    });

    render(BackendDownOverlay);
    await fireEvent.click(restartButton());

    expect(relaunch).not.toHaveBeenCalled();
    expect(reload).toHaveBeenCalledOnce();
  });
});

describe('BackendDownOverlay starting state', () => {
  beforeEach(() => {
    Object.assign(healthState, {
      status: 'starting',
      reason: null,
      consecutiveFailures: 0,
      lastCheckedAt: Date.now(),
      failureDetail: null,
      startupPhase: 'database-vacuum',
      startupDetail: 'Compacting the database (one-time)',
      startupElapsedMs: 65_000,
    });
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  });

  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('renders progress, not an error, while the backend is still booting', () => {
    render(BackendDownOverlay);

    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(screen.getByText('Starting Koryphaios backend…')).toBeInTheDocument();
    expect(screen.getByText('Compacting the database (one-time)')).toBeInTheDocument();
    expect(screen.getByText(/Elapsed 1:0\d/)).toBeInTheDocument();
    expect(screen.getByText(/Don't quit the app/)).toBeInTheDocument();
    // No failure affordances while the boot is progressing normally.
    expect(screen.queryByRole('button', { name: /Retry now/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Restart/ })).not.toBeInTheDocument();
  });

  it('falls back to a phase label when the backend supplied no detail', () => {
    healthState.startupDetail = null;
    healthState.startupPhase = 'database-migrations';
    render(BackendDownOverlay);
    expect(screen.getByText('Applying database migrations')).toBeInTheDocument();
  });
});
