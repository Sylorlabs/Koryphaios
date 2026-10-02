import { describe, expect, test, afterEach } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { SessionStore } from '../../stores/session-store';
import {
  AgentMessageTargetError,
  AgentMessagingDisabledError,
  configureAgentMail,
  resetAgentMail,
  sendAgentMessage,
  drainInbox,
} from './agent-mail-service';
import type { KoryManager } from '../manager';
import { loadAgentSettings, saveAgentSettings } from '../../agent-settings';

const sessions = new SessionStore();

/** Minimal KoryManager stand-in: the service only needs the WS emitter and
 *  startSessionTurn for push delivery. Tests here cover routing/authority, so
 *  the turn submission is never reached (worker rule and policy throw first). */
function fakeKory(): KoryManager {
  return {
    emitAgentMessageEvent: () => undefined,
    startSessionTurn: async () => {
      throw new Error('push delivery must not run in authority tests');
    },
  } as unknown as KoryManager;
}

async function seedProjectSession(title: string, workingDirectory: string) {
  const session = await sessions.create('local-user', title);
  await sessions.update(session.id, { workingDirectory });
  return session;
}

afterEach(() => {
  resetAgentMail();
});

describe('agent mail authority rules', () => {
  test('a worker cannot message another project', async () => {
    const sender = await seedProjectSession('Worker home', '/tmp/kory-auth-worker');
    await seedProjectSession('Other project', '/tmp/kory-auth-other');
    configureAgentMail({ kory: fakeKory(), sessions });

    await expect(
      sendAgentMessage({
        fromSessionId: sender.id,
        fromAgentId: 'worker-abc123',
        fromRole: 'worker',
        fromLabel: 'backend agent',
        toProject: 'Other project',
        subject: 'Feature request',
        body: 'Please add a feature for me.',
      }),
    ).rejects.toBeInstanceOf(AgentMessageTargetError);
  });

  test('a worker can message its own manager inside the same project', async () => {
    const sender = await seedProjectSession('Worker own project', '/tmp/kory-auth-own');
    configureAgentMail({ kory: fakeKory(), sessions });

    const message = await sendAgentMessage({
      fromSessionId: sender.id,
      fromAgentId: 'worker-abc123',
      fromRole: 'worker',
      fromLabel: 'backend agent',
      subject: 'Need a decision',
      body: 'Which schema should I use?',
    });
    expect(message.toSessionId).toBe(sender.id);
    expect(message.toRole).toBe('manager');
    expect(message.crossProject).toBe(false);
  });

  test('cross-project messages target only the receiving manager', async () => {
    const sender = await seedProjectSession('Cross sender', '/tmp/kory-auth-cross-a');
    await seedProjectSession('Cross target', '/tmp/kory-auth-cross-b');
    configureAgentMail({ kory: fakeKory(), sessions });

    await expect(
      sendAgentMessage({
        fromSessionId: sender.id,
        fromAgentId: 'kory-manager',
        fromRole: 'manager',
        fromLabel: '(a) manager',
        toProject: 'Cross target',
        toAgent: { role: 'worker', label: 'backend agent' },
        subject: 'Wrong target',
        body: 'body',
      }),
    ).rejects.toBeInstanceOf(AgentMessageTargetError);

    const message = await sendAgentMessage({
      fromSessionId: sender.id,
      fromAgentId: 'kory-manager',
      fromRole: 'manager',
      fromLabel: '(a) manager',
      toProject: 'Cross target',
      subject: 'Build a feature',
      body: 'Please expose a parser hook.',
    });
    expect(message.crossProject).toBe(true);
    expect(message.toRole).toBe('manager');
    expect(message.toLabel).toBe('(kory-auth-cross-b) manager');
  });

  test('the off policy disables the mailbox; pending approval is user-gated', async () => {
    const sender = await seedProjectSession('Policy project', '/tmp/kory-auth-policy');
    await seedProjectSession('Policy target', '/tmp/kory-auth-policy-b');
    configureAgentMail({ kory: fakeKory(), sessions });

    const policyRoot = '/tmp/kory-auth-policy';
    mkdirSync(policyRoot, { recursive: true });
    const original = loadAgentSettings(policyRoot);
    saveAgentSettings(policyRoot, { ...original, agentMessaging: 'off' });
    try {
      await expect(
        sendAgentMessage({
          fromSessionId: sender.id,
          fromAgentId: 'kory-manager',
          fromRole: 'manager',
          fromLabel: '(policy) manager',
          toProject: 'Policy target',
          subject: 'Blocked',
          body: 'body',
        }),
      ).rejects.toBeInstanceOf(AgentMessagingDisabledError);

      saveAgentSettings(policyRoot, {
        ...original,
        agentMessaging: 'approval-cross-project',
      });
      const held = await sendAgentMessage({
        fromSessionId: sender.id,
        fromAgentId: 'kory-manager',
        fromRole: 'manager',
        fromLabel: '(policy) manager',
        toProject: 'Policy target',
        subject: 'Needs approval',
        body: 'body',
      });
      expect(held.status).toBe('pending_approval');
    } finally {
      saveAgentSettings(policyRoot, original);
      rmSync(policyRoot, { recursive: true, force: true });
    }
  });

  test('same-session worker mail is drained (and marked delivered) by the target', async () => {
    const sender = await seedProjectSession('Drain project', '/tmp/kory-auth-drain');
    configureAgentMail({ kory: fakeKory(), sessions });

    await sendAgentMessage({
      fromSessionId: sender.id,
      fromAgentId: 'worker-abc123',
      fromRole: 'worker',
      fromLabel: 'backend agent',
      toAgent: { role: 'worker', label: 'ui agent' },
      subject: 'Handoff',
      body: 'Interface is ready for integration.',
    });

    const inbox = await drainInbox(sender.id, 'kory-manager');
    const handoff = inbox.find((message) => message.subject === 'Handoff');
    expect(handoff).toBeDefined();
    expect(handoff?.status).toBe('delivered');
  });
});
