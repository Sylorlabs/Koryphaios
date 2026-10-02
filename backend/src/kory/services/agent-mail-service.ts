// AgentMailService — routes inter-agent messages between sessions/projects.
//
// Delivery model:
// - Cross-project messages to another session's manager are queued; a retry
//   loop injects them as a session turn (via startSessionTurn) once the
//   target manager's session is idle.
// - Same-session messages (worker → manager, worker → worker) are pulled by
//   the target agent through the list_agent_messages tool.
// - Workers may only ever address their own session. Reaching another
//   project's manager requires the manager to forward via request_manager_relay.

import { basename, resolve } from 'node:path';
import type { AgentMessage, AgentMessageStatus } from '@koryphaios/shared';
import { serverLog } from '../../logger';
import {
  insertAgentMessage,
  listDueForDelivery,
  listInboxForSession,
  getAgentMessage,
  updateAgentMessageStatus,
} from '../../stores/agent-message-store';
import { loadAgentSettings } from '../../agent-settings';
import type { SessionStore } from '../../stores/session-store';
import type { KoryManager } from '../manager';

export type AgentMessagingPolicy = 'open' | 'approval-cross-project' | 'off';

const MAX_BODY_LENGTH = 20_000;
const MAX_SUBJECT_LENGTH = 200;
const DELIVERY_POLL_INTERVAL_MS = 5_000;
const DELIVERY_RETRY_AFTER_MS = 3_000;
const MAX_DELIVERY_ATTEMPTS = 60;

export class AgentMessagingDisabledError extends Error {
  constructor() {
    super('Inter-agent messaging is disabled in agent settings');
    this.name = 'AgentMessagingDisabledError';
  }
}

export class AgentMessageTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentMessageTargetError';
  }
}

export interface SendAgentMessageInput {
  fromSessionId: string;
  fromAgentId: string;
  fromRole: 'manager' | 'worker';
  fromLabel: string;
  /** Explicit target session id, or a project name/path resolved against active sessions. */
  toSessionId?: string;
  toProject?: string;
  /** Target agent within the receiving session. Omitted = session manager. */
  toAgent?: { role: 'manager' } | { role: 'worker'; agentId?: string; label?: string };
  subject: string;
  body: string;
  replyToMessageId?: string;
}

interface AgentMailConfig {
  kory: KoryManager;
  sessions: SessionStore;
}

let config: AgentMailConfig | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
const deliveryAttempts = new Map<string, number>();

/** Wire the runtime dependencies. Called once during backend bootstrap. */
export function configureAgentMail(next: AgentMailConfig): void {
  config = next;
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    void deliverDueMessages().catch((err: unknown) => {
      serverLog.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'agent mail delivery tick failed',
      );
    });
  }, DELIVERY_POLL_INTERVAL_MS);
  if (typeof pollTimer.unref === 'function') pollTimer.unref();
}

/** Stop the delivery loop (tests, shutdown). */
export function resetAgentMail(): void {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  config = null;
  deliveryAttempts.clear();
}

function requireConfig(): AgentMailConfig {
  if (!config) throw new Error('AgentMail is not configured');
  return config;
}

function projectLabelForSession(session: { title: string; workingDirectory?: string }): string {
  const project = session.workingDirectory ? basename(session.workingDirectory) : '';
  return project || session.title;
}

function sanitize(value: string, max: number, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new AgentMessageTargetError(`${field} is required`);
  if (trimmed.length > max) throw new AgentMessageTargetError(`${field} exceeds ${max} characters`);
  return trimmed;
}

async function resolveTargetSession(input: {
  toSessionId?: string;
  toProject?: string;
}): Promise<{ id: string; title: string; workingDirectory?: string }> {
  const { sessions } = requireConfig();
  const active = await sessions.listActive();
  if (input.toSessionId) {
    const direct = active.find((session) => session.id === input.toSessionId);
    if (!direct) throw new AgentMessageTargetError(`No active session '${input.toSessionId}'`);
    return direct;
  }
  const query = (input.toProject ?? '').trim();
  if (!query) throw new AgentMessageTargetError('A target project or session is required');
  const normalized = query.toLowerCase();
  const match = active.find((session) => {
    if (session.workingDirectory) {
      const dir = resolve(session.workingDirectory).toLowerCase();
      if (dir === normalized || basename(dir) === basename(normalized)) return true;
    }
    return session.title.toLowerCase() === normalized;
  });
  if (!match) {
    throw new AgentMessageTargetError(
      `No active session found for project '${query}'. Cross-project messaging targets the manager session of another open project.`,
    );
  }
  return match;
}

