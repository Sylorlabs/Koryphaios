import { afterEach, expect, mock, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KoryManager } from '../manager';
import { SessionStore } from '../../stores/session-store';
import { MessageStore } from '../../stores/message-store';
import { ToolRegistry } from '../../tools';
import { AskManagerTool, DelegateToWorkerTool, RequestCriticReviewTool } from '../../tools/interaction';
import { ManageReviewAgentsTool } from '../../tools/review-agents';
import type { Provider, StreamRequest, ProviderEvent } from '../../providers/types';
import type { ProviderRegistry } from '../../providers';
import type { KoryphaiosConfig } from '@koryphaios/shared';
import { resetSessionAgentOverridesCache } from '../../stores/session-agent-overrides';

const fixtures: Array<{ manager: KoryManager; root: string }> = [];
afterEach(async () => {
  resetSessionAgentOverridesCache();
  for (const fixture of fixtures.splice(0)) { await fixture.manager.shutdown(); rmSync(fixture.root, { recursive: true, force: true }); }
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture(mode: 'yolo' | 'guarded' | 'ask' = 'yolo') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'universal-critic-')));
  writeFileSync(join(root, 'koryphaios.json'), JSON.stringify({ agentSettings: { permissionMode: mode, criticMode: 'always', designDiscovery: false, intentInterview: 'off', maxCriticIterations: 2 } }));
  const sessions = new SessionStore();
  const messages = new MessageStore();
  const session = await sessions.create('local-user', 'Explain caching', undefined, root);
  const provider = { name: 'openai', config: {}, streamResponse: mock(async function* () {
    yield { type: 'content_delta', content: '{"allow":true,"reason":"Scoped verification"}' };
  }) } as unknown as Provider;
  const providers = {
    resolveProvider: async () => provider, getAvailable: () => [provider], getStatus: () => [],
    getConfigs: () => ({}), get: () => undefined, isQuotaError: () => false,
    executeWithRetry: mock(async function* (): AsyncGenerator<ProviderEvent> {
      yield { type: 'content_delta', content: 'A cache reuses previous results.' };
      yield { type: 'complete' };
    }),
  } as unknown as ProviderRegistry;
  const tools = new ToolRegistry();
  tools.register(new AskManagerTool());
  tools.register(new RequestCriticReviewTool());
  const manager = new KoryManager(providers, tools, root, {} as KoryphaiosConfig, sessions, messages);
  const internal = manager as any;
  manager.resolveActiveRouting = () => ({ model: 'producer', provider: 'openai' });
  internal.resolveSessionWorkingDirectory = async () => root;
  const events: Array<{ type: string; payload: any }> = [];
  internal.events.emit = (_id: string, type: string, payload: unknown) => events.push({ type, payload });
  fixtures.push({ manager, root });
  return { manager, internal, tools, sessions, messages, session, provider, providers, root, events };
}

async function reply(
  f: Awaited<ReturnType<typeof fixture>>,
  interactionMode: 'act' | 'plan' = 'act',
  userMessage = 'Explain caching',
) {
  const admission = await f.manager.reserveSessionTurn(f.session.id, 'user_turn');
  return f.manager.dispatchAdmittedTask(admission!, {
    userMessage, preferredModel: 'openai:producer', interactionMode,
  });
}

test.each(['act', 'plan'] as const)('holds a direct manager answer until Critic passes in %s', async (interactionMode) => {
  const f = await fixture();
  const entered = deferred();
  const release = deferred();
  const review = mock(async () => { entered.resolve(); await release.promise; return { passed: true }; });
  f.internal.runCriticGate = review;
  const turn = reply(f, interactionMode);
  await entered.promise;
  expect(f.events.filter((event) => event.type === 'stream.delta')).toHaveLength(0);
  expect((await f.messages.getAll(f.session.id)).filter((message) => message.role === 'assistant')).toHaveLength(0);
  release.resolve();
  await turn;
  expect(review).toHaveBeenCalledTimes(1);
  expect(f.events.filter((event) => event.type === 'stream.delta').map((event) => event.payload.content)).toEqual(['A cache reuses previous results.']);
});

test('repairs a rejected manager answer and reviews the new candidate before delivery', async () => {
  const f = await fixture();
  const review = mock(async () => review.mock.calls.length === 1
    ? { passed: false, feedback: 'Explain invalidation too.' } : { passed: true });
  f.internal.runCriticGate = review;
  let calls = 0;
  (f.providers as any).executeWithRetry = mock(async function* () {
    yield { type: 'content_delta', content: ++calls === 1 ? 'A cache stores results.' : 'A cache reuses results and invalidates them when inputs change.' };
  });
  await reply(f);
  expect(review).toHaveBeenCalledTimes(2);
  expect(f.events.filter((event) => event.type === 'stream.delta').map((event) => event.payload.content)).toEqual(['A cache reuses results and invalidates them when inputs change.']);
});

