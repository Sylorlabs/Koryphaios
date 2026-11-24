/**
 * Automatic resume after a provider usage limit.
 *
 * When a chat turn stops on a usage limit and no fallback model succeeded, the
 * manager calls `schedule`. That writes one durable `session_pending_resumes`
 * row per session and arms a timer on the session's runtime. When the timer
 * fires, the service claims the row, admits a host-authored continuation through
 * `KoryManager.admitUsageLimitContinuation` (the normal turn path, so it is a
 * real re-check: a turn that still hits the limit comes back here), and then
 * either clears the row or reschedules on the backoff.
 *
 * Attempts are bounded: the stated reset (when the provider gave one) is tried
 * first, then 15m, 1h and 3h. After the last attempt fails the chat is left
 * paused with a message and the row is cleared as `exhausted`.
 */

import { randomUUID } from 'node:crypto';
import type { PendingResumePayload } from '@koryphaios/shared';
import { serverLog } from '../../logger';
import { USAGE_LIMIT_TEXT } from '../../providers/provider-diagnostics';
import {
  nextUsageLimitResume,
  parseUsageLimitReset,
  USAGE_LIMIT_MAX_ATTEMPTS,
  type UsageLimitReset,
} from '../../providers/usage-limit-reset';
import type { PendingResumeRecord, RunResumptionStore } from '../../runs/run-resumption-store';
import type { SessionTurnResult, SessionTurnSubmission } from '../manager';

/** A session that is busy at fire time retries after this, without using an attempt. */
export const USAGE_LIMIT_BUSY_RETRY_MS = 60_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const MAX_MESSAGE_CHARS = 400;

export interface UsageLimitAdmitInput {
  sessionId: string;
  pendingResumeId: string;
  attempt: number;
  sourceRunId: string | null;
  preferredModel?: string;
}

export interface UsageLimitResumeDeps {
  store: RunResumptionStore;
  /** Arm or clear the per-session timer on SessionRuntime. */
  setTimer(sessionId: string, timer: ReturnType<typeof setTimeout> | undefined): void;
  getTimer(sessionId: string): ReturnType<typeof setTimeout> | undefined;
  isSessionActive(sessionId: string): Promise<boolean>;
  admit(input: UsageLimitAdmitInput): Promise<SessionTurnSubmission>;
  emit(sessionId: string, payload: PendingResumePayload): void;
  now?: () => number;
}

export interface UsageLimitStop {
  /** The provider's error text for the stopped turn. */
  message: string;
  provider: string | null;
  model: string | null;
  /** The run whose partial output the continuation carries. */
  sourceRunId: string | null;
  /** Optional structured reset hints from the provider adapter. */
  hints?: Parameters<typeof parseUsageLimitReset>[2];
}

export function isUsageLimitMessage(message: string): boolean {
  return USAGE_LIMIT_TEXT.test(message);
}

function bounded(message: string): string {
  const clean = message.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return clean.length > MAX_MESSAGE_CHARS ? `${clean.slice(0, MAX_MESSAGE_CHARS - 1)}…` : clean;
}

function toPayload(record: PendingResumeRecord): PendingResumePayload {
  return {
    pendingResume: {
      id: record.id,
      reason: record.reason,
      provider: record.provider,
      model: record.model,
      resumeAt: record.resumeAt,
      attempt: record.attempt,
      maxAttempts: USAGE_LIMIT_MAX_ATTEMPTS,
      state: record.state,
      message: record.message,
    },
  };
}

export class UsageLimitResumeService {
  private readonly now: () => number;

  constructor(private readonly deps: UsageLimitResumeDeps) {
    this.now = deps.now ?? Date.now;
  }

  get(sessionId: string): PendingResumeRecord | null {
    return this.deps.store.getPendingResume(sessionId);
  }

  /**
   * A turn stopped on a usage limit. Returns the new pending record, or null when
   * a continuation is already running (its own outcome decides what happens next).
   */
  schedule(sessionId: string, stop: UsageLimitStop): PendingResumeRecord | null {
    const existing = this.get(sessionId);
    if (existing?.state === 'resuming') return null;
    const now = this.now();
    const reset: UsageLimitReset | null = parseUsageLimitReset(stop.message, now, stop.hints ?? {});
    const next = nextUsageLimitResume({ now, attempt: 0, reset });
    const record: PendingResumeRecord = {
      id: `pr-${randomUUID()}`,
      sessionId,
      reason: 'usage_limit',
      provider: stop.provider,
      model: stop.model,
      resumeAt: next.resumeAt,
      attempt: 0,
      state: 'scheduled',
      message: bounded(stop.message),
      sourceRunId: stop.sourceRunId,
      createdAt: now,
      updatedAt: now,
    };
    this.deps.store.upsertPendingResume(record);
    this.arm(sessionId, record);
    this.deps.emit(sessionId, toPayload(record));
    serverLog.info(
      { sessionId, resumeAt: record.resumeAt, source: next.source },
      'Scheduled automatic resume after a usage limit',
    );
    return record;
  }

  /** Re-arm every durable pending resume after a restart. A resume that was
   *  running when the process died goes back to scheduled and fires once now. */
  recover(): number {
    const now = this.now();
    let armed = 0;
    for (const record of this.deps.store.listPendingResumes()) {
      const next: PendingResumeRecord =
        record.state === 'resuming'
          ? { ...record, state: 'scheduled', resumeAt: now, updatedAt: now }
          : record;
      if (next !== record) this.deps.store.upsertPendingResume(next);
      this.arm(record.sessionId, next);
      armed++;
    }
    return armed;
  }

