import type { WorkerDomain, ProviderName, KoryphaiosConfig } from '@koryphaios/shared';
import type { ProviderRegistry } from '../../providers';
import {
  DEDICATED_CAPABILITY_PROVIDER_NAMES,
  UNSUPPORTED_CHAT_PROVIDER_NAMES,
} from '../../providers/registry';
import { serverLog } from '../../logger';
import { loadAgentSettings } from '../../agent-settings';
import { createTaskContract } from '../prompts';
import { resolveSkills } from '../skills';
import { rankHarnessCandidates, type QualificationRole } from '../skill-qualifications';
import { RoutingServiceEnhanced, type RoutingDecision } from './RoutingServiceEnhanced';

/** Model ids that name a non-chat capability. Never valid for a delegated worker. */
const NON_CHAT_MODEL_ID = /embed|moderation|whisper|transcri|\btts\b|text-to-speech|speech|dall-e|image|rerank/i;
const SUGGESTION_LIMIT = 5;

interface ConnectedWorkerRoute {
  provider: ProviderName;
  model: string;
  aliases: string[];
}

/** Classic edit distance, used only to rank close matches for a bad model id. */
function editDistance(a: string, b: string): number {
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = previous[0]!;
    previous[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const saved = previous[j]!;
      previous[j] = Math.min(
        previous[j]! + 1,
        previous[j - 1]! + 1,
        diagonal + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      diagonal = saved;
    }
  }
  return previous[b.length]!;
}

export interface ManagerRoutingServiceDependencies {
  config: KoryphaiosConfig;
  providers: ProviderRegistry;
  workingDirectory: string;
}

/**
 * Manager-owned routing policy.
 *
 * RoutingServiceEnhanced selects a route from the configured provider catalog;
 * this service applies the manager's category access policy and the
 * independence rules used for workers, critics, and review specialists.
 */
export class ManagerRoutingService {
  private readonly routing: RoutingServiceEnhanced;

  constructor(private readonly deps: ManagerRoutingServiceDependencies) {
    this.routing = new RoutingServiceEnhanced({
      config: deps.config,
      providers: deps.providers,
    });
  }

  buildFallbackChain(startModelId: string): string[] {
    return this.routing.buildFallbackChain(startModelId);
  }

  resolveActiveRouting(
    preferredModel?: string,
    domain: WorkerDomain = 'general',
    avoidLegacy = false,
    prompt?: string,
    preferCheap?: boolean,
    workingDirectory = this.deps.workingDirectory,
  ): RoutingDecision {
    const routed = this.routing.resolveActiveRouting(
      preferredModel,
      domain,
      avoidLegacy,
      prompt,
      preferCheap,
    );

    // User-configured per-category allowlist: when set for this domain, the
    // manager may only use those models. An explicit user model pick wins.
    if (!preferredModel || preferredModel === 'auto') {
      try {
        const access = loadAgentSettings(workingDirectory).managerModelAccess;
        // `ui` is the worker-facing name for UI work. Keep `frontend` as
        // a compatibility alias for older project configs and for the
        // manager's broader task classifier.
        const hasDomainAccess = Object.prototype.hasOwnProperty.call(access ?? {}, domain);
        const allowed = hasDomainAccess
          ? access[domain]
          : domain === 'ui'
            ? access?.frontend
            : domain === 'frontend'
              ? access?.ui
              : undefined;
        if (allowed?.length && !allowed.includes(routed.model)) {
          for (const candidate of allowed) {
            const alternate = this.routing.resolveActiveRouting(
              candidate,
              domain,
              avoidLegacy,
              prompt,
              preferCheap,
            );
            if (this.deps.providers.resolveProvider(alternate.model, alternate.provider)) {
              return alternate;
            }
          }
        }
      } catch (err: unknown) {
        serverLog.debug(
          { err: err instanceof Error ? err.message : String(err) },
          'Agent settings unavailable — using the routed default',
        );
      }
    }

    return routed;
  }

  /** List the category choices exposed to the finishing agent for Critic Auto. */
  getCriticModelChoices(workingDirectory = this.deps.workingDirectory): string[] {
    const configured = loadAgentSettings(workingDirectory).managerModelAccess?.critic;
    return configured?.length ? [...configured] : this.deps.providers.getStatus()
      .filter((status) => status.adapterAvailable)
      .flatMap((status) => status.models.map((model) => `${status.name}:${model}`));
  }

