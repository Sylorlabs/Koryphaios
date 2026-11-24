// Stop semantics shared by the user's Stop button and the agent interrupt_chat
// tool. Both must cancel the same things, in the same order, or an agent-driven
// stop could leave work running that the user's Stop would have ended.

import { getContext } from '../context';

export interface StopChatRunOptions {
  /** A steer is a cancel-and-continue handoff: no visible "cancelled" banner. */
  steering?: boolean;
  /** Banner text for the transcript when not steering. */
  message?: string;
}

/** Cancel the chat's active run, its workers, pending goal drive and queued
 *  LLM jobs, then tell the chat's clients. The stop response never waits on
 *  the follow-up goal and queue cleanup. */
export async function stopChatRun(
  sessionId: string,
  options: StopChatRunOptions = {},
): Promise<void> {
  const { kory, goalDriver, wsManager } = getContext();
  await kory.cancelSessionWorkers(sessionId);
  void goalDriver.pauseForSession(sessionId).catch(() => undefined);
  void import('../queue/workers/llm-worker')
    .then(({ cancelLLMJobsForSession }) => cancelLLMJobsForSession(sessionId))
    .catch(() => undefined);
  if (options.steering) return;
  wsManager.broadcastToSession(sessionId, {
    type: 'system.info',
    payload: { message: options.message ?? 'Session cancelled' },
    timestamp: Date.now(),
    sessionId,
  });
}
