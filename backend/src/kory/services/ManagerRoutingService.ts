import type { WorkerDomain, ProviderName, KoryphaiosConfig } from '@koryphaios/shared';
import type { ProviderRegistry } from '../../providers';
import { serverLog } from '../../logger';
import { loadAgentSettings } from '../../agent-settings';
import { createTaskContract } from '../prompts';
import { resolveSkills } from '../skills';
import { rankHarnessCandidates, type QualificationRole } from '../skill-qualifications';
import { RoutingServiceEnhanced, type RoutingDecision } from './RoutingServiceEnhanced';

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
}