  resolveIndependentRouting(
    avoidModel: string | undefined,
    avoidProvider: ProviderName | undefined,
    domain: WorkerDomain,
    additionalAvoid: ReadonlyArray<{ model: string | undefined; provider: ProviderName | undefined }> = [],
    task?: string,
    qualificationRole: QualificationRole = 'worker',
    workingDirectory = this.deps.workingDirectory,
    preferredModel?: string,
    hardExclude?: ReadonlyArray<string>,
  ): RoutingDecision | null {
    const settings = loadAgentSettings(workingDirectory);
    const access = settings.managerModelAccess ?? {};
    const hasDomainAccess = Object.prototype.hasOwnProperty.call(access, domain);
    const configured = hasDomainAccess
      ? (access[domain] ?? [])
      : domain === 'ui'
        ? (access.frontend ?? [])
        : domain === 'frontend'
          ? (access.ui ?? [])
          : [];
    const candidates =
      configured.length > 0
        ? configured
        : this.deps.providers
            .getStatus()
            .filter((status) => status.adapterAvailable)
            .flatMap((status) => status.models.map((model) => `${status.name}:${model}`));
    const resolved: RoutingDecision[] = [];
    // Every reachable route, including ones the independence rules would skip.
    // An explicit manager choice is matched here so it is never silently
    // replaced by the ranked pick.
    const reachable: RoutingDecision[] = [];
    // Hard exclusions (route keys `${provider}:${model}` or bare models) remove
    // routes even from `reachable`, so no fallback can resurrect them.
    const hardExcluded = (route: RoutingDecision) =>
      hardExclude?.some(
        (key) => key === `${route.provider ?? 'unknown'}:${route.model}` || key === route.model,
      ) ?? false;
    for (const candidate of candidates) {
      try {
        const route = this.routing.resolveActiveRouting(candidate, domain);
        const provider = this.deps.providers.resolveProvider(route.model, route.provider);
        const excluded =
          (route.model === avoidModel && route.provider === avoidProvider) ||
          additionalAvoid.some(
            (identity) => route.model === identity.model && route.provider === identity.provider,
          );
        if (provider && !hardExcluded(route)) reachable.push(route);
        if (provider && !excluded && !hardExcluded(route)) resolved.push(route);
      } catch (err: unknown) {
        serverLog.debug(
          { err: err instanceof Error ? err.message : String(err) },
          'Stale user-enabled model: skip it and continue through the pool',
        );
      }
    }
    if (preferredModel) {
      // The manager picked a model from the enabled pool. Honor that pick
      // exactly -- including an identity the independence rules would
      // otherwise avoid -- because an explicit choice must never be silently
      // replaced. A model outside the enabled pool is refused with the pool, so
      // a stale pick cannot quietly become a different reviewer.
      const selected = reachable.find((route) =>
        preferredModel === route.model || preferredModel === `${route.provider ?? ''}:${route.model}`,
      );
      if (selected) return selected;
      const pool = candidates.length
        ? candidates
        : reachable.map((route) => `${route.provider ?? 'unknown'}:${route.model}`);
      throw new Error(
        `Requested model "${preferredModel}" is not available. ` +
          `Choose one of: ${pool.length ? pool.join(', ') : '(no reachable models)'}.`,
      );
    }
    // Prefer a different model from every producer before comparing providers.
    const differentModels = resolved.filter((route) =>
      route.model !== avoidModel && additionalAvoid.every((identity) => route.model !== identity.model),
    );
    const distinct = differentModels.length ? differentModels : resolved;
    // A different model already beats a different provider (that is what the
    // step above selects). Here the producer's own provider is the one that
    // most weakens independence, so only that is avoided at provider level: a
    // manager or builder *provider* is not a reason to discard a genuinely
    // different model, which would otherwise empty the pool and crown the
    // producer's sibling as the reviewer.
    const independent = distinct.filter((route) => route.provider !== avoidProvider);
    const pool = independent.length ? independent : distinct.length ? distinct : reachable;
    const contract = createTaskContract(task ?? 'Delegate task');
    const skillResolution = resolveSkills(workingDirectory, contract.goal, contract);
    const ranked = rankHarnessCandidates(
      workingDirectory,
      pool,
      qualificationRole,
      skillResolution.selected.map((item) => item.skill.name),
      skillResolution.evidence.declaredMedia[0],
    );
    return ranked[0] ?? null;
  }

