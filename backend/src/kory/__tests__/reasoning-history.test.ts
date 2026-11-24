import { afterEach, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { KoryphaiosConfig } from '@koryphaios/shared';
import { db, messages as messageRows } from '../../db';
import type { ProviderRegistry } from '../../providers';
import type { Provider, ProviderEvent, StreamRequest } from '../../providers/types';
import { MessageStore } from '../../stores/message-store';
import { SessionStore } from '../../stores/session-store';
import { ToolRegistry } from '../../tools';
import { KoryManager } from '../manager';

const fixtures: Array<{ manager: KoryManager; root: string }> = [];
afterEach(async () => {
  for (const { manager, root } of fixtures.splice(0)) {
    await manager.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});

async function fixture(rounds: ProviderEvent[][]) {
  const root = mkdtempSync(join(tmpdir(), 'reasoning-history-'));
  const sessions = new SessionStore();
  const messages = new MessageStore();
  const session = await sessions.create('local-user', 'Reasoning history', undefined, root);
  await sessions.update(session.id, {
    agentOverrides: { criticMode: 'off', agentExecutionMode: 'single' },
  });
  const requests: StreamRequest[] = [];
  const provider = { name: 'openai', config: {} } as Provider;
  const providers = {
    resolveProvider: async () => provider,
    getAvailable: () => [provider],
    getStatus: () => [],
    getConfigs: () => ({}),
    get: () => undefined,
    isQuotaError: () => false,
    executeWithRetry: async function* (request: StreamRequest): AsyncGenerator<ProviderEvent> {
      requests.push(structuredClone({ ...request, signal: undefined }));
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
  internal.events.emit = () => {};
  const toolResult = {
    callId: 'read',
    name: 'read_file',
    output: 'file contents',
    isError: false,
    durationMs: 0,
  };
  internal.executeManagerToolCall = mock(async () => toolResult);
  internal.executeToolCall = mock(async () => toolResult);
  tools.execute = mock(async () => toolResult);
  fixtures.push({ manager, root });
  return { manager, internal, messages, session, provider, requests, root };
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

test('manager carries tool-turn reasoning, persists final reasoning, and reloads it on the next user turn', async () => {
  const f = await fixture([
    toolRound,
    answerRound,
    [{ type: 'content_delta', content: 'Another answer.' }],
  ]);
  const reply = async (userMessage: string) => {
    const admission = await f.manager.reserveSessionTurn(f.session.id, 'user_turn');
    await f.manager.dispatchAdmittedTask(admission!, {
      userMessage,
      preferredModel: 'openai:gpt-4o',
      interactionMode: 'act',
    });
  };
  await reply('Inspect the file');
  expect(f.requests).toHaveLength(2);
  expect(f.requests[1].messages.find((m) => m.role === 'assistant')).toMatchObject({
    content: '',
    reasoningContent: '  Need\na file.\t',
    tool_calls: [{ id: 'read', name: 'read_file', input: { path: 'a.ts' } }],
  });
  expect(f.requests[1].messages.find((m) => m.role === 'tool')?.tool_call_id).toBe('read');
  const stored = (await new MessageStore().getContextMessages(f.session.id)).find(
    (m) => m.role === 'assistant',
  );
  expect(stored).toMatchObject({
    content: 'The answer.',
    reasoningContent: '\nHave the evidence.  ',
  });
  await reply('Follow up');
  expect(f.requests[2].messages.find((m) => m.role === 'assistant')).toMatchObject({
    content: 'The answer.',
    reasoningContent: '\nHave the evidence.  ',
  });
  const assistants = (await f.messages.getContextMessages(f.session.id)).filter(
    (m) => m.role === 'assistant',
  );
  expect(assistants.at(-1)?.reasoningContent).toBeUndefined();
});

test.each(['worker', 'critic'])(
  '%s carries per-message reasoning across tool rounds and followups',
  async (toolRole) => {
    const f = await fixture([
      toolRound,
      answerRound,
      [{ type: 'content_delta', content: 'No reasoning.' }],
    ]);
    const thread = {
      sessionId: f.session.id,
      identity: { id: 'agent' },
      toolRole,
      modelId: 'gpt-4o',
      systemPrompt: 'Test',
      messages: [{ role: 'user', content: 'Inspect' }],
      threadEntries: [],
      ctx: { workingDirectory: f.root },
      maxTokens: 100,
    };
    expect(await f.internal.processAgentThreadTurn(thread, f.provider)).toBe(true);
    expect(await f.internal.processAgentThreadTurn(thread, f.provider)).toBe(false);
    expect(f.requests[1].messages.find((m) => m.role === 'assistant')).toMatchObject({
      content: '',
      reasoningContent: '  Need\na file.\t',
      tool_calls: [{ id: 'read', name: 'read_file', input: { path: 'a.ts' } }],
    });
    thread.messages.push({ role: 'user', content: 'Follow up' });
    await f.internal.processAgentThreadTurn(thread, f.provider);
    expect(
      f.requests[2].messages.filter((m) => m.role === 'assistant').map((m) => m.reasoningContent),
    ).toEqual(['  Need\na file.\t', '\nHave the evidence.  ']);
    expect(f.internal.toProviderMessages(thread.messages).at(-1).reasoningContent).toBeUndefined();
  },
);

test('loads existing thinking blocks verbatim at normal and regeneration boundaries without inventing missing reasoning', async () => {
  const f = await fixture([]);
  await f.messages.add(f.session.id, {
    id: 'old-answer',
    sessionId: f.session.id,
    role: 'assistant',
    content: 'Old answer',
    createdAt: 1,
  });
  await db
    .update(messageRows)
    .set({
      content: JSON.stringify([
        { type: 'thinking', thinking: ' \nfirst' },
        { type: 'thinking', thinking: '\tsecond  ' },
        { type: 'text', text: 'Old answer' },
      ]),
    })
    .where(eq(messageRows.id, 'old-answer'));
  await f.messages.add(f.session.id, {
    id: 'missing-reasoning',
    sessionId: f.session.id,
    role: 'assistant',
    content: 'Imported answer',
    createdAt: 2,
  });
  const history = f.internal.toProviderMessages(await f.internal.loadHistory(f.session.id));
  expect(history.map((m: { reasoningContent?: string }) => m.reasoningContent)).toEqual([
    ' \nfirst\tsecond  ',
    undefined,
  ]);
  const boundary = await f.internal.loadHistory(f.session.id, 'old-answer');
  expect(boundary).toHaveLength(1);
  expect(boundary[0].reasoningContent).toBe(' \nfirst\tsecond  ');
});
