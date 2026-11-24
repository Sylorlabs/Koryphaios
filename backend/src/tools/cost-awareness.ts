// Cost-awareness tools (any role, read-only): get_model_pricing and
// get_usage_summary let a model check what a route costs and what has been
// spent before it chooses a large delegation. They only read; the services
// in billing/cost-awareness.ts reuse the pricing resolver, the credit ledger,
// enforced spend caps and the resource budget snapshot.

import type { ModelDef } from '@koryphaios/shared';
import { resolve } from 'node:path';
import {
  buildModelPricingReport,
  buildUsageSummary,
  USAGE_SCOPES,
  type PricingDependencies,
  type SpendCapStatus,
  type UsageScope,
  type UsageSummaryDependencies,
} from '../billing/cost-awareness';
import { collectResourceBudgetSnapshot } from '../billing/resource-budget';
import { getUsageCostBreakdown } from '../credit-accountant';
import {
  getEnforcedCaps,
  getSessionPauseRecord,
  getSpendWindowSnapshot,
  isSessionPaused,
} from '../security/spend-caps-enforced';
import { canonicalizePath } from '../runtime/platform';
import type { ProviderRegistry } from '../providers';
import { SessionStore } from '../stores/session-store';
import type { Tool, ToolCallInput, ToolCallOutput, ToolContext } from './registry';

const MAX_MODELS_PER_CALL = 50;

function fail(call: ToolCallInput, name: string, message: string): ToolCallOutput {
  return { callId: call.id, name, output: `Error: ${message}`, isError: true, durationMs: 0 };
}

function done(call: ToolCallInput, name: string, output: unknown): ToolCallOutput {
  return {
    callId: call.id,
    name,
    output: JSON.stringify(output),
    isError: false,
    durationMs: 0,
  };
}

/**
 * Any role: price facts for explicit provider:model ids, or for a provider's
 * catalog. Prices come from connected catalogs and the pricing registries;
 * anything unknown is reported as null with source "unknown".
 */
export class GetModelPricingTool implements Tool {
  readonly name = 'get_model_pricing';
  readonly role = 'any' as const;
  readonly description =
    'Read per-model price facts before choosing a route: input, output and cache prices per 1M tokens, context window, and where each price came from (catalog, models.dev, provider-reported, openrouter-equivalent, or unknown). Unknown prices are null, never zero. Pass models as provider:model ids, or a provider to list its catalog.';
  readonly inputSchema = {
    type: 'object',
    properties: {
      models: {
        type: 'array',
        items: { type: 'string' },
        description: 'provider:model ids, for example "openrouter:openai/gpt-4.1".',
      },
      provider: {
        type: 'string',
        description: 'Provider name. Scopes a bare model id, or lists that provider catalog when models is omitted.',
      },
    },
  };

  constructor(
    private providers: ProviderRegistry,
    private deps: PricingDependencies = {},
  ) {}

  async run(_ctx: ToolContext, call: ToolCallInput): Promise<ToolCallOutput> {
    try {
      const input = call.input as { models?: unknown; provider?: unknown };
      const rawModels =
        typeof input.models === 'string' ? [input.models] : Array.isArray(input.models) ? input.models : undefined;
      if (rawModels !== undefined && rawModels.some((value) => typeof value !== 'string')) {
        return fail(call, this.name, 'models must be an array of provider:model strings.');
      }
      const models = rawModels?.map((value) => (value as string).trim()).filter(Boolean).slice(0, MAX_MODELS_PER_CALL);
      const provider = typeof input.provider === 'string' ? input.provider : undefined;
      const providers = this.providers.getStatus().map((status) => ({
        name: status.name,
        models: (status.allAvailableModels ?? []) as ModelDef[],
      }));
      const report = buildModelPricingReport({ models, provider }, providers, this.deps);
      return done(call, this.name, report);
    } catch (err) {
      return fail(call, this.name, err instanceof Error ? err.message : String(err));
    }
  }
}

function canonicalFolder(dir: string | undefined): string | undefined {
  if (!dir) return undefined;
  try {
    return canonicalizePath(dir);
  } catch {
    return resolve(dir);
  }
}

