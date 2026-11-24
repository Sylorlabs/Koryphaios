/**
 * Admission of restart continuations, run once after the manager is built.
 *
 * `recoverInterruptedRuns` records a pending continuation per interrupted run.
 * This pass drains those records through the manager's admission callback. The
 * callback is `KoryManager.admitRestartContinuation`, which goes through
 * `startSessionTurn`, so the continuation has the same ledger, idempotency and
 * busy-session rules as any other turn.
 *
 * Outcomes per record:
 *   - admitted: a command now owns the continuation (accepted, parked as a
 *     steer, or an existing receipt replayed). Never admitted again.
 *   - deferred: the session was busy. The record stays pending for the next boot.
 *   - skipped: the continuation cannot run (disabled, archived, erased, or the
 *     admission threw). Recorded with the reason so it is not retried forever.
 */

import { serverLog } from '../logger';
import { deriveSessionTurnCommandIdentity } from './session-run-store';
import type { SessionTurnSubmission } from '../kory/manager';
import {
  RESTART_RESUME_SOURCE_PREFIX,
  type SessionRunCoordinator,
} from './session-run-coordinator';

export interface RestartResumeAdmissionResult {
  admitted: number;
  deferred: number;
  skipped: number;
}

export type RestartContinuationAdmit = (
  sessionId: string,
  sourceRunId: string,
) => Promise<SessionTurnSubmission>;

export function restartResumeCommandKey(sessionId: string, sourceRunId: string): string {
  return deriveSessionTurnCommandIdentity({
    sessionId,
    source: 'internal',
    sourceCommandId: `${RESTART_RESUME_SOURCE_PREFIX}${sourceRunId}`,
  }).commandKey;
}

export async function admitPendingRunResumes(
  runs: SessionRunCoordinator,
  admit: RestartContinuationAdmit,
  options: { enabled: boolean },
): Promise<RestartResumeAdmissionResult> {
  const result: RestartResumeAdmissionResult = { admitted: 0, deferred: 0, skipped: 0 };
  for (const pending of runs.listPendingRunResumes()) {
    if (!options.enabled) {
      runs.markRunResumeSkipped(pending.sourceRunId, 'resume_disabled');
      result.skipped++;
      continue;
    }
    try {
      const submission = await admit(pending.sessionId, pending.sourceRunId);
      if (submission.accepted === true || submission.accepted === 'queued') {
        runs.markRunResumeAdmitted(
          pending.sourceRunId,
          restartResumeCommandKey(pending.sessionId, pending.sourceRunId),
        );
        result.admitted++;
      } else if (submission.replay !== undefined) {
        // The continuation's command already exists; its receipt is the answer.
        runs.markRunResumeAdmitted(
          pending.sourceRunId,
          restartResumeCommandKey(pending.sessionId, pending.sourceRunId),
        );
        result.admitted++;
      } else if (submission.result.reason === 'session_busy') {
        result.deferred++;
      } else {
        runs.markRunResumeSkipped(
          pending.sourceRunId,
          `not_admitted:${submission.result.reason ?? submission.result.status}`.slice(0, 200),
        );
        result.skipped++;
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      serverLog.warn(
        { sessionId: pending.sessionId, sourceRunId: pending.sourceRunId, err: message },
        'Restart continuation could not be admitted',
      );
      runs.markRunResumeSkipped(pending.sourceRunId, `admission_failed:${message}`.slice(0, 200));
      result.skipped++;
    }
  }
  return result;
}
