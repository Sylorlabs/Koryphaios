import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  FreebuffProvider,
  freebuffCompletionFromLogRow,
  freebuffPrivateCliArgs,
  freebuffStartupState,
  readFreebuffLogRows,
  waitForFreebuffPoll,
  waitForFreebuffStartup,
  type FreebuffProviderDependencies,
} from '../freebuff-cli';
import { FREEBUFF_CLI_DEFAULT_MODEL_ID } from '../freebuff-bundled-catalog';
import { FreebuffCliBridge } from '../cli-bridges';
import type { FreebuffTurnRuntime, FreebuffRuntimeOptions } from '../freebuff-runtime';
import type { PreparedFreebuffBridge } from '../freebuff-bridge-runtime';
import type { ProviderEvent, StreamRequest } from '../types';
import { PROJECT_ROOT } from '../../runtime/paths';

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});
const READY = 'Freebuff 0.2.12\nenter a coding task or / for commands';
const SECRET = 'synthetic-private-error-DO-NOT-ECHO';
const rootRow = (text = 'Root answer', model = 'opaque-cli-handle') => ({
  msg: 'End agent base3 step 1 (turn)',
  data: { agentId: 'main-agent', model, fullResponse: text, shouldEndTurn: true },
});
const finished = (outputType = 'lastMessage') => ({
  msg: 'Main prompt finished',
  data: { outputType },
});

type Failure =
  'credentials' | 'grant' | 'runtime' | 'bridge' | 'probe' | 'start' | 'capture' | 'cleanup';
