import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { KoryphaiosConfig } from '@koryphaios/shared';
import { initDb } from '../../db';
import type { ProviderRegistry } from '../../providers';
import type { Provider, ProviderEvent, StreamRequest } from '../../providers/types';
import { MessageStore } from '../../stores/message-store';
import { SessionStore } from '../../stores/session-store';
import { ToolRegistry } from '../../tools';
import { KoryManager } from '../manager';

beforeAll(async () => {
  await initDb();
});

const fixtures: Array<{ manager: KoryManager; root: string }> = [];
afterEach(async () => {
  for (const { manager, root } of fixtures.splice(0)) {
    await manager.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});

// Same shape as turn-transcript-parity.test.ts: a real manager with a scripted provider.
async function fixture(rounds: ProviderEvent[][]) {
  const root = mkdtempSync(join(tmpdir(), 'runtime-disposal-'));
  const sessions = new SessionStore();
  const messages = new MessageStore();
  const session = await sessions.create('local-user', 'Runtime disposal', undefined, root);
  await sessions.update(session.id, {
    agentOverrides: { criticMode: 'off', agentExecutionMode: 'single' },
  });
  const provider = { name: 'openai', config: {} } as Provider;
  const providers = {
    resolveProvider: async () => provider,
    getAvailable: () => [provider],
    getStatus: () => [],
    getConfigs: () => ({}),
    get: () => undefined,
    isQuotaError: () => false,
    executeWithRetry: async function* (_request: StreamRequest): AsyncGenerator<ProviderEvent> {
      yield* rounds.shift() ?? [];
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
  );
  const internal = manager as any;
  manager.resolveActiveRouting = () => ({ model: 'gpt-4o', provider: 'openai' });
  internal.resolveSessionWorkingDirectory = async () => root;
  tools.execute = mock(async () => ({
    callId: 'x',
    name: 'read_file',
    output: '',
    isError: false,
    durationMs: 0,
  }));
  fixtures.push({ manager, root });
  return { manager, internal, session };
}

async function runTurn(f: Awaited<ReturnType<typeof fixture>>, userMessage: string) {
  const admission = await f.manager.reserveSessionTurn(f.session.id, 'user_turn');
  await f.manager.dispatchAdmittedTask(admission!, {
    userMessage,
    preferredModel: 'openai:gpt-4o',
    interactionMode: 'act',
  });
}

describe('KoryManager session runtime disposal', () => {
  test('erasing a session after a turn drops its runtime and clears its heartbeat timer', async () => {
    const f = await fixture([[{ type: 'content_delta', content: 'Done.' }]]);
    await runTurn(f, 'Say done');
    const id = f.session.id;

    // A heartbeat is the timer the runtime owns; start one so the assertion has a handle.
    f.internal.startHeartbeat(id);
    const heartbeat = f.internal.runtimes.peek(id)?.heartbeat;
    expect(heartbeat).toBeDefined();

    const cleared: unknown[] = [];
    const realClearInterval = globalThis.clearInterval;
    globalThis.clearInterval = ((timer: unknown) => {
      cleared.push(timer);
      return realClearInterval(timer as Parameters<typeof clearInterval>[0]);
    }) as typeof clearInterval;
    try {
      const lease = f.manager.tryBeginSessionErasure(id);
      expect(lease).not.toBeNull();
      await lease!.waitForIdle(2_000);
      lease!.complete();
    } finally {
      globalThis.clearInterval = realClearInterval;
    }

    expect(f.internal.runtimes.peek(id)).toBeUndefined();
    expect(f.internal.runtimes.has(id)).toBe(false);
    expect(cleared).toContain(heartbeat);
  });
});
