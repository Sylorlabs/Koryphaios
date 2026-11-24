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
  freebuffResponseFromLogRow,
  freebuffPrivateCliArgs,
  freebuffStartupState,
  freebuffAccountLimitError,
  freebuffNeedsSessionConfirmation,
  freebuffPromptReady,
  waitForFreebuffPromptReady,
  readFreebuffLogRows,
  waitForFreebuffPoll,
  waitForFreebuffStartup,
  type FreebuffProviderDependencies,
} from '../freebuff-cli';
import { FREEBUFF_CLI_DEFAULT_MODEL_ID } from '../freebuff-bundled-catalog';
import type { FreebuffAccountCatalog } from '../freebuff-model-catalog';
import { FreebuffCliBridge } from '../cli-bridges';
import type { FreebuffTurnRuntime, FreebuffRuntimeOptions } from '../freebuff-runtime';
import type { PreparedFreebuffBridge } from '../freebuff-bridge-runtime';
import {
  acquireFreebuffSessionSlot,
  FreebuffSessionSlotError,
  peekFreebuffSessionSlot,
  resetFreebuffSessionSlotsForTests,
  type FreebuffSessionSlotRequest,
} from '../freebuff-session-slots';
import type { ProviderEvent, StreamRequest } from '../types';
import { PROJECT_ROOT } from '../../runtime/paths';

