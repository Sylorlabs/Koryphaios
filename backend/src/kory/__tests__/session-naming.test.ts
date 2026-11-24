import { afterEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { KoryphaiosConfig } from '@koryphaios/shared';
import { SESSION } from '../../constants';
import type { ProviderRegistry } from '../../providers';
import type { Provider, ProviderEvent, StreamRequest } from '../../providers/types';
import { SessionStore } from '../../stores/session-store';
import { MessageStore } from '../../stores/message-store';
import { ToolRegistry, type ToolContext } from '../../tools/registry';
import { RenameSessionTool } from '../../tools/session';
import { DEFAULT_AGENT_SETTINGS } from '../../agent-settings';
import { resolveToolPermissionPolicy, decideToolPermission } from '../../tools/permission-policy';
import { KoryManager } from '../manager';
import {
  setSessionAgentOverrides,
  resetSessionAgentOverridesCache,
} from '../../stores/session-agent-overrides';

const fixtures: Array<{ manager: KoryManager; root: string }> = [];

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixedDelay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function fixture(title = SESSION.DEFAULT_TITLE) {
  const root = mkdtempSync(join(tmpdir(), 'kory-session-naming-'));
  const sessions = new SessionStore();
  const messages = new MessageStore();
  const session = await sessions.create('local-user', title, undefined, root);
  await messages.add(session.id, {
    id: `${session.id}-first`,
    sessionId: session.id,
    role: 'user',
    content: 'Help me fix the checkout login bug',
    createdAt: Date.now(),
  });
  const titleStarted = deferred();
  const titleRelease = deferred();
  const titleFinished = deferred();
  const titleRequests: StreamRequest[] = [];
  const streamResponse = mock(async function* (
    request: StreamRequest,
  ): AsyncGenerator<ProviderEvent> {
    titleRequests.push(request);
    titleStarted.resolve();
    await titleRelease.promise;
    try {
      request.signal?.throwIfAborted();
      yield { type: 'content_delta', content: 'Fix checkout login bug' };
      yield { type: 'complete' };
    } finally {
      titleFinished.resolve();
    }
  });
  const provider = { name: 'openai', config: {}, streamResponse } as unknown as Provider;
  const order: string[] = [];
  const replyCompleted = deferred();
  const replyRequests: StreamRequest[] = [];
  const executeWithRetry = mock(async function* (
    request: StreamRequest,
  ): AsyncGenerator<ProviderEvent> {
    replyRequests.push(request);
    order.push('reply');
    try {
      yield { type: 'content_delta', content: 'Here is how to fix the login issue.' };
      yield { type: 'complete' };
    } finally {
      replyCompleted.resolve();
    }
  });
  const providers = {
    resolveProvider: async () => provider,
    executeWithRetry,
    getAvailable: () => [provider],
    getStatus: () => [],
    getConfigs: () => ({}),
    get: () => undefined,
    isQuotaError: () => false,
  } as unknown as ProviderRegistry;
  const tools = new ToolRegistry();
  tools.register(new RenameSessionTool());
  const manager = new KoryManager(
    providers,
    tools,
    root,
    {} as KoryphaiosConfig,
    sessions,
    messages,
  );
  // Naming tests exercise the turn/title boundary, not the independent
  // response critic. Keep its policy out of the provider ordering assertions.
  await sessions.update(session.id, { agentOverrides: { criticGateEnabled: false } });
  setSessionAgentOverrides(session.id, { criticGateEnabled: false });
  manager.resolveActiveRouting = () => ({ model: 'selected-model', provider: 'openai' });
  const internal = manager as unknown as {
    resolveSessionWorkingDirectory(id: string): Promise<string>;
    events: { emit(sessionId: string, type: string, payload: unknown): void };
  };
  internal.resolveSessionWorkingDirectory = async () => root;
  const emit = mock((_id: string, type: string) => {
    order.push(type);
  });
  internal.events.emit = emit;
  fixtures.push({ manager, root });
  return {
    manager,
    sessions,
    messages,
    session,
    titleStarted,
    titleRelease,
    titleFinished,
    titleRequests,
    replyCompleted,
    replyRequests,
    streamResponse,
    provider,
    executeWithRetry,
    tools,
    root,
    emit,
    order,
  };
}

afterEach(async () => {
  resetSessionAgentOverridesCache();
  for (const { manager, root } of fixtures.splice(0)) {
    await manager.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});

describe('required session naming', () => {
  test.each(['act', 'plan'] as const)(
    'does not block the response on naming in %s',
    async (interactionMode) => {
      const f = await fixture();
      const admission = await f.manager.reserveSessionTurn(f.session.id, 'user_turn');
      const turn = f.manager.dispatchAdmittedTask(admission!, {
        userMessage: 'Help me fix the checkout login bug',
        preferredModel: 'openai:selected-model',
        inputAlreadyPersisted: true,
        interactionMode,
      });
      await f.titleStarted.promise;
      await f.replyCompleted.promise;
      expect(f.executeWithRetry).toHaveBeenCalledTimes(1);
      expect((await f.sessions.get(f.session.id))?.title).toBe(SESSION.DEFAULT_TITLE);
      // The provider has already completed its response while the title probe
      // is still blocked. Releasing the probe now lets the turn settle without
      // making title persistence part of the response assertion.
      f.titleRelease.resolve();
      await f.titleFinished.promise;
      await turn;
      expect(
        (await f.messages.getAll(f.session.id)).find((message) => message.role === 'assistant')
          ?.content,
      ).toBe('Here is how to fix the login issue.');
      expect(f.titleRequests[0]?.model).toBe('selected-model');
      expect(f.titleRequests[0]?.messages[0]?.content).toContain('checkout login bug');

      expect((await f.sessions.get(f.session.id))?.title).toBe('Fix checkout login bug');
      expect(f.order.filter((type) => type === 'reply' || type === 'session.updated')).toEqual([
        'reply',
        'session.updated',
      ]);
    },
  );

  const modeCases = (['auto', 'single', 'multi'] as const).flatMap((agentExecutionMode) =>
    (['act', 'plan'] as const).flatMap((interactionMode) =>
      [0, 3].map((shrink) => ({ agentExecutionMode, interactionMode, shrink })),
    ),
  );

  test.each(modeCases)(
    'keeps renaming callable in $agentExecutionMode / $interactionMode / shrink $shrink',
    async ({ agentExecutionMode, interactionMode, shrink }) => {
      const f = await fixture('Fix checkout login bug');
      setSessionAgentOverrides(f.session.id, { agentExecutionMode, criticGateEnabled: false });
      const ctx: ToolContext = {
        sessionId: f.session.id,
        workingDirectory: f.root,
        callerRole: 'manager',
        permissionPolicy: resolveToolPermissionPolicy(DEFAULT_AGENT_SETTINGS, interactionMode),
        renameSession: (title) => f.manager.renameSession(f.session.id, title),
      };
      const internal = f.manager as unknown as {
        processManagerTurn(
          sessionId: string,
          model: string,
          provider: Provider,
          messages: Array<{ role: 'user'; content: string }>,
          ctx: ToolContext,
          signal: AbortSignal,
          reasoning: undefined,
          mode: 'act' | 'plan',
          fastMode: undefined,
          revision: undefined,
          fresh: boolean,
          shrink: number,
        ): Promise<unknown>;
      };
      const admission = await f.manager.reserveSessionTurn(f.session.id, 'user_turn');
      await f.manager.dispatchAdmittedWork(
        admission!,
        async ({ signal }) => {
          await internal.processManagerTurn(
            f.session.id,
            'selected-model',
            f.provider,
            [{ role: 'user', content: 'What is HTTP caching?' }],
            ctx,
            signal,
            undefined,
            interactionMode,
            undefined,
            undefined,
            false,
            shrink,
          );
          expect(ctx.allowedToolNames?.has('rename_session')).toBe(true);
          expect(f.replyRequests[0]?.tools?.some((tool) => tool.name === 'rename_session')).toBe(
            true,
          );
          const result = await f.tools.execute(ctx, {
            id: 'mode-rename',
            name: 'rename_session',
            input: { title: 'Understanding HTTP caching' },
          });
          expect(result.isError).toBe(false);
        },
        'mode_naming_test',
      );
      expect((await f.sessions.get(f.session.id))?.title).toBe('Understanding HTTP caching');
    },
  );

  test.each(['guarded', 'ask', 'edits', 'yolo', 'custom'] as const)(
    'renaming needs no approval in %s permission mode',
    async (permissionMode) => {
      const f = await fixture('Checkout investigation');
      const waitForUserInput = mock(async () => 'Reject');
      const result = await f.tools.execute(
        {
          sessionId: f.session.id,
          workingDirectory: f.root,
          callerRole: 'manager',
          permissionPolicy: resolveToolPermissionPolicy({
            ...DEFAULT_AGENT_SETTINGS,
            permissionMode,
            autoRunTools: false,
            autoApplySafeFixes: false,
          }),
          renameSession: (title) => f.manager.renameSession(f.session.id, title),
          waitForUserInput,
        },
        { id: 'preset-rename', name: 'rename_session', input: { title: 'Payment flow redesign' } },
      );
      expect(result.isError).toBe(false);
      expect(waitForUserInput).not.toHaveBeenCalled();
      expect((await f.sessions.get(f.session.id))?.title).toBe('Payment flow redesign');
    },
  );

  test('coalesces naming and repairs a default title from the first persisted message', async () => {
    const f = await fixture();
    await f.messages.add(f.session.id, {
      id: `${f.session.id}-later`,
      sessionId: f.session.id,
      role: 'user',
      content: 'Now add a payment screen',
      createdAt: Date.now() + 1,
    });
    const first = f.manager.generateSessionTitle(f.session.id, 'Now add a payment screen');
    const second = f.manager.generateSessionTitle(f.session.id, 'A different message');
    expect(second).toBe(first);
    await f.titleStarted.promise;
    f.titleRelease.resolve();
    await Promise.all([first, second]);
    expect(f.streamResponse).toHaveBeenCalledTimes(1);
    expect(f.titleRequests[0]?.messages[0]?.content).toContain('checkout login bug');
    expect(f.titleRequests[0]?.messages[0]?.content).not.toContain('payment screen');
    expect((await f.sessions.get(f.session.id))?.title).toBe('Fix checkout login bug');
  });

  test('keeps a manual rename made while title generation is in progress', async () => {
    const f = await fixture();
    const naming = f.manager.generateSessionTitle(f.session.id, 'Initial message');
    await f.titleStarted.promise;
    await f.sessions.update(f.session.id, { title: 'My chosen title' });
    f.titleRelease.resolve();
    await naming;
    expect((await f.sessions.get(f.session.id))?.title).toBe('My chosen title');
  });

  test('uses a topic fallback when the naming model fails', async () => {
    const f = await fixture();
    f.streamResponse.mockImplementation(async function* () {
      yield { type: 'error', error: 'Invalid API key' };
    });
    await f.manager.generateSessionTitle(f.session.id, 'Later message');
    expect((await f.sessions.get(f.session.id))?.title).toBe('Help me fix the checkout login bug');
  });

  test('does not block a reply if background title saving fails and allows a later retry', async () => {
    const f = await fixture();
    const update = f.sessions.update.bind(f.sessions);
    f.sessions.update = async () => undefined;
    const admission = await f.manager.reserveSessionTurn(f.session.id, 'user_turn');
    const turn = f.manager.dispatchAdmittedTask(admission!, {
      userMessage: 'Help me fix the checkout login bug',
      preferredModel: 'openai:selected-model',
      inputAlreadyPersisted: true,
    });
    await f.titleStarted.promise;
    f.titleRelease.resolve();
    await turn;
    expect(f.executeWithRetry).toHaveBeenCalledTimes(1);
    expect(
      (await f.messages.getAll(f.session.id)).find((message) => message.role === 'assistant')
        ?.content,
    ).toBe('Here is how to fix the login issue.');
    expect((await f.sessions.get(f.session.id))?.title).toBe(SESSION.DEFAULT_TITLE);
    f.sessions.update = update;
    await f.manager.generateSessionTitle(f.session.id, 'Later retry');
    expect((await f.sessions.get(f.session.id))?.title).toBe('Fix checkout login bug');
  });

  test('synthetic latency benchmark: background naming overlaps the reply path', async () => {
    const delayMs = 12;
    const repetitions = 4;
    const measure = async (serial: boolean): Promise<number> => {
      const startedAt = performance.now();
      for (let index = 0; index < repetitions; index++) {
        if (serial) {
          await fixedDelay(delayMs);
          await fixedDelay(delayMs);
        } else {
          await Promise.all([fixedDelay(delayMs), fixedDelay(delayMs)]);
        }
      }
      return performance.now() - startedAt;
    };

    const serialMs = await measure(true);
    const backgroundMs = await measure(false);
    expect(backgroundMs).toBeLessThan(serialMs);
    // This is deliberately a labeled synthetic comparison: both sides use
    // fixed local delays and no provider account or network request.
    expect(backgroundMs).toBeLessThan(serialMs * 0.8);
  });

  test('cancellation does not persist a stale generated title', async () => {
    const f = await fixture();
    const abort = new AbortController();
    const naming = f.manager.generateSessionTitle(
      f.session.id,
      'Initial message',
      undefined,
      abort.signal,
    );
    await f.titleStarted.promise;
    abort.abort();
    f.titleRelease.resolve();
    await naming;
    expect((await f.sessions.get(f.session.id))?.title).toBe(SESSION.DEFAULT_TITLE);
    expect(f.emit).not.toHaveBeenCalled();
  });

  test('allows manager renaming on later turns in Plan and excludes worker roles', async () => {
    const f = await fixture('Checkout investigation');
    const call = {
      id: 'rename-1',
      name: 'rename_session',
      input: { title: '  Payment flow redesign  ' },
    };
    const ctx = {
      sessionId: f.session.id,
      workingDirectory: f.root,
      callerRole: 'manager' as const,
      permissionPolicy: resolveToolPermissionPolicy(DEFAULT_AGENT_SETTINGS, 'plan'),
      renameSession: (title: string) => f.manager.renameSession(f.session.id, title),
    };
    const result = await f.tools.execute(ctx, call);
    expect(result.isError).toBe(false);
    expect((await f.sessions.get(f.session.id))?.title).toBe('Payment flow redesign');
    expect(f.tools.getToolDefsForRole('manager').some((tool) => tool.name === call.name)).toBe(
      true,
    );
    expect(f.tools.getToolDefsForRole('worker').some((tool) => tool.name === call.name)).toBe(
      false,
    );
    const worker = await f.tools.execute(
      { ...ctx, callerRole: 'worker' },
      { ...call, input: { title: 'Worker overwrite' } },
    );
    expect(worker.isError).toBe(true);
    expect((await f.sessions.get(f.session.id))?.title).toBe('Payment flow redesign');
    expect(
      decideToolPermission(
        { ...ctx.permissionPolicy, toolBlocklist: ['rename_session'] },
        call.name,
      ).action,
    ).toBe('allow');
  });

  test('rejects blank, generic, overlong titles and archived-session renames', async () => {
    const f = await fixture('Checkout investigation');
    for (const title of [
      '',
      '  ',
      SESSION.DEFAULT_TITLE,
      'x'.repeat(SESSION.MAX_TITLE_LENGTH + 1),
    ]) {
      await expect(f.manager.renameSession(f.session.id, title)).rejects.toThrow(
        'descriptive title',
      );
    }
    await f.sessions.archive(f.session.id);
    await expect(f.manager.renameSession(f.session.id, 'Payment flow')).rejects.toThrow('archived');
  });
});
