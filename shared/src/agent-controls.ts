/**
 * Manager-visible control plane for live agents.
 *
 * A manager may inspect every agent in the session, but only agents it owns
 * are controllable. Permission posture is always user-owned: it is reported
 * here for coordination, never changed through agent controls.
 */
export type AgentControlRole = 'manager' | 'worker' | 'critic';

export interface AgentFallbackStep {
  /** `provider:model`, or a bare model when the provider is unambiguous. */
  model: string;
  reasoningLevel?: string;
}

export interface AgentControlsSnapshot {
  agentId: string;
  name: string;
  role: AgentControlRole;
  status: string;
  busy: boolean;
  controllable: boolean;
  /** Why this row is view-only, when it is. */
  viewOnlyReason?: string;
  model: string;
  provider: string;
  reasoningLevel?: string;
  fallbacks: AgentFallbackStep[];
  /** User-owned approval posture, exposed for coordination only. */
  permissionMode?: string;
  /** Session worker-isolation preference, exposed for coordination only. */
  worktreeMode: 'auto' | 'always' | 'never';
  updatedAt: number;
}

export interface AgentControlUpdate {
  model?: string;
  reasoningLevel?: string;
  fallbacks?: AgentFallbackStep[];
}

export interface ProviderRateLimitWindow {
  limit?: number;
  remaining?: number;
  reset?: string;
}

export interface ProviderRateLimitSnapshot {
  provider: string;
  model?: string;
  capturedAt: number;
  status: 'ok' | 'rate_limited';
  retryAfterSeconds?: number;
  requests?: ProviderRateLimitWindow;
  tokens?: ProviderRateLimitWindow;
  /** Provider-supplied limit rows from a 429 body, when present. */
  limits?: Array<{ requests: number; windowSeconds: number }>;
}

export interface ManagerBillingProvider {
  provider: string;
  connected: boolean;
  models: number;
  balanceUsd: number | null;
  usedUsd?: number;
  detail?: string;
  balanceFetchedAt?: number;
  rateLimit?: ProviderRateLimitSnapshot;
}

export interface ManagerBillingSnapshot {
  generatedAt: number;
  providers: ManagerBillingProvider[];
  subscriptions: Array<{
    provider: string;
    status?: string;
    rateLimitType?: string;
    resetsAt?: number;
    updatedAt: number;
  }>;
  sessionCost: { totalUsd: number; known: boolean; unpricedRows: number };
  /** Data a connector could not fetch is reported, never invented. */
  unavailable: string[];
}
