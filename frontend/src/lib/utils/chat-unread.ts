import type { AgentStatus } from '@koryphaios/shared';

// Sidebar "new activity" marker: a chat whose manager turn finished (or
// failed) while another chat was open. It is view state only — nothing is
// persisted, and opening the chat clears it.

const SETTLED: ReadonlySet<AgentStatus> = new Set<AgentStatus>(['idle', 'done', 'error']);

export function isSettledStatus(status: AgentStatus | null | undefined): boolean {
  return !status || SETTLED.has(status);
}

/**
 * Tracks each session's last observed manager status and reports which
 * sessions became unread. Every call takes the session id explicitly; the
 * tracker never assumes the open chat.
 */
export class ChatUnreadTracker {
  private readonly lastStatus = new Map<string, AgentStatus>();
  readonly unread = new Set<string>();

  /**
   * Record one observation. Returns true when the unread set changed.
   * A session becomes unread only on a running → settled transition while it
   * is not the open chat; the first observation never marks it.
   */
  observe(sessionId: string, status: AgentStatus, isOpen: boolean): boolean {
    const previous = this.lastStatus.get(sessionId);
    this.lastStatus.set(sessionId, status);
    if (isOpen) return this.clear(sessionId);
    if (previous !== undefined && !isSettledStatus(previous) && isSettledStatus(status)) {
      if (this.unread.has(sessionId)) return false;
      this.unread.add(sessionId);
      return true;
    }
    return false;
  }

  clear(sessionId: string): boolean {
    return this.unread.delete(sessionId);
  }

  /** Drop state for sessions that no longer exist (deleted or archived). */
  retain(sessionIds: Iterable<string>): boolean {
    const keep = new Set(sessionIds);
    let changed = false;
    for (const id of [...this.lastStatus.keys()]) {
      if (!keep.has(id)) {
        this.lastStatus.delete(id);
        if (this.unread.delete(id)) changed = true;
      }
    }
    return changed;
  }
}
