import { createRequire } from 'node:module';
import { sep } from 'node:path';
import { skillEvaluationV5ContractHash } from './skill-eval-contract-hash';
import { EMBEDDED_CURRENT_V5_SKILL_EVALUATION_CONTRACTS } from './skill-eval-embedded-contracts';
import { currentEmbeddedV5SkillEvaluationContracts } from './skill-eval-embedded-contract-validation';
import type { SkillEvalScenarioV3 } from './skill-eval-harness';
import type { V5CompiledSkillPackage } from '../../kory/skill-packages';

const isExternalEnvironmentPlaceholder = (id: string): boolean => id.includes('/external-environment-gate');

export interface CurrentV5SkillEvaluationContract {
  evaluationContractVersion: number;
  evaluationContractHash: string;
  materializerIds: readonly string[];
  scorerIds: readonly string[];
  /**
   * Readiness blockers declared by the materializers that would run this scenario.
   * A materializer that declares one cannot execute here, which is a property of
   * the evaluator environment rather than of the candidate. Absent when nothing is
   * declared, and absent on the embedded fallback metadata, which predates them.
   */
  readinessBlockers?: readonly string[];
}

/** Resolve real registered identities only after the ledger/fixture modules have initialized. */
export function currentV5SkillEvaluationContracts(
  skillPackage: V5CompiledSkillPackage,
  contractVersion: number,
): ReadonlyMap<string, CurrentV5SkillEvaluationContract> {
  const contracts = new Map<string, CurrentV5SkillEvaluationContract>();
  // Fixtures include optional browser/native runtimes. Resolve only at the gate.
  // A genuinely absent registry can use the real build's lightweight identities;
  // an existing source registry that fails initialization must stay fail-closed.
  const requireRegistry = createRequire(import.meta.url);
  // Keep the specifier opaque to Bun's static dependency scanner. In a
  // production bundle the source registry is absent, so resolution fails and
  // the generated metadata below is used; in source/test bundles an adjacent
  // registry can still be discovered and must remain authoritative.
  const registrySpecifier = `.${sep}skill-eval-fixtures`;
  let registryPath: string;
  try {
    registryPath = requireRegistry.resolve(registrySpecifier);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'MODULE_NOT_FOUND') {
      return currentEmbeddedV5SkillEvaluationContracts(
        skillPackage, contractVersion, EMBEDDED_CURRENT_V5_SKILL_EVALUATION_CONTRACTS,
      );
    }
    return contracts;
  }
  let registry: typeof import('./skill-eval-fixtures');
  try {
    registry = requireRegistry(registryPath);
  } catch {
    return contracts;
  }
  const registryEntries = Object.entries(registry as Record<string, unknown>);
  const materializers = registryEntries.find(
    ([key]) => key.startsWith('BUILTIN_SKILL_EVAL_') && key.endsWith('MATERIALIZERS'),
  )?.[1];
  const scorers = registryEntries.find(
    ([key]) => key.startsWith('BUILTIN_SKILL_EVAL_') && key.endsWith('SCORERS'),
  )?.[1];
  if (!Array.isArray(materializers) || !Array.isArray(scorers)) return contracts;
  const materializerRegistry = materializers as Array<{
    id: string;
    matches: (scenario: SkillEvalScenarioV3) => boolean;
    readinessBlockers?: readonly string[] | (() => readonly string[] | undefined);
  }>;
  const scorerRegistry = scorers as Array<{
    id: string;
    scenarioIds: readonly string[];
  }>;
  for (const task of skillPackage.evaluation.tasks) {
    const scenario: SkillEvalScenarioV3 = {
      ...task, skill: skillPackage.sidecar.name, category: 'full-task', expectedSelection: true,
      expectedSkills: [], forbiddenSkills: [], heldOut: true, adjacentSkills: [], tags: ['held-out', 'full-task'],
    };
    const matched = materializerRegistry.filter((item) => item.matches(scenario));
    const materializerIds = matched.map((item) => item.id).sort();
    // A getter is resolved per call because a runtime availability probe is state,
    // not a constant, and the campaign reads the very same declaration.
    // The external environment gate is a placeholder for the absence of an evaluator, not
    // an evaluator. Its declared blocker must stand down once a real materializer covers the
    // scenario, otherwise the gate reports a boundary for a harness that is registered and
    // says it can run. Identities stay untouched so contract hashes do not move and every
    // existing run stays bound to the contract it was produced under.
    const declaringMatchers = matched.some((item) => !isExternalEnvironmentPlaceholder(item.id))
      ? matched.filter((item) => !isExternalEnvironmentPlaceholder(item.id))
      : matched;
    const readinessBlockers = [...new Set(declaringMatchers.flatMap((item) => {
      const declared = typeof item.readinessBlockers === 'function'
        ? item.readinessBlockers()
        : item.readinessBlockers;
      return (declared ?? []).filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
    }))].sort();
    const scorerIds = scorerRegistry.filter((item) => item.scenarioIds.includes(task.id))
      .map((item) => item.id).sort();
    if (!materializerIds.length || !scorerIds.length) continue;
    contracts.set(task.id, {
      evaluationContractVersion: contractVersion,
      evaluationContractHash: skillEvaluationV5ContractHash({
        contractVersion, skill: skillPackage.sidecar.name, packageVersion: skillPackage.sidecar.version,
        scenario: task, materializerIds, scorerIds,
      }),
      materializerIds, scorerIds,
      ...(readinessBlockers.length ? { readinessBlockers } : {}),
    });
  }
  return contracts;
}
