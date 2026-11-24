import { afterEach, describe, expect, mock, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createFreebuffTurnRuntime,
  freebuffDockerRunArgs,
  freebuffDockerEnvironment,
  ensureFreebuffRuntimeImage,
  forceFreebuffRuntimeUpdate,
  freebuffRuntimeImageTag,
  findNativeFreebuffProbeBinary,
  reapFreebuffRuntimeArtifacts,
  scheduleFreebuffRuntimeUpdate,
  getFreebuffRuntimeStatus,
  probeFreebuffRuntime,
  refreshFreebuffRuntimeStatus,
  resetFreebuffRuntimeStateForTests,
  validateFreebuffRuntimePaths,
  type FreebuffRuntimeStatus,
} from '../freebuff-runtime';
import {
  FREEBUFF_MIN_RUNTIME_VERSION,
  isValidFreebuffVersion,
  compareFreebuffVersions,
} from '../freebuff-runtime-version';
import seccompProfile from '../../../../docker/freebuff-runtime/seccomp.json';

const roots: string[] = [];
function fixture(shared = false) {
  const parent = shared ? join(homedir(), '.koryphaios/freebuff-runs') : realpathSync(tmpdir());
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const runRoot = mkdtempSync(join(realpathSync(parent), 'runtime-test-'));
  roots.push(runRoot);
  const options = {
    runRoot,
    runHome: join(runRoot, 'home'),
    workspace: join(runRoot, 'workspace'),
    privateTmp: join(runRoot, 'tmp'),
    allowNetwork: false,
  };
  for (const path of [options.runHome, options.workspace, options.privateTmp])
    mkdirSync(path, { mode: 0o700 });
  return options;
}
afterEach(async () => {
  await resetFreebuffRuntimeStateForTests();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Freebuff runtime security contract', () => {
  const tag = (version: string, arch: 'amd64' | 'arm64' = 'amd64') =>
    freebuffRuntimeImageTag(version, arch);
  const tagName = (version: string, arch: 'amd64' | 'arm64' = 'amd64') =>
    tag(version, arch).split(':').at(-1)!;
  function ensureDeps(
    overrides: {
      tags?: string[];
      latest?: string | null;
      buildImpl?: (
        env: NodeJS.ProcessEnv,
        version: string,
        sha: string,
      ) => Promise<{ version: string; image: string }>;
      probeRuntime?: (target?: {
        version: string;
        image: string;
      }) => Promise<FreebuffRuntimeStatus>;
      environment?: () => Promise<NodeJS.ProcessEnv>;
      command?: (file: string, args: string[]) => Promise<string>;
    } = {},
  ) {
    const env = { HOME: '/synthetic/docker-home', DOCKER_CONTEXT: 'chosen-x64' };
    const environment = mock(overrides.environment ?? (async () => env));
    const command = mock(
      overrides.command ??
        (async (_file: string, args: string[]) =>
          args[0] === 'image' && args[1] === 'ls' ? (overrides.tags ?? []).join('\n') : 'ready'),
    );
    const build = mock(
      overrides.buildImpl ??
        (async (_env: NodeJS.ProcessEnv, version: string, _sha: string) => ({
          version,
          image: tag(version),
        })),
    );
    const resolveLatest = mock(async () =>
      'latest' in overrides ? overrides.latest : FREEBUFF_MIN_RUNTIME_VERSION,
    );
    const dependencies = {
      environment,
      command,
      build,
      resolveLatest,
      ...(overrides.probeRuntime ? { probeRuntime: overrides.probeRuntime } : {}),
    };
    return { env, environment, command, build, resolveLatest, dependencies };
  }

  test('app-owned setup resumes an existing stopped native Colima profile without changing global context', async () => {
    const keys = ['DOCKER_HOST', 'DOCKER_CONTEXT', 'KORY_FREEBUFF_DOCKER_CONTEXT'];
    const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    for (const key of keys) delete process.env[key];
    try {
      const env = { DOCKER_CONTEXT: 'colima' };
      let attempts = 0;
      const environment = mock(async () => {
        if (++attempts === 1) throw new Error('daemon stopped');
        return env;
      });
      const command = mock(async (_file: string, args: string[]) =>
        args[0] === 'list'
          ? JSON.stringify({
              name: 'default',
              arch: 'x86_64',
              runtime: 'docker',
              status: 'Stopped',
            })
          : args[0] === 'image' && args[1] === 'ls'
            ? tagName(FREEBUFF_MIN_RUNTIME_VERSION)
            : 'ready',
      );
      const build = mock(async () => ({ version: '', image: '' }));
      await ensureFreebuffRuntimeImage({
        environment,
        command,
        build,
        resolveLatest: mock(async () => FREEBUFF_MIN_RUNTIME_VERSION),
      });
      expect(
        command.mock.calls.some(
          ([file, args]) =>
            file === 'colima' && args.join(' ') === 'start default --activate=false',
        ),
      ).toBe(true);
      expect(process.env.DOCKER_CONTEXT).toBeUndefined();
      expect(build).not.toHaveBeenCalled();
    } finally {
      for (const key of keys) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }
  });

  test('uses the resolved target image when it is already installed and never builds', async () => {
    const { command, build, dependencies } = ensureDeps({
      tags: [tagName('0.2.36'), tagName('0.2.36', 'arm64'), 'other-repo:1.0.0'],
      latest: '0.2.36',
    });
    const selected = await ensureFreebuffRuntimeImage(dependencies);
    expect(selected).toEqual({ version: '0.2.36', image: tag('0.2.36') });
    expect(build).not.toHaveBeenCalled();
    expect(command.mock.calls.some(([, args]) => args[0] === 'build')).toBe(false);
  });

  test('serves the newest local image while coalescing one background build that then swaps', async () => {
    const probeRuntime = mock(async () => ({
      available: true,
      kind: 'docker' as const,
      version: '0.2.37',
      image: tag('0.2.37'),
    }));
    const { build, command, dependencies } = ensureDeps({
      tags: [tagName('0.2.36')],
      latest: '0.2.37',
      buildImpl: async (_env, version) => {
        await Bun.sleep(20);
        return { version, image: tag(version) };
      },
      probeRuntime,
    });
    const first = await ensureFreebuffRuntimeImage(dependencies);
    expect(first).toEqual({ version: '0.2.36', image: tag('0.2.36') });
    // Concurrent ensures share one coalesced flow and one background update.
    const [second, third] = await Promise.all([
      ensureFreebuffRuntimeImage(dependencies),
      ensureFreebuffRuntimeImage(dependencies),
    ]);
    expect(second.version).toBe('0.2.36');
    expect(third.version).toBe('0.2.36');
    await Bun.sleep(200);
    expect(build).toHaveBeenCalledTimes(1);
    expect(probeRuntime).toHaveBeenCalledTimes(1);
    expect(getFreebuffRuntimeStatus().version).toBe('0.2.37');
  });

  test('builds the resolved version when no local image exists, with the known hash for its arch', async () => {
    const { build, dependencies } = ensureDeps({ tags: [], latest: '0.2.36' });
    const selected = await ensureFreebuffRuntimeImage(dependencies);
    expect(selected).toEqual({ version: '0.2.36', image: tag('0.2.36') });
    expect(build).toHaveBeenCalledTimes(1);
    expect(build.mock.calls[0]![1]).toBe('0.2.36');
    expect(build.mock.calls[0]![2]).toBe(
      '7991a166aba6f374792ac8e9d9300280f6e5a2044935b268dfd96ff4b7d103e3',
    );
  });

  test('builds an unknown version trust-on-first-use with an empty hash arg', async () => {
    const { build, dependencies } = ensureDeps({ tags: [], latest: '0.3.0' });
    const selected = await ensureFreebuffRuntimeImage(dependencies);
    expect(selected.version).toBe('0.3.0');
    expect(build.mock.calls[0]![1]).toBe('0.3.0');
    expect(build.mock.calls[0]![2]).toBe('');
  });

  test('offline resolution uses the newest local image and never builds', async () => {
    const { build, dependencies } = ensureDeps({
      tags: [tagName('0.2.36'), tagName('0.2.37')],
      latest: null,
    });
    const selected = await ensureFreebuffRuntimeImage(dependencies);
    expect(selected).toEqual({ version: '0.2.37', image: tag('0.2.37') });
    expect(build).not.toHaveBeenCalled();
  });

  test('offline resolution with no local image fails with an actionable reason', async () => {
    const { dependencies } = ensureDeps({ tags: [], latest: null });
    await expect(ensureFreebuffRuntimeImage(dependencies)).rejects.toThrow(
      /could not be resolved|not installed/i,
    );
  });

  test('update GC removes only same-repo same-arch tags beyond current and previous', async () => {
    const removed: string[] = [];
    const probeRuntime = mock(async () => ({
      available: true,
      kind: 'docker' as const,
      version: '0.2.38',
      image: tag('0.2.38'),
    }));
    const { dependencies } = ensureDeps({
      latest: '0.2.38',
      buildImpl: async (_env, version) => ({ version, image: tag(version) }),
      probeRuntime,
      command: async (_file: string, args: string[]) => {
        if (args[0] === 'image' && args[1] === 'ls')
          return [
            tagName('0.2.37'),
            tagName('0.2.36'),
            tagName('0.2.35'),
            '0.2.60-bun1.3.14-rotherrecipe',
            tagName('0.2.59', 'arm64'),
            'unrelated',
          ].join('\n');
        if (args[0] === 'image' && args[1] === 'rm') {
          removed.push(args[2]!);
          return 'removed';
        }
        return 'ready';
      },
    });
    await ensureFreebuffRuntimeImage(dependencies);
    for (let attempt = 0; attempt < 100 && removed.length === 0; attempt += 1) await Bun.sleep(10);
    expect(getFreebuffRuntimeStatus().version).toBe('0.2.38');
    // Current 0.2.38 and previous 0.2.37 stay; 0.2.36 is removed. The below-MIN
    // 0.2.35 tag is foreign to the versioned scheme and is never touched.
    expect(removed).toEqual([tag('0.2.36')]);
    expect(removed.every((image) => image.startsWith('koryphaios/freebuff-runtime:'))).toBe(true);
  });

  async function asMac<T>(body: () => Promise<T> | T): Promise<T> {
    const original = process.platform;
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    try {
      return await body();
    } finally {
      Object.defineProperty(process, 'platform', { value: original, configurable: true });
    }
  }

  test('a newer local image never serves turns before its own probe succeeds', async () => {
    await asMac(async () => {
      // Seed a proven 0.2.36 runtime through the forced-update swap path.
      const seed = ensureDeps({
        tags: [],
        latest: '0.2.36',
        probeRuntime: mock(async () => ({
          available: true,
          kind: 'docker' as const,
          version: '0.2.36',
          image: tag('0.2.36'),
        })),
      });
      await forceFreebuffRuntimeUpdate(undefined, undefined, seed.dependencies);
      expect(getFreebuffRuntimeStatus().version).toBe('0.2.36');

      // A newer target already exists locally (built by another process). Hold
      // its probe pending so the unswapped window is observable.
      let releaseProbe: ((value: FreebuffRuntimeStatus) => void) | undefined;
      const probeRuntime = mock(
        async () =>
          new Promise<FreebuffRuntimeStatus>((resolve) => {
            releaseProbe = resolve;
          }),
      );
      const { build, dependencies } = ensureDeps({
        tags: [tagName('0.2.36'), tagName('0.2.37')],
        latest: '0.2.37',
        probeRuntime,
      });
      const candidate = await ensureFreebuffRuntimeImage(dependencies);
      // The candidate stays the proven image; the newer tag only swaps after
      // its own probe succeeds, and no build runs for an existing local tag.
      expect(candidate).toEqual({ version: '0.2.36', image: tag('0.2.36') });
      for (let attempt = 0; attempt < 100 && !releaseProbe; attempt += 1) await Bun.sleep(10);
      expect(probeRuntime).toHaveBeenCalledTimes(1);
      expect(getFreebuffRuntimeStatus().version).toBe('0.2.36');
      expect(build).not.toHaveBeenCalled();
      releaseProbe!({
        available: true,
        kind: 'docker',
        version: '0.2.37',
        image: tag('0.2.37'),
      });
      for (
        let attempt = 0;
        attempt < 100 && getFreebuffRuntimeStatus().version !== '0.2.37';
        attempt += 1
      )
        await Bun.sleep(10);
      expect(getFreebuffRuntimeStatus().version).toBe('0.2.37');
      expect(probeRuntime).toHaveBeenCalledTimes(1);
      expect(build).not.toHaveBeenCalled();
    });
  });

  test('update scheduling is throttled and skipped while a flow is in flight', async () => {
    await asMac(async () => {
      const { environment, dependencies } = ensureDeps({
        tags: [tagName('0.2.36')],
        latest: '0.2.36',
      });
      scheduleFreebuffRuntimeUpdate(dependencies);
      scheduleFreebuffRuntimeUpdate(dependencies);
      for (let attempt = 0; attempt < 100 && environment.mock.calls.length === 0; attempt += 1)
        await Bun.sleep(10);
      for (let attempt = 0; attempt < 100 && environment.mock.calls.length < 2; attempt += 1)
        await Bun.sleep(10);
      expect(environment).toHaveBeenCalledTimes(1);
      // Even after the coalesced flow finished, the ten-minute window holds.
      scheduleFreebuffRuntimeUpdate(dependencies);
      await Bun.sleep(30);
      expect(environment).toHaveBeenCalledTimes(1);
    });
  });

  test('concurrent forced updates share one build and one probe', async () => {
    await asMac(async () => {
      const probeRuntime = mock(async () => ({
        available: true,
        kind: 'docker' as const,
        version: '0.2.37',
        image: tag('0.2.37'),
      }));
      const { build, dependencies } = ensureDeps({
        tags: [],
        latest: '0.2.37',
        probeRuntime,
      });
      const [first, second] = await Promise.all([
        forceFreebuffRuntimeUpdate('0.2.36', undefined, dependencies),
        forceFreebuffRuntimeUpdate('0.2.36', undefined, dependencies),
      ]);
      expect(build).toHaveBeenCalledTimes(1);
      expect(probeRuntime).toHaveBeenCalledTimes(1);
      expect(first.version).toBe('0.2.37');
      expect(second.version).toBe('0.2.37');
    });
  });

  test('one caller cancelling does not fail the shared forced update for others', async () => {
    await asMac(async () => {
      const controller = new AbortController();
      let releaseBuild: (() => void) | undefined;
      const probeRuntime = mock(async () => ({
        available: true,
        kind: 'docker' as const,
        version: '0.2.37',
        image: tag('0.2.37'),
      }));
      const { build, dependencies } = ensureDeps({
        tags: [],
        latest: '0.2.37',
        probeRuntime,
      });
      const originalBuild = build.getMockImplementation();
      build.mockImplementation(async (env, version, hash) => {
        await new Promise<void>((resolve) => {
          releaseBuild = resolve;
        });
        return originalBuild(env, version, hash);
      });
      const callerA = forceFreebuffRuntimeUpdate('0.2.36', controller.signal, dependencies);
      const callerB = forceFreebuffRuntimeUpdate('0.2.36', undefined, dependencies);
      for (let attempt = 0; attempt < 100 && !releaseBuild; attempt += 1) await Bun.sleep(10);
      controller.abort();
      releaseBuild!();
      // Caller A's abort is never observed by the shared build: both promises
      // settle from the same completed update.
      await expect(callerA).resolves.toMatchObject({ version: '0.2.37' });
      await expect(callerB).resolves.toMatchObject({ version: '0.2.37' });
      expect(build).toHaveBeenCalledTimes(1);
      // A NEW caller whose signal is already aborted still refuses to join.
      const preAborted = new AbortController();
      preAborted.abort();
      await expect(
        forceFreebuffRuntimeUpdate('0.2.37', preAborted.signal, dependencies),
      ).rejects.toThrowError(expect.objectContaining({ name: 'AbortError' }));
    });
  });

  test('forced update returns immediately when status already advanced past the failed version', async () => {
    await asMac(async () => {
      const seed = ensureDeps({
        tags: [],
        latest: '0.2.38',
        probeRuntime: mock(async () => ({
          available: true,
          kind: 'docker' as const,
          version: '0.2.38',
          image: tag('0.2.38'),
        })),
      });
      await forceFreebuffRuntimeUpdate('0.2.36', undefined, seed.dependencies);
      expect(getFreebuffRuntimeStatus().version).toBe('0.2.38');
      const { build, resolveLatest, dependencies } = ensureDeps({
        tags: [],
        latest: '0.2.39',
      });
      const next = await forceFreebuffRuntimeUpdate('0.2.36', undefined, dependencies);
      expect(next.version).toBe('0.2.38');
      expect(resolveLatest).not.toHaveBeenCalled();
      expect(build).not.toHaveBeenCalled();
    });
  });

  test('forced update fails when latest is not newer than the rejected version', async () => {
    await asMac(async () => {
      const { dependencies } = ensureDeps({ tags: [], latest: '0.2.36' });
      await expect(forceFreebuffRuntimeUpdate('0.2.36', undefined, dependencies)).rejects.toThrow(
        /latest published release v0\.2\.36/,
      );
    });
  });

  test('forced update probes an already-local latest image without rebuilding', async () => {
    await asMac(async () => {
      const probeRuntime = mock(async () => ({
        available: true,
        kind: 'docker' as const,
        version: '0.2.37',
        image: tag('0.2.37'),
      }));
      const { build, dependencies } = ensureDeps({
        tags: [tagName('0.2.37')],
        latest: '0.2.37',
        probeRuntime,
      });
      const next = await forceFreebuffRuntimeUpdate('0.2.36', undefined, dependencies);
      expect(next.version).toBe('0.2.37');
      expect(build).not.toHaveBeenCalled();
      expect(probeRuntime).toHaveBeenCalledTimes(1);
    });
  });

  const CATALOG_PROBE_OUTPUT = `CODEBUFF_CLI_VERSION:"0.2.36";${[
    '"x-freebuff-catalog-protocol"',
    '"/api/v1/freebuff/models"',
    '"freebuff_catalog_stale"',
    'recommendedKey:',
    'fallbackKey:',
    'freebuffModelKey',
    'freebuffCatalogReasoningEfforts',
  ].join(';')}`;

  function probeCommand(handlers: {
    imageId?: () => string;
    catalog?: () => Promise<string>;
    isolation?: () => Promise<string>;
  }) {
    const counts = { catalog: 0, isolation: 0 };
    const command = mock(async (file: string, args: string[]) => {
      if (file !== 'docker') return '';
      if (args[0] === 'info') return 'aarch64';
      if (args[0] === 'image' && args[1] === 'inspect')
        return handlers.imageId?.() ?? 'sha256:image-a';
      if (args[0] === 'run' || args[0] === 'rm') return '';
      if (args[0] === 'exec') {
        const joined = args.join(' ');
        if (args.includes('-e') && joined.includes('/opt/kory/freebuff/freebuff')) {
          counts.catalog += 1;
          return handlers.catalog ? handlers.catalog() : CATALOG_PROBE_OUTPUT;
        }
        if (joined.includes('isolation-ok')) {
          counts.isolation += 1;
          return handlers.isolation ? handlers.isolation() : 'isolation-ok';
        }
        return '';
      }
      return '';
    });
    return { command: command as never, counts };
  }

  test('the catalog extraction is cached by image ID and re-extracts on a new artifact', async () => {
    await asMac(async () => {
      let imageId = 'sha256:image-a';
      const { command, counts } = probeCommand({ imageId: () => imageId });
      const target = { version: '0.2.36', image: 'koryphaios/freebuff-runtime:test' };
      expect((await probeFreebuffRuntime(target, { command })).available).toBe(true);
      expect(counts.catalog).toBe(1);
      // Same image ID: the heavyweight extraction is skipped while isolation
      // checks still run on every probe.
      expect((await probeFreebuffRuntime(target, { command })).available).toBe(true);
      expect(counts.catalog).toBe(1);
      expect(counts.isolation).toBe(2);
      imageId = 'sha256:image-b';
      await probeFreebuffRuntime(target, { command });
      expect(counts.catalog).toBe(2);
    });
  });

  test('a single exit 137 in the catalog extraction is retried once', async () => {
    await asMac(async () => {
      let attempts = 0;
      const { command, counts } = probeCommand({
        catalog: async () => {
          if (++attempts === 1) throw Object.assign(new Error('killed'), { code: 137 });
          return CATALOG_PROBE_OUTPUT;
        },
      });
      const status = await probeFreebuffRuntime(
        { version: '0.2.36', image: 'koryphaios/freebuff-runtime:test' },
        { command },
      );
      expect(status.available).toBe(true);
      expect(counts.catalog).toBe(2);
    });
  });

  test('an exit 137 in an isolation check is never retried', async () => {
    await asMac(async () => {
      const { command, counts } = probeCommand({
        isolation: async () => {
          throw Object.assign(new Error('killed'), { code: 137 });
        },
      });
      await expect(
        probeFreebuffRuntime(
          { version: '0.2.36', image: 'koryphaios/freebuff-runtime:test' },
          { command },
        ),
      ).rejects.toThrow();
      expect(counts.isolation).toBe(1);
    });
  });
  test('uses a native Docker architecture without changing the selected global context', async () => {
    const keys = ['DOCKER_HOST', 'DOCKER_CONTEXT', 'KORY_FREEBUFF_DOCKER_CONTEXT'];
    const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    for (const key of keys) delete process.env[key];
    try {
      const probe = mock(
        async (_file: string, _args: string[], _timeout?: number, env?: NodeJS.ProcessEnv) =>
          env?.DOCKER_CONTEXT === 'colima' ? 'x86_64\n' : 'aarch64\n',
      );
      const nativeArm = await freebuffDockerEnvironment(probe);
      expect(nativeArm.DOCKER_CONTEXT).toBeUndefined();
      expect(nativeArm.KORY_FREEBUFF_DOCKER_ARCH).toBe('arm64');
      expect(process.env.DOCKER_CONTEXT).toBeUndefined();
      expect(probe).toHaveBeenCalledTimes(1);
      const offlineDefault = mock(
        async (_file: string, _args: string[], _timeout?: number, env?: NodeJS.ProcessEnv) => {
          if (env?.DOCKER_CONTEXT === 'colima') return 'x86_64';
          throw new Error('default daemon offline');
        },
      );
      expect((await freebuffDockerEnvironment(offlineDefault)).DOCKER_CONTEXT).toBe('colima');
      process.env.KORY_FREEBUFF_DOCKER_CONTEXT = 'chosen-arm-context';
      const chosenArm = await freebuffDockerEnvironment(probe);
      expect(chosenArm.DOCKER_CONTEXT).toBe('chosen-arm-context');
      expect(chosenArm.KORY_FREEBUFF_DOCKER_ARCH).toBe('arm64');
      expect(probe).toHaveBeenCalledTimes(2);
      process.env.KORY_FREEBUFF_DOCKER_CONTEXT = 'chosen-x64-context';
      const nativeProbe = mock(async () => 'x86_64');
      expect((await freebuffDockerEnvironment(nativeProbe)).DOCKER_CONTEXT).toBe(
        'chosen-x64-context',
      );
      expect(nativeProbe).toHaveBeenCalledTimes(1);
    } finally {
      for (const key of keys) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }
  });
  test('only one writable host mount, no privileged daemon or environment forwarding', () => {
    const image = tag(FREEBUFF_MIN_RUNTIME_VERSION);
    const args = freebuffDockerRunArgs('/private/run', 'test', image);
    expect(args.filter((value) => value === '--mount')).toHaveLength(1);
    expect(args).toContain('type=bind,src=/private/run,dst=/private/run');
    expect(args).toContain('--read-only');
    expect(args).toContain('host.docker.internal:host-gateway');
    expect(args).toContain('--cap-drop=ALL');
    expect(args).toContain('no-new-privileges');
    expect(args.at(-1)).toBe(image);
    expect(args).not.toContain('--privileged');
    expect(args).not.toContain('seccomp=unconfined');
    expect(args.join(' ')).not.toContain('docker.sock');
    expect(args).not.toContain('--env');
    expect(args).not.toContain('-e');
    expect(args.filter((value) => value.startsWith('--cap-add='))).toEqual([
      '--cap-add=SYS_ADMIN',
      '--cap-add=SETUID',
      '--cap-add=SETGID',
      '--cap-add=DAC_OVERRIDE',
    ]);
    expect(freebuffDockerRunArgs('/private/run', 'test', image, false)).toContain('none');
  });
  test('keeps default-deny seccomp and permits pivot_root, not arbitrary syscalls', () => {
    expect(seccompProfile.defaultAction).toBe('SCMP_ACT_ERRNO');
    expect(seccompProfile.syscalls.at(-1)?.names).toEqual(['pivot_root']);
    expect(seccompProfile.syscalls.some((rule) => rule.names.includes('keyctl'))).toBe(false);
  });
  test('accepts only existing private canonical subdirectories', () => {
    const options = fixture();
    expect(() => validateFreebuffRuntimePaths(options)).not.toThrow();
    expect(() => validateFreebuffRuntimePaths({ ...options, runRoot: homedir() })).toThrow();
    expect(() =>
      validateFreebuffRuntimePaths({ ...options, workspace: dirnameOutside(options.runRoot) }),
    ).toThrow();
    expect(() =>
      validateFreebuffRuntimePaths({ ...options, workspace: options.runHome }),
    ).toThrow();
    rmSync(options.workspace, { recursive: true });
    symlinkSync(options.runHome, options.workspace);
    expect(() => validateFreebuffRuntimePaths(options)).toThrow(/symlinks/);
  });
  test('cached status is a defensive snapshot, not an optimistic Docker presence check', () => {
    const snapshot = getFreebuffRuntimeStatus();
    snapshot.available = !snapshot.available;
    expect(getFreebuffRuntimeStatus().available).not.toBe(snapshot.available);
  });

  test('native readiness probes a detected sibling Freebuff profile', () => {
    const previousHome = process.env.HOME;
    const previousPath = process.env.PATH;
    const previousConfigDir = process.env.FREEBUFF_CONFIG_DIR;
    const home = mkdtempSync(join(tmpdir(), 'freebuff-runtime-home-'));
    roots.push(home);
    const profile = join(home, '.config', 'manicode-work');
    mkdirSync(profile, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(profile, 'credentials.json'),
      JSON.stringify({ default: { authToken: 'fixture-token', fingerprintId: 'fixture' } }),
      { mode: 0o600 },
    );
    const binary = join(profile, 'freebuff');
    writeFileSync(binary, '#!/bin/sh\n', { mode: 0o700 });
    process.env.HOME = home;
    process.env.PATH = '/nonexistent-freebuff-test-path';
    delete process.env.FREEBUFF_CONFIG_DIR;
    try {
      expect(findNativeFreebuffProbeBinary()).toBe(binary);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousConfigDir === undefined) delete process.env.FREEBUFF_CONFIG_DIR;
      else process.env.FREEBUFF_CONFIG_DIR = previousConfigDir;
    }
  });
});
function dirnameOutside(root: string) {
  return join(root, '..', 'outside');
}

