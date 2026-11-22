import { describe, expect, test, afterEach } from 'bun:test';
import { SessionStore } from '../../stores/session-store';
import { listDueForDelivery } from '../../stores/agent-message-store';
import {
  AgentMessageTargetError,
  AgentMessagingDisabledError,
  approveAgentMessage,
  configureAgentMail,
  resetAgentMail,
  sendAgentMessage,
  drainInbox,
} from './agent-mail-service';
import type {
  AgentControlsSnapshot,
  AgentMessageStatus,
  MessagingPermissionsByTier,
} from '@koryphaios/shared';
import type { KoryManager } from '../manager';

const sessions = new SessionStore();

interface MailKoryOptions {
  calls?: string[];
  turn?: 'accept' | 'queue' | 'throw';
  mode?: string;
  messaging?: MessagingPermissionsByTier;
  workers?: Record<string, AgentControlsSnapshot[]>;
}

/** KoryManager stand-in: message events are no-ops, push delivery is a
 *  recorded stub, settings and worker snapshots come from the options. */
function mailKory(opts: MailKoryOptions = {}): KoryManager {
  return {
    emitAgentMessageEvent: () => undefined,
    isSessionRunning: () => false,
    settingsForSession: () => ({
      permissionMode: opts.mode ?? 'yolo',
      messagingPermissionsByTier: opts.messaging ?? {},
    }),
    agentControlSnapshots: (sessionId: string) => opts.workers?.[sessionId] ?? [],
    startSessionTurn: async (input: { sessionId: string }) => {
      opts.calls?.push(input.sessionId);
      if (opts.turn === 'throw') throw new Error('push delivery must not run');
      if (opts.turn === 'queue') return { accepted: 'queued' };
      return { accepted: true, completion: Promise.resolve(undefined) };
    },
  } as unknown as KoryManager;
}

function fakeKory(extra: MailKoryOptions = {}): KoryManager {
  return mailKory({ turn: 'throw', ...extra });
}

const uiWorker = {
  agentId: 'worker-ui42',
  name: 'UI agent',
  role: 'worker',
  status: 'active',
  busy: false,
  controllable: true,
  model: 'm',
  provider: 'p',
  worktreeMode: 'auto',
  updatedAt: 0,
} as AgentControlsSnapshot;

async function seedProjectSession(title: string, workingDirectory: string) {
  const session = await sessions.create('local-user', title);
  await sessions.update(session.id, { workingDirectory });
  return session;
}

afterEach(() => {
  resetAgentMail();
});