function harness(
  options: {
    failure?: Failure;
    settings?: string;
    pane?: string;
    rows?: Record<string, unknown>[][];
    selectedModel?: string;
    signal?: AbortSignal;
    onProbe?: () => void;
    onStart?: (root: string) => void;
    onRuntime?: (options: FreebuffRuntimeOptions) => void;
    noReadyMarker?: boolean;
    readyOnSubmit?: boolean;
    runtimeAvailable?: boolean;
    catalogVersion?: string;
  } = {},
) {
  // Only synthetic credentials in a temporary fixture. Never discover actual CLI accounts.
  const profileDir = mkdtempSync(join(tmpdir(), 'freebuff-fixture-'));
  temporary.push(profileDir);
  writeFileSync(
    join(profileDir, 'credentials.json'),
    JSON.stringify({ default: { authToken: 'synthetic-fixture-token', fingerprintId: 'fixture' } }),
    { mode: 0o600 },
  );
  writeFileSync(join(profileDir, 'freebuff'), 'synthetic executable fixture');
  if (options.settings !== undefined)
    writeFileSync(join(profileDir, 'settings.json'), options.settings);
  const runRoot = join(PROJECT_ROOT, '.koryphaios', `freebuff-lifecycle-test-${randomUUID()}`);
  temporary.push(runRoot);
  const calls: string[] = [];
  const tmuxCalls: string[][] = [];
  let runtimeOptions: FreebuffRuntimeOptions | undefined;
  const readyPath = join(runRoot, 'bridge-ready.json');
  const selectedModel = options.selectedModel ?? FREEBUFF_CLI_DEFAULT_MODEL_ID;
  const servers = [
    {
      name: 'kory',
      command: '/private/bun',
      args: ['/private/bridge.js'],
      transport: 'stdio' as const,
    },
  ];
  const fail = (stage: Failure) => {
    if (options.failure === stage) throw new Error(`${SECRET} at ${stage}`);
  };
  const runtime: FreebuffTurnRuntime = {
    kind: 'docker',
    bunBinary: '/private/bun',
    freebuffBinary: '/private/freebuff',
    hostGateway: 'host.docker.internal',
    session: 'private-session',
    exec: mock(async (_command: string, _args: string[]) => {
      calls.push('probe');
      options.onProbe?.();
      fail('probe');
      return '{"ready":true,"toolCount":0}';
    }),
    start: mock(async (args: string[]) => {
      calls.push('start');
      expect(args).toEqual(['--cwd', join(runRoot, 'workspace'), '--trust-agents']);
      options.onStart?.(runRoot);
      fail('start');
      if (!options.noReadyMarker) writeFileSync(readyPath, '{"ready":true}');
    }),
    tmux: mock(async (args: string[]) => {
      tmuxCalls.push(args);
      if (options.readyOnSubmit && args[0] === 'send-keys' && args.at(-1) === 'Enter') {
        writeFileSync(readyPath, '{"ready":true}');
      }
      if (args[0] === 'capture-pane') {
        fail('capture');
        return options.pane ?? READY;
      }
      return '';
    }),
    cleanup: mock(async () => {
      calls.push('runtime-cleanup');
      fail('cleanup');
    }),
  };
  const prepared: PreparedFreebuffBridge = {
    servers,
    readyPath,
    probeArgs: ['/private/bridge.js', '--probe'],
    cleanup: mock(async () => {
      calls.push('bridge-cleanup');
    }),
  };
  const bridge = new FreebuffCliBridge();
  bridge.buildMcpConfig = () => servers;
  bridge.buildRules = () => [];
  const rows = [...(options.rows ?? [[rootRow(), finished()]])];
  const dependencies: Partial<FreebuffProviderDependencies> = {
    discoverAccounts: () => [
      {
        id: 'fixture',
        label: 'Fixture',
        profileDir,
        authToken: 'not-a-real-token',
        fingerprintId: 'fixture',
      },
    ],
    findBinary: () => join(profileDir, 'freebuff'),
    discoverCatalog: async () => ({
      cliVersion: options.catalogVersion ?? '0.2.12',
      models: [{ id: selectedModel, name: 'Fixture default', multimodal: false }],
    }),
    runtimeStatus: () => ({
      available: options.runtimeAvailable !== false,
      kind: 'docker',
      version: '0.2.12',
    }),
    refreshRuntimeStatus: async () => ({
      available: options.runtimeAvailable !== false,
      kind: 'docker',
      version: '0.2.12',
    }),
    createRunRoot: () => {
      if (options.failure === 'credentials') rmSync(join(profileDir, 'credentials.json'));
      return runRoot;
    },
    createLease: () => {
      calls.push('grant');
      fail('grant');
      return {
        sessionId: 'fixture-session',
        role: 'manager',
        grant: () => {
          throw new Error('unused');
        },
        bindToChild: () => {},
        cleanup: () => {
          calls.push('grant-cleanup');
        },
      };
    },
    getBridge: () => bridge,
    createRuntime: async (input) => {
      calls.push('runtime');
      runtimeOptions = input;
      options.onRuntime?.(input);
      fail('runtime');
      return runtime;
    },
    prepareBridge: async (input) => {
      calls.push('bridge');
      expect(input.runtimeKind).toBe('docker');
      expect(input.hostGateway).toBe('host.docker.internal');
      expect(input.signal).toBeDefined();
      fail('bridge');
      return prepared;
    },
    readLogRows: mock(async () => {
      calls.push('logs');
      return rows.shift() ?? [];
    }),
  };
  const provider = new FreebuffProvider({ name: 'freebuff' }, dependencies);
  const request: StreamRequest = {
    model: selectedModel,
    messages: [{ role: 'user', content: 'Hello fixture' }],
    systemPrompt: 'Use Kory tools.',
    sessionId: 'fixture-session',
    signal: options.signal,
  };
  const collect = async (overrides: Partial<StreamRequest> = {}) => {
    const events: ProviderEvent[] = [];
    for await (const event of provider.streamResponse({ ...request, ...overrides }))
      events.push(event);
    return events;
  };
  return {
    provider,
    collect,
    calls,
    tmuxCalls,
    runtime,
    prepared,
    runRoot,
    runtimeOptions: () => runtimeOptions,
  };
}

