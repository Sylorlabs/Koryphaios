/**
 * Fallback chain runtime: classify a failed provider turn, decide whether the
 * user's chain allows a hop, and keep the per-turn and cross-turn hop state.
 *
 * Pure functions plus two small state shapes. Route resolution (which provider
 * object serves a step) and transcript writes stay in the manager, which owns
 * them. Auth failures never hop: a missing or rejected credential is a
 * configuration problem and must fail closed, as it does without a chain.
 */

import {
  fallbackStepKey,
  normalizeFallbackChain,
  type FallbackChain,
  type FallbackChainRole,
  type FallbackHopReason,
  type FallbackStep,
  type FallbackTriggers,
} from '@koryphaios/shared';
import { isContextLimitFailureMessage, USAGE_LIMIT_TEXT } from '../providers/provider-diagnostics';

/** How long a `after_reset` chain keeps a failed primary out of rotation. */
export const FALLBACK_RESET_COOLDOWN_MS = 60 * 60 * 1000;

const AUTH_TEXT =
  /unauthori[sz]ed|forbidden|invalid api key|invalid_api_key|authentication|sign[ -]?in|not (?:signed|logged)|login required|codex login|invalid token|expired token|token expired|auth\.json|api key (?:is )?(?:missing|not set|required)/i;
const RATE_TEXT =
  /rate[ _-]?limit|too many requests|\b429\b|resource[ _]exhausted|requests per (?:minute|day)/i;
const TIMEOUT_TEXT = /timed out|timeout|time out|etimedout|deadline exceeded/i;

/**
 * Classify one provider failure for the fallback chain. Returns the hop reason,
 * or undefined when the failure must never hop (auth). Context-limit text
 * returns `provider_error`: the manager's shrink retry runs first, and a chain
 * may still help once shrinking is exhausted.
 */
export function classifyFallbackFailure(
  error: unknown,
  status?: number,
): FallbackHopReason | undefined {
  const message =
    typeof error === 'string' ? error : error instanceof Error ? error.message : String(error ?? '');
  const name = error instanceof Error ? error.name : '';
  if (status === 401 || status === 403) return undefined;
  if (AUTH_TEXT.test(message)) return undefined;
  if (USAGE_LIMIT_TEXT.test(message)) return 'usage_limit';
  if (status === 429 || RATE_TEXT.test(message)) return 'rate_limit';
  if (name === 'TimeoutError' || TIMEOUT_TEXT.test(message)) return 'timeout';
  return 'provider_error';
}

/** Whether a classified reason is switched on in the chain's triggers. */
export function fallbackReasonEnabled(reason: FallbackHopReason, triggers: FallbackTriggers): boolean {
  switch (reason) {
    case 'usage_limit':
      return triggers.usageLimit;
    case 'rate_limit':
      return triggers.rateLimit;
    case 'provider_error':
      return triggers.providerError;
    case 'timeout':
      return triggers.timeout;
  }
}

/** One completed hop, kept for the exhausted summary and the persisted notice. */
export interface FallbackHopRecord {
  fromModel: string;
  fromProvider?: string;
  toModel: string;
  toProvider?: string;
  reason: FallbackHopReason;
  stepIndex: number;
  at: number;
}

/** Hop state for the turn in flight. `activeIndex` is -1 on the primary route. */
export interface FallbackTurnState {
  role: FallbackChainRole;
  chain: FallbackChain;
  activeIndex: number;
  hops: FallbackHopRecord[];
  /** Steps skipped at runtime because their provider is not connected. */
  skipped: string[];
}

/**
 * Where a chain left the role on its last hop. Carried across turns only for
 * `never` and `after_reset`; `next_turn` clears it at the next turn start.
 */
export interface FallbackStickyState {
  role: FallbackChainRole;
  activeIndex: number;
  stepKey: string;
  hoppedAt: number;
  /** `after_reset`: the primary route is retried once this time passes. */
  resetAfter?: number;
}

/**
 * Resolve the chain for a turn: the per-chat override wins, then the role's own
 * chain, then the project default. An empty chain means no fallback.
 */