const temporary: string[] = [];
afterEach(() => {
  resetFreebuffSessionSlotsForTests();
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
    /** Optional capture-pane sequence; falls back to `pane` when exhausted. */
    panes?: string[];
    /** Holds the account slot before the stream, then releases after `ms`. */
    slotPrehold?: {
      sessionId: string;
      role?: 'manager' | 'worker' | 'critic';
      releaseAfterMs?: number;
    };
    acquireSessionSlot?: (
      accountId: string,
      request: FreebuffSessionSlotRequest,
    ) => Promise<() => void>;
    peekSessionSlot?: (accountId: string) => { sessionId: string; role: string } | null;
    rows?: Record<string, unknown>[][];
    selectedModel?: string;
    signal?: AbortSignal;
    onProbe?: () => void;
    onStart?: (root: string) => void;
    onRuntime?: (options: FreebuffRuntimeOptions) => void;
    noReadyMarker?: boolean;
    readyOnSubmit?: boolean;
    readyOnEnterCount?: number;
    dieOnStart?: boolean;
    sessionLostGraceMs?: number;
    runtimeAvailable?: boolean;
    catalogVersion?: string;
    refreshedVersion?: string;
    forceUpdate?: () => Promise<{ available: boolean; kind: 'docker'; version: string }>;
    accountCatalog?: FreebuffAccountCatalog;
    accountCatalogFailure?: boolean;
    readLogRows?: () => Promise<Record<string, unknown>[]>;
    dieAfterReads?: number;
    probeFailOnce137?: boolean;
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
  let runtimeVersion = '0.2.12';
  let forcedRefreshes = 0;
  let rowReads = 0;
  let loadedPrompt = '';
  let pastedPrompt = '';
  let enterSubmits = 0;
  let tuiExited = false;
  let probeFailedOnce = false;
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
      if (options.probeFailOnce137 && !probeFailedOnce) {
        probeFailedOnce = true;
        throw Object.assign(new Error('killed'), { code: 137 });
      }
      fail('probe');
      return '{"ready":true,"toolCount":0}';
    }),
    start: mock(async (args: string[]) => {
      calls.push('start');
      tuiExited = false;
      expect(args).toEqual(['--cwd', join(runRoot, 'workspace'), '--trust-agents']);
      options.onStart?.(runRoot);
      fail('start');
      if (!options.noReadyMarker) writeFileSync(readyPath, '{"ready":true}');
      if (options.dieOnStart) tuiExited = true;
    }),
    tmux: mock(async (args: string[]) => {
      tmuxCalls.push(args);
      if (args[0] === 'load-buffer' && args.at(-1) === join(runRoot, 'prompt.txt')) {
        loadedPrompt = readFileSync(args.at(-1)!, 'utf8');
      }
      if (args[0] === 'paste-buffer' && loadedPrompt) pastedPrompt = loadedPrompt;
      if (args[0] === 'send-keys' && args.at(-1) === 'Enter') enterSubmits += 1;
      if (
        ((options.readyOnSubmit && enterSubmits === 1) ||
          enterSubmits === options.readyOnEnterCount) &&
        args[0] === 'send-keys' &&
        args.at(-1) === 'Enter'
      ) {
        writeFileSync(readyPath, '{"ready":true}');
      }
      if (args[0] === 'send-keys' && args.at(-1) === 'C-c') {
        tuiExited = true;
        calls.push('tui-quit');
      }
      if (args[0] === 'has-session' && tuiExited) throw new Error('session ended');
      if (args[0] === 'capture-pane') {
        fail('capture');
        const pane = options.panes?.length ? options.panes.shift()! : options.pane;
        return `${pane ?? READY}\n${pastedPrompt ? (pastedPrompt.length > 2000 ? `Pasted text (${pastedPrompt.length.toLocaleString()} chars)` : pastedPrompt) : ''}`;
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
  // The real slot lease against a private temp dir: in-process holder/FIFO
  // and the mkdir file lease both behave exactly as in production.
  const slotsDir = mkdtempSync(join(tmpdir(), 'freebuff-test-slots-'));
  temporary.push(slotsDir);
  const slotEvents: string[] = [];
  const acquireSlot = async (accountId: string, request: FreebuffSessionSlotRequest) => {
    const release = await (
      options.acquireSessionSlot ??
      ((id: string, req: FreebuffSessionSlotRequest) =>
        acquireFreebuffSessionSlot(id, req, { slotsDir }))
    )(accountId, request);
    slotEvents.push(`acquired:${accountId}`);
    calls.push('slot-acquired');
    return () => {
      slotEvents.push(`released:${accountId}`);
      calls.push('slot-released');
      release();
    };
  };
  const peekSlot =
    options.peekSessionSlot ??
    ((accountId: string) => peekFreebuffSessionSlot(accountId, { slotsDir }));
  if (options.slotPrehold) {
    const { sessionId, role = 'manager', releaseAfterMs = 600 } = options.slotPrehold;
    // A foreign-style lease whose pid is alive (this process): the slot layer
    // sees a legitimate holder until the scheduled removal frees it.
    const leaseDir = join(slotsDir, Buffer.from('fixture').toString('base64url'));
    mkdirSync(leaseDir, { recursive: true });
    writeFileSync(
      join(leaseDir, 'info.json'),
      JSON.stringify({ pid: process.pid, sessionId, role, startedAt: Date.now() }),
      { mode: 0o600 },
    );
    setTimeout(() => rmSync(leaseDir, { recursive: true, force: true }), releaseAfterMs).unref();
  }
  const dependencies: Partial<FreebuffProviderDependencies> = {
    acquireSessionSlot: acquireSlot,
    peekSessionSlot: peekSlot,
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
      ...(options.accountCatalog || options.accountCatalogFailure
        ? { selectionMode: 'cli-managed' as const }
        : {}),
      models: [
        {
          id:
            options.accountCatalog || options.accountCatalogFailure
              ? FREEBUFF_CLI_DEFAULT_MODEL_ID
              : selectedModel,
          name: 'Fixture default',
          multimodal: false,
        },
      ],
    }),
    discoverAccountCatalog: async () => {
      if (options.accountCatalogFailure) throw new Error(SECRET);
      return options.accountCatalog ?? { models: [], refreshAt: Date.now() + 60_000 };
    },
    runtimeStatus: () => ({
      available: options.runtimeAvailable !== false,
      kind: 'docker',
      version: runtimeVersion,
    }),
    refreshRuntimeStatus: async (force?: boolean) => {
      if (force === true) {
        forcedRefreshes += 1;
        if (options.refreshedVersion) runtimeVersion = options.refreshedVersion;
      }
      return {
        available: options.runtimeAvailable !== false,
        kind: 'docker' as const,
        version: runtimeVersion,
      };
    },
    scheduleRuntimeUpdate: () => {},
    sessionLostGraceMs: options.sessionLostGraceMs ?? 30_000,
    forceRuntimeUpdate:
      options.forceUpdate ??
      (async () => {
        throw new Error('synthetic update failure');
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
    readLogRows: options.readLogRows
      ? mock(async () => {
          calls.push('logs');
          return options.readLogRows!();
        })
      : mock(async () => {
          calls.push('logs');
          const chunk = rows.shift() ?? [];
          if (++rowReads >= (options.dieAfterReads ?? Number.POSITIVE_INFINITY)) tuiExited = true;
          return chunk;
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
    slotsDir,
    slotEvents,
    runtimeOptions: () => runtimeOptions,
    forcedRefreshes: () => forcedRefreshes,
  };
}

describe('Freebuff native TUI evidence', () => {
  it('waits for the actual paste receipt before submitting an asynchronous composer', async () => {
    const prompt = 'synthetic text '.repeat(200);
    expect(freebuffPromptReady(READY, prompt)).toBe(false);
    expect(
      freebuffPromptReady(`Pasted text (${prompt.length.toLocaleString()} chars)`, prompt),
    ).toBe(true);
    expect(freebuffPromptReady(`📄 ${prompt.length.toLocaleString()} chars`, prompt)).toBe(true);
    expect(freebuffPromptReady('Pasted text (1,000 chars)', prompt)).toBe(false);
    expect(freebuffPromptReady('Hello fixture', 'Hello fixture')).toBe(true);
    expect(
      freebuffPromptReady(
        '│must retrieve the  │\n│note.              │',
        'must retrieve the note.',
      ),
    ).toBe(true);
    let polls = 0;
    const tmux = mock(async (_args: string[]) =>
      ++polls === 1 ? READY : `Pasted text (${prompt.length.toLocaleString()} chars)`,
    );
    await waitForFreebuffPromptReady(tmux, 'private', prompt, undefined, 1000);
    expect(polls).toBe(2);
    expect(tmux.mock.calls.map(([args]) => args[0])).toEqual(['capture-pane', 'capture-pane']);
  });
  it('requires the actual composer placeholder, not a banner or long arbitrary pane', () => {
    expect(freebuffStartupState(READY)).toBe('ready');
    expect(freebuffStartupState('Freebuff\n' + 'continue '.repeat(100))).toBe('waiting');
    expect(freebuffStartupState('Load and run these? [y/N]')).toBe('trust');
    expect(freebuffStartupState('Please log in')).toBe('login');
  });

  it('reports an account Freebuck limit instead of misclassifying it as bridge startup failure', () => {
    expect(freebuffAccountLimitError('Not enough Freebucks available')).toContain('no Freebucks');
    expect(freebuffAccountLimitError('Freebucks: 12 remaining')).toBeNull();
  });

  it('reports the 0.2.36 concurrent-session gate instead of auto-confirming take over', () => {
    // Real 0.2.36 modal shape: confirming would stop the account's other session.
    const gate = [
      '│ Your concurrent-session limit across CLI and Desktop is reached. Take over to stop another session and use its slot here. │',
      '│ Enter: take over  Esc: back to draft │',
    ].join('\n');
    expect(freebuffAccountLimitError(gate)).toContain('concurrent-session limit');
    expect(freebuffNeedsSessionConfirmation(gate)).toBe(false);
    expect(freebuffAccountLimitError('model session ready')).toBeNull();
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
    expect(freebuffCompletionFromLogRow({ msg: 'Main prompt finished', data: {} }, true)).toBe(
      'success',
    );
  });

  it('recovers text from native completion payload variants', () => {
    expect(
      freebuffResponseFromLogRow({
        msg: 'Main prompt finished',
        data: { lastMessage: { role: 'assistant', content: 'structured answer' } },
      }),
    ).toBe('structured answer');
    expect(
      freebuffResponseFromLogRow({
        msg: 'Main prompt finished',
        data: {
          allMessages: [
            { role: 'user', content: 'prompt' },
            { role: 'model', content: 'answer' },
          ],
        },
      }),
    ).toBe('answer');
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
  const accountModel = {
    id: 'freebuff/catalog-m-fixture',
    name: 'Account model',
    multimodal: true,
    contextWindow: 1_000_000,
    reasoningLevels: ['low', 'high'],
    handle: 'private-account-handle',
  };
  it('publishes real account capabilities without handles and verifies explicit selection and effort', async () => {
    const source = {
      freebuffModelKey: 'm-other',
      freebuffCatalogReasoningEfforts: { 'm-other': 'low' },
    };
    const fixture = harness({
      accountCatalog: { models: [accountModel], refreshAt: Date.now() + 60_000 },
      selectedModel: accountModel.id,
      settings: JSON.stringify(source),
      rows: [[rootRow('Selected answer', accountModel.handle), finished()]],
      onStart: (root) => {
        expect(
          JSON.parse(readFileSync(join(root, 'home/.config/manicode/settings.json'), 'utf8')),
        ).toMatchObject({
          freebuffModelKey: 'm-fixture',
          freebuffCatalogReasoningEfforts: { 'm-other': 'low', 'm-fixture': 'high' },
        });
      },
    });
    const models = await fixture.provider.refreshModels();
    expect(models.find((model) => model.apiModelId === accountModel.id)).toMatchObject({
      name: 'Account model',
      accountId: 'fixture',
      vision: true,
      supportsAttachments: true,
      contextWindow: 1_000_000,
      contextVerified: true,
      reasoningLevels: ['low', 'high'],
    });
    expect(JSON.stringify(models)).not.toContain(accountModel.handle);
    const events = await fixture.collect({ reasoningLevel: 'high' });
    expect(events.some((event) => event.type === 'complete')).toBe(true);
    expect(JSON.stringify(events)).not.toContain(accountModel.handle);
  });
  it('rejects a substituted modern catalog handle before publishing content', async () => {
    const fixture = harness({
      accountCatalog: { models: [accountModel], refreshAt: Date.now() + 60_000 },
      selectedModel: accountModel.id,
      rows: [[rootRow('Wrong answer', 'private-other-handle'), finished()]],
    });
    const events = await fixture.collect();
    expect(events).toHaveLength(1);
    expect(events[0]?.error).toContain('did not use the requested model');
    expect(JSON.stringify(events)).not.toContain('private-other-handle');
  });
  it('rejects unavailable account models and unsupported effort before staging a runtime', async () => {
    for (const accountCatalogFailure of [false, true]) {
      const fixture = harness({
        accountCatalog: { models: [accountModel], refreshAt: Date.now() + 60_000 },
        selectedModel: accountModel.id,
        accountCatalogFailure,
      });
      const events = await fixture.collect({ reasoningLevel: 'unsupported' });
      expect(events[0]?.type).toBe('error');
      expect(fixture.calls).not.toContain('runtime');
      expect(JSON.stringify(events)).not.toContain(SECRET);
    }
  });

  it('surfaces the real tool and late result through the provider polling loop', async () => {
    const fixture = harness({
      rows: [
        [
          {
            msg: 'step',
            data: {
              toolCalls: [
                { toolCallId: 'read-1', toolName: 'kory__read_file', input: { path: 'README.md' } },
              ],
            },
          },
        ],
        [
          {
            msg: 'step results',
            data: {
              toolResults: [{ toolCallId: 'read-1', content: 'Permission denied', isError: true }],
            },
          },
          rootRow(),
          finished(),
        ],
      ],
    });
    const events = await fixture.collect();
    expect(events.filter((event) => event.type === 'tool_executed')).toEqual([
      {
        type: 'tool_executed',
        toolCallId: 'read-1',
        toolName: 'kory__read_file',
        toolInput: '{"path":"README.md"}',
        toolOutput: 'Permission denied',
        isError: true,
      },
    ]);
    expect(events.some((event) => event.type === 'complete')).toBe(true);
    const pasteIndex = fixture.tmuxCalls.findIndex((args) => args[0] === 'paste-buffer');
    expect(fixture.tmuxCalls[pasteIndex]).not.toContain('-p');
    expect(fixture.tmuxCalls[pasteIndex - 1]?.at(-1)).toBe('\x1b[200~');
    expect(fixture.tmuxCalls[pasteIndex + 1]?.at(-1)).toBe('\x1b[201~');
    const submitIndex = fixture.tmuxCalls.findIndex(
      (args) => args[0] === 'send-keys' && args.at(-1) === 'Enter',
    );
    expect(
      fixture.tmuxCalls
        .slice(pasteIndex + 2, submitIndex)
        .some((args) => args[0] === 'capture-pane'),
    ).toBe(true);
  });

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

  it('re-probes the real runtime on a catalog mismatch and accepts the CLI it confirms', async () => {
    const fixture = harness({ catalogVersion: '0.2.13', refreshedVersion: '0.2.13' });
    const events = await fixture.collect();
    expect(fixture.forcedRefreshes()).toBeGreaterThanOrEqual(1);
    expect(events.some((event) => event.type === 'complete')).toBe(true);
  });
  it('refuses a host CLI upgrade that still differs after a forced re-probe', async () => {
    const fixture = harness({ catalogVersion: '0.2.13', refreshedVersion: '0.2.12' });
    const events = await fixture.collect();
    expect(fixture.forcedRefreshes()).toBeGreaterThanOrEqual(1);
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
        expect(
          JSON.parse(readFileSync(join(root, 'workspace', '.agents', 'mcp.json'), 'utf8')),
        ).toEqual({
          mcpServers: {
            kory: {
              command: '/private/bun',
              args: ['/private/bridge.js'],
              env: {},
              type: 'stdio',
            },
          },
        });
      },
    });
    const events = await fixture.collect();
    expect(events).toEqual([
      { type: 'content_delta', content: 'Root answer' },
      { type: 'complete', finishReason: 'end_turn' },
    ]);
    expect(fixture.calls.indexOf('probe')).toBeLessThan(fixture.calls.indexOf('start'));
    expect(fixture.calls.slice(-4)).toEqual([
      'runtime-cleanup',
      'slot-released',
      'bridge-cleanup',
      'grant-cleanup',
    ]);
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
    expect(fixture.calls.slice(-4)).toEqual([
      'runtime-cleanup',
      'slot-released',
      'bridge-cleanup',
      'grant-cleanup',
    ]);
    expect(existsSync(fixture.runRoot)).toBe(false);
  });

  it('rejects a trust prompt without submitting or echoing it', async () => {
    const fixture = harness({ pane: `Load and run these? [y/N]\n${SECRET}` });
    const events = await fixture.collect();
    expect(events[0]).toMatchObject({ type: 'error' });
    expect(JSON.stringify(events)).not.toContain(SECRET);
    expect(
      fixture.tmuxCalls.some(
        (args) =>
          ['load-buffer', 'paste-buffer'].includes(args[0]!) ||
          (args[0] === 'send-keys' && args.at(-1) !== 'C-c'),
      ),
    ).toBe(false);
  });

  it('recognizes the native paid-model confirmation without treating it as MCP approval', () => {
    expect(freebuffNeedsSessionConfirmation('\u001b[31mEnter: confirm and send\u001b[0m')).toBe(
      true,
    );
    expect(freebuffNeedsSessionConfirmation('Enter: retry')).toBe(false);
    expect(freebuffNeedsSessionConfirmation('take over this session?')).toBe(false);
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

  const retiredRow = {
    msg: 'Error in AI SDK stream',
    data: {
      agentId: 'main-agent',
      error: {
        statusCode: 410,
        responseBody: '{"error":{"code":"freebuff_update_required","message":"update"}}',
      },
    },
  };

  it('self-heals a Codebuff 410 once: update, cleanup, retry, completion', async () => {
    const forceUpdate = mock(async () => ({
      available: true,
      kind: 'docker' as const,
      version: '0.2.13',
    }));
    const fixture = harness({
      forceUpdate,
      rows: [[retiredRow], [rootRow(), finished()]],
    });
    const events = await fixture.collect();
    expect(forceUpdate).toHaveBeenCalledTimes(1);
    expect(events.some((event) => event.type === 'complete')).toBe(true);
    expect(events.some((event) => event.type === 'error')).toBe(false);
    // The retired attempt's cleanup ran before the retried turn staged its runtime.
    const runtimes = fixture.calls
      .map((call, index) => ({ call, index }))
      .filter((entry) => entry.call === 'runtime');
    expect(runtimes).toHaveLength(2);
    expect(fixture.calls.indexOf('runtime-cleanup')).toBeLessThan(runtimes[1]!.index);
    expect(fixture.calls.indexOf('grant-cleanup')).toBeLessThan(runtimes[1]!.index);
    expect(existsSync(fixture.runRoot)).toBe(false);
  });

  it('reports retirement after the retried turn is rejected without a third attempt', async () => {
    const forceUpdate = mock(async () => ({
      available: true,
      kind: 'docker' as const,
      version: '0.2.13',
    }));
    const fixture = harness({
      forceUpdate,
      rows: [[retiredRow], [retiredRow], [rootRow(), finished()]],
    });
    const events = await fixture.collect();
    expect(forceUpdate).toHaveBeenCalledTimes(1);
    expect(events.some((event) => event.type === 'complete')).toBe(false);
    const error = events.find((event) => event.type === 'error');
    expect(error?.error).toContain('Codebuff has retired Freebuff 0.2.12');
    expect(fixture.calls.filter((call) => call === 'runtime')).toHaveLength(2);
  });

  it('surfaces an actionable retirement error when the runtime update fails', async () => {
    const fixture = harness({ rows: [[retiredRow]] });
    const events = await fixture.collect();
    expect(events.some((event) => event.type === 'complete')).toBe(false);
    const error = events.find((event) => event.type === 'error');
    expect(error?.error).toContain('Codebuff has retired Freebuff 0.2.12');
    expect(error?.error).toContain('could not install a newer runtime');
    expect(error?.error).toContain('synthetic update failure');
    expect(fixture.calls.filter((call) => call === 'runtime')).toHaveLength(1);
  });

  it('never retries a retirement after content was already emitted', async () => {
    const forceUpdate = mock(async () => ({
      available: true,
      kind: 'docker' as const,
      version: '0.2.13',
    }));
    const fixture = harness({
      forceUpdate,
      rows: [[rootRow(), retiredRow]],
    });
    const events = await fixture.collect();
    expect(events.some((event) => event.type === 'content_delta')).toBe(true);
    expect(events.some((event) => event.type === 'complete')).toBe(false);
    expect(forceUpdate).not.toHaveBeenCalled();
    expect(fixture.calls.filter((call) => call === 'runtime')).toHaveLength(1);
  });

  it('surfaces the real upstream error code and message without private material', async () => {
    const token = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.fixture';
    const fixture = harness({
      rows: [
        [
          {
            msg: 'Error in AI SDK stream',
            data: {
              agentId: 'main-agent',
              error: {
                statusCode: 502,
                isRetryable: true,
                url: 'https://internal.example/request?key=hidden',
                requestBodyValues: { prompt: 'the user prompt must never surface' },
                stack: 'Error: stack\n at internal',
                responseBody: JSON.stringify({
                  error: { code: 'upstream_bad_gateway', message: `model endpoint broke ${token}` },
                }),
              },
            },
          },
          finished('error'),
        ],
      ],
    });
    const events = await fixture.collect();
    const error = events.find((event) => event.type === 'error');
    expect(error?.error).toBe(
      'Freebuff model request failed (HTTP 502, upstream_bad_gateway): model endpoint broke [redacted]',
    );
    expect(error?.errorTransient).toBe(true);
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain('user prompt must never surface');
    expect(serialized).not.toContain('requestBodyValues');
    expect(serialized).not.toContain('internal.example');
  });

  it('reports a waiting state while the forced runtime update installs', async () => {
    const forceUpdate = mock(async () => ({
      available: true,
      kind: 'docker' as const,
      version: '0.2.13',
    }));
    const fixture = harness({
      forceUpdate,
      rows: [[retiredRow], [rootRow(), finished()]],
    });
    const events = await fixture.collect();
    const waitingIndex = events.findIndex((event) => event.type === 'waiting');
    expect(waitingIndex).toBeGreaterThanOrEqual(0);
    expect(events[waitingIndex]?.waitingReason).toContain('Updating the Freebuff runtime');
    const completeIndex = events.findIndex((event) => event.type === 'complete');
    expect(completeIndex).toBeGreaterThan(waitingIndex);
  });

  it('cancels promptly while a forced runtime update is still installing', async () => {
    const controller = new AbortController();
    let releaseUpdate: (() => void) | undefined;
    const forceUpdate = mock(async () => {
      await new Promise<void>((resolve) => {
        releaseUpdate = resolve;
      });
      return { available: true, kind: 'docker' as const, version: '0.2.13' };
    });
    const fixture = harness({
      forceUpdate,
      signal: controller.signal,
      rows: [[retiredRow], [rootRow(), finished()]],
    });
    const collected = fixture.collect();
    for (let attempt = 0; attempt < 100 && !releaseUpdate; attempt += 1) await Bun.sleep(10);
    expect(forceUpdate).toHaveBeenCalledTimes(1);
    controller.abort();
    const events = await collected;
    releaseUpdate?.();
    const error = events.find((event) => event.type === 'error');
    expect(error?.error).toBe('Freebuff PTY turn cancelled.');
    expect(events.some((event) => event.type === 'complete')).toBe(false);
  });

  it('does not rebuild the runtime for a bare 410 on an unrelated row', async () => {
    const forceUpdate = mock(async () => ({
      available: true,
      kind: 'docker' as const,
      version: '0.2.13',
    }));
    const fixture = harness({
      forceUpdate,
      rows: [
        [
          { msg: 'Runtime telemetry flush failed', data: { error: { statusCode: 410 } } },
          rootRow(),
          finished(),
        ],
      ],
    });
    const events = await fixture.collect();
    expect(forceUpdate).not.toHaveBeenCalled();
    expect(events.some((event) => event.type === 'complete')).toBe(true);
  });

  it('treats a 410 on the model-stream rows as retirement', async () => {
    const forceUpdate = mock(async () => ({
      available: true,
      kind: 'docker' as const,
      version: '0.2.13',
    }));
    const fixture = harness({
      forceUpdate,
      rows: [
        [{ msg: 'Error in AI SDK stream', data: { error: { statusCode: 410 } } }],
        [rootRow(), finished()],
      ],
    });
    const events = await fixture.collect();
    expect(forceUpdate).toHaveBeenCalledTimes(1);
    expect(events.some((event) => event.type === 'complete')).toBe(true);
  });

  it('reports the TUI exit when the runtime dies between the liveness check and the log drain', async () => {
    let callsToDrain = 0;
    const fixture = harness({
      readLogRows: async () => {
        callsToDrain += 1;
        throw new Error('Freebuff runtime command failed');
      },
    });
    const events = await fixture.collect();
    const error = events.find((event) => event.type === 'error');
    expect(error?.error).toBe('Freebuff TUI exited before producing a completion event');
    // The raw runtime error must not surface, and the failure stays fail-closed.
    expect(events.some((event) => event.type === 'complete')).toBe(false);
    expect(callsToDrain).toBeGreaterThanOrEqual(2);
  });

  it('completes when the TUI exits after writing a success completion', async () => {
    const fixture = harness({
      dieAfterReads: 1,
      rows: [[], [rootRow('Final answer'), finished()]],
    });
    const events = await fixture.collect();
    expect(events.some((event) => event.type === 'error')).toBe(false);
    expect(events.find((event) => event.type === 'content_delta')?.content).toBe('Final answer');
    expect(events.some((event) => event.type === 'complete')).toBe(true);
  });

  it('reports the upstream error when the TUI exits after a failed completion', async () => {
    const fixture = harness({
      dieAfterReads: 1,
      rows: [
        [],
        [
          {
            msg: 'Error in AI SDK stream',
            data: {
              error: {
                statusCode: 503,
                responseBody: '{"error":{"code":"upstream_down","message":"Service broken"}}',
              },
            },
          },
          finished('error'),
        ],
      ],
    });
    const events = await fixture.collect();
    const error = events.find((event) => event.type === 'error');
    expect(error?.error).toContain('HTTP 503');
    expect(error?.error).toContain('Service broken');
    expect(events.some((event) => event.type === 'complete')).toBe(false);
  });

  it('still reports a dead TUI when the final drain has no completion', async () => {
    const fixture = harness({ dieAfterReads: 1, rows: [[], []] });
    const events = await fixture.collect();
    const error = events.find((event) => event.type === 'error');
    expect(error?.error).toBe('Freebuff TUI exited before producing a completion event');
    expect(events.some((event) => event.type === 'complete')).toBe(false);
  });

  it('fails fast when a startup drain completes without the MCP ready proof', async () => {
    // The TUI dies during bridge startup after the turn already finished: the
    // drain surfaces a completion, but the missing ready marker can never be
    // produced by a dead runtime, so the turn must refuse the completion
    // immediately instead of spinning out the readiness timeout.
    const fixture = harness({ noReadyMarker: true, dieOnStart: true });
    const events = await fixture.collect();
    const error = events.find((event) => event.type === 'error');
    expect(error?.error).toBe('Freebuff TUI exited before the Kory MCP bridge reported ready');
    expect(events.some((event) => event.type === 'complete')).toBe(false);
  });

  it('still reports a dead TUI when the startup drain has no completion', async () => {
    const fixture = harness({ noReadyMarker: true, dieOnStart: true, rows: [[], []] });
    const events = await fixture.collect();
    const error = events.find((event) => event.type === 'error');
    expect(error?.error).toBe('Freebuff TUI exited before producing a completion event');
    expect(events.some((event) => event.type === 'complete')).toBe(false);
  });

  it('fails fast when the CLI session is displaced before the bridge starts', async () => {
    const fixture = harness({
      noReadyMarker: true,
      sessionLostGraceMs: 50,
      pane: `${READY}\nEnter: confirm and send`,
      rows: [
        [{ msg: '[chat-runtime] Freebuff session over; holding queued messages until rejoin' }],
        [],
        [rootRow(), finished()],
      ],
    });
    const events = await fixture.collect();
    const error = events.find((event) => event.type === 'error');
    expect(error?.error).toBe('Freebuff session ended before the Kory MCP bridge reported ready');
    expect(events.some((event) => event.type === 'complete')).toBe(false);
  });

  it('resubmits a prompt swallowed by a startup dialog so the bridge still starts', async () => {
    const fixture = harness({
      noReadyMarker: true,
      readyOnEnterCount: 3,
      pane: `${READY}\nEnter: confirm and send`,
      rows: [[], [rootRow(), finished()]],
    });
    const events = await fixture.collect();
    const enters = fixture.tmuxCalls.filter(
      (args) => args[0] === 'send-keys' && args.at(-1) === 'Enter',
    );
    // 1 submission + 1 dialog dismissal + 1 verified resubmit.
    expect(enters).toHaveLength(3);
    expect(events.some((event) => event.type === 'complete')).toBe(true);
  });

  it('self-heals when the final drain carries the retirement rows', async () => {
    const forceUpdate = mock(async () => ({
      available: true,
      kind: 'docker' as const,
      version: '0.2.13',
    }));
    const retired = {
      msg: 'Error in AI SDK stream',
      data: {
        error: { statusCode: 410, responseBody: '{"error":"freebuff_update_required"}' },
      },
    };
    const fixture = harness({
      dieAfterReads: 1,
      forceUpdate,
      rows: [[], [retired], [rootRow(), finished()]],
    });
    const events = await fixture.collect();
    expect(forceUpdate).toHaveBeenCalledTimes(1);
    expect(events.some((event) => event.type === 'complete')).toBe(true);
  });

  it('retries a killed bridge catalog probe exec once', async () => {
    const fixture = harness({ probeFailOnce137: true });
    const events = await fixture.collect();
    expect(events.some((event) => event.type === 'complete')).toBe(true);
    expect(fixture.calls.filter((call) => call === 'probe')).toHaveLength(2);
  });

  it('retries a killed log-reader exec once and still completes', async () => {
    let reads = 0;
    const fixture = harness({
      readLogRows: async () => {
        if (++reads === 1) throw Object.assign(new Error('killed'), { code: 137 });
        return [rootRow(), finished()];
      },
    });
    const events = await fixture.collect();
    expect(events.some((event) => event.type === 'complete')).toBe(true);
    expect(reads).toBeGreaterThanOrEqual(2);
  });

  it('fails closed when the exec kill persists past the retry', async () => {
    const fixture = harness({
      readLogRows: async () => {
        throw Object.assign(new Error('killed'), { code: 137 });
      },
    });
    const events = await fixture.collect();
    expect(events.find((event) => event.type === 'error')?.error).toBe(
      'Freebuff TUI exited before producing a completion event',
    );
    expect(events.some((event) => event.type === 'complete')).toBe(false);
  });

  it('sends the TUI quit before the forced teardown on cancellation', async () => {
    const controller = new AbortController();
    const fixture = harness({
      signal: controller.signal,
      onProbe: () => controller.abort(),
    });
    const events = await fixture.collect();
    expect(events[0]).toMatchObject({ type: 'error', error: 'Freebuff PTY turn cancelled.' });
    const quitIndex = fixture.calls.indexOf('tui-quit');
    expect(quitIndex).toBeGreaterThanOrEqual(0);
    expect(quitIndex).toBeLessThan(fixture.calls.indexOf('runtime-cleanup'));
    expect(fixture.calls.filter((call) => call === 'runtime-cleanup')).toHaveLength(1);
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

  it('waits out a busy account slot, emits the waiting state, then completes', async () => {
    const fixture = harness({
      slotPrehold: { sessionId: 'another-chat', role: 'manager', releaseAfterMs: 900 },
    });
    const events = await fixture.collect();
    const waitingIndex = events.findIndex(
      (event) =>
        event.type === 'waiting' &&
        event.waitingReason === "Waiting for the Freebuff account's live session…",
    );
    expect(waitingIndex).toBeGreaterThanOrEqual(0);
    const completeIndex = events.findIndex((event) => event.type === 'complete');
    expect(completeIndex).toBeGreaterThan(waitingIndex);
    expect(events.some((event) => event.type === 'error')).toBe(false);
    expect(fixture.calls).toContain('runtime');
    // The foreign lease was superseded? No: the turn waited, won the slot and
    // released it exactly once at the end.
    expect(fixture.slotEvents).toEqual(['acquired:fixture', 'released:fixture']);
  });

  it('fails a same-session manager→worker delegate without staging a runtime', async () => {
    const fixture = harness({
      slotPrehold: { sessionId: 'fixture-session', role: 'manager', releaseAfterMs: 60_000 },
    });
    const events = await fixture.collect({ harnessRole: 'worker' });
    const error = events.find((event) => event.type === 'error');
    expect(error?.error).toContain(
      "The Freebuff manager of this chat is holding the account's only live session",
    );
    expect(error?.errorTransient).toBeFalsy();
    expect(events.some((event) => event.type === 'complete')).toBe(false);
    // Deadlock detection precedes any runtime work.
    expect(fixture.calls).not.toContain('runtime');
    expect(fixture.slotEvents).toEqual([]);
  });

  it('turns a take-over prompt into a slot-busy error and never confirms it', async () => {
    const fixture = harness({
      noReadyMarker: true,
      panes: [READY, READY, 'This account is in use elsewhere.\nEnter: take over'],
      pane: 'This account is in use elsewhere.\nEnter: take over',
    });
    const events = await fixture.collect();
    const error = events.find((event) => event.type === 'error');
    expect(error?.error).toContain('live-session slot is in use by another session');
    expect(error?.error).toContain('never takes over');
    // Transient so a bounded retry can reclaim once the other session —
    // including a server-side zombie of a finished turn — clears.
    expect(error?.errorTransient).toBeTruthy();
    // Only the prompt-submission Enter was ever sent; the takeover gate was
    // never answered.
    const enters = fixture.tmuxCalls.filter(
      (args) => args[0] === 'send-keys' && args.at(-1) === 'Enter',
    );
    expect(enters).toHaveLength(1);
    expect(fixture.calls).toContain('runtime-cleanup');
    expect(fixture.slotEvents).toEqual(['acquired:fixture', 'released:fixture']);
  });

  it('keeps a waiting-room session waiting instead of reporting session loss', async () => {
    const fixture = harness({
      noReadyMarker: true,
      sessionLostGraceMs: 50,
      pane: 'You are in line, starting soon',
      panes: [READY, READY, `${READY}\nEnter: confirm and send`],
      onStart: (root) =>
        setTimeout(
          () => writeFileSync(join(root, 'bridge-ready.json'), '{"ready":true}'),
          1_100,
        ).unref(),
      rows: [
        [{ msg: '[chat-runtime] Freebuff session over; holding queued messages until rejoin' }],
        [{ msg: 'chat update', data: { error: 'waiting_room_queued' } }],
        [],
        [rootRow(), finished()],
      ],
    });
    const events = await fixture.collect();
    const waitingIndex = events.findIndex(
      (event) =>
        event.type === 'waiting' &&
        event.waitingReason === 'Freebuff is queued for model session capacity…',
    );
    expect(waitingIndex).toBeGreaterThanOrEqual(0);
    expect(
      events.some((event) => event.type === 'error' && event.error?.includes('session ended')),
    ).toBe(false);
    expect(events.some((event) => event.type === 'complete')).toBe(true);
  });

  it('maps a server session_superseded row to a transient takeover error', async () => {
    const fixture = harness({
      rows: [
        [
          {
            msg: 'session over',
            data: { agentId: 'main-agent', error: 'session_superseded' },
          },
          finished(),
        ],
      ],
    });
    const events = await fixture.collect();
    const error = events.find((event) => event.type === 'error');
    expect(error?.error).toContain('session was taken over by another session');
    expect(error?.errorTransient).toBe(true);
    expect(events.some((event) => event.type === 'complete')).toBe(false);
  });

  it('maps a server session_limit_reached row to a non-transient slot-busy error', async () => {
    const fixture = harness({
      rows: [
        [
          {
            msg: 'session rejected',
            data: { agentId: 'main-agent', error: { code: 'session_limit_reached' } },
          },
          finished(),
        ],
      ],
    });
    const events = await fixture.collect();
    const error = events.find((event) => event.type === 'error');
    expect(error?.error).toContain('live-session slot is in use by another session');
    expect(error?.errorTransient).toBeFalsy();
  });

  it('releases the slot after every attempt including the 410 retry', async () => {
    const forceUpdate = mock(async () => ({
      available: true,
      kind: 'docker' as const,
      version: '0.2.13',
    }));
    const fixture = harness({
      forceUpdate,
      rows: [[retiredRow], [rootRow(), finished()]],
    });
    const events = await fixture.collect();
    expect(events.some((event) => event.type === 'complete')).toBe(true);
    expect(fixture.slotEvents).toEqual([
      'acquired:fixture',
      'released:fixture',
      'acquired:fixture',
      'released:fixture',
    ]);
    // The slot is dropped only after its runtime is down — for both attempts.
    const acquiredAt = fixture.calls
      .map((call, index) => ({ call, index }))
      .filter((entry) => entry.call === 'slot-acquired')
      .map((entry) => entry.index);
    const releasedAt = fixture.calls
      .map((call, index) => ({ call, index }))
      .filter((entry) => entry.call === 'slot-released')
      .map((entry) => entry.index);
    const cleanedAt = fixture.calls
      .map((call, index) => ({ call, index }))
      .filter((entry) => entry.call === 'runtime-cleanup')
      .map((entry) => entry.index);
    expect(cleanedAt[0]!).toBeLessThan(releasedAt[0]!);
    expect(releasedAt[0]!).toBeLessThan(acquiredAt[1]!);
    expect(cleanedAt[1]!).toBeLessThan(releasedAt[1]!);
  });

  it('emits waiting then a transient busy error when the slot never frees', async () => {
    let attempt = 0;
    const fixture = harness({
      // Immediate pass is busy; the parked wait expires 'timeout'; the rescan
      // is busy again — the turn reports the actionable transient busy error.
      acquireSessionSlot: async () => {
        attempt += 1;
        throw new FreebuffSessionSlotError('held', attempt === 2 ? 'timeout' : 'busy', {
          sessionId: 'foreign',
          role: 'manager',
        });
      },
    });
    const events = await fixture.collect();
    const waitingIndex = events.findIndex((event) => event.type === 'waiting');
    expect(waitingIndex).toBeGreaterThanOrEqual(0);
    const error = events.find((event) => event.type === 'error');
    expect(error?.error).toContain('live-session slot is in use by another session');
    expect(error?.errorTransient).toBe(true);
    expect(fixture.calls).not.toContain('runtime');
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
