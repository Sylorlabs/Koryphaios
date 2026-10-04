import { realpathSync } from 'node:fs';
import type { ChatGitSwitchRequest } from '@koryphaios/shared';
import { getContext } from '../context';
import { ConflictError, NotFoundError, ValidationError } from '../errors/types';
import { ChatGit } from '../kory/chat-git';
import { processSupervisor } from '../process-supervisor/supervisor';
import { withSessionRecoveryGuard } from '../routes/v1/session-recovery-guard';
import { getSessionReview } from '../stores/session-review-store';
import {
  hasExclusiveWorkspaceOperation,
  tryAcquireWorkspaceOperation,
} from '../tools/workspace-operation-gate';

export function requireGitSessionId(request: Request): string {
  const id = request.headers.get('x-koryphaios-session')?.trim();
  if (!id)
    throw new ValidationError(
      'Select a chat before using Git. Project-wide checkout is not supported here.',
    );
  return id;
}

export async function chatGitForSession(sessionId: string) {
  const { sessions, kory } = getContext();
  const existing = await sessions.get(sessionId);
  if (!existing) throw new NotFoundError('Session', sessionId);
  if (existing.archivedAt !== undefined)
    throw new ConflictError('Recover this archived chat before accessing its Git workspace.');
  const directory = await kory.resolveSessionWorkingDirectoryPublic(sessionId);
  const session = await sessions.get(sessionId);
  if (!session?.gitWorkspace || session.archivedAt !== undefined)
    throw new ConflictError('This chat’s workspace changed. Refresh and try again.');
  if (realpathSync(session.gitWorkspace.path) !== realpathSync(directory))
    throw new ConflictError('The chat workspace binding changed.');
  return { session, git: new ChatGit(directory), directory };
}

/** UI Git writes share the same workspace/worker barriers as revision switching. */
export async function withChatGitMutation<T>(
  sessionId: string,
  run: (directory: string) => Promise<T>,
): Promise<T> {
  const lease = tryAcquireWorkspaceOperation(sessionId, true);
  if (!lease) throw new ConflictError('Another tool is using this chat’s workspace.');
  try {
    return await withSessionRecoveryGuard({
      tryAcquireManager: () => getContext().kory.tryAcquireSessionMutationBarrier(sessionId),
      tryAcquireProcess: () => processSupervisor.tryAcquireAgentToolBarrier(sessionId),
      onBusy: () => {
        throw new ConflictError('Finish active chat work before using Git actions.');
      },
      run: async () => {
        const { directory } = await chatGitForSession(sessionId);
        const review = await getSessionReview(sessionId);
        if (review?.status === 'pending' || review?.status === 'rejecting')
          throw new ConflictError(
            'Resolve this chat’s pending change review before using Git actions.',
          );
        return run(directory);
      },
    });
  } finally {
    lease.release();
  }
}

export async function switchChatGit(
  sessionId: string,
  input: ChatGitSwitchRequest,
  agent?: { workingDirectory: string; signal?: AbortSignal },
) {
  const { kory, sessions, wsManager } = getContext();
  // The agent's exclusive lease must come from ToolRegistry, not tool arguments.
  if (agent && !hasExclusiveWorkspaceOperation(sessionId))
    throw new ConflictError('Git switching must run through the exclusive tool pipeline.');
  const uiLease = agent ? undefined : tryAcquireWorkspaceOperation(sessionId, true);
  if (!agent && !uiLease)
    throw new ConflictError('Another tool is using this chat’s workspace. Wait before switching.');
  try {
    return await withSessionRecoveryGuard({
      tryAcquireManager: () =>
        agent
          ? kory.tryAcquireAgentGitMutationBarrier(sessionId)
          : kory.tryAcquireSessionMutationBarrier(sessionId),
      tryAcquireProcess: () => processSupervisor.tryAcquireAgentToolBarrier(sessionId),
      onBusy: () => {
        throw new ConflictError(
          'Finish active chat work, workers, and agent background terminals before switching revisions.',
        );
      },
      run: async () => {
        const { session, git, directory } = await chatGitForSession(sessionId);
        if (agent && realpathSync(agent.workingDirectory) !== realpathSync(directory))
          throw new ValidationError(
            'Only the manager in this chat’s own checkout may switch its revision.',
          );
        const review = await getSessionReview(sessionId);
        if (review?.status === 'pending' || review?.status === 'rejecting')
          throw new ConflictError(
            'Resolve this chat’s pending change review before switching revisions.',
          );
        agent?.signal?.throwIfAborted();
        const selection = await git.switch(input, agent?.signal);
        const updated = await sessions.update(
          sessionId,
          {
            gitWorkspace: { ...session.gitWorkspace!, selection },
          },
          session.version,
        );
        if (!updated)
          throw new ConflictError(
            `Git switched this chat to ${selection.branch}, but its metadata changed concurrently. Refresh Git state before continuing; no checkout was discarded.`,
          );
        wsManager.broadcastToSession(sessionId, {
          type: 'session.updated',
          payload: { session: updated },
          sessionId,
          timestamp: Date.now(),
        });
        return git.state(sessionId, selection);
      },
    });
  } finally {
    uiLease?.release();
  }
}
