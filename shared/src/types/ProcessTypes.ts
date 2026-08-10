/**
 * Authoritative process ownership and lifecycle contract shared by the
 * backend, REST/WebSocket clients, and native Monitoring UI.
 *
 * Provenance is assigned by the server entry point that creates a process.
 * It must never be inferred from a command, process name, session id, or
 * legacy metadata.
 */
export type ProcessProvenance =
  'agent-tool' | 'agent-external-cli' | 'manual-service' | 'legacy-unknown';

export type ProcessSupervision = 'owned-child' | 'external-detached' | 'legacy-unknown';

export type ProcessStatus =
  | 'starting'
  | 'running'
  | 'exited'
  | 'killed'
  | 'crashed'
  | 'spawn_failed'
  | 'orphaned'
  | 'detached';

export type ProcessTerminalReason =
  | 'exit-zero'
  | 'exit-nonzero'
  | 'killed-by-user'
  | 'killed-for-restart'
  | 'session-cancelled'
  | 'spawn-failed'
  | 'restart-failed'
  | 'process-missing'
  | 'backend-restart-orphaned'
  | 'backend-restart-unverified'
  | 'backend-restart-missing'
  | 'external-handle-unavailable';

export interface ProcessClassification {
  provenance: ProcessProvenance;
  supervision: ProcessSupervision;
  isBackground: boolean;
}

/**
 * The one predicate for agent waiting, wake-up, Monitoring, and cancellation.
 *
 * Native CLI jobs for which Kory does not own an OS process handle are
 * intentionally excluded. They are recorded as detached evidence, but quiet
 * output is not authoritative proof that they completed.
 */
export function isAgentBackgroundProcess(
  process: Pick<ProcessClassification, 'provenance' | 'supervision' | 'isBackground'>,
): boolean {
  return (
    process.provenance === 'agent-tool' &&
    process.supervision === 'owned-child' &&
    process.isBackground === true
  );
}
