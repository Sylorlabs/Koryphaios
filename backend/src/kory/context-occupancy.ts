import type { ProviderName } from '@koryphaios/shared';
import { resolveTrustedContextWindow } from '../providers';

export interface LiveOccupancyInput {
  tokensIn: number;
  tokensOut: number;
  model: string;
  provider: ProviderName;
  usageKnown: boolean;
  /** True when the provider flagged this sample as cumulative/approximate
   *  rather than exact live occupancy (e.g. Codex turn.completed totals). */
  estimated?: boolean;
}

export interface LiveOccupancy {
  tokensIn: number;
  tokensOut: number;
  tokensUsed: number;
  usageKnown: boolean;
  /** True when the occupancy is approximate: flagged by the provider, or
   *  clamped down to the trusted window because the raw total was
   *  impossibly large. Estimated occupancy must never trigger auto-compact. */
  estimated: boolean;
  contextKnown: boolean;
  contextWindow?: number;
}

/** Reconcile a provider-reported usage sample with the trusted context
 *  window. Provider totals that exceed the window (Codex reports cumulative
 *  input across its internal requests, so multi-step turns can read 3x the
 *  window) are clamped instead of displayed as impossible ratios like
 *  860k / 285k, and the result is marked estimated so the auto-compact
 *  trigger withholds it. Unknown usage fails closed to zero/estimated. */
export function resolveLiveOccupancy(input: LiveOccupancyInput): LiveOccupancy {
  const win = resolveTrustedContextWindow(input.model, input.provider);
  const contextKnown = win.contextKnown;
  const contextWindow = win.contextWindow;
  if (!input.usageKnown) {
    return {
      tokensIn: 0,
      tokensOut: 0,
      tokensUsed: 0,
      usageKnown: false,
      estimated: true,
      contextKnown,
      ...(typeof contextWindow === 'number' ? { contextWindow } : {}),
    };
  }
  let tokensIn = Math.max(0, Math.floor(input.tokensIn));
  let tokensOut = Math.max(0, Math.floor(input.tokensOut));
  let estimated = input.estimated === true;
  if (contextKnown && typeof contextWindow === 'number' && contextWindow > 0) {
    if (tokensIn > contextWindow) {
      tokensIn = contextWindow;
      estimated = true;
    }
    if (tokensOut > contextWindow) {
      tokensOut = contextWindow;
      estimated = true;
    }
  }
  let tokensUsed = tokensIn + tokensOut;
  if (contextKnown && typeof contextWindow === 'number' && contextWindow > 0) {
    if (tokensUsed > contextWindow) {
      tokensUsed = contextWindow;
      estimated = true;
    }
  }
  return {
    tokensIn,
    tokensOut,
    tokensUsed,
    usageKnown: true,
    estimated,
    contextKnown,
    ...(typeof contextWindow === 'number' ? { contextWindow } : {}),
  };
}
