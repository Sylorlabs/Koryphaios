/** Stable correlation identity for artifacts produced by one durable run. */
export type RunId = string;

export interface RunRef {
  sessionId: string;
  runId: RunId;
}

export interface RunRevisionRef extends RunRef {
  revision: number;
}

export function isRunRef(value: unknown): value is RunRef {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.sessionId === 'string' &&
    candidate.sessionId.length > 0 &&
    typeof candidate.runId === 'string' &&
    candidate.runId.length > 0
  );
}

export function isRunRevisionRef(value: unknown): value is RunRevisionRef {
  return (
    isRunRef(value) &&
    Number.isSafeInteger((value as RunRevisionRef).revision) &&
    (value as RunRevisionRef).revision >= 0
  );
}
