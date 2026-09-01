export interface TimelineRewriteLease {
  accepted: boolean;
  epoch: number;
  signal: AbortSignal;
}

interface AppliedRewrite {
  epoch: number;
  controller: AbortController;
}

/**
 * Makes timeline rewrites monotonic per session. The same durable control row
 * can arrive through WebSocket immediately before its HTTP initiator receives
 * the response; only the first path may clear/reload the feed. A newer rewrite
 * aborts enrichment still running for the older branch.
 */
export class TimelineRewriteEpochGate {
  private readonly applied = new Map<string, AppliedRewrite>();

  adopt(sessionId: string, epoch: number): TimelineRewriteLease | null {
    if (!sessionId || !Number.isSafeInteger(epoch) || epoch < 1) return null;
    const current = this.applied.get(sessionId);
    if (current && current.epoch >= epoch) {
      return { accepted: false, epoch: current.epoch, signal: current.controller.signal };
    }

    current?.controller.abort();
    const controller = new AbortController();
    this.applied.set(sessionId, { epoch, controller });
    return { accepted: true, epoch, signal: controller.signal };
  }

  getEpoch(sessionId: string): number | undefined {
    return this.applied.get(sessionId)?.epoch;
  }

  isCurrent(sessionId: string, epoch: number): boolean {
    const current = this.applied.get(sessionId);
    return current?.epoch === epoch && !current.controller.signal.aborted;
  }

  clearSession(sessionId: string): void {
    this.applied.get(sessionId)?.controller.abort();
    this.applied.delete(sessionId);
  }

  clear(): void {
    for (const current of this.applied.values()) current.controller.abort();
    this.applied.clear();
  }
}