export function resolveFallbackChain(input: {
  sessionOverride?: unknown;
  roleChains?: Partial<Record<FallbackChainRole, unknown>>;
  role: FallbackChainRole;
}): FallbackChain {
  if (input.sessionOverride !== undefined && input.sessionOverride !== null) {
    return normalizeFallbackChain(input.sessionOverride);
  }
  const roleChain = input.roleChains?.[input.role];
  if (roleChain !== undefined && roleChain !== null) return normalizeFallbackChain(roleChain);
  const fallback = input.roleChains?.default;
  if (fallback !== undefined && fallback !== null) return normalizeFallbackChain(fallback);
  return normalizeFallbackChain(undefined);
}

/** Find the next step after `fromIndex` for a reason, without checking connectivity. */
export function nextCandidateStepIndex(
  chain: FallbackChain,
  fromIndex: number,
  reason: FallbackHopReason,
): number {
  if (!fallbackReasonEnabled(reason, chain.triggers)) return -1;
  const next = fromIndex + 1;
  return next < chain.steps.length ? next : -1;
}

/** Start a turn at the primary route, or at the sticky step when the chain says so. */
export function beginFallbackTurnState(input: {
  role: FallbackChainRole;
  chain: FallbackChain;
  sticky?: FallbackStickyState;
  now: number;
}): { state: FallbackTurnState; sticky?: FallbackStickyState } {
  let start = -1;
  const sticky = input.sticky;
  if (sticky && sticky.role === input.role && sticky.activeIndex < input.chain.steps.length) {
    if (input.chain.returnToPrimary === 'never') start = sticky.activeIndex;
    else if (
      input.chain.returnToPrimary === 'after_reset' &&
      sticky.resetAfter !== undefined &&
      input.now < sticky.resetAfter
    ) {
      start = sticky.activeIndex;
    }
  }
  return {
    state: { role: input.role, chain: input.chain, activeIndex: start, hops: [], skipped: [] },
    sticky: start >= 0 ? sticky : undefined,
  };
}

export function formatFallbackStepLabel(step: Pick<FallbackStep, 'provider' | 'model' | 'label'>): string {
  return step.label?.trim() || fallbackStepKey(step);
}

/**
 * Human summary of every hop when the chain runs out. Appended to the turn's
 * failure so the user sees the full route that was tried, not only the last error.
 */
export function formatFallbackExhaustedSummary(
  hops: readonly FallbackHopRecord[],
  primaryModel: string,
  stepCount: number,
): string {
  if (hops.length === 0) return '';
  const route = [`${primaryModel} (primary)`, ...hops.map((hop) => `${hop.toModel} (${hop.reason.replace('_', ' ')})`)];
  return `Fallback chain exhausted after ${hops.length} hop${hops.length === 1 ? '' : 's'} of ${stepCount} step${stepCount === 1 ? '' : 's'}: ${route.join(' -> ')}.`;
}

/** Payload given to {@link onFallbackChainExhausted} subscribers. */
export interface FallbackChainExhaustedInfo {
  role: FallbackChainRole;
  hops: FallbackHopRecord[];
  lastReason: FallbackHopReason;
  lastError: string;
  stepCount: number;
  summary: string;
}

export type FallbackChainExhaustedHandler = (sessionId: string, info: FallbackChainExhaustedInfo) => void;

const exhaustedHandlers = new Set<FallbackChainExhaustedHandler>();

/** Subscribe to chain exhaustion. Returns the unsubscribe function. */
export function registerFallbackChainExhaustedHandler(handler: FallbackChainExhaustedHandler): () => void {
  exhaustedHandlers.add(handler);
  return () => {
    exhaustedHandlers.delete(handler);
  };
}

/**
 * Hook fired once the chain has no step left to try for a turn that already hopped.
 * Auto-resume (scheduling a retry after a usage limit) belongs here: it runs only
 * after the chain is exhausted, never in place of a hop. A failing subscriber is
 * isolated so it cannot break the turn that reported the failure.
 */
export function onFallbackChainExhausted(sessionId: string, info: FallbackChainExhaustedInfo): void {
  for (const handler of exhaustedHandlers) {
    try {
      handler(sessionId, info);
    } catch {
      // A subscriber must never turn an exhausted chain into a different failure.
    }
  }
}

