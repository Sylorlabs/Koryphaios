import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KoryManager } from '../manager';
import { SessionStore } from '../../stores/session-store';
import { MessageStore } from '../../stores/message-store';
import { ToolRegistry } from '../../tools';
import {
  AskManagerTool,
  DelegateToWorkerTool,
  RequestCriticReviewTool,
} from '../../tools/interaction';
import { ManageReviewAgentsTool } from '../../tools/review-agents';
import type { Provider, StreamRequest, ProviderEvent } from '../../providers/types';
import type { ProviderRegistry } from '../../providers';
import type { KoryphaiosConfig } from '@koryphaios/shared';
import { resetSessionAgentOverridesCache } from '../../stores/session-agent-overrides';

const fixtures: Array<{ manager: KoryManager; root: string }> = [];
afterEach(async () => {
  resetSessionAgentOverridesCache();
  for (const fixture of fixtures.splice(0)) {
    await fixture.manager.shutdown();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture(mode: 'yolo' | 'guarded' | 'ask' = 'yolo') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'universal-critic-')));
  writeFileSync(
    join(root, 'koryphaios.json'),
    JSON.stringify({
      agentSettings: {
        permissionMode: mode,
        criticMode: 'always',
        designDiscovery: false,
        intentInterview: 'off',
        maxCriticIterations: 2,
      },
    }),
  );
  const sessions = new SessionStore();
  const messages = new MessageStore();
  const session = await sessions.create('local-user', 'Explain caching', undefined, root);
  const provider = {
    name: 'openai',
    config: {},
    streamResponse: mock(async function* () {
      yield { type: 'content_delta', content: '{"allow":true,"reason":"Scoped verification"}' };
    }),
  } as unknown as Provider;
  const providers = {
    resolveProvider: async () => provider,
    getAvailable: () => [provider],
    getStatus: () => [],
    getConfigs: () => ({}),
    get: () => undefined,
    isQuotaError: () => false,
    executeWithRetry: mock(async function* (): AsyncGenerator<ProviderEvent> {
      yield { type: 'content_delta', content: 'A cache reuses previous results.' };
      yield { type: 'complete' };
    }),
  } as unknown as ProviderRegistry;
  const tools = new ToolRegistry();
  tools.register(new AskManagerTool());
  tools.register(new RequestCriticReviewTool());
  const manager = new KoryManager(
    providers,
    tools,
    root,
    {} as KoryphaiosConfig,
    sessions,
    messages,
  );
  const internal = manager as any;
  manager.resolveActiveRouting = () => ({ model: 'producer', provider: 'openai' });
  internal.resolveSessionWorkingDirectory = async () => root;
  const events: Array<{ type: string; payload: any }> = [];
  internal.events.emit = (_id: string, type: string, payload: unknown) =>
    events.push({ type, payload });
  fixtures.push({ manager, root });
  return {
    manager,
    internal,
    tools,
    sessions,
    messages,
    session,
    provider,
    providers,
    root,
    events,
  };
}

async function reply(
  f: Awaited<ReturnType<typeof fixture>>,
  interactionMode: 'act' | 'plan' = 'act',
  userMessage = 'Explain caching',
) {
  const admission = await f.manager.reserveSessionTurn(f.session.id, 'user_turn');
  return f.manager.dispatchAdmittedTask(admission!, {
    userMessage,
    preferredModel: 'openai:producer',
    interactionMode,
  });
}

test.each(['act', 'plan'] as const)(
  'holds a direct manager answer until Critic passes in %s',
  async (interactionMode) => {
    const f = await fixture();
    const entered = deferred();
    const release = deferred();
    const review = mock(async () => {
      entered.resolve();
      await release.promise;
      return { passed: true };
    });
    f.internal.runCriticGate = review;
    const turn = reply(f, interactionMode);
    await entered.promise;
    expect(f.events.filter((event) => event.type === 'stream.delta')).toHaveLength(0);
    expect(
      (await f.messages.getAll(f.session.id)).filter((message) => message.role === 'assistant'),
    ).toHaveLength(0);
    release.resolve();
    await turn;
    expect(review).toHaveBeenCalledTimes(1);
    expect(
      f.events
        .filter((event) => event.type === 'stream.delta')
        .map((event) => event.payload.content),
    ).toEqual(['A cache reuses previous results.']);
  },
);

