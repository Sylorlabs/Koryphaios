import { describe, expect, test } from 'bun:test';
import { SessionStore, sanitizeSessionAgentOverrides } from './session-store';

const sessions = new SessionStore();

describe('per-session agent overrides', () => {
  test('persists the approval preset, agent mode, and critic toggle on the session', async () => {
    const session = await sessions.create('local-user', 'YOLO chat');
    await sessions.update(session.id, {
      agentOverrides: {
        permissionMode: 'yolo',
        agentExecutionMode: 'multi',
        criticGateEnabled: false,
      },
    });
    const reloaded = await new SessionStore().get(session.id);
    expect(reloaded?.agentOverrides).toEqual({
      permissionMode: 'yolo',
      agentExecutionMode: 'multi',
      criticGateEnabled: false,
    });
  });

  test('keeps each chat independent and leaves untouched chats undefined', async () => {
    const guarded = await sessions.create('local-user', 'Guarded chat');
    const yolo = await sessions.create('local-user', 'YOLO chat');
    const untouched = await sessions.create('local-user', 'Untouched chat');
    await sessions.update(guarded.id, { agentOverrides: { permissionMode: 'guarded' } });
    await sessions.update(yolo.id, { agentOverrides: { permissionMode: 'yolo' } });

    const store = new SessionStore();
    expect((await store.get(guarded.id))?.agentOverrides?.permissionMode).toBe('guarded');
    expect((await store.get(yolo.id))?.agentOverrides?.permissionMode).toBe('yolo');
    expect((await store.get(untouched.id))?.agentOverrides).toBeUndefined();
  });

  test('an empty patch clears the overrides so the chat falls back to the workspace default', async () => {
    const session = await sessions.create('local-user', 'Cleared chat');
    await sessions.update(session.id, { agentOverrides: { permissionMode: 'yolo' } });
    const cleared = await sessions.update(session.id, { agentOverrides: {} });
    expect(cleared?.agentOverrides).toBeUndefined();
    expect((await new SessionStore().get(session.id))?.agentOverrides).toBeUndefined();
  });

  test('persists id-addressed manager controls and drops malformed entries', async () => {
    const session = await sessions.create('local-user', 'Manager control chat');
    await sessions.update(session.id, {
      agentOverrides: {
        managerControls: {
          'kory-manager': {
            model: 'gpt-5',
            provider: 'openai',
            reasoningLevel: 'high',
            fallbacks: [{ provider: 'anthropic', model: 'sonnet', reasoningLevel: 'low' }],
          },
          broken: { model: '', fallbacks: [] } as never,
        },
      },
    });
    const reloaded = await new SessionStore().get(session.id);
    expect(reloaded?.agentOverrides?.managerControls).toEqual({
      'kory-manager': {
        model: 'gpt-5',
        provider: 'openai',
        reasoningLevel: 'high',
        fallbacks: [{ provider: 'anthropic', model: 'sonnet', reasoningLevel: 'low' }],
      },
    });
  });

  test('rejects unknown or ill-typed override values', () => {
    expect(sanitizeSessionAgentOverrides({ permissionMode: 'everything-goes' })).toBeUndefined();
    expect(sanitizeSessionAgentOverrides({ permissionMode: 'plan' })).toBeUndefined();
    expect(sanitizeSessionAgentOverrides({ agentExecutionMode: 7 })).toBeUndefined();
    expect(sanitizeSessionAgentOverrides({ criticGateEnabled: 'yes' })).toBeUndefined();
    expect(sanitizeSessionAgentOverrides('yolo')).toBeUndefined();
    expect(
      sanitizeSessionAgentOverrides({
        permissionMode: 'yolo',
        bogus: 'ignored',
        criticGateEnabled: true,
      }),
    ).toEqual({ permissionMode: 'yolo', criticGateEnabled: true });
  });
});