describe('Freebuff native TUI evidence', () => {
  it('requires the actual composer placeholder, not a banner or long arbitrary pane', () => {
    expect(freebuffStartupState(READY)).toBe('ready');
    expect(freebuffStartupState('Freebuff\n' + 'continue '.repeat(100))).toBe('waiting');
    expect(freebuffStartupState('Load and run these? [y/N]')).toBe('trust');
    expect(freebuffStartupState('Please log in')).toBe('login');
  });

  it('does not approve a trust prompt or include pane contents in failures', async () => {
    const tmux = mock(async () => `Load and run these? [y/N]\n${SECRET}`);
    await expect(waitForFreebuffStartup(tmux, 'private')).rejects.toThrow(
      'private workspace trust flag',
    );
    expect(tmux.mock.calls).toHaveLength(1);
    expect(tmux.mock.calls[0]).toEqual([['capture-pane', '-p', '-J', '-t', 'private']]);
  });

  it('dismisses only an exact welcome gate before waiting for real readiness', async () => {
    const calls: string[][] = [];
    let captures = 0;
    await waitForFreebuffStartup(async (args) => {
      calls.push(args);
      if (args[0] !== 'capture-pane') return '';
      return ++captures === 1 ? 'Press Enter to continue' : READY;
    }, 'private');
    expect(calls.filter((args) => args[0] === 'send-keys')).toEqual([
      ['send-keys', '-t', 'private', 'Enter'],
    ]);
  });

  it('restricts --trust-agents to the private generated workspace', () => {
    expect(freebuffPrivateCliArgs('/private/turn', '/private/turn/workspace')).toContain(
      '--trust-agents',
    );
    expect(() => freebuffPrivateCliArgs('/private/turn', '/real/repository')).toThrow(
      'non-private',
    );
    expect(() =>
      freebuffPrivateCliArgs('/private/turn', '/private/turn/workspace/../other'),
    ).toThrow('non-private');
  });

  it('only completes on successful main prompt output, never nested shouldEndTurn', () => {
    expect(
      freebuffCompletionFromLogRow({ msg: 'End agent child', data: { shouldEndTurn: true } }),
    ).toBe('pending');
    expect(freebuffCompletionFromLogRow(finished())).toBe('success');
    expect(freebuffCompletionFromLogRow(finished('error'))).toBe('error');
    expect(freebuffCompletionFromLogRow(finished('unknown'))).toBe('error');
    expect(freebuffCompletionFromLogRow({ msg: 'Main prompt finished', data: {} })).toBe('error');
  });

  it('removes poll abort listeners on resolution and propagates cancellation', async () => {
    const controller = new AbortController();
    const add = spyOn(controller.signal, 'addEventListener');
    const remove = spyOn(controller.signal, 'removeEventListener');
    for (let i = 0; i < 15; i++) await waitForFreebuffPoll(0, controller.signal);
    expect(add).toHaveBeenCalledTimes(15);
    expect(remove).toHaveBeenCalledTimes(15);
    const waiting = waitForFreebuffPoll(60_000, controller.signal);
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    expect(remove).toHaveBeenCalledTimes(16);
    add.mockRestore();
    remove.mockRestore();
  });
});