test('repairs a rejected manager answer and reviews the new candidate before delivery', async () => {
  const f = await fixture();
  const review = mock(async () =>
    review.mock.calls.length === 1
      ? { passed: false, feedback: 'Explain invalidation too.' }
      : { passed: true },
  );
  f.internal.runCriticGate = review;
  let calls = 0;
  (f.providers as any).executeWithRetry = mock(async function* () {
    yield {
      type: 'content_delta',
      content:
        ++calls === 1
          ? 'A cache stores results.'
          : 'A cache reuses results and invalidates them when inputs change.',
    };
  });
  await reply(f);
  expect(review).toHaveBeenCalledTimes(2);
  expect(
    f.events.filter((event) => event.type === 'stream.delta').map((event) => event.payload.content),
  ).toEqual(['A cache reuses results and invalidates them when inputs change.']);
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

test('Auto asks the agent even for a readiness message and honors its decline', async () => {
  const f = await fixture();
  await f.sessions.update(f.session.id, { agentOverrides: { criticMode: 'auto' } });
  const review = mock(async () => ({ passed: true }));
  f.internal.runCriticGate = review;
  const decisions: StreamRequest[] = [];
  f.provider.streamResponse = mock(async function* (request: StreamRequest) {
    decisions.push(request);
    yield { type: 'content_delta', content: '{"review":false,"reason":"Nothing to verify."}' };
  });
  await reply(f, 'act', 'test');
  expect(decisions).toHaveLength(1);
  expect(review).not.toHaveBeenCalled();
  expect(
    f.events.some(
      (event) =>
        event.type === 'system.info' &&
        event.payload.message.includes('Critic Auto · review required'),
    ),
  ).toBe(false);
  expect(
    f.events.filter((event) => event.type === 'stream.delta').map((event) => event.payload.content),
  ).toEqual(['A cache reuses previous results.']);
});

test('Auto retries an invalid decision with a correction and honors the follow-up choice', async () => {
  const f = await fixture();
  await f.sessions.update(f.session.id, { agentOverrides: { criticMode: 'auto' } });
  writeFileSync(
    join(f.root, 'koryphaios.json'),
    JSON.stringify({
      agentSettings: {
        criticMode: 'auto',
        designDiscovery: false,
        intentInterview: 'off',
        managerModelAccess: { critic: ['openai:critic-a', 'openai:critic-b'] },
      },
    }),
  );
  const review = mock(async (..._args: unknown[]) => ({ passed: true }));
  f.internal.runCriticGate = review;
  const decisions: StreamRequest[] = [];
  f.provider.streamResponse = mock(async function* (request: StreamRequest) {
    decisions.push(request);
    yield {
      type: 'content_delta',
      content:
        decisions.length === 1
          ? 'not json at all'
          : JSON.stringify({
              review: true,
              reason: 'Needs a second look.',
              model: 'openai:critic-b',
            }),
    };
  });
  await reply(f);
  expect(decisions).toHaveLength(2);
  const retryMessages = decisions[1]!.messages;
  expect(retryMessages.at(-1)).toMatchObject({ role: 'user' });
  expect(String(retryMessages.at(-1)?.content)).toContain('Your previous reply was invalid');
  expect(retryMessages.at(-2)).toMatchObject({ role: 'assistant', content: 'not json at all' });
  expect(review).toHaveBeenCalledTimes(1);
  expect(review.mock.calls[0]?.[7]).toMatchObject({ criticModel: 'openai:critic-b' });
});

test('Auto gives up deciding after three invalid replies and runs no review', async () => {
  const f = await fixture();
  await f.sessions.update(f.session.id, { agentOverrides: { criticMode: 'auto' } });
  const review = mock(async () => ({ passed: true }));
  f.internal.runCriticGate = review;
  const decisions: StreamRequest[] = [];
  f.provider.streamResponse = mock(async function* (request: StreamRequest) {
    decisions.push(request);
    yield { type: 'content_delta', content: 'this is not the decision schema' };
  });
  await reply(f);
  expect(decisions).toHaveLength(3);
  expect(review).not.toHaveBeenCalled();
  expect(
    f.events.some(
      (event) =>
        event.type === 'system.info' &&
        event.payload.message.includes('decision unavailable after 3 attempts'),
    ),
  ).toBe(true);
  expect(
    f.events.filter((event) => event.type === 'stream.delta').map((event) => event.payload.content),
  ).toEqual(['A cache reuses previous results.']);
});

test('Auto asks the session manager when the producer provider cannot be asked', async () => {
  const f = await fixture();
  await f.sessions.update(f.session.id, { agentOverrides: { criticMode: 'auto' } });
  f.internal.runtimes.get(f.session.id).managerRouting = {
    provider: 'anthropic',
    model: 'manager-model',
  };
  // The producer's provider is missing from the available list; only the
  // manager's provider can answer a decision request.
  f.providers.getAvailable = () => [{ name: 'anthropic' } as Provider];
  const decisions: StreamRequest[] = [];
  f.provider.streamResponse = mock(async function* (request: StreamRequest) {
    decisions.push(request);
    yield { type: 'content_delta', content: '{"review":false,"reason":"Manager declines."}' };
  });
  const gate = await f.manager.runCriticGate(
    f.session.id,
    [{ role: 'assistant', content: 'Implemented caching.' }],
    'openai:producer',
    'Implement caching',
    f.root,
    { provider: 'openai', model: 'producer' },
  );
  expect(gate).toMatchObject({ passed: true, skipped: true });
  expect(decisions).toHaveLength(1);
  expect(decisions[0]?.model).toBe('manager-model');
});

test('Auto runs no review when neither producer nor manager can be asked', async () => {
  const f = await fixture();
  await f.sessions.update(f.session.id, { agentOverrides: { criticMode: 'auto' } });
  f.providers.getAvailable = () => [];
  const decisions: StreamRequest[] = [];
  f.provider.streamResponse = mock(async function* (request: StreamRequest) {
    decisions.push(request);
    yield { type: 'content_delta', content: '{"review":false,"reason":"x"}' };
  });
  const gate = await f.manager.runCriticGate(
    f.session.id,
    [{ role: 'assistant', content: 'Implemented caching.' }],
    'openai:producer',
    'Implement caching',
    f.root,
    { provider: 'openai', model: 'producer' },
  );
  expect(gate).toMatchObject({ passed: true, skipped: true });
  expect(decisions).toHaveLength(0);
  expect(f.events.some((event) => event.type === 'agent.spawned')).toBe(false);
  expect(
    f.events.some(
      (event) =>
        event.type === 'system.info' &&
        event.payload.message.includes('no agent is available to decide'),
    ),
  ).toBe(true);
});

test('Always retries a crashed Critic on another route and passes', async () => {
  const f = await fixture();
  writeFileSync(
    join(f.root, 'koryphaios.json'),
    JSON.stringify({
      agentSettings: {
        criticMode: 'always',
        designDiscovery: false,
        intentInterview: 'off',
        managerModelAccess: { critic: ['openai:critic-a', 'openai:critic-b'] },
      },
    }),
  );
  const attempted: string[] = [];
  (f.providers as any).executeWithRetry = mock(async function* (request: StreamRequest) {
    if (attempted.push(request.model) === 1) {
      yield { type: 'error', error: 'critic provider exploded' };
      return;
    }
    yield {
      type: 'content_delta',
      content: JSON.stringify({
        verdict: 'PASS',
        findings: [],
        checksReviewed: ['inspection'],
        unmetCriteria: [],
        skillReviews: [],
        verifierAssessment: { status: 'supported', evidence: 'Looks right' },
      }),
    };
  });
  const gate = await f.manager.runCriticGate(
    f.session.id,
    [{ role: 'assistant', content: 'Explained caching.' }],
    'openai:producer',
    'Explain caching',
    f.root,
    { provider: 'openai', model: 'producer' },
  );
  expect(gate.passed).toBe(true);
  expect(attempted).toHaveLength(2);
  expect(attempted[0]).not.toBe(attempted[1]);
  expect(
    f.internal.runtimes.peek(f.session.id)?.failedCriticRoutes.has(`openai:${attempted[0]}`),
  ).toBe(true);
  expect(
    f.events.some(
      (event) =>
        event.type === 'system.info' &&
        event.payload.message.includes('Retrying with another Critic'),
    ),
  ).toBe(true);
});

test('a malformed Critic report is retried on another route', async () => {
  const f = await fixture();
  writeFileSync(
    join(f.root, 'koryphaios.json'),
    JSON.stringify({
      agentSettings: {
        criticMode: 'always',
        designDiscovery: false,
        intentInterview: 'off',
        managerModelAccess: { critic: ['openai:critic-a', 'openai:critic-b'] },
      },
    }),
  );
  const attempted: string[] = [];
  (f.providers as any).executeWithRetry = mock(async function* (request: StreamRequest) {
    if (attempted.push(request.model) === 1) {
      yield { type: 'content_delta', content: 'I inspected it and it looked fine to me.' };
      return;
    }
    yield {
      type: 'content_delta',
      content: JSON.stringify({
        verdict: 'PASS',
        findings: [],
        checksReviewed: ['inspection'],
        unmetCriteria: [],
        skillReviews: [],
        verifierAssessment: { status: 'supported', evidence: 'Looks right' },
      }),
    };
  });
  const gate = await f.manager.runCriticGate(
    f.session.id,
    [{ role: 'assistant', content: 'Explained caching.' }],
    'openai:producer',
    'Explain caching',
    f.root,
    { provider: 'openai', model: 'producer' },
  );
  expect(gate.passed).toBe(true);
  expect(attempted).toHaveLength(2);
  expect(
    f.events.some(
      (event) => event.type === 'system.info' && event.payload.message.includes('malformed report'),
    ),
  ).toBe(true);
});

test('Auto re-asks the deciding agent with the failed route excluded and reports it', async () => {
  const f = await fixture();
  await f.sessions.update(f.session.id, { agentOverrides: { criticMode: 'auto' } });
  writeFileSync(
    join(f.root, 'koryphaios.json'),
    JSON.stringify({
      agentSettings: {
        criticMode: 'auto',
        designDiscovery: false,
        intentInterview: 'off',
        managerModelAccess: { critic: ['openai:critic-a', 'openai:critic-b'] },
      },
    }),
  );
  const attempted: string[] = [];
  (f.providers as any).executeWithRetry = mock(async function* (request: StreamRequest) {
    if (request.model === 'critic-a') {
      attempted.push(request.model);
      yield { type: 'error', error: 'critic-a exploded' };
      return;
    }
    attempted.push(request.model);
    yield {
      type: 'content_delta',
      content: JSON.stringify({
        verdict: 'PASS',
        findings: [],
        checksReviewed: ['inspection'],
        unmetCriteria: [],
        skillReviews: [],
        verifierAssessment: { status: 'supported', evidence: 'Looks right' },
      }),
    };
  });
  const decisions: StreamRequest[] = [];
  f.provider.streamResponse = mock(async function* (request: StreamRequest) {
    decisions.push(request);
    yield {
      type: 'content_delta',
      content: JSON.stringify(
        decisions.length === 1
          ? { review: true, reason: 'Verify it.', model: 'openai:critic-a' }
          : { review: true, reason: 'Try another route.', model: 'openai:critic-b' },
      ),
    };
  });
  const gate = await f.manager.runCriticGate(
    f.session.id,
    [{ role: 'assistant', content: 'Explained caching.' }],
    'openai:producer',
    'Explain caching',
    f.root,
    { provider: 'openai', model: 'producer' },
  );
  expect(gate.passed).toBe(true);
  expect(decisions).toHaveLength(2);
  const retryPayload = JSON.parse(String(decisions[1]?.messages[0]?.content));
  expect(retryPayload.criticModels).toEqual(['openai:critic-b']);
  expect(retryPayload.failedCritics).toEqual([
    expect.objectContaining({ route: 'openai:critic-a' }),
  ]);
  expect(attempted).toEqual(['critic-a', 'critic-b']);
});

test('Auto re-runs an explicitly re-picked route when every enabled Critic already failed', async () => {
  const f = await fixture();
  await f.sessions.update(f.session.id, { agentOverrides: { criticMode: 'auto' } });
  writeFileSync(
    join(f.root, 'koryphaios.json'),
    JSON.stringify({
      agentSettings: {
        criticMode: 'auto',
        designDiscovery: false,
        intentInterview: 'off',
        managerModelAccess: { critic: ['openai:critic-a'] },
      },
    }),
  );
  const attempted: string[] = [];
  (f.providers as any).executeWithRetry = mock(async function* (request: StreamRequest) {
    attempted.push(request.model);
    if (attempted.length === 1) {
      yield { type: 'error', error: 'critic-a exploded' };
      return;
    }
    yield {
      type: 'content_delta',
      content: JSON.stringify({
        verdict: 'PASS',
        findings: [],
        checksReviewed: ['inspection'],
        unmetCriteria: [],
        skillReviews: [],
        verifierAssessment: { status: 'supported', evidence: 'Looks right' },
      }),
    };
  });
  const decisions: StreamRequest[] = [];
  f.provider.streamResponse = mock(async function* (request: StreamRequest) {
    decisions.push(request);
    yield {
      type: 'content_delta',
      content: JSON.stringify({
        review: true,
        reason: 'Retry the same route.',
        model: 'openai:critic-a',
      }),
    };
  });
  const gate = await f.manager.runCriticGate(
    f.session.id,
    [{ role: 'assistant', content: 'Explained caching.' }],
    'openai:producer',
    'Explain caching',
    f.root,
    { provider: 'openai', model: 'producer' },
  );
  expect(gate.passed).toBe(true);
  expect(decisions).toHaveLength(2);
  const retryPayload = JSON.parse(String(decisions[1]?.messages[0]?.content));
  // The failed route stays offered — re-picking it is an explicit retry, and
  // the decider is told it can retry or decline.
  expect(retryPayload.criticModels).toEqual(['openai:critic-a']);
  expect(retryPayload.failedCritics).toEqual([
    expect.objectContaining({ route: 'openai:critic-a' }),
  ]);
  expect(String(decisions[1]?.systemPrompt)).toContain('Every enabled Critic has already failed');
  // The re-picked route really ran again, not a recorded failure shortcut.
  expect(attempted).toEqual(['critic-a', 'critic-a']);
  expect(f.internal.runtimes.peek(f.session.id)?.failedCriticRoutes.has('openai:critic-a')).toBe(
    false,
  );
});

test('a session-remembered failed route still runs when the agent explicitly picks it', async () => {
  const f = await fixture();
  await f.sessions.update(f.session.id, { agentOverrides: { criticMode: 'auto' } });
  writeFileSync(
    join(f.root, 'koryphaios.json'),
    JSON.stringify({
      agentSettings: {
        criticMode: 'auto',
        designDiscovery: false,
        intentInterview: 'off',
        managerModelAccess: { critic: ['openai:critic-a'] },
      },
    }),
  );
  // A previous turn within the TTL crashed on this route.
  f.internal.runtimes.get(f.session.id).failedCriticRoutes.set('openai:critic-a', {
    failedAt: Date.now(),
    error: 'previous crash',
  });
  const attempted: string[] = [];
  (f.providers as any).executeWithRetry = mock(async function* (request: StreamRequest) {
    attempted.push(request.model);
    yield {
      type: 'content_delta',
      content: JSON.stringify({
        verdict: 'PASS',
        findings: [],
        checksReviewed: ['inspection'],
        unmetCriteria: [],
        skillReviews: [],
        verifierAssessment: { status: 'supported', evidence: 'Looks right' },
      }),
    };
  });
  const decisions: StreamRequest[] = [];
  f.provider.streamResponse = mock(async function* (request: StreamRequest) {
    decisions.push(request);
    yield {
      type: 'content_delta',
      content: JSON.stringify({
        review: true,
        reason: 'Give it another shot.',
        model: 'openai:critic-a',
      }),
    };
  });
  const gate = await f.manager.runCriticGate(
    f.session.id,
    [{ role: 'assistant', content: 'Explained caching.' }],
    'openai:producer',
    'Explain caching',
    f.root,
    { provider: 'openai', model: 'producer' },
  );
  expect(gate.passed).toBe(true);
  expect(decisions).toHaveLength(1);
  // The explicit pick was honored: the Critic stream really ran instead of the
  // pin being short-circuited by session failure memory.
  expect(attempted).toEqual(['critic-a']);
  expect(f.internal.runtimes.peek(f.session.id)?.failedCriticRoutes.has('openai:critic-a')).toBe(
    false,
  );
});

test('a Critic that cannot run ships the manager answer as unverified, not as a rejection', async () => {
  const f = await fixture();
  writeFileSync(
    join(f.root, 'koryphaios.json'),
    JSON.stringify({
      agentSettings: {
        criticMode: 'always',
        designDiscovery: false,
        intentInterview: 'off',
        managerModelAccess: { critic: ['openai:critic-a', 'openai:critic-b'] },
      },
    }),
  );
  (f.providers as any).executeWithRetry = mock(async function* (request: StreamRequest) {
    if (request.model === 'producer') {
      yield { type: 'content_delta', content: 'A cache reuses previous results.' };
      return;
    }
    yield { type: 'error', error: 'critic provider exploded' };
  });
  await reply(f);
  const answer = f.events
    .filter((event) => event.type === 'stream.delta' && event.payload.agentId === 'kory-manager')
    .map((event) => event.payload.content)
    .join('');
  expect(answer).toContain('A cache reuses previous results.');
  expect(answer).toContain('UNVERIFIED: Critic could not run');
  expect(
    f.events.some(
      (event) =>
        event.type === 'stream.delta' &&
        String(event.payload.content).includes('CRITIC REQUIRES REPAIR'),
    ),
  ).toBe(false);
  const assistant = (await f.messages.getAll(f.session.id)).filter(
    (message) => message.role === 'assistant',
  );
  expect(assistant).toHaveLength(1);
  expect(String(assistant[0]?.content)).toContain('UNVERIFIED: Critic could not run');
  expect(String(assistant[0]?.content)).not.toContain('QUALITY GATE FAILED');
});

test('every Critic route failing returns criticUnavailable, skipped and not passed', async () => {
  const f = await fixture();
  writeFileSync(
    join(f.root, 'koryphaios.json'),
    JSON.stringify({
      agentSettings: {
        criticMode: 'always',
        designDiscovery: false,
        intentInterview: 'off',
        managerModelAccess: { critic: ['openai:critic-a', 'openai:critic-b'] },
      },
    }),
  );
  (f.providers as any).executeWithRetry = mock(async function* () {
    yield { type: 'error', error: 'critic provider exploded' };
  });
  const gate = await f.manager.runCriticGate(
    f.session.id,
    [{ role: 'assistant', content: 'Implemented caching.' }],
    'openai:producer',
    'Implement caching',
    f.root,
    { provider: 'openai', model: 'producer' },
  );
  expect(gate).toMatchObject({ passed: false, skipped: true, criticUnavailable: true });
  expect(String(gate.feedback)).toContain('Critic could not run');
});

test('the decision pool excludes a recently failed Critic route and restores it after the TTL', async () => {
  const f = await fixture();
  writeFileSync(
    join(f.root, 'koryphaios.json'),
    JSON.stringify({
      agentSettings: {
        criticMode: 'auto',
        designDiscovery: false,
        intentInterview: 'off',
        managerModelAccess: { critic: ['openai:critic-a', 'openai:critic-b'] },
      },
    }),
  );
  const decisions: StreamRequest[] = [];
  f.provider.streamResponse = mock(async function* (request: StreamRequest) {
    decisions.push(request);
    yield { type: 'content_delta', content: '{"review":false,"reason":"Not needed."}' };
  });
  const ask = () =>
    f.internal.askForCriticDecision(f.session.id, [], 'Check work', f.root, {
      provider: 'openai',
      model: 'producer',
    });
  const poolOf = (request: StreamRequest) =>
    JSON.parse(String(request.messages[0]?.content)).criticModels;
  f.internal.recordCriticRouteFailure(f.session.id, 'openai:critic-a', 'provider exploded');
  await ask();
  expect(poolOf(decisions[0]!)).toEqual(['openai:critic-b']);
  const nowSpy = spyOn(Date, 'now').mockReturnValue(Date.now() + 11 * 60 * 1000);
  try {
    await ask();
    expect(poolOf(decisions[1]!)).toEqual(['openai:critic-a', 'openai:critic-b']);
  } finally {
    nowSpy.mockRestore();
  }
});

test('Auto asks the finishing manager and honors its chosen critic model', async () => {
  const f = await fixture();
  await f.sessions.update(f.session.id, { agentOverrides: { criticMode: 'auto' } });
  writeFileSync(
    join(f.root, 'koryphaios.json'),
    JSON.stringify({
      agentSettings: {
        criticMode: 'auto',
        designDiscovery: false,
        intentInterview: 'off',
        managerModelAccess: { critic: ['openai:critic-a', 'openai:critic-b'] },
      },
    }),
  );
  const review = mock(async (..._args: unknown[]) => ({ passed: true }));
  f.internal.runCriticGate = review;
  const decisions: StreamRequest[] = [];
  (f.provider as Provider).streamResponse = mock(async function* (request: StreamRequest) {
    decisions.push(request);
    yield {
      type: 'content_delta',
      content: JSON.stringify({
        review: true,
        reason: 'Check the factual claim.',
        model: 'openai:critic-b',
      }),
    };
  });
  await reply(f);
  expect(decisions).toHaveLength(1);
  expect(decisions[0]?.model).toBe('producer');
  expect(decisions[0]?.tools).toEqual([]);
  expect(JSON.stringify(decisions[0]?.messages)).toContain('A cache reuses previous results.');
  expect(review).toHaveBeenCalledTimes(1);
  expect(review.mock.calls[0]?.[7]).toMatchObject({
    autoDecisionMade: true,
    criticModel: 'openai:critic-b',
  });
});

test('Auto asks a completed worker and declining skips review even with file evidence', async () => {
  const f = await fixture();
  await f.sessions.update(f.session.id, { agentOverrides: { criticMode: 'auto' } });
  const decisions: StreamRequest[] = [];
  f.provider.streamResponse = mock(async function* (request: StreamRequest) {
    decisions.push(request);
    yield { type: 'content_delta', content: '{"review":false,"reason":"Checks are sufficient."}' };
  });
  f.internal.resolveIndependentRouting = mock(() => {
    throw new Error('Declined review must not route a critic');
  });
  const gate = await f.manager.runCriticGate(
    f.session.id,
    [{ role: 'assistant', content: 'Implemented caching and verified it.' }],
    'openai:builder',
    'Implement caching',
    f.root,
    { provider: 'openai', model: 'builder' },
  );
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
  expect(
    f.events.some(
      (event) =>
        event.type === 'system.info' && event.payload.message.includes('decision unavailable'),
    ),
  ).toBe(true);
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
  expect(
    f.events.some(
      (event) => event.type === 'system.info' && event.payload.message.includes('review required'),
    ),
  ).toBe(false);
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
  expect(
    f.events.some(
      (event) =>
        event.type === 'system.info' &&
        event.payload.message.includes('Critic review unavailable') &&
        event.payload.message.includes('distinct Critic provider/model'),
    ),
  ).toBe(true);
});

test.each(['yolo', 'guarded', 'ask'] as const)(
  'routes Critic action approval to the correct owner in %s',
  async (mode) => {
    const f = await fixture(mode);
    f.internal.waitForUserInputInternal = mock(async () => 'Allow once');
    f.internal.runtimes.get(f.session.id).managerRouting = {
      provider: 'openai',
      model: 'producer',
    };
    const approved = await f.internal.approveCriticAction(
      f.session.id,
      'critic-test',
      'Explain caching',
      { id: 'action', name: 'bash', input: { command: 'bun test' } },
      'Verify behavior',
      new AbortController().signal,
    );
    expect(approved).toBe(true);
    expect(f.internal.waitForUserInputInternal.mock.calls.length).toBe(mode === 'ask' ? 1 : 0);
    expect((f.provider.streamResponse as any).mock.calls.length).toBe(mode === 'ask' ? 0 : 1);
    if (mode !== 'ask') {
      const request = (f.provider.streamResponse as any).mock.calls[0][0] as StreamRequest;
      expect(request.tools).toEqual([]);
      expect(request.forceFreshConversation).toBe(true);
    }
  },
);

test('universal Critic executes approved experiments and manages specialists in isolated copies', async () => {
  const f = await fixture();
  writeFileSync(join(f.root, 'implementation.txt'), 'producer');
  f.tools.register(new DelegateToWorkerTool());
  f.tools.register(new ManageReviewAgentsTool());
  const commandRoots: string[] = [];
  f.tools.register({
    name: 'bash',
    description: 'Verification command fixture',
    inputSchema: {},
    run: async (ctx, call) => {
      commandRoots.push(ctx.workingDirectory);
      expect(ctx.approvedToolCallIds?.has(call.id)).toBe(true);
      expect(ctx.requiredWorkspaceRoot).toBe(ctx.workingDirectory);
      writeFileSync(join(ctx.workingDirectory, 'implementation.txt'), 'red-team experiment');
      return {
        callId: call.id,
        name: call.name,
        output: 'Boundary checks passed',
        isError: false,
        durationMs: 1,
      };
    },
  });
  f.internal.resolveIndependentRouting = (_model: string, _provider: string, domain: string) => ({
    model: domain === 'critic' ? 'critic' : 'specialist',
    provider: 'openai',
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
      yield {
        type: 'content_delta',
        content: 'Inspected implementation and independently checked invalidation behavior.',
      };
      return;
    }
    if (reviewRound++ === 0) {
      yield* emitCall('bash', { command: 'verify' });
      return;
    }
    if (reviewRound === 2) {
      yield* emitCall('delegate_to_worker', { task: 'Verify cache invalidation', domain: 'test' });
      return;
    }
    if (reviewRound === 3) {
      yield* emitCall('manage_review_agents', { action: 'list' });
      return;
    }
    if (reviewRound === 4) {
      const receipt = request.messages
        .filter((message) => message.role === 'tool')
        .map((message) => JSON.parse(String(message.content)))
        .find((result) => result.name === 'delegate_to_worker');
      const child = JSON.parse(receipt.output);
      yield* emitCall('manage_review_agents', {
        action: 'message',
        agentId: child.agentId,
        message: 'Also inspect empty cache behavior',
      });
      return;
    }
    yield {
      type: 'content_delta',
      content: JSON.stringify({
        verdict: 'PASS',
        findings: [],
        checksReviewed: ['Actual response, verification command and specialist evidence'],
        unmetCriteria: [],
        skillReviews: [],
        verifierAssessment: {
          status: 'supported',
          evidence: 'Checks and direct inspection support the claims',
        },
      }),
    };
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
  expect(
    f.events.some(
      (event) =>
        event.type === 'stream.tool_call' && event.payload.toolCall.name === 'critic_review',
    ),
  ).toBe(true);
  expect(
    f.events
      .filter((event) => event.type === 'stream.delta' && event.payload.agentId === 'kory-manager')
      .map((event) => event.payload.content),
  ).toEqual(['Caching avoids redundant computation.']);
});

test('a failing deterministic check cannot be overridden by a Critic PASS', async () => {
  const f = await fixture();
  writeFileSync(join(f.root, 'package.json'), JSON.stringify({ scripts: { test: 'exit 1' } }));
  f.tools.register({
    name: 'bash',
    description: '',
    inputSchema: {},
    run: async (_ctx, call) => ({
      callId: call.id,
      name: call.name,
      output: 'A regression failed',
      isError: true,
      durationMs: 1,
    }),
  });
  f.internal.resolveIndependentRouting = () => ({ model: 'critic', provider: 'openai' });
  (f.providers as any).executeWithRetry = mock(async function* () {
    yield {
      type: 'content_delta',
      content: JSON.stringify({
        verdict: 'PASS',
        findings: [],
        checksReviewed: ['test'],
        unmetCriteria: [],
        skillReviews: [],
        verifierAssessment: { status: 'supported', evidence: 'Inspection' },
      }),
    };
  });
  const gate = await f.manager.runCriticGate(
    f.session.id,
    [{ role: 'assistant', content: 'Implemented cache' }],
    'openai:producer',
    'Implement cache',
    f.root,
    { provider: 'openai', model: 'producer' },
  );
  expect(gate.passed).toBe(false);
  expect(gate.feedback).toContain('Hard checks failed');
  expect(
    f.events.some(
      (event) =>
        event.type === 'stream.tool_result' &&
        event.payload.toolResult.name === 'bash' &&
        event.payload.toolResult.isError,
    ),
  ).toBe(true);
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

  // The only route keeps failing, so the gate retried it until the attempt
  // cap and reported the Critic as unavailable — with every attempt's
  // error and partial output preserved in its own tool_result.
  expect(result.passed).toBe(false);
  expect(result.skipped).toBe(true);
  expect(result.criticUnavailable).toBe(true);
  expect(result.feedback).toContain('Critic could not run');
  expect(result.feedback).toContain('upstream stream closed after response bytes');
  const toolResults = f.events.filter(
    (event) =>
      event.type === 'stream.tool_result' && event.payload.toolResult.name === 'critic_review',
  );
  expect(toolResults).toHaveLength(3);
  for (const toolResult of toolResults) {
    expect(toolResult.payload.toolResult.criticOutcome).toBe('run_failed_after_output');
    expect(toolResult.payload.toolResult.output).toContain('Partial critic output');
  }
});

test('stopping a held manager response does not publish or persist an unreviewed answer', async () => {
  const f = await fixture();
  const entered = deferred();
  const release = deferred();
  f.internal.runCriticGate = mock(async () => {
    entered.resolve();
    await release.promise;
    return { passed: true };
  });
  const turn = reply(f);
  await entered.promise;
  f.manager.abortManagerRun(f.session.id);
  release.resolve();
  await turn;
  expect(f.events.filter((event) => event.type === 'stream.delta')).toHaveLength(0);
  expect(
    (await f.messages.getAll(f.session.id)).filter((message) => message.role === 'assistant'),
  ).toHaveLength(0);
});