test('Critic Off releases the answer without review', async () => {
  const f = await fixture();
  await f.sessions.update(f.session.id, { agentOverrides: { criticGateEnabled: false } });
  const review = mock(async () => ({ passed: true }));
  f.internal.runCriticGate = review;
  await reply(f);
  expect(review).not.toHaveBeenCalled();
  expect(f.events.some((event) => event.type === 'stream.delta')).toBe(true);
});

test('Auto does not invoke Critic for a trivial readiness test message', async () => {
  const f = await fixture();
  await f.sessions.update(f.session.id, { agentOverrides: { criticMode: 'auto' } });
  const review = mock(async () => ({ passed: true }));
  f.internal.runCriticGate = review;
  await reply(f, 'act', 'test');
  expect(review).not.toHaveBeenCalled();
  expect(f.events.some((event) => event.type === 'system.info' && event.payload.message.includes('Critic Auto'))).toBe(false);
  expect(f.events.filter((event) => event.type === 'stream.delta').map((event) => event.payload.content)).toEqual(['A cache reuses previous results.']);
});

test('Auto asks the finishing manager and honors its chosen critic model', async () => {
  const f = await fixture();
  await f.sessions.update(f.session.id, { agentOverrides: { criticMode: 'auto' } });
  writeFileSync(join(f.root, 'koryphaios.json'), JSON.stringify({ agentSettings: {
    criticMode: 'auto', designDiscovery: false, intentInterview: 'off',
    managerModelAccess: { critic: ['openai:critic-a', 'openai:critic-b'] },
  } }));
  const review = mock(async (..._args: unknown[]) => ({ passed: true }));
  f.internal.runCriticGate = review;
  const decisions: StreamRequest[] = [];
  (f.provider as Provider).streamResponse = mock(async function* (request: StreamRequest) {
    decisions.push(request);
    yield { type: 'content_delta', content: JSON.stringify({ review: true, reason: 'Check the factual claim.', model: 'openai:critic-b' }) };
  });
  await reply(f);
  expect(decisions).toHaveLength(1);
  expect(decisions[0]?.model).toBe('producer');
  expect(decisions[0]?.tools).toEqual([]);
  expect(JSON.stringify(decisions[0]?.messages)).toContain('A cache reuses previous results.');
  expect(review).toHaveBeenCalledTimes(1);
  expect(review.mock.calls[0]?.[7]).toMatchObject({ autoDecisionMade: true, criticModel: 'openai:critic-b' });
});

 test('Auto asks a completed worker and declining skips review even with file evidence', async () => {
  const f = await fixture();
  await f.sessions.update(f.session.id, { agentOverrides: { criticMode: 'auto' } });
  const decisions: StreamRequest[] = [];
  f.provider.streamResponse = mock(async function* (request: StreamRequest) {
    decisions.push(request);
    yield { type: 'content_delta', content: '{"review":false,"reason":"Checks are sufficient."}' };
  });
  f.internal.resolveIndependentRouting = mock(() => { throw new Error('Declined review must not route a critic'); });
  const gate = await f.manager.runCriticGate(f.session.id,
    [{ role: 'assistant', content: 'Implemented caching and verified it.' }],
    'openai:builder', 'Implement caching', f.root, { provider: 'openai', model: 'builder' });
  expect(gate).toMatchObject({ passed: true, skipped: true });
  expect(decisions).toHaveLength(1);
  expect(decisions[0]?.model).toBe('builder');
  expect(f.events.some((event) => event.type === 'agent.spawned')).toBe(false);
});

 test('invalid Auto decision cannot silently launch a critic', async () => {
  const f = await fixture();
  await f.sessions.update(f.session.id, { agentOverrides: { criticMode: 'auto' } });
  f.provider.streamResponse = mock(async function* () {
    yield { type: 'content_delta', content: '{"review":"yes","model":"outside-pool"}' };
  });
  const review = mock(async () => ({ passed: true }));
  f.internal.runCriticGate = review;
  await reply(f);
  expect(review).not.toHaveBeenCalled();
  expect(f.events.some((event) => event.type === 'system.info' && event.payload.message.includes('decision unavailable'))).toBe(true);
});

test('Always still reviews while Auto is manager-selected', async () => {
  const f = await fixture();
  const review = mock(async () => ({ passed: true }));
  f.internal.runCriticGate = review;
  await reply(f);
  expect(review).toHaveBeenCalledTimes(1);
});

