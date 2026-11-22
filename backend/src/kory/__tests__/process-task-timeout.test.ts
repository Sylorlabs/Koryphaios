import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { KoryphaiosConfig, WSMessage } from '@koryphaios/shared';
import { wsBroker } from '../../pubsub';
import { initDb } from '../../db';
import { AGENT } from '../../constants';
import type { ProviderRegistry } from '../../providers';
import type { Provider, ProviderEvent, StreamRequest } from '../../providers/types';
import { MessageStore } from '../../stores/message-store';
import { SessionStore } from '../../stores/session-store';
import { SessionRunCoordinator } from '../../runs/session-run-coordinator';
import { SessionRunStore } from '../../runs/session-run-store';
import { ToolRegistry } from '../../tools';
import { KoryManager } from '../manager';

// Reproduction of the long-session bug: AGENT.PROCESS_TASK_TIMEOUT_MS arms a
// wall-clock setTimeout in processTaskWithClaim that aborts the turn's
// AbortController with a TimeoutError DOMException. The abort reason is never
// inspected — observeCancellation() treats any non-loop abort as a user stop —
// so a turn that is still actively streaming is killed mid-flight and reported
// as 'Stopped by user.' / 'cancelled_by_user'.

beforeAll(async () => {
  await initDb();
});

const fixtures: Array<{ manager: KoryManager; root: string }> = [];
let originalTimeout = 0;

beforeEach(() => {
  originalTimeout = AGENT.PROCESS_TASK_TIMEOUT_MS;
  AGENT.PROCESS_TASK_TIMEOUT_MS = 400;
});

