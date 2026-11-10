import { createHash } from 'node:crypto';
import { isDirectSkillSelection, type ResolvedSkill, type SkillResolverResult } from './skills';
import type { TaskContract, TaskKind } from './prompts';

/** The planner is deliberately conservative: it only runs on resolver output. */
export const DEFAULT_MAX_OPTIONAL_SKILLS = 8;
export const DEFAULT_CHARS_PER_TOKEN = 4;
const RESOLVER_REQUIRED_SKILL_NAMES = ['task-routing'] as const;

export interface SkillPruningOptions {
  /** Explicit pins are protected even when the resolver's reason is legacy text. */
  explicitPins?: readonly string[];
  assignedSkills?: readonly string[];
  requiredCoreSkills?: readonly string[];
  repositoryMutation?: boolean;
  taskContract?: Pick<TaskContract, 'taskKind' | 'risk'>;
  /** A high-risk direct match owns the corresponding high-consequence boundary. */
  protectHighRiskDirectOwners?: boolean;
  maxOptionalSkills?: number;
  budgetChars?: number;
  budgetTokens?: number;
  charsPerToken?: number;
}

export interface SkillPruningPlan {
  selected: ResolvedSkill[];
  promptText: string;
  manifestHash: string;
  totalContextCost: number;
  contextOverheadCost: number;
  budgetChars: number;
  prunedSkillNames: string[];
  failed: boolean;
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

function manifestFor(selected: readonly ResolvedSkill[]) {
  return selected.map(
    ({ skill, reason, representation, contextCost, fullContextCost, omittedDetailChars }) => ({
      name: skill.name,
      version: skill.metadata.version,
      source: skill.source,
      hash: skill.hash,
      reason,
      representation,
      contextCost,
      fullContextCost,
      omittedDetailChars,
    }),
  );
}

function normalizedPromptBlock(promptText: string): string {
  // Resolver blocks carry their separator so they can be joined directly. The
  // planner may remove an earlier item, so rebuild separators without touching
  // any authored skill text.
  return promptText.replace(/^\n+/, '');
}

function renderSelected(selected: readonly ResolvedSkill[]): {
  selected: ResolvedSkill[];
  promptText: string;
  manifestHash: string;
  totalContextCost: number;
  contextOverheadCost: number;
} {
  const materialized = selected.map((item, index) => {
    const promptText = `${index > 0 ? '\n\n' : ''}${normalizedPromptBlock(item.promptText)}`;
    const fullContextCost = Math.max(item.fullContextCost, promptText.length);
    return {
      ...item,
      promptText,
      contextCost: promptText.length,
      fullContextCost,
      omittedDetailChars: Math.max(0, fullContextCost - promptText.length),
    };
  });
  const manifestHash = sha256(JSON.stringify(manifestFor(materialized)));
  const skillText = materialized.length
    ? materialized.map(({ promptText }) => promptText).join('')
    : 'No local skills were selected.';
  const promptText = `## Active local skills\nManifest: ${materialized.length} ordered skills; identities in the headers below\nManifest sha256: ${manifestHash}\n${skillText}`;
  const itemCost = materialized.reduce((sum, item) => sum + item.contextCost, 0);
  return {
    selected: materialized,
    promptText,
    manifestHash,
    totalContextCost: promptText.length,
    contextOverheadCost: promptText.length - itemCost,
  };
}

function normalizedBudgetChars(
  resolution: SkillResolverResult,
  options: SkillPruningOptions,
): number {
  const charsPerToken =
    Number.isFinite(options.charsPerToken) && (options.charsPerToken ?? 0) > 0
      ? Math.floor(options.charsPerToken!)
      : DEFAULT_CHARS_PER_TOKEN;
  const explicitChars = options.budgetChars;
  const explicitTokens = options.budgetTokens;
  const budget =
    Number.isFinite(explicitChars) && (explicitChars ?? 0) >= 0
      ? explicitChars!
      : Number.isFinite(explicitTokens) && (explicitTokens ?? 0) >= 0
        ? explicitTokens! * charsPerToken
        : resolution.contextBudget;
  return Math.max(0, Math.floor(budget));
}

function normalizedMaxOptionalSkills(options: SkillPruningOptions): number {
  return Number.isFinite(options.maxOptionalSkills) && (options.maxOptionalSkills ?? 0) >= 0
    ? Math.floor(options.maxOptionalSkills!)
    : DEFAULT_MAX_OPTIONAL_SKILLS;
}

function directReason(item: ResolvedSkill): string {
  return item.reason.toLowerCase();
}

function isPinnedReason(item: ResolvedSkill): boolean {
  return directReason(item).startsWith('pinned explicitly');
}

function isSecurityHighConsequence(
  taskContract?: Pick<TaskContract, 'taskKind' | 'risk'>,
): boolean {
  return taskContract?.taskKind === 'security-infra' || taskContract?.risk === 'high';
}

function requiredNames(options: SkillPruningOptions): Set<string> {
  const names = new Set([
    ...RESOLVER_REQUIRED_SKILL_NAMES,
    ...(options.explicitPins ?? []),
    ...(options.assignedSkills ?? []),
    ...(options.requiredCoreSkills ?? []),
  ]);
  if (options.repositoryMutation) names.add('repository-environment-discovery');
  if (
    options.taskContract &&
    !['question', 'research-docs'].includes(options.taskContract.taskKind)
  ) {
    names.add('testing-engineering');
    names.add('verification');
  }
  if (options.taskContract?.taskKind === 'bug') names.add('debugging');
  if (isSecurityHighConsequence(options.taskContract)) names.add('security-review');
  return names;
}

function validateClosureInputs(
  selected: readonly ResolvedSkill[],
  protectedRoots: ReadonlySet<string>,
  byName: ReadonlyMap<string, ResolvedSkill>,
): void {
  for (const root of protectedRoots) {
    if (!byName.has(root)) throw new Error(`Pruning closure root is unavailable: ${root}`);
  }

  for (const item of selected) {
    for (const dependency of [...item.skill.metadata.broader, ...item.skill.metadata.requires]) {
      if (!byName.has(dependency)) {
        throw new Error(
          `Pruning closure references unavailable dependency ${dependency} from ${item.skill.name}`,
        );
      }
    }
  }
}

function relationDependencies(
  item: ResolvedSkill,
  byName: ReadonlyMap<string, ResolvedSkill>,
): string[] {
  const names = [...item.skill.metadata.broader, ...item.skill.metadata.requires].filter((name) =>
    byName.has(name),
  );
  // Facets are represented by a provenance reason rather than a reciprocal
  // metadata edge. Keep a retained direct owner's selected facets together.
  for (const candidate of byName.values()) {
    if (candidate.reason === `Professional facet of ${item.skill.name} (declared relation)`) {
      names.push(candidate.skill.name);
    }
  }
  return [...new Set(names)];
}

function closureOf(
  roots: Iterable<string>,
  byName: ReadonlyMap<string, ResolvedSkill>,
): Set<string> {
  const closure = new Set<string>();
  const visit = (name: string): void => {
    if (closure.has(name)) return;
    const item = byName.get(name);
    if (!item) throw new Error(`Pruning closure references unavailable skill ${name}`);
    closure.add(name);
    for (const dependency of relationDependencies(item, byName)) visit(dependency);
  };
  for (const root of roots) if (byName.has(root)) visit(root);
  return closure;
}

function compareOptionalRelevance(left: ResolvedSkill, right: ResolvedSkill): number {
  const leftDirect = isDirectSkillSelection(left) ? 1 : 0;
  const rightDirect = isDirectSkillSelection(right) ? 1 : 0;
  if (leftDirect !== rightDirect) return rightDirect - leftDirect;

  const relevance = (item: ResolvedSkill): number => {
    const reason = directReason(item);
    if (reason.startsWith('matched ')) return 3;
    if (reason.startsWith('selected ')) return 2;
    if (reason.startsWith('required ')) return 1;
    return 0;
  };
  const relevanceDifference = relevance(right) - relevance(left);
  if (relevanceDifference) return relevanceDifference;
  return (
    right.skill.metadata.depth - left.skill.metadata.depth ||
    left.skill.name.localeCompare(right.skill.name)
  );
}

/**
 * Plan a deterministic, runtime-only reduction of an already-resolved bundle.
 * This function does not inspect skill files, perform routing, or change any
 * qualification/provider/model state.
 *
 * Integration point: a prompt compiler may call this after the resolver has
 * returned a non-blocked result and after dependency/conflict closure. The
 * companion apply function preserves the original resolver object on planner
 * failure, so callers can adopt this boundary without changing routing.
 */
export function planSkillPruning(
  resolution: SkillResolverResult,
  options: SkillPruningOptions = {},
): SkillPruningPlan {
  try {
    const selected = resolution.selected;
    const byName = new Map(selected.map((item) => [item.skill.name, item]));
    const budgetChars = normalizedBudgetChars(resolution, options);
    const maxOptionalSkills = normalizedMaxOptionalSkills(options);
    const protectedRoots = requiredNames(options);

    for (const item of selected) {
      if (isPinnedReason(item)) protectedRoots.add(item.skill.name);
      if (
        (options.protectHighRiskDirectOwners || isSecurityHighConsequence(options.taskContract)) &&
        isDirectSkillSelection(item)
      ) {
        protectedRoots.add(item.skill.name);
      }
    }

    validateClosureInputs(selected, protectedRoots, byName);
    const protectedNames = closureOf(protectedRoots, byName);
    const optionalRoots = selected
      .filter((item) => !protectedNames.has(item.skill.name) && isDirectSkillSelection(item))
      .sort(compareOptionalRelevance);
    const retainedNames = new Set(protectedNames);

    for (const root of optionalRoots) {
      const candidateClosure = closureOf([root.skill.name], byName);
      const optionalCount = [...new Set([...retainedNames, ...candidateClosure])].filter(
        (name) => !protectedNames.has(name),
      ).length;
      if (optionalCount > maxOptionalSkills) continue;

      const trialNames = new Set([...retainedNames, ...candidateClosure]);
      const trialSelected = selected.filter((item) => trialNames.has(item.skill.name));
      if (renderSelected(trialSelected).totalContextCost <= budgetChars) {
        for (const name of candidateClosure) retainedNames.add(name);
      }
    }

    const finalSelected = selected.filter((item) => retainedNames.has(item.skill.name));
    const rendered = renderSelected(finalSelected);
    return {
      ...rendered,
      budgetChars,
      prunedSkillNames: selected
        .filter((item) => !retainedNames.has(item.skill.name))
        .map((item) => item.skill.name),
      failed: false,
    };
  } catch {
    // A malformed legacy resolution must never make a turn lose its original
    // guidance. Returning the original array also gives callers an identity
    // check for the fail-open planner path.
    return {
      selected: resolution.selected,
      promptText: resolution.promptText,
      manifestHash: resolution.manifestHash,
      totalContextCost: resolution.totalContextCost,
      contextOverheadCost: resolution.contextOverheadCost,
      budgetChars: resolution.contextBudget,
      prunedSkillNames: [],
      failed: true,
    };
  }
}

/** Apply a successful plan while preserving every unrelated resolver field. */
export function applySkillPruningPlan(
  resolution: SkillResolverResult,
  plan: SkillPruningPlan,
): SkillResolverResult {
  if (plan.failed || plan.prunedSkillNames.length === 0) return resolution;
  return {
    ...resolution,
    selected: plan.selected,
    promptText: plan.promptText,
    manifestHash: plan.manifestHash,
    totalContextCost: plan.totalContextCost,
    contextOverheadCost: plan.contextOverheadCost,
    compressedByBudget: resolution.compressedByBudget.filter((item) =>
      plan.selected.some((selected) => selected.skill.name === item.name),
    ),
  };
}

export function isRepositoryMutationTask(taskKind: TaskKind): boolean {
  return !['question', 'research-docs'].includes(taskKind);
}