export async function sendAgentMessage(input: SendAgentMessageInput): Promise<AgentMessage> {
  const { kory, sessions } = requireConfig();

  const body = sanitize(input.body, MAX_BODY_LENGTH, 'Message body');
  const subject = sanitize(input.subject || '(no subject)', MAX_SUBJECT_LENGTH, 'Subject');

  const allActive = await sessions.listActive();
  const senderSession = allActive.find((session) => session.id === input.fromSessionId);
  if (!senderSession) {
    throw new AgentMessageTargetError(`Sender session '${input.fromSessionId}' is not active`);
  }
  const target = await resolveTargetSession({
    toSessionId: input.toSessionId ?? (input.toProject ? undefined : input.fromSessionId),
    toProject: input.toProject,
  });

  const senderDir = senderSession.workingDirectory
    ? resolve(senderSession.workingDirectory)
    : undefined;
  const targetDir = target.workingDirectory ? resolve(target.workingDirectory) : undefined;
  const crossProject = Boolean(senderDir && targetDir && senderDir !== targetDir);

  // Authority rules: workers stay inside their own project; cross-project
  // contact is strictly manager-to-manager. Fail closed.
  if (input.fromRole === 'worker' && crossProject) {
    throw new AgentMessageTargetError(
      'Workers cannot message other projects. Ask your manager (kory__request_manager_relay) to forward this request.',
    );
  }
  if (crossProject && input.toAgent && input.toAgent.role !== 'manager') {
    throw new AgentMessageTargetError('Cross-project messages may only target the project manager');
  }

  const settings = loadAgentSettings(senderDir ?? process.cwd());
  const policy: AgentMessagingPolicy = settings.agentMessaging ?? 'open';
  if (policy === 'off') throw new AgentMessagingDisabledError();

  const targetIsManager = !input.toAgent || input.toAgent.role === 'manager';
  const toLabel = targetIsManager
    ? `(${projectLabelForSession(target)}) manager`
    : input.toAgent && 'label' in input.toAgent && input.toAgent.label
      ? input.toAgent.label
      : 'worker agent';

  let status: AgentMessageStatus = 'queued';
  let statusReason: string | undefined;
  if (policy === 'approval-cross-project' && crossProject) {
    status = 'pending_approval';
    statusReason = 'Cross-project messaging requires user approval in the current policy';
  }

  const message = await insertAgentMessage({
    fromSessionId: input.fromSessionId,
    fromAgentId: input.fromAgentId,
    fromRole: input.fromRole,
    fromLabel: input.fromLabel,
    toSessionId: target.id,
    toAgentId: targetIsManager
      ? undefined
      : input.toAgent && 'agentId' in input.toAgent
        ? input.toAgent.agentId
        : undefined,
    toRole: targetIsManager ? 'manager' : 'worker',
    toLabel,
    crossProject,
    isRelayRequest: false,
    subject,
    body,
    replyToMessageId: input.replyToMessageId,
    status,
    statusReason,
  });

  if (input.replyToMessageId) {
    const answered = await updateAgentMessageStatus(input.replyToMessageId, 'answered', {
      reply: body,
    });
    if (answered) {
      kory.emitAgentMessageEvent(answered.fromSessionId, answered);
      kory.emitAgentMessageEvent(answered.toSessionId, answered);
    }
  }

  kory.emitAgentMessageEvent(input.fromSessionId, message);
  kory.emitAgentMessageEvent(target.id, message);

  if (status === 'queued' && crossProject) {
    // Push delivery across sessions; the retry loop covers busy targets.
    // Same-session mail (worker ↔ manager/worker) is pulled via the inbox tool.
    await attemptDelivery(message).catch((err: unknown) => {
      serverLog.warn(
        { err: err instanceof Error ? err.message : String(err), messageId: message.id },
        'immediate agent message delivery failed; will retry',
      );
    });
    const refreshed = await getAgentMessage(message.id);
    return refreshed ?? message;
  }
  return message;
}

/** Build the turn text injected into the receiving manager's conversation. */
export function renderAgentMessageEnvelope(message: AgentMessage): string {
  const lines = [
    `[Agent message from ${message.fromLabel}] Subject: ${message.subject}`,
    message.body,
    `(Reply with send_agent_message and replyToMessageId: ${message.id})`,
  ];
  return lines.join('\n\n');
}

