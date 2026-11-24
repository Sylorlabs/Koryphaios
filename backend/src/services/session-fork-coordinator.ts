// Chat fork orchestration shared by the HTTP routes, the `fork_chat` agent tool
// and the kory MCP bridge. The DB work lives in session-fork-service.ts; this
// module adds the lifecycle guards and publishes the session events so every
// client sees a fork appear and a merge land without reloading.

import type { Session, WSEventType } from '@koryphaios/shared';
import { getContext } from '../context';
import { serverLog } from '../logger';
import { ConflictError, NotFoundError, ValidationError } from '../errors/types';
import { writeAllCliRulesAndSkills } from '../providers/cli-rules-skills';
import { setSessionAgentOverrides } from '../stores/session-agent-overrides';
import { tryAcquireSessionCreationLease } from './session-erasure-service';
import {
  buildForkMergeDigest,
  commitForkMerge,
  forkSessionAtMessage,
  type ForkMergeMode,
  type ForkSessionResult,
} from './session-fork-service';

interface Lease {
  release(): void;
}

export interface ForkCoordinatorDependencies {
  getSession(id: string): Promise<Session | undefined>;
  tryAcquireCreationLease(): Lease | null;
  /** The chat's mutation barrier: refuses while a turn, worker or compaction is live. */
  tryAcquireMutationBarrier(sessionId: string): Lease | null;
  prepareForkedSession(session: Session): void;
  publish(type: WSEventType, sessionId: string, payload: Record<string, unknown>): void;
}

function productionDependencies(): ForkCoordinatorDependencies {
  const { sessions, kory, wsManager } = getContext();
  return {
    getSession: (id) => sessions.get(id),
    tryAcquireCreationLease: () => tryAcquireSessionCreationLease(),
    tryAcquireMutationBarrier: (id) => kory.tryAcquireSessionMutationBarrier(id),
    prepareForkedSession: (session) => {
      try {
        writeAllCliRulesAndSkills(session.id, '');
      } catch (err: unknown) {
        // Expected failure: CLI rules are supplementary, not request-critical.
        serverLog.warn({ err, sessionId: session.id }, 'Failed to write CLI rules + skills');
      }
      if (session.agentOverrides) setSessionAgentOverrides(session.id, session.agentOverrides);
    },
    publish: (type, sessionId, payload) =>
      wsManager.broadcastEphemeral({ type, sessionId, timestamp: Date.now(), payload }),
  };
}

export interface ForkChatRequest {
  /** The chat to fork. Defaults to the chat the caller is acting in. */
  sourceSessionId: string;
  messageId?: string;
  title?: string;
}

export interface ForkChatOutcome extends ForkSessionResult {
  sourceSessionId: string;
}

/**
 * Create a fork of a chat. Forking reads the source and writes only a new chat,
 * so an archived or busy source can be forked; the in-flight rule in the service
 * keeps a running turn's unfinished message out of the copy.
 *
 * Publishes `session.updated` for the new fork (lifecycle, like `session.created`)
 * and `session.forked` on the source, which is session-bound.
 */
export async function forkChatCoordinated(
  request: ForkChatRequest,
  dependencies?: ForkCoordinatorDependencies,
): Promise<ForkChatOutcome> {
  const deps = dependencies ?? productionDependencies();
  if (!(await deps.getSession(request.sourceSessionId))) {
    throw new NotFoundError('Session', request.sourceSessionId);
  }

  const lease = deps.tryAcquireCreationLease();
  if (!lease) {
    throw new ConflictError(
      'Session creation is temporarily blocked while delete-all is finishing.',
    );
  }
  let result: ForkSessionResult;
  try {
    result = forkSessionAtMessage({
      sourceSessionId: request.sourceSessionId,
      messageId: request.messageId,
      title: request.title,
    });
  } finally {
    lease.release();
  }

  const { session } = result;
  deps.prepareForkedSession(session);
  deps.publish('session.updated', session.id, { session });
  deps.publish('session.forked', request.sourceSessionId, {
    sourceSessionId: request.sourceSessionId,
    forkMessageId: result.forkMessageId,
    copiedMessageCount: result.copiedMessageCount,
    session,
  });
  return { ...result, sourceSessionId: request.sourceSessionId };
}

export interface MergeForkOutcome {
  fork: Session;
  source: Session;
  messageId: string;
  mode: ForkMergeMode;
}

/**
 * Append a fork's result to its source transcript and mark the fork merged.
 *
 * `summary` appends a deterministic digest of the fork's new work (its first
 * request and last reply). `messages` quotes the new messages, newest first
 * within a fixed budget. Both are written as a host-authored `system` entry, not
 * a user turn, so no provider run starts. Each fork merges once.
 *
 * Both chats' mutation barriers are held for the whole write, so a turn cannot
 * start in either chat between the check and the append.
 */
export async function mergeForkCoordinated(
  request: { forkSessionId: string; mode: ForkMergeMode },
  dependencies?: ForkCoordinatorDependencies,
): Promise<MergeForkOutcome> {
  const deps = dependencies ?? productionDependencies();
  if (request.mode !== 'summary' && request.mode !== 'messages') {
    throw new ValidationError("Choose a merge mode: 'summary' or 'messages'.");
  }
  const fork = await deps.getSession(request.forkSessionId);
  if (!fork) throw new NotFoundError('Session', request.forkSessionId);
  const sourceId = fork.forkedFromSessionId;
  if (!sourceId) {
    throw new ValidationError(
      'This chat was not forked from another chat, so there is nothing to merge back.',
    );
  }
  if (!(await deps.getSession(sourceId))) {
    throw new ConflictError('The chat this fork came from no longer exists.');
  }

  const sourceLease = deps.tryAcquireMutationBarrier(sourceId);
  if (!sourceLease) {
    throw new ConflictError('Wait for active work in the source chat to finish before merging.');
  }
  const forkLease = deps.tryAcquireMutationBarrier(request.forkSessionId);
  if (!forkLease) {
    sourceLease.release();
    throw new ConflictError('Wait for active work in the fork to finish before merging.');
  }
  try {
    const digest = await buildForkMergeDigest({
      forkSessionId: request.forkSessionId,
      mode: request.mode,
    });
    const { messageId } = await commitForkMerge(digest);
    const forkNow = await deps.getSession(request.forkSessionId);
    const sourceNow = await deps.getSession(sourceId);
    if (!forkNow || !sourceNow) {
      throw new ConflictError('A chat disappeared while its fork was being merged.');
    }
    deps.publish('session.updated', request.forkSessionId, { session: forkNow });
    deps.publish('session.updated', sourceId, { session: sourceNow });
    deps.publish('session.merged', sourceId, {
      sourceSessionId: sourceId,
      forkSessionId: request.forkSessionId,
      mode: request.mode,
      messageId,
    });
    return { fork: forkNow, source: sourceNow, messageId, mode: request.mode };
  } finally {
    forkLease.release();
    sourceLease.release();
  }
}