test('a failed status re-probes on the next refresh after the failure window', async () => {
  let now = 1_000_000;
  const available: FreebuffRuntimeStatus = {
    available: true,
    kind: 'native',
    version: FREEBUFF_MIN_RUNTIME_VERSION,
  };
  const probeRuntime = mock(async () => available);
  const failProbe = mock(async (): Promise<FreebuffRuntimeStatus> => {
    throw Object.assign(new Error('runtime command exit 137'), { code: 137 });
  });
  const first = await refreshFreebuffRuntimeStatus(true, undefined, {
    probeRuntime: failProbe,
    now: () => now,
  });
  expect(first.available).toBe(false);
  // Within 10s of a failure the cached failure is served (rate limit), not a new probe.
  now += 5_000;
  const second = await refreshFreebuffRuntimeStatus(false, undefined, {
    probeRuntime,
    now: () => now,
  });
  expect(second.available).toBe(false);
  expect(probeRuntime).toHaveBeenCalledTimes(0);
  // Past the window the next refresh re-probes and the turn can proceed.
  now += 6_000;
  const third = await refreshFreebuffRuntimeStatus(false, undefined, {
    probeRuntime,
    now: () => now,
  });
  expect(third).toEqual(available);
  expect(probeRuntime).toHaveBeenCalledTimes(1);
  // Success then caches for the full minute.
  now += 30_000;
  await refreshFreebuffRuntimeStatus(false, undefined, { probeRuntime, now: () => now });
  expect(probeRuntime).toHaveBeenCalledTimes(1);
});