test('Auto does not review a completion claim by itself', async () => {
  const f = await fixture();
  await f.sessions.update(f.session.id, { agentOverrides: { criticMode: 'auto' } });
  (f.providers as any).executeWithRetry = mock(async function* () {
    yield { type: 'content_delta', content: 'I implemented caching. Tests passed.' };
  });
  const review = mock(async () => ({ passed: true }));
  f.internal.runCriticGate = review;
  await reply(f);
  expect(review).not.toHaveBeenCalled();
  expect(f.events.some((event) => event.type === 'system.info' && event.payload.message.includes('review required'))).toBe(false);
});

test('an eligible Critic review explains when no independent route can start', async () => {
  const f = await fixture();
  const result = await f.manager.runCriticGate(
    f.session.id,
    [{ role: 'assistant', content: 'Implemented caching.' }],
    'openai:producer',
    'Implement caching',
    f.root,
    { provider: 'openai', model: 'producer' },
  );

  expect(result.skipped).toBe(true);
  expect(f.events.some((event) =>
    event.type === 'system.info' &&
    event.payload.message.includes('Critic review unavailable') &&
    event.payload.message.includes('distinct Critic provider/model'),
  )).toBe(true);
});

test.each(['yolo', 'guarded', 'ask'] as const)('routes Critic action approval to the correct owner in %s', async (mode) => {
  const f = await fixture(mode);
  f.internal.waitForUserInputInternal = mock(async () => 'Allow once');
  f.internal.managerRoutingBySession.set(f.session.id, { provider: 'openai', model: 'producer' });
  const approved = await f.internal.approveCriticAction(f.session.id, 'critic-test', 'Explain caching',
    { id: 'action', name: 'bash', input: { command: 'bun test' } }, 'Verify behavior', new AbortController().signal);
  expect(approved).toBe(true);
  expect(f.internal.waitForUserInputInternal.mock.calls.length).toBe(mode === 'ask' ? 1 : 0);
  expect((f.provider.streamResponse as any).mock.calls.length).toBe(mode === 'ask' ? 0 : 1);
  if (mode !== 'ask') {
    const request = (f.provider.streamResponse as any).mock.calls[0][0] as StreamRequest;
    expect(request.tools).toEqual([]);
    expect(request.forceFreshConversation).toBe(true);
  }
});

test('universal Critic executes approved experiments and manages specialists in isolated copies', async () => {
  const f = await fixture();
  writeFileSync(join(f.root, 'implementation.txt'), 'producer');
  f.tools.register(new DelegateToWorkerTool());
  f.tools.register(new ManageReviewAgentsTool());
  const commandRoots: string[] = [];
  f.tools.register({
    name: 'bash', description: 'Verification command fixture', inputSchema: {},
    run: async (ctx, call) => {
      commandRoots.push(ctx.workingDirectory);
      expect(ctx.approvedToolCallIds?.has(call.id)).toBe(true);
      expect(ctx.requiredWorkspaceRoot).toBe(ctx.workingDirectory);
      writeFileSync(join(ctx.workingDirectory, 'implementation.txt'), 'red-team experiment');
      return { callId: call.id, name: call.name, output: 'Boundary checks passed', isError: false, durationMs: 1 };
    },
  });
  f.internal.resolveIndependentRouting = (_model: string, _provider: string, domain: string) => ({
    model: domain === 'critic' ? 'critic' : 'specialist', provider: 'openai',
  });
  const reviewRoots: string[] = [];
  const criticRequests: StreamRequest[] = [];
  let reviewRound = 0;
  let specialistTurns = 0;
  const emitCall = function* (name: string, input: object): Generator<ProviderEvent> {
    const toolCallId = crypto.randomUUID();
    yield { type: 'tool_use_start', toolCallId, toolName: name };
    yield { type: 'tool_use_delta', toolCallId, toolInput: JSON.stringify(input) };
    yield { type: 'tool_use_stop', toolCallId };
  };
  (f.providers as any).executeWithRetry = mock(async function* (request: StreamRequest) {
    if (request.model === 'producer') {
      yield { type: 'content_delta', content: 'Caching avoids redundant computation.' };
      return;
    }
    reviewRoots.push(request.workingDirectory!);
    if (request.model === 'critic') criticRequests.push(request);
    if (request.model === 'specialist') {
      specialistTurns++;
      yield { type: 'content_delta', content: 'Inspected implementation and independently checked invalidation behavior.' };
      return;
    }
    if (reviewRound++ === 0) { yield* emitCall('bash', { command: 'verify' }); return; }
    if (reviewRound === 2) { yield* emitCall('delegate_to_worker', { task: 'Verify cache invalidation', domain: 'test' }); return; }
    if (reviewRound === 3) { yield* emitCall('manage_review_agents', { action: 'list' }); return; }
    if (reviewRound === 4) {
      const receipt = request.messages.filter((message) => message.role === 'tool')
        .map((message) => JSON.parse(String(message.content)))
        .find((result) => result.name === 'delegate_to_worker');
      const child = JSON.parse(receipt.output);
      yield* emitCall('manage_review_agents', { action: 'message', agentId: child.agentId, message: 'Also inspect empty cache behavior' });
      return;
    }
    yield { type: 'content_delta', content: JSON.stringify({
      verdict: 'PASS', findings: [], checksReviewed: ['Actual response, verification command and specialist evidence'],
      unmetCriteria: [], skillReviews: [], verifierAssessment: { status: 'supported', evidence: 'Checks and direct inspection support the claims' },
    }) };
  });
  await reply(f);
  expect(commandRoots).toHaveLength(1);
  expect(commandRoots[0]).not.toBe(f.root);
  expect(readFileSync(join(f.root, 'implementation.txt'), 'utf8')).toBe('producer');
  expect(specialistTurns).toBe(2);
  expect(new Set(reviewRoots).size).toBe(2);
  expect(reviewRoots.every((root) => !existsSync(root))).toBe(true);
  expect(criticRequests[0]).toMatchObject({
    interactionMode: 'act',
    harnessRole: 'critic',
  });
  expect(criticRequests[0]?.permissionMode).not.toBe('plan');
  expect(f.events.some((event) => event.type === 'stream.tool_call' && event.payload.toolCall.name === 'critic_review')).toBe(true);
  expect(f.events.filter((event) => event.type === 'stream.delta' && event.payload.agentId === 'kory-manager').map((event) => event.payload.content)).toEqual(['Caching avoids redundant computation.']);
});