describe('Freebuff mocked lifecycle (no login or inference)', () => {
  it('honors image confirmation but still verifies native TUI attachment evidence', async () => {
    const fixture = harness({
      pane: `${READY}\nki1.png`,
      rows: [
        [
          {
            msg: '[send-message] Sending message with sdk run config',
            data: { runConfig: { contentBlockCount: 1 } },
          },
          rootRow(),
          finished(),
        ],
      ],
      onStart: (root) => {
        expect(readFileSync(join(root, 'workspace', 'ki1.png')).toString('base64')).toBe(
          'cGl4ZWxz',
        );
      },
    });
    const events = await fixture.collect({
      imageInputOverride: { provider: 'freebuff', model: FREEBUFF_CLI_DEFAULT_MODEL_ID },
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Inspect' },
            { type: 'image', imageData: 'cGl4ZWxz', imageMimeType: 'image/png' },
          ],
        },
      ],
    });
    expect(events.some((event) => event.type === 'complete')).toBe(true);
    expect(events.some((event) => event.type === 'error')).toBe(false);
    expect(fixture.tmuxCalls.filter((args) => args[0] === 'paste-buffer')).toHaveLength(2);
    expect(existsSync(fixture.runRoot)).toBe(false);
  });

  it('does not let a capability correction bypass missing native image evidence', async () => {
    const fixture = harness({ pane: `${READY}\nki1.png` });
    const events = await fixture.collect({
      imageInputOverride: { provider: 'freebuff', model: FREEBUFF_CLI_DEFAULT_MODEL_ID },
      messages: [
        {
          role: 'user',
          content: [{ type: 'image', imageData: 'cGl4ZWxz', imageMimeType: 'image/png' }],
        },
      ],
    });
    expect(
      events.some(
        (event) => event.type === 'error' && event.error?.includes('native image content'),
      ),
    ).toBe(true);
    expect(events.some((event) => event.type === 'complete')).toBe(false);
  });

  it('rejects image confirmation for a different provider or model', async () => {
    for (const imageInputOverride of [
      { provider: 'codebuff', model: FREEBUFF_CLI_DEFAULT_MODEL_ID },
      { provider: 'freebuff', model: 'another-model' },
    ]) {
      const fixture = harness();
      const events = await fixture.collect({
        imageInputOverride,
        messages: [
          {
            role: 'user',
            content: [{ type: 'image', imageData: 'cGl4ZWxz', imageMimeType: 'image/png' }],
          },
        ],
      });
      expect(events[0]?.error).toContain('cannot verify image support');
      expect(fixture.calls).not.toContain('runtime');
    }
  });

  it('refuses a host CLI upgrade that differs from the qualified runtime', async () => {
    const fixture = harness({ catalogVersion: '0.2.13' });
    const events = await fixture.collect();
    expect(events.some((event) => event.type === 'complete')).toBe(false);
    expect(events.find((event) => event.type === 'error')?.error).toContain(
      'differs from the qualified execution runtime',
    );
    expect(fixture.calls).not.toContain('start');
    expect(existsSync(fixture.runRoot)).toBe(false);
  });
  it('refuses to launch without proven runtime readiness even when a CLI account exists', async () => {
    const fixture = harness({ runtimeAvailable: false });
    expect(fixture.provider.isAvailable()).toBe(false);
    const events = await fixture.collect();
    expect(events[0]).toMatchObject({ type: 'error' });
    expect(fixture.calls).toEqual([]);
    expect(existsSync(fixture.runRoot)).toBe(false);
  });

  it('cleans a runtime acquired after cancellation instead of staging the bridge', async () => {
    const controller = new AbortController();
    const fixture = harness({ signal: controller.signal, onRuntime: () => controller.abort() });
    const events = await fixture.collect();
    expect(events[0]).toMatchObject({ type: 'error', error: 'Freebuff PTY turn cancelled.' });
    expect(fixture.calls).not.toContain('bridge');
    expect(fixture.calls.filter((call) => call === 'runtime-cleanup')).toHaveLength(1);
    expect(fixture.calls).toContain('grant-cleanup');
    expect(existsSync(fixture.runRoot)).toBe(false);
  });

  it('probes before launch, uses private tmux only, preserves model settings and cleans everything', async () => {
    const source = {
      freebuffModelKey: 'exact-cli-key',
      freebuffModelDefaultMigration: 'migration-2',
      alwaysUseALaCarte: false,
      untrustedSecret: SECRET,
    };
    const fixture = harness({
      settings: JSON.stringify(source),
      onStart: (root) => {
        const home = join(root, 'home', '.config', 'manicode');
        expect(JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8'))).toEqual({
          freebuffModelKey: 'exact-cli-key',
          freebuffModelDefaultMigration: 'migration-2',
          alwaysUseALaCarte: false,
        });
        // Check copied credentials only by existence/permissions; never read their contents.
        expect(existsSync(join(home, 'credentials.json'))).toBe(true);
        expect(statSync(join(home, 'credentials.json')).mode & 0o777).toBe(0o600);
        const prompt = readFileSync(join(root, 'prompt.txt'), 'utf8');
        expect(prompt).toContain('tools/list catalog defines available tools');
        expect(prompt).not.toContain('Authoritative Kory MCP catalog for this role:');
      },
    });
    const events = await fixture.collect();
    expect(events).toEqual([
      { type: 'content_delta', content: 'Root answer' },
      { type: 'complete', finishReason: 'end_turn' },
    ]);
    expect(fixture.calls.indexOf('probe')).toBeLessThan(fixture.calls.indexOf('start'));
    expect(fixture.calls.slice(-3)).toEqual(['runtime-cleanup', 'bridge-cleanup', 'grant-cleanup']);
    expect(fixture.tmuxCalls.some((args) => args[0] === 'new-session')).toBe(false);
    expect(
      fixture.tmuxCalls
        .filter((args) => args.includes('-t'))
        .every((args) => args[args.indexOf('-t') + 1] === 'private-session'),
    ).toBe(true);
    expect(existsSync(fixture.runRoot)).toBe(false);
  });

  for (const failure of [
    'credentials',
    'grant',
    'runtime',
    'bridge',
    'probe',
    'start',
    'capture',
  ] as const) {
    it(`cleans acquired resources when ${failure} setup fails, without exposing child diagnostics`, async () => {
      const fixture = harness({ failure });
      const events = await fixture.collect();
      expect(events.some((event) => event.type === 'error')).toBe(true);
      expect(events.some((event) => event.type === 'complete')).toBe(false);
      expect(JSON.stringify(events)).not.toContain(SECRET);
      expect(existsSync(fixture.runRoot)).toBe(false);
      if (!['credentials', 'grant'].includes(failure))
        expect(fixture.calls).toContain('grant-cleanup');
      if (['bridge', 'probe', 'start', 'capture'].includes(failure))
        expect(fixture.calls).toContain('runtime-cleanup');
      if (['probe', 'start', 'capture'].includes(failure))
        expect(fixture.calls).toContain('bridge-cleanup');
      if (failure === 'probe') expect(fixture.calls).not.toContain('start');
    });
  }

  it('cleans copied credentials when private settings JSON is malformed', async () => {
    const fixture = harness({ settings: `{broken-${SECRET}` });
    expect((await fixture.collect())[0]).toMatchObject({
      type: 'error',
      error:
        'Freebuff PTY failed during CLI model settings. No private diagnostic output was retained.',
    });
    expect(fixture.calls).not.toContain('grant');
    expect(existsSync(fixture.runRoot)).toBe(false);
  });

  it('continues grant/bridge/file cleanup even if runtime cleanup rejects', async () => {
    const fixture = harness({ failure: 'cleanup' });
    await fixture.collect();
    expect(fixture.calls.slice(-3)).toEqual(['runtime-cleanup', 'bridge-cleanup', 'grant-cleanup']);
    expect(existsSync(fixture.runRoot)).toBe(false);
  });

  it('rejects a trust prompt without submitting or echoing it', async () => {
    const fixture = harness({ pane: `Load and run these? [y/N]\n${SECRET}` });
    const events = await fixture.collect();
    expect(events[0]).toMatchObject({ type: 'error' });
    expect(JSON.stringify(events)).not.toContain(SECRET);
    expect(
      fixture.tmuxCalls.some((args) =>
        ['send-keys', 'load-buffer', 'paste-buffer'].includes(args[0]!),
      ),
    ).toBe(false);
  });

  it('requires the actual MCP ready marker, not only a successful probe', async () => {
    const controller = new AbortController();
    const fixture = harness({
      signal: controller.signal,
      noReadyMarker: true,
      onStart: () => {
        setTimeout(() => controller.abort(), 20);
      },
    });
    const events = await fixture.collect();
    expect(events[0]).toMatchObject({ type: 'error', error: 'Freebuff PTY turn cancelled.' });
    expect(
      events.some((event) => event.type === 'content_delta' || event.type === 'complete'),
    ).toBe(false);
    expect(existsSync(fixture.runRoot)).toBe(false);
  });

  it('supports lazy MCP startup after the first prompt while retaining signed preflight', async () => {
    const fixture = harness({ noReadyMarker: true, readyOnSubmit: true });
    const events = await fixture.collect();
    expect(events.at(-1)).toMatchObject({ type: 'complete' });
    expect(fixture.calls.indexOf('probe')).toBeLessThan(fixture.calls.indexOf('start'));
    expect(fixture.tmuxCalls.some((args) => args[0] === 'paste-buffer')).toBe(true);
  });

  it('ignores nested completion/content and waits for the main-agent response', async () => {
    const fixture = harness({
      rows: [
        [
          {
            msg: 'End agent child step 1',
            data: {
              agentId: 'child',
              model: 'opaque-cli-handle',
              fullResponse: 'Nested only',
              shouldEndTurn: true,
            },
          },
        ],
        [rootRow(), finished()],
      ],
    });
    const events = await fixture.collect();
    expect(events).toEqual([
      { type: 'content_delta', content: 'Root answer' },
      { type: 'complete', finishReason: 'end_turn' },
    ]);
    expect(fixture.calls.filter((call) => call === 'logs')).toHaveLength(2);
  });

  for (const output of ['error', 'unknown']) {
    it(`does not convert root outputType ${output} into successful completion`, async () => {
      const fixture = harness({ rows: [[rootRow(), finished(output)]] });
      const events = await fixture.collect();
      expect(events.some((event) => event.type === 'error')).toBe(true);
      expect(events.some((event) => event.type === 'complete')).toBe(false);
    });
  }

  it('requires nonempty root content and model evidence', async () => {
    for (const rows of [[rootRow('  '), finished()], [finished()]]) {
      const fixture = harness({ rows: [rows] });
      const events = await fixture.collect();
      expect(events.some((event) => event.type === 'error')).toBe(true);
      expect(events.some((event) => event.type === 'complete')).toBe(false);
    }
  });

  it('rejects silently substituted explicit models before emitting their content', async () => {
    const fixture = harness({
      selectedModel: 'example/requested',
      rows: [[rootRow('wrong response', 'example/other'), finished()]],
    });
    const events = await fixture.collect();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'error',
      error: 'Freebuff CLI did not use the requested model; refresh models and reconnect',
    });
  });

  it('attributes usage to the verified CLI-managed model and excludes other models', async () => {
    const fixture = harness({
      rows: [
        [
          {
            msg: 'Start agent base3 step 1',
            data: { model: 'opaque-cli-handle', contextTokenCount: 1234 },
          },
          { msg: 'Start agent child step 1', data: { model: 'other', contextTokenCount: 9999 } },
          rootRow(),
          finished(),
        ],
      ],
    });
    const usage = (await fixture.collect()).find((event) => event.type === 'usage_update');
    expect(usage).toMatchObject({
      tokensIn: 1234,
      billingTokensIn: 1234,
      usagePrecision: 'input-context-only',
    });
  });

  it('does not inherit backend secrets or proxy/bridge configuration into the runtime', async () => {
    const key = 'KORY_BRIDGE_AUTH_FILE';
    const previous = process.env[key];
    process.env[key] = SECRET;
    try {
      const fixture = harness();
      await fixture.collect();
      const env = fixture.runtimeOptions()!.env!;
      expect(env[key]).toBeUndefined();
      expect(env.HTTP_PROXY).toBeUndefined();
      expect(JSON.stringify(env)).not.toContain(SECRET);
      expect(env.HOME).toBe(join(fixture.runRoot, 'home'));
    } finally {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  });

  it('propagates cancellation during setup and tears runtime down exactly once', async () => {
    const controller = new AbortController();
    const fixture = harness({ signal: controller.signal, onProbe: () => controller.abort() });
    const events = await fixture.collect();
    expect(events[0]).toMatchObject({ type: 'error', error: 'Freebuff PTY turn cancelled.' });
    expect(fixture.calls).not.toContain('start');
    expect(fixture.calls.filter((call) => call === 'runtime-cleanup')).toHaveLength(1);
    expect(fixture.calls).toContain('bridge-cleanup');
    expect(fixture.calls).toContain('grant-cleanup');
    expect(existsSync(fixture.runRoot)).toBe(false);
  });
});