/** Attempt one delivery of a queued cross-project message. Returns final status. */
export async function attemptDelivery(message: AgentMessage): Promise<AgentMessageStatus> {
  const { kory } = requireConfig();
  if (message.status !== 'queued') return message.status;
  const submission = await kory.startSessionTurn({
    sessionId: message.toSessionId,
    source: 'internal',
    sourceCommandId: `agent-msg-${message.id}`,
    userMessage: renderAgentMessageEnvelope(message),
  });
  if (submission.accepted) {
    void submission.completion.catch(() => undefined);
    deliveryAttempts.delete(message.id);
    const updated = await updateAgentMessageStatus(message.id, 'delivered');
    requireConfig().kory.emitAgentMessageEvent(message.toSessionId, updated ?? message);
    return 'delivered';
  }
  const attempts = (deliveryAttempts.get(message.id) ?? 0) + 1;
  deliveryAttempts.set(message.id, attempts);
  if (submission.result.status === 'rejected' && attempts < MAX_DELIVERY_ATTEMPTS) {
    return 'queued';
  }
  const reason =
    attempts >= MAX_DELIVERY_ATTEMPTS
      ? 'Target manager session never became idle'
      : `Turn not accepted (${submission.result.status})`;
  deliveryAttempts.delete(message.id);
  await updateAgentMessageStatus(message.id, 'failed', { statusReason: reason });
  return 'failed';
}

async function deliverDueMessages(): Promise<void> {
  const due = await listDueForDelivery(new Date(Date.now() - DELIVERY_RETRY_AFTER_MS));
  for (const message of due) {
    try {
      await attemptDelivery(message);
    } catch (err: unknown) {
      serverLog.debug(
        { err: err instanceof Error ? err.message : String(err), messageId: message.id },
        'agent mail delivery attempt failed',
      );
    }
  }
}

export interface RelayRequestInput {
  sessionId: string;
  workerId: string;
  workerLabel: string;
  toProject: string;
  subject: string;
  body: string;
}

/** Persist a worker's relay request addressed to its own manager. The manager
 *  runtime decides whether to forward (see KoryManager.handleRelayRequest). */
export async function fileRelayRequest(input: RelayRequestInput): Promise<AgentMessage> {
  const { kory, sessions } = requireConfig();
  const all = await sessions.listActive();
  const session = all.find((candidate) => candidate.id === input.sessionId);
  if (!session) throw new AgentMessageTargetError(`Session '${input.sessionId}' is not active`);
  const message = await insertAgentMessage({
    fromSessionId: input.sessionId,
    fromAgentId: input.workerId,
    fromRole: 'worker',
    fromLabel: input.workerLabel,
    toSessionId: input.sessionId,
    toRole: 'manager',
    toLabel: `(${projectLabelForSession(session)}) manager`,
    crossProject: false,
    isRelayRequest: true,
    subject: sanitize(input.subject || '(no subject)', MAX_SUBJECT_LENGTH, 'Subject'),
    body: sanitize(input.body, MAX_BODY_LENGTH, 'Message body'),
    status: 'delivered',
  });
  kory.emitAgentMessageEvent(input.sessionId, message);
  return message;
}

/** Manager declined to forward a worker's relay request. */
export async function declineRelayRequest(id: string, reason: string): Promise<void> {
  const { kory } = requireConfig();
  const declined = await updateAgentMessageStatus(id, 'declined', {
    statusReason: reason || 'Manager declined to relay',
  });
  if (declined) kory.emitAgentMessageEvent(declined.toSessionId, declined);
}

/** User approval entry point for the approval-cross-project policy. */
export async function approveAgentMessage(
  id: string,
  approved: boolean,
): Promise<AgentMessage | null> {
  const existing = await getAgentMessage(id);
  if (!existing || existing.status !== 'pending_approval') return null;
  if (!approved) {
    const declined = await updateAgentMessageStatus(id, 'declined', {
      statusReason: 'Declined by user',
    });
    if (declined) {
      requireConfig().kory.emitAgentMessageEvent(declined.fromSessionId, declined);
      requireConfig().kory.emitAgentMessageEvent(declined.toSessionId, declined);
    }
    return declined;
  }
  const queued = await updateAgentMessageStatus(id, 'queued');
  if (!queued) return null;
  const finalStatus = await attemptDelivery(queued);
  return (await getAgentMessage(id)) ?? { ...queued, status: finalStatus };
}

/** Pull-based inbox for an agent in the target session. Same-session and
 *  worker-addressed messages are marked delivered once observed. */
export async function drainInbox(sessionId: string, agentId?: string): Promise<AgentMessage[]> {
  const inbox = await listInboxForSession(sessionId);
  const { kory } = requireConfig();
  const visible: AgentMessage[] = [];
  for (const message of inbox) {
    const addressedToAgent = message.toAgentId ? message.toAgentId === agentId : true;
    const sameSession = message.toSessionId === sessionId && message.fromSessionId === sessionId;
    if (!addressedToAgent && message.status !== 'delivered') continue;
    if (message.status === 'queued' && sameSession) {
      const delivered = await updateAgentMessageStatus(message.id, 'delivered');
      if (delivered) kory.emitAgentMessageEvent(sessionId, delivered);
      visible.push(delivered ?? message);
      continue;
    }
    visible.push(message);
  }
  return visible;
}