  /**
   * Route a delegated worker. With no explicit model the user's category pool
   * is the preferred default, exactly as before. An explicit `model` may name
   * any connected, chat-capable provider:model. The old pool gate stays behind
   * `restrictDelegationToPools` for users who want it.
   */
  resolveDelegatedWorkerRouting(input: {
    avoidModel?: string;
    avoidProvider?: ProviderName;
    domain: WorkerDomain;
    task?: string;
    workingDirectory?: string;
    requestedModel?: string;
  }): RoutingDecision | null {
    const workingDirectory = input.workingDirectory ?? this.deps.workingDirectory;
    const requested = input.requestedModel?.trim();
    if (!requested || requested === 'auto') {
      return this.resolveIndependentRouting(
        input.avoidModel,
        input.avoidProvider,
        input.domain,
        [],
        input.task,
        'worker',
        workingDirectory,
      );
    }
    if (loadAgentSettings(workingDirectory).restrictDelegationToPools === true) {
      return this.resolveIndependentRouting(
        input.avoidModel,
        input.avoidProvider,
        input.domain,
        [],
        input.task,
        'worker',
        workingDirectory,
        requested,
      );
    }
    return this.resolveConnectedWorkerRoute(requested, input.domain);
  }

  /** Every connected, verified, chat-capable provider:model. Capability-only
   *  providers and providers without a chat-completions contract never qualify. */
  connectedWorkerRoutes(): ConnectedWorkerRoute[] {
    const routes: ConnectedWorkerRoute[] = [];
    for (const status of this.deps.providers.getStatus()) {
      if (!status.adapterAvailable) continue;
      if (!(status.authenticated || status.connectionState === 'verified')) continue;
      if (
        UNSUPPORTED_CHAT_PROVIDER_NAMES.has(status.name) ||
        DEDICATED_CAPABILITY_PROVIDER_NAMES.has(status.name)
      ) {
        continue;
      }
      const catalog =
        status.allAvailableModels.length > 0
          ? status.allAvailableModels.map((def) => ({ id: def.id, aliases: def.aliases ?? [] }))
          : status.models.map((id) => ({ id, aliases: [] as string[] }));
      for (const def of catalog) {
        if (NON_CHAT_MODEL_ID.test(def.id)) continue;
        routes.push({ provider: status.name, model: def.id, aliases: def.aliases });
      }
    }
    return routes;
  }

  private resolveConnectedWorkerRoute(requested: string, _domain: WorkerDomain): RoutingDecision {
    const routes = this.connectedWorkerRoutes();
    const qualified = routes.filter(
      (route) =>
        `${route.provider}:${route.model}` === requested ||
        route.aliases.some((alias) => `${route.provider}:${alias}` === requested),
    );
    const matches =
      qualified.length > 0
        ? qualified
        : routes.filter((route) => route.model === requested || route.aliases.includes(requested));
    if (matches.length === 0) {
      const closest = routes
        .map((route) => ({
          label: `${route.provider}:${route.model}`,
          distance: Math.min(
            editDistance(requested.toLowerCase(), route.model.toLowerCase()),
            editDistance(requested.toLowerCase(), `${route.provider}:${route.model}`.toLowerCase()),
          ),
        }))
        .sort((a, b) => a.distance - b.distance || a.label.localeCompare(b.label))
        .slice(0, SUGGESTION_LIMIT)
        .map((entry) => entry.label);
      throw new Error(
        `Model "${requested}" is not a connected chat model. ` +
          (closest.length
            ? `Closest connected models: ${closest.join(', ')}.`
            : 'No chat model is connected; connect a provider in Settings.'),
      );
    }
    if (matches.length > 1) {
      throw new Error(
        `Model "${requested}" matches several connected providers (${matches
          .map((route) => `${route.provider}:${route.model}`)
          .join(', ')}). Name the provider, for example ${matches[0]!.provider}:${matches[0]!.model}.`,
      );
    }
    const route = matches[0]!;
    if (!this.deps.providers.resolveProvider(route.model, route.provider)) {
      throw new Error(
        `Model "${route.provider}:${route.model}" is listed but its provider is not connected right now.`,
      );
    }
    return { provider: route.provider, model: route.model };
  }
}
