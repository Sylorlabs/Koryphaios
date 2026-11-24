import { describe, expect, it } from 'bun:test';
import { createComputerPlatformAdapter, runComputerHelper } from './platform';
import { MACOS_HELPER_SOURCE } from './platform-macos';
import { WINDOWS_HELPER_SOURCE } from './platform-windows';
import { LINUX_HELPER_SOURCE } from './platform-linux';
import type { ComputerAction, ComputerTarget } from '@koryphaios/shared';

const window: ComputerTarget = {
  appId: 'macos:/Applications/Example.app/Contents/MacOS/Example',
  windowId: '42:123456',
  pid: 42,
  title: 'Example',
};
const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF9sAAAAASUVORK5CYII=';

describe('computer platform adapter (no native dependencies)', () => {
  it('fails closed on Wayland including XWayland without invoking a helper', async () => {
    let called = false;
    const adapter = createComputerPlatformAdapter({
      platform: 'linux',
      env: { WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' },
      invoke: async () => {
        called = true;
        return {};
      },
    });
    expect((await adapter.status()).available).toBe(false);
    expect((await adapter.status()).limitations.join(' ')).toContain('Wayland');
    await expect(adapter.execute({ kind: 'discover' })).rejects.toThrow('Wayland');
    expect(called).toBe(false);
  });
  it('reports unsupported operating systems without trying dependencies', async () => {
    const adapter = createComputerPlatformAdapter({
      platform: 'freebsd',
      invoke: async () => {
        throw new Error('must not run');
      },
    });
    expect(await adapter.status()).toMatchObject({ available: false, capabilities: [] });
    await expect(adapter.execute({ kind: 'discover' })).rejects.toThrow('unsupported');
  });
  it('reports missing dependencies without claiming capabilities', async () => {
    const adapter = createComputerPlatformAdapter({
      platform: 'win32',
      invoke: async () => {
        throw new Error('PowerShell unavailable');
      },
    });
    expect(await adapter.status()).toEqual({
      platform: 'win32',
      available: false,
      capabilities: [],
      limitations: ['PowerShell unavailable'],
    });
  });
  it('rejects invented/reserved native capabilities', async () => {
    const adapter = createComputerPlatformAdapter({
      platform: 'darwin',
      invoke: async () => ({
        platform: 'darwin',
        available: true,
        capabilities: ['clipboardRead'],
        limitations: [],
      }),
    });
    expect((await adapter.status()).available).toBe(false);
  });
  it('exposes only checked native targets', async () => {
    const adapter = createComputerPlatformAdapter({
      platform: 'darwin',
      invoke: async () => ({ targets: [window] }),
    });
    expect(await adapter.execute({ kind: 'discover' })).toEqual({ targets: [window] });
    const malformed = createComputerPlatformAdapter({
      platform: 'darwin',
      invoke: async () => ({ targets: [{ ...window, pid: -1 }] }),
    });
    await expect(malformed.execute({ kind: 'discover' })).rejects.toThrow('target');
  });
  it('rechecks app, process and launch-bound window identity before native action', async () => {
    for (const changed of [
      { ...window, pid: 43 },
      { ...window, appId: 'macos:/evil' },
      { ...window, windowId: '42:reused' },
    ]) {
      const calls: string[] = [];
      const adapter = createComputerPlatformAdapter({
        platform: 'darwin',
        invoke: async (request) => {
          calls.push(request.kind);
          return { targets: [changed] };
        },
      });
      await expect(adapter.execute({ kind: 'focus', target: window })).rejects.toThrow(
        'identity changed',
      );
      expect(calls).toEqual(['discover']);
    }
  });
  it('uses the current OS title, not agent supplied display labels, and strips unknown fields', async () => {
    const calls: unknown[] = [];
    const adapter = createComputerPlatformAdapter({
      platform: 'darwin',
      invoke: async (request) => {
        calls.push(request);
        return request.kind === 'discover' ? { targets: [window] } : { text: 'Focused' };
      },
    });
    await adapter.execute({
      kind: 'focus',
      target: { ...window, title: 'forged title' },
      script: 'unsafe',
    } as ComputerAction);
    expect(calls[1]).toEqual({ kind: 'focus', target: window });
  });
  it('transports shell metacharacters as text data, not executable code', async () => {
    const text = '$(touch /tmp/never); `whoami`\n"quoted"';
    let received: unknown;
    const adapter = createComputerPlatformAdapter({
      platform: 'darwin',
      invoke: async (request) => {
        if (request.kind === 'discover') return { targets: [window] };
        received = request;
        return { text: 'Inserted' };
      },
    });
    await adapter.execute({ kind: 'type', target: window, text });
    expect(received).toEqual({ kind: 'type', target: window, text });
  });
  it('refuses unsupported input without falling back to global injection', async () => {
    const adapter = createComputerPlatformAdapter({
      platform: 'freebsd',
      invoke: async () => {
        throw new Error('must not run');
      },
    });
    for (const action of [
      { kind: 'key', target: window, key: 'Ctrl+A' },
      { kind: 'scroll', target: window, delta: 4 },
      { kind: 'type', target: window, text: 'x' },
    ] as ComputerAction[]) {
      await expect(adapter.execute(action)).rejects.toThrow('unsupported');
    }
  });
  it('rejects invalid input before discovery or native invocation', async () => {
    const adapter = createComputerPlatformAdapter({
      platform: 'darwin',
      invoke: async () => {
        throw new Error('must not run');
      },
    });
    for (const x of [-1, NaN, Infinity, 10000])
      await expect(adapter.execute({ kind: 'click', target: window, x, y: 1 })).rejects.toThrow(
        'coordinates',
      );
    await expect(
      adapter.execute({ kind: 'type', target: window, text: 'x'.repeat(16385) }),
    ).rejects.toThrow('text');
  });
  it('discards a capture if target identity changes during observation', async () => {
    let discoveries = 0;
    const adapter = createComputerPlatformAdapter({
      platform: 'darwin',
      invoke: async (request) =>
        request.kind === 'discover'
          ? { targets: ++discoveries === 1 ? [window] : [] }
          : { imageBase64: png },
    });
    await expect(adapter.execute({ kind: 'observe', target: window })).rejects.toThrow(
      'image discarded',
    );
  });
  it('returns only PNG observations after a post-capture identity check', async () => {
    const adapter = createComputerPlatformAdapter({
      platform: 'darwin',
      invoke: async (request) =>
        request.kind === 'discover' ? { targets: [window] } : { imageBase64: png },
    });
    expect((await adapter.execute({ kind: 'observe', target: window })).imageBase64).toBe(png);
    const invalid = createComputerPlatformAdapter({
      platform: 'darwin',
      invoke: async (request) =>
        request.kind === 'discover'
          ? { targets: [window] }
          : { imageBase64: Buffer.from('not png').toString('base64') },
    });
    await expect(invalid.execute({ kind: 'observe', target: window })).rejects.toThrow('not a PNG');
  });
  it('does not turn helper errors or empty action responses into success', async () => {
    for (const result of [{ error: 'OS denied' }, {}]) {
      const adapter = createComputerPlatformAdapter({
        platform: 'darwin',
        invoke: async (request) => (request.kind === 'discover' ? { targets: [window] } : result),
      });
      await expect(adapter.execute({ kind: 'focus', target: window })).rejects.toThrow();
    }
  });
  it('honors an abort before invocation and after an uncooperative helper returns', async () => {
    const controller = new AbortController();
    const adapter = createComputerPlatformAdapter({
      platform: 'darwin',
      invoke: async () => {
        controller.abort();
        return { targets: [window] };
      },
    });
    await expect(adapter.execute({ kind: 'discover' }, controller.signal)).rejects.toThrow();
    await expect(adapter.execute({ kind: 'discover' }, controller.signal)).rejects.toThrow();
  });
});

describe('native helper transport', () => {
  it('uses stdin for data and rejects malformed exit status', async () => {
    const result = await runComputerHelper(
      process.execPath,
      ['-e', 'process.stdin.pipe(process.stdout)'],
      '$(echo never)',
      process.env,
    );
    expect(result).toBe('$(echo never)');
    await expect(
      runComputerHelper(process.execPath, ['-e', 'process.exit(2)'], '', process.env),
    ).rejects.toThrow('failed (2)');
  });
  it('kills a timed-out native helper', async () => {
    await expect(
      runComputerHelper(
        process.execPath,
        ['-e', 'setInterval(() => {}, 1000)'],
        '',
        process.env,
        undefined,
        80,
      ),
    ).rejects.toThrow('timed out');
  });
  it('kills native helpers when stopped', async () => {
    const controller = new AbortController();
    const pending = runComputerHelper(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      '',
      process.env,
      controller.signal,
    );
    setTimeout(() => controller.abort(), 80);
    await expect(pending).rejects.toThrow('aborted');
  });
  it('runs a queue of steps across windows in one native round trip', async () => {
    const requests: unknown[] = [];
    const windowA = {
      appId: 'macos:/A',
      windowId: 'w1',
      title: 'A',
      pid: 11,
      scope: 'window' as const,
    };
    const windowB = {
      appId: 'macos:/B',
      windowId: 'w2',
      title: 'B',
      pid: 22,
      scope: 'window' as const,
    };
    const adapter = createComputerPlatformAdapter({
      platform: 'win32',
      invoke: async (request) => {
        requests.push(request);
        if ((request as { kind: string }).kind === 'discover')
          return { targets: [windowA, windowB] };
        return {
          text: 'Ran 2 steps.',
          steps: [
            { index: 0, status: 'done' },
            { index: 1, status: 'done' },
          ],
        };
      },
    });
    const result = await adapter.execute({
      kind: 'sequence',
      observationId: 'obs-1',
      steps: [
        { kind: 'click', target: windowA, x: 10, y: 12 },
        { kind: 'type', target: windowB, text: 'hello' },
      ],
    });
    expect(result.text).toBe('Ran 2 steps.');
    expect(result.steps?.map((step) => step.status)).toEqual(['done', 'done']);
    const dispatched = requests.at(-1) as {
      steps: Array<Record<string, unknown>>;
      observationId?: string;
    };
    // Every step is rebuilt from the live window list, never from the agent's claim.
    expect(dispatched.steps[0]).toMatchObject({ kind: 'click', target: windowA, x: 10, y: 12 });
    expect(dispatched.steps[1]).toMatchObject({ kind: 'type', target: windowB, text: 'hello' });
    expect(dispatched.observationId).toBe('obs-1');
  });
  it('refuses a queue that is empty, over long, or names a window that vanished', async () => {
    const adapter = createComputerPlatformAdapter({
      platform: 'win32',
      invoke: async (request) =>
        (request as { kind: string }).kind === 'discover' ? { targets: [] } : { text: 'never' },
    });
    const gone = {
      appId: 'macos:/A',
      windowId: 'w1',
      title: 'A',
      pid: 11,
      scope: 'window' as const,
    };
    await expect(adapter.execute({ kind: 'sequence', steps: [] })).rejects.toThrow('1 to 64 steps');
    await expect(
      adapter.execute({
        kind: 'sequence',
        steps: Array.from({ length: 65 }, () => ({ kind: 'wait' as const, ms: 1 })),
      }),
    ).rejects.toThrow('1 to 64 steps');
    await expect(
      adapter.execute({ kind: 'sequence', steps: [{ kind: 'click', target: gone, x: 1, y: 1 }] }),
    ).rejects.toThrow('no longer available');
    await expect(
      adapter.execute({
        kind: 'sequence',
        steps: [{ kind: 'launch' as never, target: gone }],
      }),
    ).rejects.toThrow('Unsupported queue step');
  });
  it('surfaces user interference instead of cancelling the task', async () => {
    const windowA = {
      appId: 'macos:/A',
      windowId: 'w1',
      title: 'A',
      pid: 11,
      scope: 'window' as const,
    };
    const adapter = createComputerPlatformAdapter({
      platform: 'win32',
      invoke: async (request) =>
        (request as { kind: string }).kind === 'discover'
          ? { targets: [windowA] }
          : {
              text: 'Ran 1 steps.',
              interference: { kind: 'user-input', message: 'Someone typed.' },
            },
    });
    const result = await adapter.execute({
      kind: 'sequence',
      steps: [{ kind: 'click', target: windowA, x: 1, y: 1 }],
    });
    expect(result.interference).toEqual({ kind: 'user-input', message: 'Someone typed.' });
  });
  it('moves a window off screen and puts it back by request', async () => {
    const requests: Array<Record<string, unknown>> = [];
    const windowA = {
      appId: 'macos:/A',
      windowId: 'w1',
      title: 'A',
      pid: 11,
      scope: 'window' as const,
    };
    const adapter = createComputerPlatformAdapter({
      platform: 'win32',
      invoke: async (request) => {
        requests.push(request as Record<string, unknown>);
        return (request as { kind: string }).kind === 'discover'
          ? { targets: [windowA] }
          : { text: 'Window moved off screen.' };
      },
    });
    await adapter.execute({ kind: 'place', target: windowA, hidden: true });
    const hiddenCall = requests.at(-1)!;
    expect(hiddenCall.kind).toBe('place');
    expect(hiddenCall.hidden).toBe(true);
    expect(hiddenCall.target).toMatchObject({ windowId: 'w1', pid: 11 });
    await adapter.execute({ kind: 'place', target: windowA, hidden: false });
    expect(requests.at(-1)!.hidden).toBe(false);
    await expect(adapter.execute({ kind: 'place', target: windowA } as never)).rejects.toThrow(
      'explicit hidden flag',
    );
  });
  it('delivers input to the authorized process instead of the session that has focus', () => {
    // A computer use task must not take the user's focus or pointer: every event is
    // addressed to the authorized window's process, and activation is skipped.
    expect(MACOS_HELPER_SOURCE).toContain('event.postToPid(pid)');
    expect(MACOS_HELPER_SOURCE).toContain('directedPid == nil && !desktop(window)');
    expect(MACOS_HELPER_SOURCE).toContain('if directedPid == nil { try focus(window) }');
    expect(MACOS_HELPER_SOURCE).toContain('directedPid = background && !desktop(window)');
    // The person sees which window is driven, and the marker never intercepts input.
    expect(MACOS_HELPER_SOURCE).toContain('Controlled by Koryphaios');
    expect(MACOS_HELPER_SOURCE).toContain('overlay.ignoresMouseEvents = true');
    expect(MACOS_HELPER_SOURCE).toContain('showRing(window)');
    // Off screen placement keeps the window controllable and restore is part of ending control.
    expect(MACOS_HELPER_SOURCE).toContain('func offscreenPoint(');
    expect(MACOS_HELPER_SOURCE).toContain('releaseInput(); restoreWindows()');
    expect(MACOS_HELPER_SOURCE).toContain('onScreenWindowsOnly: onScreenOnly');
  });
  it('has embedded sources usable in a Bun compiled binary, without desktop capture/injection fallbacks', () => {
    expect(MACOS_HELPER_SOURCE).toContain('SCContentFilter(desktopIndependentWindow: native)');
    expect(MACOS_HELPER_SOURCE).toContain('CGEvent(');
    expect(MACOS_HELPER_SOURCE).toContain('eventSourceUserData');
    expect(WINDOWS_HELPER_SOURCE).toContain('PrintWindow($handle');
    expect(WINDOWS_HELPER_SOURCE).not.toContain('SendInput');
    expect(WINDOWS_HELPER_SOURCE).not.toContain('CopyFromScreen');
    expect(LINUX_HELPER_SOURCE).toContain('XResQueryClientIds');
    expect(LINUX_HELPER_SOURCE).toContain('XCompositeNameWindowPixmap(display, window)');
    expect(LINUX_HELPER_SOURCE).not.toContain('XGetImage(display, root');
  });
});