describe('messaging permission policy', () => {
  const MATRIX: Record<string, { manager: AgentMessageStatus; worker: AgentMessageStatus }> = {
    yolo: { manager: 'queued', worker: 'queued' },
    guarded: { manager: 'queued', worker: 'pending_approval' },
    edits: { manager: 'pending_approval', worker: 'pending_approval' },
    ask: { manager: 'pending_approval', worker: 'pending_approval' },
    custom: { manager: 'pending_approval', worker: 'pending_approval' },
  };

  for (const [mode, expected] of Object.entries(MATRIX)) {
    test(`${mode}: manager→${expected.manager}, sub-agent→${expected.worker}`, async () => {
      const sender = await seedProjectSession(`Mtx sender ${mode}`, `/tmp/kory-mtx-a-${mode}`);
      const target = await seedProjectSession(`Mtx target ${mode}`, `/tmp/kory-mtx-b-${mode}`);
      configureAgentMail({
        kory: mailKory({ mode, turn: 'queue' }),
        sessions,
      });

      const managerMsg = await sendAgentMessage({
        fromSessionId: sender.id,
        fromAgentId: 'kory-manager',
        fromRole: 'manager',
        fromLabel: '(a) manager',
        toSessionId: target.id,
        subject: 'From manager',
        body: 'body',
      });
      expect(managerMsg.status).toBe(expected.manager);

      const workerMsg = await sendAgentMessage({
        fromSessionId: sender.id,
        fromAgentId: 'worker-abc123',
        fromRole: 'worker',
        fromLabel: 'backend agent',
        toSessionId: target.id,
        subject: 'From worker',
        body: 'body',
      });
      expect(workerMsg.status).toBe(expected.worker);
      if (expected.worker === 'pending_approval') {
        expect(workerMsg.statusReason).toContain('Needs your approval');
      }
    });
  }

  test('same-chat mail stays queued in every mode, even when overrides block cross-chat', async () => {
    for (const mode of Object.keys(MATRIX)) {
      const sender = await seedProjectSession(
        `Own ${mode}`,
        `/tmp/kory-own-${mode}`,
      );
      configureAgentMail({
        kory: mailKory({
          mode,
          turn: 'queue',
          messaging: { [mode]: { manager: 'block', subAgents: 'block' } },
        }),
        sessions,
      });
      const message = await sendAgentMessage({
        fromSessionId: sender.id,
        fromAgentId: 'worker-abc123',
        fromRole: 'worker',
        fromLabel: 'backend agent',
        subject: 'Need a decision',
        body: 'body',
      });
      expect(message.toSessionId).toBe(sender.id);
      expect(message.toRole).toBe('manager');
      expect(message.status).toBe('queued');
    }
  });

  test('a tier override can allow what the preset asks for', async () => {
    const sender = await seedProjectSession('Override sender', '/tmp/kory-ovr-a');
    const target = await seedProjectSession('Override target', '/tmp/kory-ovr-b');
    const calls: string[] = [];
    configureAgentMail({
      kory: mailKory({
        mode: 'ask',
        messaging: { ask: { manager: 'allow' } },
        calls,
      }),
      sessions,
    });
    const message = await sendAgentMessage({
      fromSessionId: sender.id,
      fromAgentId: 'kory-manager',
      fromRole: 'manager',
      fromLabel: '(a) manager',
      toSessionId: target.id,
      subject: 'Override',
      body: 'body',
    });
    expect(message.status).toBe('delivered');
    expect(calls).toEqual([target.id]);
  });

  test('a block override refuses the send with a settings hint', async () => {
    const sender = await seedProjectSession('Block sender', '/tmp/kory-blk-a');
    const target = await seedProjectSession('Block target', '/tmp/kory-blk-b');
    configureAgentMail({
      kory: mailKory({
        mode: 'ask',
        messaging: { ask: { subAgents: 'block' } },
      }),
      sessions,
    });
    await expect(
      sendAgentMessage({
        fromSessionId: sender.id,
        fromAgentId: 'worker-abc123',
        fromRole: 'worker',
        fromLabel: 'backend agent',
        toSessionId: target.id,
        subject: 'Blocked',
        body: 'body',
      }),
    ).rejects.toThrow(
      'Messaging other chats is blocked for sub-agents in Ask mode. Change it in Agent settings → Inter-agent messaging.',
    );
    await expect(
      sendAgentMessage({
        fromSessionId: sender.id,
        fromAgentId: 'worker-abc123',
        fromRole: 'worker',
        fromLabel: 'backend agent',
        toSessionId: target.id,
        subject: 'Blocked',
        body: 'body',
      }),
    ).rejects.toBeInstanceOf(AgentMessagingDisabledError);
  });

  test('a worker in yolo messages another folder\u2019s manager directly', async () => {
    const sender = await seedProjectSession('Worker free', '/tmp/kory-wfree-a');
    const target = await seedProjectSession('Free target', '/tmp/kory-wfree-b');
    const calls: string[] = [];
    configureAgentMail({ kory: mailKory({ calls }), sessions });

    const message = await sendAgentMessage({
      fromSessionId: sender.id,
      fromAgentId: 'worker-abc123',
      fromRole: 'worker',
      fromLabel: 'backend agent',
      toProject: 'Free target',
      subject: 'Direct cross-folder',
      body: 'body',
    });
    expect(message.toSessionId).toBe(target.id);
    expect(message.status).toBe('delivered');
    expect(calls).toEqual([target.id]);
  });

  test('a worker label resolves against the target chat\u2019s live sub-agents', async () => {
    const sender = await seedProjectSession('Label sender', '/tmp/kory-lbl-a');
    const target = await seedProjectSession('Label target', '/tmp/kory-lbl-b');
    configureAgentMail({
      kory: mailKory({
        workers: {
          [target.id]: [
            {
              agentId: 'worker-ui42',
              name: 'UI agent',
              role: 'worker',
              status: 'active',
              busy: false,
              controllable: true,
              model: 'm',
              provider: 'p',
              worktreeMode: 'auto',
              updatedAt: 0,
            } as AgentControlsSnapshot,
          ],
        },
      }),
      sessions,
    });

    const message = await sendAgentMessage({
      fromSessionId: sender.id,
      fromAgentId: 'worker-abc123',
      fromRole: 'worker',
      fromLabel: 'backend agent',
      toSessionId: target.id,
      toAgent: { role: 'worker', label: 'ui agent' },
      subject: 'For UI',
      body: 'body',
    });
    expect(message.toAgentId).toBe('worker-ui42');
    expect(message.toRole).toBe('worker');
    expect(message.toLabel).toBe('UI agent');

    await expect(
      sendAgentMessage({
        fromSessionId: sender.id,
        fromAgentId: 'worker-abc123',
        fromRole: 'worker',
        fromLabel: 'backend agent',
        toSessionId: target.id,
        toAgent: { role: 'worker', label: 'docs agent' },
        subject: 'Wrong name',
        body: 'body',
      }),
    ).rejects.toThrow('UI agent');
  });

  test('a chat with no running sub-agents reports that plainly', async () => {
    const sender = await seedProjectSession('Empty sender', '/tmp/kory-emp-a');
    const target = await seedProjectSession('Empty target', '/tmp/kory-emp-b');
    configureAgentMail({ kory: mailKory(), sessions });
    await expect(
      sendAgentMessage({
        fromSessionId: sender.id,
        fromAgentId: 'kory-manager',
        fromRole: 'manager',
        fromLabel: '(a) manager',
        toSessionId: target.id,
        toAgent: { role: 'worker', label: 'anyone' },
        subject: 'Nobody there',
        body: 'body',
      }),
    ).rejects.toThrow('no running sub-agents');
  });

  test('a cross-chat worker-addressed message is delivered when that worker drains', async () => {
    const sender = await seedProjectSession('DrainX sender', '/tmp/kory-drx-a');
    const target = await seedProjectSession('DrainX target', '/tmp/kory-drx-b');
    configureAgentMail({
      kory: mailKory({
        workers: {
          [target.id]: [
            {
              agentId: 'worker-ui42',
              name: 'UI agent',
              role: 'worker',
              status: 'active',
              busy: false,
              controllable: true,
              model: 'm',
              provider: 'p',
              worktreeMode: 'auto',
              updatedAt: 0,
            } as AgentControlsSnapshot,
          ],
        },
      }),
      sessions,
    });
    const message = await sendAgentMessage({
      fromSessionId: sender.id,
      fromAgentId: 'kory-manager',
      fromRole: 'manager',
      fromLabel: '(a) manager',
      toSessionId: target.id,
      toAgent: { role: 'worker', label: 'ui agent' },
      subject: 'Cross-chat worker mail',
      body: 'body',
    });
    expect(message.status).toBe('queued');

    const inbox = await drainInbox(target.id, 'worker-ui42');
    const found = inbox.find((entry) => entry.id === message.id);
    expect(found?.status).toBe('delivered');
  });

  test('approval push-delivers manager targets but leaves worker targets queued', async () => {
    const sender = await seedProjectSession('Appr sender', '/tmp/kory-apr-a');
    const target = await seedProjectSession('Appr target', '/tmp/kory-apr-b');
    const calls: string[] = [];
    configureAgentMail({
      kory: mailKory({
        mode: 'ask',
        calls,
        workers: {
          [target.id]: [
            {
              agentId: 'worker-ui42',
              name: 'UI agent',
              role: 'worker',
              status: 'active',
              busy: false,
              controllable: true,
              model: 'm',
              provider: 'p',
              worktreeMode: 'auto',
              updatedAt: 0,
            } as AgentControlsSnapshot,
          ],
        },
      }),
      sessions,
    });

    const managerMail = await sendAgentMessage({
      fromSessionId: sender.id,
      fromAgentId: 'kory-manager',
      fromRole: 'manager',
      fromLabel: '(a) manager',
      toSessionId: target.id,
      subject: 'Pending manager',
      body: 'body',
    });
    expect(managerMail.status).toBe('pending_approval');
    const approved = await approveAgentMessage(managerMail.id, true);
    expect(approved?.status).toBe('delivered');
    expect(calls).toEqual([target.id]);

    const workerMail = await sendAgentMessage({
      fromSessionId: sender.id,
      fromAgentId: 'worker-abc123',
      fromRole: 'worker',
      fromLabel: 'backend agent',
      toSessionId: target.id,
      toAgent: { role: 'worker', label: 'ui agent' },
      subject: 'Pending worker',
      body: 'body',
    });
    expect(workerMail.status).toBe('pending_approval');
    const workerApproved = await approveAgentMessage(workerMail.id, true);
    expect(workerApproved?.status).toBe('queued');
    expect(calls).toEqual([target.id]);
  });
});