test('a failing deterministic check cannot be overridden by a Critic PASS', async () => {
  const f = await fixture();
  writeFileSync(join(f.root, 'package.json'), JSON.stringify({ scripts: { test: 'exit 1' } }));
  f.tools.register({ name: 'bash', description: '', inputSchema: {}, run: async (_ctx, call) => ({
    callId: call.id, name: call.name, output: 'A regression failed', isError: true, durationMs: 1,
  }) });
  f.internal.resolveIndependentRouting = () => ({ model: 'critic', provider: 'openai' });
  (f.providers as any).executeWithRetry = mock(async function* () {
    yield { type: 'content_delta', content: JSON.stringify({ verdict: 'PASS', findings: [], checksReviewed: ['test'], unmetCriteria: [], skillReviews: [], verifierAssessment: { status: 'supported', evidence: 'Inspection' } }) };
  });
  const gate = await f.manager.runCriticGate(f.session.id, [{ role: 'assistant', content: 'Implemented cache' }],
    'openai:producer', 'Implement cache', f.root, { provider: 'openai', model: 'producer' });
  expect(gate.passed).toBe(false);
  expect(gate.feedback).toContain('Hard checks failed');
  expect(f.events.some((event) => event.type === 'stream.tool_result' && event.payload.toolResult.name === 'bash' && event.payload.toolResult.isError)).toBe(true);
});

test('preserves Critic errors and partial output when the provider fails after streaming', async () => {
  const f = await fixture();
  f.internal.resolveIndependentRouting = () => ({ model: 'critic', provider: 'openai' });
  (f.providers as any).executeWithRetry = mock(async function* (request: StreamRequest) {
    if (request.model === 'critic') {
      yield { type: 'content_delta', content: '{"verdict":"PASS","findings":[]' };
      yield { type: 'error', error: 'upstream stream closed after response bytes' };
      return;
    }
    yield { type: 'content_delta', content: 'Producer response.' };
  });

  const result = await f.manager.runCriticGate(
    f.session.id,
    [{ role: 'assistant', content: 'Producer response.' }],
    'openai:producer',
    'Review producer response',
    f.root,
    { provider: 'openai', model: 'producer' },
  );

  expect(result.passed).toBe(false);
  expect(result.feedback).toContain('upstream stream closed after response bytes');
  expect(result.feedback).toContain('Partial critic output');
  const toolResult = f.events.find(
    (event) => event.type === 'stream.tool_result' && event.payload.toolResult.name === 'critic_review',
  );
  expect(toolResult?.payload.toolResult.criticOutcome).toBe('run_failed_after_output');
  expect(toolResult?.payload.toolResult.output).toContain('Partial critic output');
});

test('stopping a held manager response does not publish or persist an unreviewed answer', async () => {
  const f = await fixture();
  const entered = deferred();
  const release = deferred();
  f.internal.runCriticGate = mock(async () => { entered.resolve(); await release.promise; return { passed: true }; });
  const turn = reply(f);
  await entered.promise;
  f.manager.abortManagerRun(f.session.id);
  release.resolve();
  await turn;
  expect(f.events.filter((event) => event.type === 'stream.delta')).toHaveLength(0);
  expect((await f.messages.getAll(f.session.id)).filter((message) => message.role === 'assistant')).toHaveLength(0);
});