/** Default spend-cap read: enforced limits plus the live spend windows for the chat and globally. */
export async function readSpendCapStatus(sessionId: string | undefined): Promise<SpendCapStatus> {
  const caps = await getEnforcedCaps();
  const windows = await getSpendWindowSnapshot(sessionId);
  const usd = (cents: number): number => cents / 100;
  const limit = (cents: number): number | null => (cents > 0 ? usd(cents) : null);
  const pause = sessionId && isSessionPaused(sessionId) ? getSessionPauseRecord(sessionId) : undefined;
  return {
    enabled: caps.enabled,
    action: caps.action,
    limitsUsd: {
      sessionHourly: limit(caps.sessionHourlyCents),
      sessionDaily: limit(caps.sessionDailyCents),
      globalHourly: limit(caps.globalHourlyCents),
      globalDaily: limit(caps.globalDailyCents),
    },
    spentUsd: {
      sessionHour: sessionId ? usd(windows.sessionHourCents) : null,
      sessionDay: sessionId ? usd(windows.sessionDayCents) : null,
      globalHour: usd(windows.globalHourCents),
      globalDay: usd(windows.globalDayCents),
    },
    ...(sessionId ? { sessionId } : {}),
    paused: pause !== undefined,
    ...(pause ? { pauseReason: pause.reason } : {}),
  };
}

/**
 * Any role: spend so far for this chat, its project folder, today or this
 * month; per provider and model; the enforced spend caps; and subscription or
 * balance states the backend already knows, with their freshness.
 */
export class GetUsageSummaryTool implements Tool {
  readonly name = 'get_usage_summary';
  readonly role = 'any' as const;
  readonly description =
    'Read spend so far: USD where prices are known (tokens always), per provider and model, the enforced spend caps and current windows, and subscription or balance states with freshness. scope: session (default, this chat or the given sessionId), project (chats in the same folder), today, or month. Unknown values are null, never zero.';
  readonly inputSchema = {
    type: 'object',
    properties: {
      scope: {
        type: 'string',
        enum: [...USAGE_SCOPES],
        description: "Default 'session'.",
      },
      sessionId: {
        type: 'string',
        description: 'Chat to summarize for session/project scope. Defaults to this chat.',
      },
    },
  };

  constructor(
    private providers: ProviderRegistry,
    private sessions: Pick<SessionStore, 'get' | 'listAll'> = new SessionStore(),
    private deps: Partial<UsageSummaryDependencies> = {},
  ) {}

  async run(ctx: ToolContext, call: ToolCallInput): Promise<ToolCallOutput> {
    try {
      const input = call.input as { scope?: unknown; sessionId?: unknown };
      const scope = (input.scope ?? 'session') as UsageScope;
      if (!USAGE_SCOPES.includes(scope)) {
        return fail(call, this.name, `scope must be one of ${USAGE_SCOPES.join(', ')}.`);
      }

      let targetId = ctx.sessionId;
      const requested = typeof input.sessionId === 'string' ? input.sessionId.trim() : '';
      if (requested && requested !== ctx.sessionId) {
        const target = await this.sessions.get(requested);
        if (!target) {
          return fail(call, this.name, `No chat with id '${requested}'. Use list_sessions to find chat ids.`);
        }
        targetId = target.id;
      }

      let projectSessionIds: string[] = [targetId];
      if (scope === 'project') {
        const target = await this.sessions.get(targetId);
        const folder = canonicalFolder(target?.workingDirectory);
        if (folder) {
          const all = await this.sessions.listAll();
          projectSessionIds = all
            .filter((session) => canonicalFolder(session.workingDirectory) === folder)
            .map((session) => session.id);
        }
      }

      const providerConfigs = () => this.providers.getConfigs();
      const report = await buildUsageSummary(
        { scope, sessionId: targetId, projectSessionIds },
        {
          rows: this.deps.rows ?? ((sinceMs) => getUsageCostBreakdown(undefined, sinceMs)),
          budget:
            this.deps.budget ??
            (() => collectResourceBudgetSnapshot(providerConfigs(), {})),
          spendCap: this.deps.spendCap ?? readSpendCapStatus,
          ...(this.deps.now ? { now: this.deps.now } : {}),
        },
      );
      return done(call, this.name, report);
    } catch (err) {
      return fail(call, this.name, err instanceof Error ? err.message : String(err));
    }
  }
}