describe('same-session inbox behavior', () => {
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

/** KoryManager stand-in that records push-delivery turn submissions. 'queue'
 *  mode answers 'queued' so the message stays queued for the retry loop. */
function pushKory(
  calls: string[],
  mode: 'accept' | 'queue' = 'accept',
  extra: MailKoryOptions = {},
): KoryManager {
  return mailKory({ calls, turn: mode, ...extra });
}

describe('agent mail targeting by chat id', () => {
  test('toSessionId targets that exact chat and push-delivers', async () => {
    const sender = await seedProjectSession('Id sender', '/tmp/kory-id-a');
    const target = await seedProjectSession('Id target', '/tmp/kory-id-b');
    const calls: string[] = [];
    configureAgentMail({ kory: pushKory(calls), sessions });

    const message = await sendAgentMessage({
      fromSessionId: sender.id,
      fromAgentId: 'kory-manager',
      fromRole: 'manager',
      fromLabel: '(a) manager',
      toSessionId: target.id,
      subject: 'Direct',
      body: 'Can you see this?',
    });
    expect(message.toSessionId).toBe(target.id);
    expect(message.status).toBe('delivered');
    expect(calls).toEqual([target.id]);
  });

  test('toProject equal to a chat id resolves to that chat', async () => {
    const sender = await seedProjectSession('Pasted sender', '/tmp/kory-paste-a');
    const target = await seedProjectSession('Pasted target', '/tmp/kory-paste-b');
    const calls: string[] = [];
    configureAgentMail({ kory: pushKory(calls), sessions });

    const message = await sendAgentMessage({
      fromSessionId: sender.id,
      fromAgentId: 'kory-manager',
      fromRole: 'manager',
      fromLabel: '(a) manager',
      toProject: target.id,
      subject: 'Pasted id',
      body: 'body',
    });
    expect(message.toSessionId).toBe(target.id);
  });

  test('an ambiguous project name errors listing both candidate chat ids', async () => {
    const sender = await seedProjectSession('Amb sender', '/tmp/kory-amb-other');
    const first = await seedProjectSession('Amb first', '/tmp/kory-amb-shared');
    const second = await seedProjectSession('Amb second', '/tmp/kory-amb-shared');
    configureAgentMail({ kory: fakeKory(), sessions });

    const attempt = sendAgentMessage({
      fromSessionId: sender.id,
      fromAgentId: 'kory-manager',
      fromRole: 'manager',
      fromLabel: '(other) manager',
      toProject: 'kory-amb-shared',
      subject: 'Ambiguous',
      body: 'body',
    });
    await expect(attempt).rejects.toBeInstanceOf(AgentMessageTargetError);
    await expect(attempt).rejects.toThrow(first.id);
    await expect(attempt).rejects.toThrow(second.id);
    await expect(attempt).rejects.toThrow('toSessionId');
  });

  test('the sender is excluded from name matching in a shared folder', async () => {
    const sender = await seedProjectSession('Shared sender', '/tmp/kory-self-shared');
    const sibling = await seedProjectSession('Shared sibling', '/tmp/kory-self-shared');
    const calls: string[] = [];
    configureAgentMail({ kory: pushKory(calls), sessions });

    // Only two chats share the folder; without sender exclusion the sender
    // would silently mail itself.
    const message = await sendAgentMessage({
      fromSessionId: sender.id,
      fromAgentId: 'kory-manager',
      fromRole: 'manager',
      fromLabel: '(shared) manager',
      toProject: 'kory-self-shared',
      subject: 'Sibling',
      body: 'body',
    });
    expect(message.toSessionId).toBe(sibling.id);
    expect(message.toSessionId).not.toBe(sender.id);
  });

  test('a manager message to another chat in the same folder is push-delivered', async () => {
    const sender = await seedProjectSession('Folder sender', '/tmp/kory-push-shared');
    const target = await seedProjectSession('Folder target', '/tmp/kory-push-shared');
    const calls: string[] = [];
    configureAgentMail({ kory: pushKory(calls), sessions });

    const message = await sendAgentMessage({
      fromSessionId: sender.id,
      fromAgentId: 'kory-manager',
      fromRole: 'manager',
      fromLabel: '(shared) manager',
      toSessionId: target.id,
      subject: 'Same folder',
      body: 'body',
    });
    expect(message.crossProject).toBe(false);
    expect(message.status).toBe('delivered');
    expect(calls).toEqual([target.id]);
  });

  test('a queued same-folder message is picked up by listDueForDelivery', async () => {
    const sender = await seedProjectSession('Due sender', '/tmp/kory-due-shared');
    const target = await seedProjectSession('Due target', '/tmp/kory-due-shared');
    const calls: string[] = [];
    configureAgentMail({ kory: pushKory(calls, 'queue'), sessions });

    const message = await sendAgentMessage({
      fromSessionId: sender.id,
      fromAgentId: 'kory-manager',
      fromRole: 'manager',
      fromLabel: '(shared) manager',
      toSessionId: target.id,
      subject: 'Busy target',
      body: 'body',
    });
    expect(message.status).toBe('queued');
    const due = await listDueForDelivery(new Date(Date.now() + 60_000));
    expect(due.map((entry) => entry.id)).toContain(message.id);
  });

  test('same-session worker to manager mail is still pull-only', async () => {
    const sender = await seedProjectSession('Pull project', '/tmp/kory-pull-own');
    const calls: string[] = [];
    configureAgentMail({ kory: pushKory(calls), sessions });

    const message = await sendAgentMessage({
      fromSessionId: sender.id,
      fromAgentId: 'worker-abc123',
      fromRole: 'worker',
      fromLabel: 'backend agent',
      subject: 'Need a decision',
      body: 'body',
    });
    expect(message.toSessionId).toBe(sender.id);
    expect(message.status).toBe('queued');
    expect(calls).toEqual([]);
  });

  test('a worker-addressed message to another chat is not pushed', async () => {
    const sender = await seedProjectSession('WtoW sender', '/tmp/kory-w2w-shared');
    const target = await seedProjectSession('WtoW target', '/tmp/kory-w2w-shared');
    const calls: string[] = [];
    configureAgentMail({
      kory: pushKory(calls, 'accept', {
        workers: { [target.id]: [uiWorker] },
      }),
      sessions,
    });

    const message = await sendAgentMessage({
      fromSessionId: sender.id,
      fromAgentId: 'kory-manager',
      fromRole: 'manager',
      fromLabel: '(shared) manager',
      toSessionId: target.id,
      toAgent: { role: 'worker', label: 'ui agent' },
      subject: 'Worker handoff',
      body: 'body',
    });
    expect(message.toRole).toBe('worker');
    expect(message.toAgentId).toBe('worker-ui42');
    expect(message.status).toBe('queued');
    expect(calls).toEqual([]);
  });

  test('an archived chat cannot be targeted by id', async () => {
    const sender = await seedProjectSession('Arc sender', '/tmp/kory-arc-a');
    const target = await seedProjectSession('Arc target', '/tmp/kory-arc-b');
    await sessions.archive(target.id);
    configureAgentMail({ kory: fakeKory(), sessions });

    await expect(
      sendAgentMessage({
        fromSessionId: sender.id,
        fromAgentId: 'kory-manager',
        fromRole: 'manager',
        fromLabel: '(a) manager',
        toSessionId: target.id,
        subject: 'Archived',
        body: 'body',
      }),
    ).rejects.toThrow('archived');
  });
});