  /** The user's "Cancel". Returns false when nothing was pending. */
  cancel(sessionId: string): boolean {
    const record = this.get(sessionId);
    if (!record) return false;
    if (record.state === 'resuming') return false;
    this.clear(sessionId, 'cancelled');
    return true;
  }

  /** The user's "Resume now". Fires immediately; the same durable path as a timer. */
  async resumeNow(sessionId: string): Promise<'started' | 'not_found' | 'already_running'> {
    const record = this.get(sessionId);
    if (!record) return 'not_found';
    if (record.state === 'resuming') return 'already_running';
    this.deps.setTimer(sessionId, undefined);
    await this.fire(sessionId, record.id);
    return 'started';
  }

  private arm(sessionId: string, record: PendingResumeRecord): void {
    const previous = this.deps.getTimer(sessionId);
    if (previous !== undefined) clearTimeout(previous);
    this.deps.setTimer(sessionId, undefined);
    if (record.state !== 'scheduled') return;
    const delay = Math.max(0, Math.min(MAX_TIMER_DELAY_MS, record.resumeAt - this.now()));
    const timer = setTimeout(() => {
      this.deps.setTimer(sessionId, undefined);
      void this.fire(sessionId, record.id).catch((error: unknown) =>
        serverLog.warn(
          { sessionId, err: error instanceof Error ? error.message : String(error) },
          'Automatic usage-limit resume failed',
        ),
      );
    }, delay);
    (timer as { unref?: () => void }).unref?.();
    this.deps.setTimer(sessionId, timer);
  }

  private clear(sessionId: string, clearedReason: 'resumed' | 'cancelled' | 'exhausted'): void {
    const previous = this.deps.getTimer(sessionId);
    if (previous !== undefined) clearTimeout(previous);
    this.deps.setTimer(sessionId, undefined);
    this.deps.store.deletePendingResume(sessionId);
    this.deps.emit(sessionId, { pendingResume: null, clearedReason });
  }

  private async fire(sessionId: string, pendingId: string): Promise<void> {
    const record = this.get(sessionId);
    if (!record || record.id !== pendingId || record.state !== 'scheduled') return;

    if (!(await this.deps.isSessionActive(sessionId))) {
      this.clear(sessionId, 'cancelled');
      return;
    }

    const attempt = record.attempt + 1;
    const claimed: PendingResumeRecord = { ...record, state: 'resuming', updatedAt: this.now() };
    this.deps.store.upsertPendingResume(claimed);
    this.deps.emit(sessionId, toPayload(claimed));

    let submission: SessionTurnSubmission;
    try {
      submission = await this.deps.admit({
        sessionId,
        pendingResumeId: record.id,
        attempt,
        sourceRunId: record.sourceRunId,
        ...(record.model ? { preferredModel: record.model } : {}),
      });
    } catch (error: unknown) {
      this.failAttempt(sessionId, claimed, error instanceof Error ? error.message : String(error));
      return;
    }

    if (submission.accepted === true) {
      void submission.completion
        .then((result) => this.onOutcome(sessionId, claimed, result))
        .catch((error: unknown) =>
          this.failAttempt(
            sessionId,
            claimed,
            error instanceof Error ? error.message : String(error),
          ),
        );
      return;
    }

    if (submission.accepted === 'queued') {
      this.clear(sessionId, 'resumed');
      return;
    }

    if (submission.replay !== undefined) {
      // The continuation's command already exists. Its receipt is the outcome.
      this.onOutcome(sessionId, claimed, submission.result);
      return;
    }

    if (submission.result.reason === 'session_busy') {
      // Not an attempt: the chat is working, so try again soon.
      const retry: PendingResumeRecord = {
        ...claimed,
        state: 'scheduled',
        resumeAt: this.now() + USAGE_LIMIT_BUSY_RETRY_MS,
        updatedAt: this.now(),
      };
      this.deps.store.upsertPendingResume(retry);
      this.arm(sessionId, retry);
      this.deps.emit(sessionId, toPayload(retry));
      return;
    }

    this.failAttempt(
      sessionId,
      claimed,
      `Automatic resume was not admitted (${submission.result.reason ?? submission.result.status}).`,
    );
  }

  private onOutcome(
    sessionId: string,
    claimed: PendingResumeRecord,
    result: SessionTurnResult,
  ): void {
    if (result.status === 'completed' || result.status === 'waiting') {
      this.clear(sessionId, 'resumed');
      return;
    }
    const reason = result.reason ?? '';
    if (isUsageLimitMessage(reason)) {
      this.failAttempt(sessionId, claimed, reason);
      return;
    }
    // A non-limit failure is a real error: stop automatic retries and let the
    // error stand in the transcript.
    this.clear(sessionId, 'cancelled');
  }

  /** One automatic attempt did not get past the limit. Reschedule or give up. */
  private failAttempt(sessionId: string, claimed: PendingResumeRecord, message: string): void {
    const attempts = claimed.attempt + 1;
    if (attempts >= USAGE_LIMIT_MAX_ATTEMPTS) {
      this.clear(sessionId, 'exhausted');
      return;
    }
    const now = this.now();
    const reset = parseUsageLimitReset(message, now);
    const next = nextUsageLimitResume({ now, attempt: attempts, reset });
    const scheduled: PendingResumeRecord = {
      ...claimed,
      state: 'scheduled',
      attempt: attempts,
      resumeAt: next.resumeAt,
      message: bounded(message) || claimed.message,
      updatedAt: now,
    };
    this.deps.store.upsertPendingResume(scheduled);
    this.arm(sessionId, scheduled);
    this.deps.emit(sessionId, toPayload(scheduled));
  }
}
