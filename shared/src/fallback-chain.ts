/**
 * User-defined fallback chain: what runs next when the active model runs out of
 * usage, is rate limited, errors, or times out.
 *
 * The chain holds only the fallback steps. The active (primary) model is the
 * route the turn already resolved; step 1 runs after it fails, step 2 after step 1
 * fails, and so on. Pure data and normalizers only. Trigger classification and
 * hop execution live in the backend (`backend/src/kory/fallback-chain.ts`).
 */

export const FALLBACK_REASONING_LEVELS = ['low', 'medium', 'high', 'xhigh'] as const;
export type FallbackReasoningLevel = (typeof FALLBACK_REASONING_LEVELS)[number];

/** Hard cap on the steps in one chain. */
export const FALLBACK_CHAIN_MAX_STEPS = 50;

/** Agent roles that can carry their own chain. `default` applies when a role has none. */
export const FALLBACK_CHAIN_ROLES = ['default', 'manager', 'worker', 'critic'] as const;
export type FallbackChainRole = (typeof FALLBACK_CHAIN_ROLES)[number];

/** Failure classes that can trigger a hop, mirrored by {@link FallbackTriggers}. */
export type FallbackHopReason = 'usage_limit' | 'rate_limit' | 'provider_error' | 'timeout';

export const FALLBACK_RETURN_TO_PRIMARY = ['next_turn', 'after_reset', 'never'] as const;
export type FallbackReturnToPrimary = (typeof FALLBACK_RETURN_TO_PRIMARY)[number];

export interface FallbackStep {
  /** Provider name. Empty only for a legacy bare-model step, resolved by model id at runtime. */
  provider: string;
  model: string;
  reasoningLevel?: FallbackReasoningLevel;
  /** Optional display name chosen by the user. */
  label?: string;
}

export interface FallbackTriggers {
  usageLimit: boolean;
  rateLimit: boolean;
  providerError: boolean;
  timeout: boolean;
}

export interface FallbackChain {
  steps: FallbackStep[];
  triggers: FallbackTriggers;
  returnToPrimary: FallbackReturnToPrimary;
}

/** Per-role chains stored in agent settings. Absent roles fall back to `default`. */
export type FallbackChainSettings = Partial<Record<FallbackChainRole, FallbackChain>>;

export const DEFAULT_FALLBACK_TRIGGERS: Readonly<FallbackTriggers> = Object.freeze({
  usageLimit: true,
  rateLimit: true,
  providerError: true,
  timeout: true,
});

export function createEmptyFallbackChain(): FallbackChain {
  return {
    steps: [],
    triggers: { ...DEFAULT_FALLBACK_TRIGGERS },
    returnToPrimary: 'next_turn',
  };
}

/** Payload of `session.fallback.hop`. */
export interface SessionFallbackHopPayload {
  sessionId: string;
  /** The manager turn's assistant message id; the hop is folded into that turn. */
  messageId: string;
  /** Set for a worker or critic hop; absent for a manager hop. */
  agentId?: string;
  fromModel: string;
  toModel: string;
  fromProvider?: string;
  toProvider?: string;
  reason: FallbackHopReason;
  /** 0-based index of the step the hop lands on. */
  stepIndex: number;
}

/** Stable key for a step: `provider:model`, or the bare model for a legacy step. */
export function fallbackStepKey(step: Pick<FallbackStep, 'provider' | 'model'>): string {
  return step.provider ? `${step.provider}:${step.model}` : step.model;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isReasoningLevel(value: unknown): value is FallbackReasoningLevel {
  return typeof value === 'string' && (FALLBACK_REASONING_LEVELS as readonly string[]).includes(value);
}

/**
 * Normalize one step from either the current shape `{provider, model, ...}` or
 * the legacy worker/manager shape `{model: 'provider:model' | 'model', reasoningLevel}`.
 * Returns undefined for a malformed or empty step. A legacy `provider:model`
 * string is split on its first colon; backend callers that know the provider
 * names should split with `splitProviderKey` before calling this.
 */
export function normalizeFallbackStep(input: unknown): FallbackStep | undefined {
  if (!isRecord(input)) return undefined;
  const rawModel = typeof input.model === 'string' ? input.model.trim() : '';
  if (!rawModel) return undefined;
  let provider = typeof input.provider === 'string' ? input.provider.trim() : '';
  let model = rawModel;
  if (!provider) {
    const colon = rawModel.indexOf(':');
    if (colon > 0 && colon < rawModel.length - 1) {
      provider = rawModel.slice(0, colon);
      model = rawModel.slice(colon + 1);
    }
  }
  const step: FallbackStep = { provider, model };
  if (isReasoningLevel(input.reasoningLevel)) step.reasoningLevel = input.reasoningLevel;
  if (typeof input.label === 'string' && input.label.trim()) {
    step.label = input.label.trim().slice(0, 80);
  }
  return step;
}

/** Normalize a list of steps, dropping malformed entries and capping the length. */
export function normalizeFallbackSteps(input: unknown): FallbackStep[] {
  if (!Array.isArray(input)) return [];
  const steps: FallbackStep[] = [];
  for (const raw of input) {
    const step = normalizeFallbackStep(raw);
    if (step) steps.push(step);
    if (steps.length >= FALLBACK_CHAIN_MAX_STEPS) break;
  }
  return steps;
}

/** Normalize a chain, filling defaults for anything missing or malformed. */
export function normalizeFallbackChain(input: unknown): FallbackChain {
  const base = createEmptyFallbackChain();
  if (!isRecord(input)) return base;
  const triggersInput = isRecord(input.triggers) ? input.triggers : {};
  const triggers: FallbackTriggers = {
    usageLimit: typeof triggersInput.usageLimit === 'boolean' ? triggersInput.usageLimit : base.triggers.usageLimit,
    rateLimit: typeof triggersInput.rateLimit === 'boolean' ? triggersInput.rateLimit : base.triggers.rateLimit,
    providerError:
      typeof triggersInput.providerError === 'boolean'
        ? triggersInput.providerError
        : base.triggers.providerError,
    timeout: typeof triggersInput.timeout === 'boolean' ? triggersInput.timeout : base.triggers.timeout,
  };
  const returnToPrimary = (FALLBACK_RETURN_TO_PRIMARY as readonly string[]).includes(
    input.returnToPrimary as string,
  )
    ? (input.returnToPrimary as FallbackReturnToPrimary)
    : base.returnToPrimary;
  return { steps: normalizeFallbackSteps(input.steps), triggers, returnToPrimary };
}

/** Normalize a per-role settings record, keeping only known roles. */
export function normalizeFallbackChainSettings(input: unknown): FallbackChainSettings {
  const out: FallbackChainSettings = {};
  if (!isRecord(input)) return out;
  for (const role of FALLBACK_CHAIN_ROLES) {
    if (input[role] !== undefined && input[role] !== null) out[role] = normalizeFallbackChain(input[role]);
  }
  return out;
}