afterEach(async () => {
  AGENT.PROCESS_TASK_TIMEOUT_MS = originalTimeout;
  for (const { manager, root } of fixtures.splice(0)) {
    await manager.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});

async function fixture(
  script: (request: StreamRequest) => AsyncGenerator<ProviderEvent>,
) {
  const root = mkdtempSync(join(tmpdir(), 'process-task-timeout-'));
  const sessions = new SessionStore();
  const messages = new MessageStore();
  const session = await sessions.create('local-user', 'Timeout', undefined, root);
  await sessions.update(session.id, {
    agentOverrides: { criticMode: 'off', agentExecutionMode: 'single' },
  });
  const provider = { name: 'openai', config: {} } as Provider;
  const runs = new SessionRunCoordinator(new SessionRunStore(), (_sessionId, message) => {
    wsBroker.publish('custom', message as WSMessage);
  });
  const providers = {
    resolveProvider: async () => provider,
    getAvailable: () => [provider],
    getStatus: () => [],
    getConfigs: () => ({}),
    get: () => undefined,
    isQuotaError: () => false,
    executeWithRetry: async function* (request: StreamRequest): AsyncGenerator<ProviderEvent> {
      yield* script(request);
    },
  } as unknown as ProviderRegistry;
  const tools = new ToolRegistry();
  const manager = new KoryManager(
    providers,
    tools,
    root,
    {} as KoryphaiosConfig,
    sessions,
    messages,
    undefined,
    undefined,
    runs,
  );
  manager.resolveActiveRouting = () => ({ model: 'gpt-4o', provider: 'openai' });
  (manager as any).resolveSessionWorkingDirectory = async () => root;
  tools.execute = mock(async () => ({
    callId: 'x',
    name: 'noop',
    output: '',
    isError: false,
    durationMs: 0,
  }));
  fixtures.push({ manager, root });
  return { manager, session, runs, messages };
}

async function captureBroker<T>(run: () => Promise<T>): Promise<{ result: T; published: WSMessage[] }> {
  const published: WSMessage[] = [];
  const broker = wsBroker as unknown as { publish: (channel: string, message: unknown) => void };
  const original = broker.publish;
  broker.publish = (_channel, message) => {
    published.push(message as WSMessage);
  };
  try {
    return { result: await run(), published };
  } finally {
    broker.publish = original;
  }
}

function runTurn(f: Awaited<ReturnType<typeof fixture>>) {
  return f.manager
    .reserveSessionTurn(f.session.id, 'user_turn')
    .then((admission) =>
      f.manager.dispatchAdmittedTask(admission!, {
        userMessage: 'Answer me',
        preferredModel: 'openai:gpt-4o',
        interactionMode: 'act',
      }),
    );
}

function sessionEvents(published: WSMessage[], sessionId: string) {
  return published.filter((m) => m.sessionId === sessionId);
}

function terminalRunState(events: WSMessage[]) {
  return events.find(
    (m) =>
      m.type === 'run.state' &&
      (m.payload as { snapshot: { status: string } }).snapshot.status === 'terminal',
  );
}

describe('PROCESS_TASK_TIMEOUT_MS wall-clock kill', () => {
  // CHARACTERIZES CURRENT BUGGY BEHAVIOR. The turn below is actively streaming
  // (a delta every 25 ms, so the idle stream timeout never fires), yet the
  // 30-minute wall-clock PROCESS_TASK_TIMEOUT_MS timer aborts it and the abort
  // is reported as a user stop. When the timeout is fixed — e.g. made an idle
  // timeout or reported as a timeout — invert this test: expect the turn to run
  // to its natural completion with outcome 'completed'.
  test('an actively-progressing turn is killed by the wall-clock timeout and reported as a user stop', async () => {
    let providerSawAbortAt: number | undefined;
    const start = Date.now();
    const f = await fixture(async function* (request) {
      // Stream steadily; only stop when the turn's signal aborts, with a 5 s
      // safety ceiling so a hung test cannot stall forever.
      const deadline = Date.now() + 5_000;
      while (!request.signal?.aborted && Date.now() < deadline) {
        yield { type: 'content_delta', content: '.' } as ProviderEvent;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      providerSawAbortAt = Date.now();
      if (request.signal?.aborted) {
        throw (request.signal.reason ?? new DOMException('Aborted', 'AbortError'));
      }
      yield { type: 'complete' } as ProviderEvent;
    });
    const { published } = await captureBroker(() => runTurn(f).catch(() => undefined));
    const events = sessionEvents(published, f.session.id);
    // (a) The provider's request signal aborted at ~400 ms, well before the 5 s
    // ceiling — the wall-clock kill, not the stream ending on its own.
    expect(providerSawAbortAt).toBeDefined();
    const abortElapsed = providerSawAbortAt! - start;
    expect(abortElapsed).toBeGreaterThanOrEqual(300);
    expect(abortElapsed).toBeLessThan(3_000);

    // (b) The abort is surfaced as a user stop, not a timeout: the run's
    // terminal reason is 'cancelled_by_user' and settlement reports 'cancelled'.
    // (Note: this path does not broadcast a 'Stopped by user.' system.info —
    // the kill lands between provider turns, so only the persisted marker and
    // the run records show it.)
    const terminal = terminalRunState(events);
    expect(terminal).toBeDefined();
    expect(
      (terminal!.payload as { snapshot: { terminalReason: string | null } }).snapshot
        .terminalReason,
    ).toBe('cancelled_by_user');

    const settled = events.filter((m) => m.type === 'run.settled');
    expect(settled).toHaveLength(1);
    expect(settled[0].payload).toMatchObject({ outcome: 'cancelled' });

    // The persisted transcript also records the stop as a user action.
    const persisted = await f.messages.getContextMessages(f.session.id);
    expect(
      persisted.some((m) => m.role === 'system' && m.content === 'Stopped by user.'),
    ).toBe(true);
  });

  test('control: a turn that finishes under the limit completes normally', async () => {
    const f = await fixture(async function* () {
      const deadline = Date.now() + 150;
      while (Date.now() < deadline) {
        yield { type: 'content_delta', content: '.' } as ProviderEvent;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      yield { type: 'content_delta', content: 'Done.' } as ProviderEvent;
      yield { type: 'complete' } as ProviderEvent;
    });
    const { published } = await captureBroker(() => runTurn(f).catch(() => undefined));
    const events = sessionEvents(published, f.session.id);

    const terminal = terminalRunState(events);
    expect(terminal).toBeDefined();
    expect(
      (terminal!.payload as { snapshot: { terminalReason: string | null } }).snapshot
        .terminalReason,
    ).toBe('provider_turn_completed');

    const settled = events.filter((m) => m.type === 'run.settled');
    expect(settled).toHaveLength(1);
    expect(settled[0].payload).toMatchObject({ outcome: 'completed' });

    const stopNotices = events.filter(
      (m) =>
        m.type === 'system.info' &&
        String((m.payload as { message?: string })?.message ?? '').includes('Stopped by user'),
    );
    expect(stopNotices).toHaveLength(0);
  });
});