describe('Freebuff isolated log reader', () => {
  it('uses runtime.exec, byte offsets and complete JSONL rows without following symlink files', async () => {
    const root = mkdtempSync(join(tmpdir(), 'freebuff-log-fixture-'));
    temporary.push(root);
    const logs = join(root, 'logs');
    mkdirSync(logs);
    const log = join(logs, 'log.jsonl');
    const first = { msg: 'unicode 🦬', data: { fullResponse: 'é' } };
    writeFileSync(log, JSON.stringify(first) + '\n' + '{"msg":"partial');
    const linked = join(root, 'linked');
    mkdirSync(linked);
    symlinkSync(log, join(linked, 'log.jsonl'));
    const exec = mock(async (command: string, args: string[]) => {
      // Unit-test the pure reader only against our fixture; production always routes this through bwrap.
      const child = Bun.spawn([command, ...args], { env: {}, stdout: 'pipe', stderr: 'pipe' });
      const text = await new Response(child.stdout).text();
      expect(await child.exited).toBe(0);
      return text;
    });
    const runtime = { bunBinary: process.execPath, exec };
    const offsets = new Map<string, number>();
    expect(await readFreebuffLogRows(runtime, root, offsets)).toEqual([first]);
    expect(offsets.get(log)).toBe(Buffer.byteLength(JSON.stringify(first) + '\n'));
    expect(await readFreebuffLogRows(runtime, root, offsets)).toEqual([]);
    appendFileSync(log, '"}\n');
    expect(await readFreebuffLogRows(runtime, root, offsets)).toEqual([{ msg: 'partial' }]);
    expect(exec.mock.calls[0]![1][0]).toBe('-e');
    expect(offsets.size).toBe(1);
    writeFileSync(log, '{"msg":"rotated"}\n');
    expect(await readFreebuffLogRows(runtime, root, offsets)).toEqual([{ msg: 'rotated' }]);
  });

  it('does not follow a symlinked log root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'freebuff-symlink-fixture-'));
    temporary.push(root);
    const target = join(root, 'target');
    mkdirSync(target);
    writeFileSync(join(target, 'log.jsonl'), JSON.stringify(rootRow()) + '\n');
    const link = join(root, 'link');
    symlinkSync(target, link);
    const runtime = {
      bunBinary: process.execPath,
      exec: async (command: string, args: string[]) => {
        const child = Bun.spawn([command, ...args], { env: {}, stdout: 'pipe' });
        const text = await new Response(child.stdout).text();
        expect(await child.exited).toBe(0);
        return text;
      },
    };
    expect(await readFreebuffLogRows(runtime, link, new Map())).toEqual([]);
  });
});