// Explicit opt-in: credential-free kernel, real native binary and real private PTY tests.
// Never reads account credentials and never sends a prompt or logs into Freebuff.
test.skipIf(process.env.KORY_FREEBUFF_RUNTIME_SMOKE !== '1')(
  'real bwrap, private tmux, sanitized environment and credential-free TUI',
  async () => {
    const status = await refreshFreebuffRuntimeStatus(true);
    expect(status.available).toBe(true);
    expect(isValidFreebuffVersion(status.version)).toBe(true);
    expect(
      compareFreebuffVersions(status.version!, FREEBUFF_MIN_RUNTIME_VERSION),
    ).toBeGreaterThanOrEqual(0);
    const options = fixture(process.platform === 'darwin');
    const runtime = await createFreebuffTurnRuntime({
      ...options,
      env: { OPENAI_API_KEY: 'must-not-pass', KORY_RUNTIME_HOST_SENTINEL: 'must-not-pass' },
    });
    try {
      expect((await runtime.exec('/bin/sh', ['-ec', 'env'])).includes('must-not-pass')).toBe(false);
      const caps = await runtime.exec('/bin/sh', [
        '-ec',
        'grep -E "^(CapEff|CapPrm|CapInh|CapAmb|NoNewPrivs|Seccomp):" /proc/self/status',
      ]);
      expect(caps).toMatch(/CapEff:\s+0+\n/);
      expect(caps).toMatch(/CapPrm:\s+0+\n/);
      expect(caps).toMatch(/CapInh:\s+0+\n/);
      expect(caps).toMatch(/CapAmb:\s+0+\n/);
      expect(caps).toMatch(/NoNewPrivs:\s+1\n/);
      await runtime.exec('/bin/sh', [
        '-ec',
        'printf allowed > "$1"; ! (printf denied > /usr/denied) 2>/dev/null; ! (printf denied > "$2") 2>/dev/null',
        'probe',
        join(options.runRoot, 'allowed'),
        join(options.workspace, 'denied'),
      ]);
      expect(readFileSync(join(options.runRoot, 'allowed'), 'utf8')).toBe('allowed');
      // Reproduce Colima's stale readdir cache: a new host script appears after
      // a Linux listing. exec must invalidate only the private staging directory.
      await runtime.exec('/bin/ls', ['-a', options.runRoot]);
      const lateScript = join(options.runRoot, 'late-staged.js');
      writeFileSync(lateScript, 'console.log("late-stage-visible")', { mode: 0o600 });
      expect((await runtime.exec(runtime.bunBinary, [lateScript])).trim()).toBe(
        'late-stage-visible',
      );
      // TUI stops at credential-free login; network disabled and no prompt submitted.
      await runtime.start(['--cwd', options.workspace, '--trust-agents']);
      let pane = '';
      for (let attempt = 0; attempt < 40; attempt++) {
        await Bun.sleep(250);
        pane = await runtime.tmux(['capture-pane', '-p', '-J', '-t', runtime.session]);
        if (/log.?in|sign.?in|welcome|freebuff/i.test(pane)) break;
      }
      expect(pane).toMatch(/log.?in|sign.?in|welcome|freebuff/i);
      const socket = (await runtime.tmux(['display-message', '-p', '#{socket_path}'])).trim();
      expect(socket).toContain('kory-');
      expect(
        await runtime.exec('/bin/sh', [
          '-ec',
          'test ! -e "$1"; ! cat "$1" 2>/dev/null; ! (echo denied > "$1") 2>/dev/null; printf socket-hidden',
          'probe',
          socket,
        ]),
      ).toBe('socket-hidden');
      await runtime.cleanup();
      await runtime.cleanup();
      await expect(runtime.tmux(['has-session', '-t', runtime.session])).rejects.toThrow();
    } finally {
      await runtime.cleanup();
    }
  },
  120_000,
);

