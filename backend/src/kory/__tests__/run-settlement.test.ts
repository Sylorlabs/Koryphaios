import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { KoryphaiosConfig, WSMessage } from '@koryphaios/shared';
import { wsBroker } from '../../pubsub';
import { initDb } from '../../db';
import type { ProviderRegistry } from '../../providers';
import type { Provider, ProviderEvent, StreamRequest } from '../../providers/types';
import { MessageStore } from '../../stores/message-store';
import { SessionStore } from '../../stores/session-store';
import { SessionRunCoordinator } from '../../runs/session-run-coordinator';
import { SessionRunStore } from '../../runs/session-run-store';
import { ToolRegistry } from '../../tools';
import { KoryManager } from '../manager';

// Turn lifecycle contract: turn.provider_completed marks the end of provider work,
// run.settled marks the end of the run after its follow-up work. Both are emitted
// once per run, and run.settled follows the run's terminal run.state.

beforeAll(async () => {
  await initDb();
});

const MANAGER_AGENT = 'kory-manager';
const fixtures: Array<{ manager: KoryManager; root: string }> = [];
afterEach(async () => {
  for (const { manager, root } of fixtures.splice(0)) {
    await manager.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * A real manager with a durable SessionRun coordinator and a scripted provider.
 * `script` produces one provider call's events; it may act on the run mid-stream.
 */
async function fixture(script: (ctx: { sessionId: string; manager: KoryManager; runs: SessionRunCoordinator }) => AsyncGenerator<ProviderEvent>) {
  const root = mkdtempSync(join(tmpdir(), 'run-settlement-'));
  const sessions = new SessionStore();
  const messages = new MessageStore();
  const session = await sessions.create('local-user', 'Run settlement', undefined, root);
  await sessions.update(session.id, { agentOverrides: { criticMode: 'off', agentExecutionMode: 'single' } });
  const provider = { name: 'openai', config: {} } as Provider;
  const runs = new SessionRunCoordinator(new SessionRunStore(), (_sessionId, message) => {
    wsBroker.publish('custom', message as WSMessage);
  });
  let manager!: KoryManager;
  const providers = {
    resolveProvider: async () => provider,
    getAvailable: () => [provider], getStatus: () => [], getConfigs: () => ({}),
    get: () => undefined, isQuotaError: () => false,
    executeWithRetry: async function* (_request: StreamRequest): AsyncGenerator<ProviderEvent> {
      yield* script({ sessionId: session.id, manager, runs });
    },
  } as unknown as ProviderRegistry;
  const tools = new ToolRegistry();
  manager = new KoryManager(providers, tools, root, {} as KoryphaiosConfig, sessions, messages, undefined, undefined, runs);
  const internal = manager as any;
  manager.resolveActiveRouting = () => ({ model: 'gpt-4o', provider: 'openai' });
  internal.resolveSessionWorkingDirectory = async () => root;
  tools.execute = mock(async () => ({ callId: 'x', name: 'noop', output: '', isError: false, durationMs: 0 }));
  fixtures.push({ manager, root });
  return { manager, session, runs };
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

async function runTurn(f: Awaited<ReturnType<typeof fixture>>) {
  const admission = await f.manager.reserveSessionTurn(f.session.id, 'user_turn');
  return f.manager.dispatchAdmittedTask(admission!, {
    userMessage: 'Answer me',
    preferredModel: 'openai:gpt-4o',
    interactionMode: 'act',
  });
}

/** The ordered lifecycle events for this session that the settlement contract is about. */
function lifecycle(published: WSMessage[], sessionId: string) {
  return published
    .filter((m) => m.sessionId === sessionId)
    .filter((m) => {
      if (m.type === 'turn.provider_completed' || m.type === 'run.settled' || m.type === 'run.state') return true;
      return m.type === 'stream.delta' || (m.type === 'agent.status' && (m.payload as { agentId?: string }).agentId === MANAGER_AGENT);
    });
}

function indexOfType(events: WSMessage[], type: string, predicate: (m: WSMessage) => boolean = () => true) {
  return events.findIndex((m) => m.type === type && predicate(m));
}

function terminalRunState(events: WSMessage[]) {
  return events.find(
    (m) => m.type === 'run.state' && (m.payload as { snapshot: { status: string } }).snapshot.status === 'terminal',
  );
}

const answer: ProviderEvent[] = [{ type: 'content_delta', content: 'The answer.' }];

describe('turn provider completion and run settlement', () => {
  test('success: provider completion precedes follow-up work, and settlement follows the terminal run', async () => {
    const f = await fixture(async function* () {
      yield* answer;
    });
    const { published } = await captureBroker(() => runTurn(f));
    const events = lifecycle(published, f.session.id);

    const providerDone = events.filter((m) => m.type === 'turn.provider_completed');
    const settled = events.filter((m) => m.type === 'run.settled');
    expect(providerDone).toHaveLength(1);
    expect(settled).toHaveLength(1);

    const terminal = terminalRunState(events);
    const runId = (terminal!.payload as { snapshot: { runId: string } }).snapshot.runId;
    expect((providerDone[0].payload as { runId: string }).runId).toBe(runId);
    expect(settled[0].payload).toMatchObject({ runId, outcome: 'completed' });

    const doneStatus = indexOfType(events, 'agent.status', (m) => (m.payload as { status: string }).status === 'done');
    const lastDelta = events.map((m) => m.type).lastIndexOf('stream.delta');
    const providerIdx = events.indexOf(providerDone[0]);
    const terminalIdx = events.indexOf(terminal!);
    const settledIdx = events.indexOf(settled[0]);
    expect(lastDelta).toBeLessThan(providerIdx);
    expect(providerIdx).toBeLessThan(doneStatus);
    expect(doneStatus).toBeLessThan(terminalIdx);
    expect(terminalIdx).toBeLessThan(settledIdx);
  });

  test('provider error: provider completion is emitted once, and the run settles once as failed', async () => {
    const f = await fixture(async function* () {
      yield { type: 'error', error: 'provider exploded' } as ProviderEvent;
    });
    const { published } = await captureBroker(() => runTurn(f).catch(() => undefined));
    const events = lifecycle(published, f.session.id);

    const providerDone = events.filter((m) => m.type === 'turn.provider_completed');
    const settled = events.filter((m) => m.type === 'run.settled');
    expect(providerDone).toHaveLength(1);
    expect(settled).toHaveLength(1);
    expect(settled[0].payload).toMatchObject({ outcome: 'failed' });

    const terminalIdx = events.indexOf(terminalRunState(events)!);
    expect(events.indexOf(providerDone[0])).toBeLessThan(terminalIdx);
    expect(terminalIdx).toBeLessThan(events.indexOf(settled[0]));
  });

  test('user stop: provider completion and settlement are each emitted once, in order, as cancelled', async () => {
    let stopping: Promise<void> | undefined;
    const f = await fixture(async function* ({ manager, sessionId }) {
      // The stop is requested mid-stream. The owner settles it after its own follow-up work.
      stopping = manager.cancelSessionWorkers(sessionId);
      yield { type: 'content_delta', content: 'Partial' } as ProviderEvent;
    });
    const { published } = await captureBroker(async () => {
      await runTurn(f).catch(() => undefined);
      await stopping;
    });
    const events = lifecycle(published, f.session.id);

    const providerDone = events.filter((m) => m.type === 'turn.provider_completed');
    const settled = events.filter((m) => m.type === 'run.settled');
    expect(providerDone).toHaveLength(1);
    expect(settled).toHaveLength(1);
    expect(settled[0].payload).toMatchObject({ outcome: 'cancelled' });

    const terminalIdx = events.indexOf(terminalRunState(events)!);
    expect(events.indexOf(providerDone[0])).toBeLessThan(terminalIdx);
    expect(terminalIdx).toBeLessThan(events.indexOf(settled[0]));
  });

  test('superseded run: an outside owner terminalizes the run mid-turn, and settlement is emitted exactly once', async () => {
    const f = await fixture(async function* ({ sessionId, runs }) {
      // Another owner terminalizes the run while this turn is still streaming.
      await runs.cancelCurrent(sessionId, 'superseded_by_new_turn');
      yield* answer;
    });
    const { published } = await captureBroker(() => runTurn(f).catch(() => undefined));
    const events = lifecycle(published, f.session.id);

    const settled = events.filter((m) => m.type === 'run.settled');
    expect(events.filter((m) => m.type === 'turn.provider_completed')).toHaveLength(1);
    expect(settled).toHaveLength(1);
    expect(settled[0].payload).toMatchObject({ outcome: 'cancelled' });
    expect(events.indexOf(terminalRunState(events)!)).toBeLessThan(events.indexOf(settled[0]));
  });
});
