import type { SessionRunSnapshot } from '@koryphaios/shared';

/**
 * What the desktop shell needs to decide whether quitting would interrupt
 * work: `runs` counts authoritative active session runs, and `agents` counts
 * the agents those runs have in flight (the manager plus any workers).
 *
 * Waiting runs (`waiting_user`, `waiting_terminal`) are deliberately not
 * counted. Nothing is executing for them, and the desktop quit confirmation
 * has always been about interrupting executing agents.
 */
export interface ActiveRunWork {
  runs: number;
  agents: number;
}

export function summarizeActiveWork(
  snapshots: ReadonlyArray<Pick<SessionRunSnapshot, 'status' | 'activeAgentIds'>>,
): ActiveRunWork {
  let runs = 0;
  let agents = 0;
  for (const snapshot of snapshots) {
    if (snapshot.status !== 'active') continue;
    runs += 1;
    // A run always has at least its manager, even if the snapshot lost its list.
    agents += Math.max(1, snapshot.activeAgentIds.length);
  }
  return { runs, agents };
}
