import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  reduceTurnEvents,
  turnEventFromWSMessage,
  type TranscriptPart,
  type WSMessage,
  type KoryphaiosConfig,
} from '@koryphaios/shared';
import { wsBroker } from '../../pubsub';
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

const MANAGER_AGENT = 'kory-manager';
const fixtures: Array<{ manager: KoryManager; root: string }> = [];
afterEach(async () => {
  for (const { manager, root } of fixtures.splice(0)) {
    await manager.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * A real manager with a scripted provider. Nothing in the emit path is stubbed:
 * events go through EventEmitterService, the recorder and wsBroker.publish.
 */
async function fixture(rounds: ProviderEvent[][], seed?: (args: { messages: MessageStore; sessionId: string }) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'turn-parity-'));
  const sessions = new SessionStore();
  const messages = new MessageStore();
  const session = await sessions.create('local-user', 'Turn parity', undefined, root);
  await sessions.update(session.id, { agentOverrides: { criticMode: 'off', agentExecutionMode: 'single' } });
  if (seed) await seed({ messages, sessionId: session.id });
  const requests: StreamRequest[] = [];
  const provider = { name: 'openai', config: {} } as Provider;
  const providers = {
    resolveProvider: async () => provider,
    getAvailable: () => [provider], getStatus: () => [], getConfigs: () => ({}),
    get: () => undefined, isQuotaError: () => false,
    executeWithRetry: async function* (request: StreamRequest): AsyncGenerator<ProviderEvent> {
      requests.push(structuredClone({ ...request, signal: undefined }));
      yield* rounds.shift() ?? [];
    },
  } as unknown as ProviderRegistry;
  const tools = new ToolRegistry();
  const manager = new KoryManager(providers, tools, root, {} as KoryphaiosConfig, sessions, messages);
  const internal = manager as any;
  manager.resolveActiveRouting = () => ({ model: 'gpt-4o', provider: 'openai' });
  internal.resolveSessionWorkingDirectory = async () => root;
  const toolResult = { callId: 'read', name: 'read_file', output: 'file contents', isError: false, durationMs: 0 };
  internal.executeManagerToolCall = mock(async () => toolResult);
  internal.executeToolCall = mock(async () => toolResult);
  tools.execute = mock(async () => toolResult);
  fixtures.push({ manager, root });
  return { manager, session, messages, requests };
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

const toolRound: ProviderEvent[] = [
  { type: 'thinking_delta', thinking: '  Need\n' },
  { type: 'thinking_delta', thinking: 'a file.\t' },
  { type: 'tool_use_start', toolCallId: 'read', toolName: 'read_file' },
  { type: 'tool_use_delta', toolCallId: 'read', toolInput: '{"path":"a.ts"}' },
  { type: 'tool_use_stop', toolCallId: 'read' },
];
const answerRound: ProviderEvent[] = [
  { type: 'thinking_delta', thinking: '\nHave the evidence.  ' },
  { type: 'content_delta', content: 'The answer.' },
];

async function runTurn(f: Awaited<ReturnType<typeof fixture>>, userMessage: string) {
  const admission = await f.manager.reserveSessionTurn(f.session.id, 'user_turn');
  await f.manager.dispatchAdmittedTask(admission!, { userMessage, preferredModel: 'openai:gpt-4o', interactionMode: 'act' });
}

describe('manager turn transcript parity', () => {
  test('live events, persisted message id and persisted parts agree for reasoning -> tool -> reasoning -> text', async () => {
    const f = await fixture([toolRound, answerRound]);
    const { published } = await captureBroker(() => runTurn(f, 'Inspect the file'));

    const managerStream = published.filter(
      (m) => m.type.startsWith('stream.') && (m.payload as { agentId?: string }).agentId === MANAGER_AGENT,
    );
    expect(managerStream.length).toBeGreaterThan(0);

    const ids = new Set(managerStream.map((m) => (m.payload as { messageId?: string }).messageId));
    expect(ids.size).toBe(1);
    const [turnId] = [...ids];
    expect(typeof turnId).toBe('string');

    const persisted = (await f.messages.getContextMessages(f.session.id)).find(
      (m) => m.role === 'assistant',
    );
    expect(persisted?.id).toBe(turnId);

    const expected = reduceTurnEvents(
      managerStream
        .map((m) => turnEventFromWSMessage({ type: m.type, payload: m.payload, timestamp: m.timestamp }))
        .filter((e): e is NonNullable<typeof e> => e !== null),
    );
    expect(expected.map((p) => p.kind)).toEqual(['reasoning', 'tool', 'reasoning', 'text']);
    expect(persisted?.parts).toEqual(expected);
    expect(persisted?.content).toBe('The answer.');
    expect(persisted?.reasoningContent).toBe('\nHave the evidence.  ');
  });

  test('a stored message with parts sends the same provider messages as one without', async () => {
    const nonce = `${Date.now()}-${Math.random()}`;
    const legacyTurn = { role: 'assistant' as const, content: 'Earlier answer', reasoningContent: 'Earlier why', createdAt: 2 };
    const withoutParts = await fixture([[{ type: 'content_delta', content: 'Next.' }]], async ({ messages, sessionId }) => {
      await messages.add(sessionId, { id: `q0-a-${nonce}`, sessionId, role: 'user', content: 'Earlier question', createdAt: 1 });
      await messages.add(sessionId, { ...legacyTurn, id: `prev-a-${nonce}`, sessionId });
    });
    const withParts = await fixture([[{ type: 'content_delta', content: 'Next.' }]], async ({ messages, sessionId }) => {
      await messages.add(sessionId, { id: `q0-b-${nonce}`, sessionId, role: 'user', content: 'Earlier question', createdAt: 1 });
      await messages.add(sessionId, {
        ...legacyTurn,
        id: `prev-b-${nonce}`,
        sessionId,
        parts: [
          { kind: 'reasoning', text: 'Earlier why', startedAt: 2, endedAt: 2 },
          { kind: 'tool', callId: 'x', name: 'read_file', input: {}, startedAt: 2, output: 'o', endedAt: 2 },
          { kind: 'text', text: 'Earlier answer', startedAt: 2 },
        ] satisfies TranscriptPart[],
      });
    });
    await runTurn(withoutParts, 'Follow up');
    await runTurn(withParts, 'Follow up');
    expect(withParts.requests[0].messages).toEqual(withoutParts.requests[0].messages);
    expect(withParts.requests[0].messages.find((m) => m.role === 'assistant')).toMatchObject({
      content: 'Earlier answer', reasoningContent: 'Earlier why',
    });
  });
});
