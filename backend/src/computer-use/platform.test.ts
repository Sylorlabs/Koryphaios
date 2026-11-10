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