describe('Freebuff artifact reaper', () => {
  /** Build a temp runs/slots root pair plus a scripted docker command. */
  function reaperFixture(containers: { name: string; created: string; mounts?: string[] }[]) {
    const base = mkdtempSync(join(realpathSync(tmpdir()), 'reaper-'));
    roots.push(base);
    const runsRoot = join(base, 'freebuff-runs');
    const slotsRoot = join(base, 'freebuff-slots');
    mkdirSync(runsRoot, { recursive: true });
    mkdirSync(slotsRoot, { recursive: true });
    const dockerCalls: string[][] = [];
    const command = async (file: string, args: string[]) => {
      expect(file).toBe('docker');
      dockerCalls.push(args);
      if (args[0] === 'ps') return containers.map((container) => container.name).join('\n');
      if (args[0] === 'inspect') {
        const name = args.at(-1)!;
        const found = containers.find((container) => container.name === name);
        if (!found) throw new Error('no such container');
        return `${found.created} ${JSON.stringify(
          (found.mounts ?? []).map((Source) => ({ Source })),
        )}`;
      }
      if (args[0] === 'rm') return '';
      throw new Error(`unexpected docker call: ${args.join(' ')}`);
    };
    return { runsRoot, slotsRoot, command, dockerCalls };
  }
  let runDirSuffix = 0;
  const runDir = (root: string, ms: number) => {
    runDirSuffix += 1;
    const dir = join(root, `${ms}-deadbeef${runDirSuffix.toString(16).padStart(8, '0')}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'stale'), 'x');
    return dir;
  };
  const slotDir = (root: string, name: string, info: object) => {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'info.json'), JSON.stringify(info));
    return dir;
  };
  const age = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
  const exists = (path: string) => existsSync(path);

  test('removes only stale foreign kory-freebuff containers', async () => {
    const { runsRoot, slotsRoot, command, dockerCalls } = reaperFixture([
      { name: 'kory-freebuff-deadbeef', created: age(60) }, // stale zombie → rm
      { name: 'kory-freebuff-beeff00d', created: age(2) }, // young → keep
      { name: 'kory-freebuff-nothex!', created: age(60) }, // off-pattern → keep
      { name: 'other-container', created: age(60) }, // foreign → keep
    ]);
    await reapFreebuffRuntimeArtifacts({}, command, { runsRoot, slotsRoot });
    const removed = dockerCalls.filter((args) => args[0] === 'rm').map((args) => args.at(-1));
    expect(removed).toEqual(['kory-freebuff-deadbeef']);
  });

  test('removes old run roots but never a mounted or young one', async () => {
    const base = mkdtempSync(join(realpathSync(tmpdir()), 'reaper-runs-'));
    roots.push(base);
    const runsRoot = join(base, 'freebuff-runs');
    mkdirSync(runsRoot, { recursive: true });
    const oldMounted = runDir(runsRoot, Date.now() - 2 * 24 * 60 * 60_000);
    const oldFree = runDir(runsRoot, Date.now() - 2 * 24 * 60 * 60_000);
    const youngFree = runDir(runsRoot, Date.now() - 60_000);
    const offPattern = join(runsRoot, 'kory-freebuff-probe-abcdef');
    mkdirSync(offPattern);
    const { command } = reaperFixture([
      {
        name: 'kory-freebuff-facefeed',
        created: age(1),
        mounts: [oldMounted],
      },
    ]);
    const slotsRoot = join(base, 'freebuff-slots');
    mkdirSync(slotsRoot, { recursive: true });
    await reapFreebuffRuntimeArtifacts({}, command, {
      runsRoot,
      slotsRoot,
      now: () => Date.now(),
    });
    expect(exists(oldMounted)).toBe(true); // mounted: never touched
    expect(exists(oldFree)).toBe(false); // old, unmounted: reaped
    expect(exists(youngFree)).toBe(true); // fresh: kept
    expect(exists(offPattern)).toBe(true); // not <ms>-<hex>: kept
  });

  test('removes slot lease dirs whose holder pid is dead', async () => {
    const base = mkdtempSync(join(realpathSync(tmpdir()), 'reaper-slots-'));
    roots.push(base);
    const runsRoot = join(base, 'freebuff-runs');
    const slotsRoot = join(base, 'freebuff-slots');
    mkdirSync(runsRoot, { recursive: true });
    mkdirSync(slotsRoot, { recursive: true });
    const dead = slotDir(slotsRoot, 'deadbeef', {
      pid: 424242,
      sessionId: 's',
      role: 'manager',
      startedAt: 0,
    });
    const alive = slotDir(slotsRoot, 'alivebeef', {
      pid: 424243,
      sessionId: 's',
      role: 'manager',
      startedAt: 0,
    });
    const corrupt = slotDir(slotsRoot, 'corruptxx', {});
    const { command } = reaperFixture([]);
    await reapFreebuffRuntimeArtifacts({}, command, {
      runsRoot,
      slotsRoot,
      kill: (pid) => {
        if (pid === 424242) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
        if (pid === 424243) return; // alive
      },
    });
    expect(exists(dead)).toBe(false);
    expect(exists(alive)).toBe(true);
    expect(exists(corrupt)).toBe(true); // unreadable is the slot layer's job
  });

  test('swallows a failing docker ps and reaps nothing', async () => {
    const { runsRoot, slotsRoot } = reaperFixture([]);
    const command = async () => {
      throw new Error('docker daemon gone');
    };
    const dir = runDir(runsRoot, Date.now() - 2 * 24 * 60 * 60_000);
    await reapFreebuffRuntimeArtifacts({}, command, { runsRoot, slotsRoot });
    expect(exists(dir)).toBe(true); // still removed? no: mount unknown → kept
  });
});
