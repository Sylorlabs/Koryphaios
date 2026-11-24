/**
 * Release activity surfaced by the local backend while the GitHub Actions
 * release pipeline is preparing or building a version. The signed Tauri
 * `latest.json` manifest remains the only source of truth for installability;
 * this contract only answers "is a release on the way, and which one?".
 */

export type UpdateReleasePhase = 'preparing' | 'building';

export type UpdateReleaseRunStatus = 'queued' | 'in_progress' | 'completed' | 'unknown';

export type UpdateReleaseTrigger = 'commit' | 'manual' | 'tag';

export interface UpdateReleaseActivity {
  phase: UpdateReleasePhase;
  /** Resolved version, when the run/tag/source makes it knowable. */
  version: string | null;
  /** Immutable `v*` tag for a building desktop release. */
  tag: string | null;
  status: UpdateReleaseRunStatus;
  conclusion: string | null;
  runUrl: string;
  workflow: string;
  trigger: UpdateReleaseTrigger;
  startedAt: string | null;
}

export interface UpdateReleaseStatus {
  repo: string;
  currentVersion: string;
  checkedAt: string;
  activity: UpdateReleaseActivity | null;
  /** Soft failure only. A failed probe is never an update. */
  error: string | null;
}
