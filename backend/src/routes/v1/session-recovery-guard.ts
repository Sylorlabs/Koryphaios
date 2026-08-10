export interface SessionRecoveryLease {
  release(): void;
}

const EMPTY_TIME_TRAVEL_STATE = {
  currentHash: '',
  timeline: [],
  canUndo: false,
  canRedo: false,
  stats: { totalStates: 0, totalCost: 0, modelsUsed: [] },
} as const;

/**
 * Keep Time Travel storage failures visible without leaking a stack or turning
 * panel loading into an HTTP 500. The empty data shape remains present for old
 * clients, but ok:false/degraded:true prevents it being mistaken for history.
 */
export function timeTravelDegradedResponse(error: unknown) {
  const raw = error instanceof Error ? error.message : String(error);
  const detail = raw.replace(/[\r\n\t]+/g, ' ').trim() || 'Unknown recovery storage failure';
  const message = `Time Travel history is unavailable: ${detail}`.slice(0, 500);
  return {
    ok: false as const,
    degraded: true as const,
    error: message,
    data: EMPTY_TIME_TRAVEL_STATE,
  };
}

/**
 * Run a Time Travel route under both authoritative lifecycle barriers. The
 * manager lease closes the pre-controller/provider-resolution start race; the
 * supervisor lease closes the background-process start race.
 */
export async function withSessionRecoveryGuard<TBusy, TResult>(options: {
  tryAcquireManager: () => SessionRecoveryLease | null;
  tryAcquireProcess: () => SessionRecoveryLease | null;
  onBusy: () => TBusy;
  run: () => Promise<TResult>;
}): Promise<TBusy | TResult> {
  const managerLease = options.tryAcquireManager();
  if (!managerLease) return options.onBusy();
  const processLease = options.tryAcquireProcess();
  if (!processLease) {
    managerLease.release();
    return options.onBusy();
  }
  try {
    return await options.run();
  } finally {
    processLease.release();
    managerLease.release();
  }
}
