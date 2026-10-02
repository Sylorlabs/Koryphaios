import { describe, expect, test } from 'bun:test';
import { SessionStore } from './session-store';
import {
  getAgentMessage,
  insertAgentMessage,
  listDueForDelivery,
  listInboxForSession,
  listThreadActivity,
  updateAgentMessageStatus,
} from './agent-message-store';

const sessions = new SessionStore();

async function seedProjectSession(title: string, workingDirectory: string) {
  const session = await sessions.create('local-user', title);
  await sessions.update(session.id, { workingDirectory });
  return session;
}

describe('agent message store', () => {
  test('round-trips a cross-project message through SQLite', async () => {
    const sender = await seedProjectSession('Sender project', '/tmp/kory-sender');
    const target = await seedProjectSession('Target project', '/tmp/kory-target');

    const created = await insertAgentMessage({
      fromSessionId: sender.id,
      fromAgentId: 'kory-manager',
      fromRole: 'manager',
      fromLabel: '(sender) manager',
      toSessionId: target.id,
      toRole: 'manager',
      toLabel: '(target) manager',
      crossProject: true,
      subject: 'Add a parser hook',
      body: 'Please expose a parser hook the compiler project can consume.',
      status: 'queued',
    });

    expect(created.id).toBeTruthy();
    expect(created.status).toBe('queued');
    const loaded = await getAgentMessage(created.id);
    expect(loaded?.toLabel).toBe('(target) manager');
    expect(loaded?.crossProject).toBe(true);
  });

  test('replies inherit the thread id of the parent message', async () => {
    const sender = await seedProjectSession('Thread sender', '/tmp/kory-thread-a');
    const target = await seedProjectSession('Thread target', '/tmp/kory-thread-b');
    const parent = await insertAgentMessage({
      fromSessionId: sender.id,
      fromAgentId: 'kory-manager',
      fromRole: 'manager',
      fromLabel: '(a) manager',
      toSessionId: target.id,
      toRole: 'manager',
      toLabel: '(b) manager',
      crossProject: true,
      subject: 'Question',
      body: 'What is the API shape?',
      status: 'delivered',
    });
    const reply = await insertAgentMessage({
      fromSessionId: target.id,
      fromAgentId: 'kory-manager',
      fromRole: 'manager',
      fromLabel: '(b) manager',
      toSessionId: sender.id,
      toRole: 'manager',
      toLabel: '(a) manager',
      crossProject: true,
      subject: 'Re: Question',
      body: 'Here is the API shape.',
      replyToMessageId: parent.id,
      status: 'queued',
    });
    expect(reply.threadId).toBe(parent.threadId);

    const answered = await updateAgentMessageStatus(parent.id, 'answered', {
      reply: 'Here is the API shape.',
    });
    expect(answered?.status).toBe('answered');
    expect(answered?.reply).toContain('API shape');
    expect(answered?.answeredAt).toBeTruthy();
  });

  test('delivery retry only picks up queued cross-project mail past the backoff window', async () => {
    const sender = await seedProjectSession('Retry sender', '/tmp/kory-retry-a');
    const target = await seedProjectSession('Retry target', '/tmp/kory-retry-b');

    const cross = await insertAgentMessage({
      fromSessionId: sender.id,
      fromAgentId: 'kory-manager',
      fromRole: 'manager',
      fromLabel: '(a) manager',
      toSessionId: target.id,
      toRole: 'manager',
      toLabel: '(b) manager',
      crossProject: true,
      subject: 'Retry me',
      body: 'body',
      status: 'queued',
    });
    const sameSession = await insertAgentMessage({
      fromSessionId: sender.id,
      fromAgentId: 'worker-abc',
      fromRole: 'worker',
      fromLabel: 'backend agent',
      toSessionId: sender.id,
      toRole: 'manager',
      toLabel: '(a) manager',
      crossProject: false,
      subject: 'Pull me',
      body: 'body',
      status: 'queued',
    });

    // Fresh messages are inside the backoff window and must not be due yet.
    const dueNow = await listDueForDelivery(new Date(Date.now() - 3_000));
    expect(dueNow.find((message) => message.id === cross.id)).toBeUndefined();

    const dueLater = await listDueForDelivery(new Date(Date.now() + 10_000));
    expect(dueLater.some((message) => message.id === cross.id)).toBe(true);
    // Same-session pull-based mail never enters the push retry loop.
    expect(dueLater.some((message) => message.id === sameSession.id)).toBe(false);
  });

  test('inbox and thread activity cover both directions for the UI', async () => {
    const sender = await seedProjectSession('Audit sender', '/tmp/kory-audit-a');
    const target = await seedProjectSession('Audit target', '/tmp/kory-audit-b');
    const message = await insertAgentMessage({
      fromSessionId: sender.id,
      fromAgentId: 'kory-manager',
      fromRole: 'manager',
      fromLabel: '(a) manager',
      toSessionId: target.id,
      toRole: 'manager',
      toLabel: '(b) manager',
      crossProject: true,
      subject: 'Audit me',
      body: 'body',
      status: 'delivered',
    });

    const targetInbox = await listInboxForSession(target.id);
    expect(targetInbox.some((candidate) => candidate.id === message.id)).toBe(true);

    const senderActivity = await listThreadActivity(sender.id);
    expect(senderActivity.some((candidate) => candidate.id === message.id)).toBe(true);
    const targetActivity = await listThreadActivity(target.id);
    expect(targetActivity.some((candidate) => candidate.id === message.id)).toBe(true);
  });
});