/** A live route for one chain step. `P` is the provider handle the caller uses. */
export interface FallbackResolvedRoute<P> {
  model: string;
  provider: P;
  providerName: string;
}

export type FallbackHopDecision<P> =
  | {
      kind: 'hop';
      state: FallbackTurnState;
      sticky?: FallbackStickyState;
      hop: FallbackHopRecord;
      stepIndex: number;
      step: FallbackStep;
      route: FallbackResolvedRoute<P>;
    }
  | { kind: 'exhausted'; state: FallbackTurnState; info: FallbackChainExhaustedInfo }
  | { kind: 'none'; state: FallbackTurnState };

/**
 * Pure hop policy for one failed attempt. Given the turn's state and the failure,
 * it picks the next connected step (disconnected steps are recorded as skipped),
 * or reports the chain exhausted when a hop already happened or every step was
 * skipped. It never touches storage, events or providers: the caller applies the
 * returned state, emits the notice, and fires the exhaustion hook.
 *
 * Auth failures and disabled triggers return `none` with the state unchanged.
 */
export function decideFallbackHop<P>(input: {
  state: FallbackTurnState;
  sticky?: FallbackStickyState;
  failure: { message: string; name?: string; status?: number };
  current: { model: string; provider: string };
  now: number;
  resolve: (step: FallbackStep) => FallbackResolvedRoute<P> | undefined;
}): FallbackHopDecision<P> {
  const { state: input_state, failure, current } = input;
  const reason = classifyFallbackFailure(
    Object.assign(new Error(failure.message), { name: failure.name ?? 'Error' }),
    failure.status,
  );
  if (!reason || !fallbackReasonEnabled(reason, input_state.chain.triggers)) {
    return { kind: 'none', state: input_state };
  }

  const state: FallbackTurnState = { ...input_state, hops: [...input_state.hops], skipped: [...input_state.skipped] };
  let next: { index: number; step: FallbackStep; route: FallbackResolvedRoute<P> } | undefined;
  for (let index = state.activeIndex + 1; index < state.chain.steps.length; index++) {
    const step = state.chain.steps[index]!;
    const route = input.resolve(step);
    if (route) {
      next = { index, step, route };
      break;
    }
    state.skipped.push(fallbackStepKey(step));
  }

  const stepCount = state.chain.steps.length;
  if (!next) {
    if (state.hops.length === 0 && state.skipped.length === 0) return { kind: 'none', state };
    const primaryModel = state.hops[0]?.fromModel ?? current.model;
    const base =
      state.hops.length > 0
        ? formatFallbackExhaustedSummary(state.hops, primaryModel, stepCount)
        : `Fallback chain skipped: no step is connected (${state.skipped.join(', ')}).`;
    const summary =
      state.skipped.length > 0 && state.hops.length > 0
        ? `${base} Skipped (not connected): ${state.skipped.join(', ')}.`
        : base;
    return {
      kind: 'exhausted',
      state,
      info: {
        role: state.role,
        hops: [...state.hops],
        lastReason: reason,
        lastError: failure.message,
        stepCount,
        summary,
      },
    };
  }

  const hop: FallbackHopRecord = {
    fromModel: current.model,
    fromProvider: current.provider,
    toModel: next.route.model,
    toProvider: next.route.providerName,
    reason,
    stepIndex: next.index,
    at: input.now,
  };
  state.activeIndex = next.index;
  state.hops.push(hop);
  const sticky: FallbackStickyState | undefined =
    state.chain.returnToPrimary === 'next_turn'
      ? undefined
      : {
          role: state.role,
          activeIndex: next.index,
          stepKey: fallbackStepKey(next.step),
          hoppedAt: input.now,
          ...(state.chain.returnToPrimary === 'after_reset'
            ? { resetAfter: input.now + FALLBACK_RESET_COOLDOWN_MS }
            : {}),
        };
  return { kind: 'hop', state, sticky, hop, stepIndex: next.index, step: next.step, route: next.route };
}
