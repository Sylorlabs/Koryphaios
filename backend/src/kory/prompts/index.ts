/** Versioned prompt compiler shared by manager, worker, and critic execution. */

import type { ProviderName, UIMode, WorkerDomain } from '@koryphaios/shared';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { getProviderHarnessCapabilities } from '../../providers/provider-harness';
import { resolveTrustedContextWindow } from '../../providers/models';
import {
  deriveAuthoritativeTargetMedium,
  resolveSkills,
  type SkillResolverResult,
} from '../skills';

export const PROMPT_VERSION = 'kory-workflow-v6-verified-context-skills';

export type TaskKind =
  | 'question'
  | 'bug'
  | 'mechanical-edit'
  | 'refactor'
  | 'feature'
  | 'ui'
  | 'research-docs'
  | 'security-infra';
export type PromptRole = 'manager' | 'worker' | 'critic';

export interface TaskContract {
  goal: string;
  taskKind: TaskKind;
  scope: string[];
  nonGoals: string[];
  constraints: string[];
  acceptanceCriteria: string[];
  risk: 'low' | 'medium' | 'high';
  requiredEvidence: string[];
  /** Durable Goal Mode context; preserved through manager, worker, critic, and retries. */
  goalContext?: {
    goalId: string;
    objective: string;
    itemId: string;
    itemTitle: string;
    verification: 'eligible' | 'unverified' | 'remote-pending-review';
  };
}

export interface InstructionSource {
  path: string;
  scope: string;
  priority: number;
  hash: string;
  content: string;
  truncated: boolean;
}

export interface ProviderCapabilityProfile {
  mode: 'managed' | 'native-passthrough';
  hardToolPolicy: boolean;
  edit: boolean;
  shell: boolean;
  browser: boolean;
  filesystemIsolation: boolean;
  qualifiedRoles: PromptRole[];
  version: string;
  hash: string;
  isolationMechanism: string;
  verificationEligible: boolean;
  limitations: string[];
}

export interface PromptManifest {
  version: string;
  hash: string;
  role: PromptRole;
  taskContract: TaskContract;
  instructions: Array<Omit<InstructionSource, 'content'>>;
  providerAdapter: string;
  capabilityProfile: ProviderCapabilityProfile;
  skills: Array<{
    name: string;
    version: string;
    source: string;
    hash: string;
    reason: string;
    representation: 'full' | 'compact' | 'minimal';
    contextCost: number;
    fullContextCost: number;
    omittedDetailChars: number;
  }>;
  skillManifestHash: string;
  targetMedium?: string;
  skillContextBudget: SkillContextBudgetDecision;
  skillContextCost: number;
  /** Fail-closed UTF-8 byte upper bound for the compiled system prompt. */
  systemPromptTokenUpperBound: number;
  /** Occupied context + compiled prompt + the actual reserved completion limit. */
  totalContextTokenUpperBound: number;
  conflicts: string[];
  taskContractHash: string;
}

export interface QualityGateReport {
  verdict: 'passed' | 'failed' | 'blocked' | 'unverified';
  checks: Array<{ command: string; passed: boolean; output?: string }>;
  artifacts: string[];
  criticFindings: Array<{
    severity: 'critical' | 'major' | 'minor';
    evidence: string;
    criterion: string;
    finding: string;
  }>;
  unmetCriteria: string[];
  reasons: string[];
}

export interface IntentDecisionState {
  resolved: Record<string, string>;
  unresolved: string[];
  recommendedDefaults: Record<string, string>;
  userOverrides: Record<string, string>;
  discoveryEndedEarly: boolean;
}

export interface CompiledPrompt {
  systemPrompt: string;
  manifest: PromptManifest;
  /** Non-fatal issues encountered during compilation. Callers may surface
   *  these to the user as warnings (e.g. via a system.warning WS event). */
  warnings?: string[];
}

export interface SkillContextBudgetDecision {
  budget: number;
  requestedBudget: number;
  source: 'planning-default' | 'trusted-model-window';
  contextWindowTokens?: number;
  /** Legacy diagnostic retained for clients; live budgeting uses token upper bounds below. */
  occupiedContextChars: number;
  nonSkillPromptChars: number;
  occupiedContextTokenUpperBound: number;
  nonSkillPromptTokenUpperBound: number;
  reservedOutputTokens?: number;
}

/** Legacy mode-copy shape retained for UI/status callers; live agents use compilePrompt. */
export interface PromptTemplate {
  managerSystem: string;
  workerSystem: string;
  criticSystem: string;
  workerDelegation: (domain: string) => string;
  criticReview: string;
  toolDescriptions: Record<string, string>;
  errors: {
    noProvider: string;
    toolFailed: string;
    workerFailed: string;
    noGitRepo: string;
  };
  thoughts: {
    analyzing: string;
    planning: string;
    executing: string;
    reviewing: string;
    complete: string;
  };
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

export function classifyTask(goal: string, domain?: WorkerDomain): TaskKind {
  const text = goal.toLowerCase();
  if (
    domain === 'ui' ||
    /\b(ui|ux|interface|layout|screen|component|responsive|accessibility|navigation|editor|findability|microcopy)\b/.test(
      text,
    ) ||
    (/\bdesign\b/.test(text) &&
      /\b(flow|interaction|navigation|screen|editor|interface|experience|recovery)\b/.test(text))
  )
    return 'ui';
  if (
    /\b(security|permission|permissions|auth|authorization|authorisation|access control|secret|infra|deploy|migration|database)\b/.test(
      text,
    )
  )
    return 'security-infra';
  if (/\b(bug|fix|broken|error|regression|fails?|crash)\b/.test(text)) return 'bug';
  if (/\b(refactor|restructure|architecture|extract|consolidate)\b/.test(text)) return 'refactor';
  if (/\b(research|document|docs|readme|investigate|compare)\b/.test(text)) return 'research-docs';
  if (
    /\b(add|build|implement|create|feature|fuzz|fuzzing|property test|property tests|differential test|differential tests)\b/.test(
      text,
    )
  )
    return 'feature';
  if (/\b(rename|replace|format|bump|update string|mechanical)\b/.test(text))
    return 'mechanical-edit';
  return 'question';
}

/** Tasks where Multi-Agent mode must use at least one worker. Small questions and
 * mechanical edits stay direct because delegation would add coordination without
 * creating an independent workstream. */
export function requiresMultiAgentDelegation(goal: string, domain?: WorkerDomain): boolean {
  return !['question', 'mechanical-edit'].includes(classifyTask(goal, domain));
}

export function createTaskContract(
  goal: string,
  options: Partial<Omit<TaskContract, 'goal' | 'taskKind'>> & { taskKind?: TaskKind } = {},
): TaskContract {
  const taskKind = options.taskKind ?? classifyTask(goal);
  const normalizedGoal = goal.toLowerCase();
  const verificationOnly =
    /\b(assess|audit|review|verify|verification|fuzz|fuzzing|test|testing|benchmark|threat model)\b/.test(
      normalizedGoal,
    ) &&
    !/\b(add|build|implement|create|change|edit|fix|refactor|rewrite|replace)\b/.test(
      normalizedGoal,
    );
  const changesCode = taskKind !== 'question' && taskKind !== 'research-docs' && !verificationOnly;
  const requiresVerification = changesCode || verificationOnly || taskKind === 'security-infra';
  return {
    goal: goal.trim(),
    taskKind,
    scope: options.scope ?? [],
    nonGoals: options.nonGoals ?? [
      'Unrequested publishing, commits, pull requests, or unrelated cleanup',
    ],
    constraints: options.constraints ?? [],
    acceptanceCriteria: options.acceptanceCriteria ?? [
      'The requested outcome is complete without hidden scope expansion',
      ...(requiresVerification
        ? ['Relevant repository or runtime checks pass without weakening evidence']
        : []),
    ],
    risk:
      options.risk ??
      (taskKind === 'security-infra'
        ? 'high'
        : taskKind === 'refactor' || taskKind === 'feature' || taskKind === 'ui'
          ? 'medium'
          : 'low'),
    requiredEvidence:
      options.requiredEvidence ??
      (changesCode
        ? ['Actual diff', 'Relevant deterministic checks']
        : verificationOnly || taskKind === 'security-infra'
          ? [
              'Exact verification commands or inspected artifacts',
              'Reproducible findings with explicit unavailable limits',
            ]
          : ['Evidence-backed answer']),
    goalContext: options.goalContext,
  };
}

function findRepositoryRoot(start: string): string {
  let current = resolve(start);
  while (true) {
    if (existsSync(join(current, '.git'))) return current;
    const parent = dirname(current);
    if (parent === current) return resolve(start);
    current = parent;
  }
}

/** Load broad-to-specific instructions. Later entries have higher precedence. */
export function loadRepositoryInstructions(
  workingDirectory: string,
  configuredPaths: string[] = [],
  maxCharsPerSource = 20_000,
): InstructionSource[] {
  const cwd = resolve(workingDirectory);
  const root = findRepositoryRoot(cwd);
  const directories: string[] = [];
  let current = cwd;
  while (current.startsWith(root)) {
    directories.unshift(current);
    if (current === root) break;
    current = dirname(current);
  }

  const candidates = directories.map((directory) => {
    const override = join(directory, 'AGENTS.override.md');
    return existsSync(override) ? override : join(directory, 'AGENTS.md');
  });
  for (const configuredPath of configuredPaths) {
    const path = isAbsolute(configuredPath) ? configuredPath : join(root, configuredPath);
    candidates.push(path);
  }

  return [...new Set(candidates)]
    .filter((path) => existsSync(path))
    .map((path, index) => {
      const full = readFileSync(path, 'utf8');
      const content = full.slice(0, maxCharsPerSource);
      return {
        path,
        scope: relative(root, dirname(path)) || '.',
        priority: index + 1,
        hash: sha256(full),
        content,
        truncated: content.length < full.length,
      };
    });
}

/** Report instruction conditions which must be visible instead of silently guessed. */
export function inspectInstructionSources(
  workingDirectory: string,
  configuredPaths: string[] = [],
): { sources: InstructionSource[]; conflicts: string[] } {
  const sources = loadRepositoryInstructions(workingDirectory, configuredPaths);
  const conflicts: string[] = [];
  for (const source of sources) {
    if (source.truncated) conflicts.push(`Instruction source was truncated: ${source.path}`);
  }
  const byScope = new Map<string, InstructionSource[]>();
  for (const source of sources) {
    const scoped = byScope.get(source.scope) ?? [];
    scoped.push(source);
    byScope.set(source.scope, scoped);
  }
  for (const [scope, scoped] of byScope) {
    const unique = new Set(scoped.map((source) => source.hash));
    if (unique.size > 1) {
      conflicts.push(
        `Multiple distinct instruction sources apply at scope ${scope}: ${scoped.map((source) => source.path).join(', ')}`,
      );
    }
  }
  return { sources, conflicts };
}

const UNIVERSAL_CORE = `## Non-negotiable execution contract
- Obey the current task scope and applicable repository instructions. Current user constraints override standing preferences; more specific repository instructions override broader ones.
- Inspect relevant code, tests, configuration, and existing patterns before changing anything.
- Preserve the existing architecture and design system. Make the minimum sufficient change and fix root causes.
- Prefer modifying an appropriate existing file over creating a new file. Create a file only when it has a distinct durable responsibility or the repository convention requires it; never create speculative wrappers, abstractions, or duplicate implementations.
- Never hard-code a narrow domain assumption into a universal workflow. Domain expertise belongs in a conditional quality profile or separately versioned skill. UI guidance is medium-neutral: native, terminal, embedded, game, spatial, mobile, and web interfaces must follow their own toolkit and repository rules.
- Do not disguise stubs, uncertainty, skipped checks, unavailable evidence, or partial work. Never claim completion without exact evidence.
- Publishing is separate from implementation. Do not commit, push, or open a pull request unless the user or an explicit workspace policy requested it.
- Notice when the work would benefit from durable Goal Mode or a reusable workflow. Suggest Goal Mode for long-running, multi-session, dependency-heavy, or evidence-tracked outcomes. Suggest a workflow when the same ordered procedure is likely to recur. Make the suggestion briefly and at a natural boundary; do not interrupt active work, repeatedly ask, or suggest either for ordinary questions, one-off fixes, or small edits. Never create a goal or workflow without the user's explicit approval.
- Work autonomously inside the granted project jail. Do not ask for routine edits, shell commands, tests, installs, network access, or delegation. Ask only immediately before catastrophic broad destruction such as recursively deleting a home/root directory, formatting a disk, destructive raw-device writes, or powering down the host.`;

const DEFAULT_SKILL_CONTEXT_BUDGET = 30_000;
export const MANAGER_OUTPUT_TOKEN_LIMIT = 16_384;
export const WORKER_OUTPUT_TOKEN_LIMIT = 16_384;
export const CRITIC_OUTPUT_TOKEN_LIMIT = 2_048;

/**
 * A UTF-8 byte count is a tokenizer-independent upper bound for byte-fallback
 * provider tokenizers. It is deliberately much stricter than a universal
 * chars-per-token guess, which is unsafe for CJK, emoji, code, and binary-like
 * tool output.
 */
export function textTokenUpperBound(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

/**
 * Cap skill context by a provider-confirmed model window and everything already
 * occupying that window. Without a verified window this returns a planning-only
 * budget; compilePrompt rejects that state whenever live execution requires
 * verified capacity.
 */
export function deriveSkillContextBudget(input: {
  requestedBudget?: number;
  contextWindowTokens?: number;
  occupiedContextChars?: number;
  nonSkillPromptChars?: number;
  occupiedContextTokenUpperBound?: number;
  nonSkillPromptTokenUpperBound?: number;
  reservedOutputTokens?: number;
}): SkillContextBudgetDecision {
  const requestedBudget = Math.max(
    1,
    Math.floor(input.requestedBudget ?? DEFAULT_SKILL_CONTEXT_BUDGET),
  );
  const occupiedContextChars = Math.max(0, Math.floor(input.occupiedContextChars ?? 0));
  const nonSkillPromptChars = Math.max(0, Math.floor(input.nonSkillPromptChars ?? 0));
  const occupiedContextTokenUpperBound = Math.max(
    0,
    Math.floor(input.occupiedContextTokenUpperBound ?? occupiedContextChars),
  );
  const nonSkillPromptTokenUpperBound = Math.max(
    0,
    Math.floor(input.nonSkillPromptTokenUpperBound ?? nonSkillPromptChars),
  );
  const window = input.contextWindowTokens;
  if (!window || !Number.isFinite(window) || window < 1_024) {
    return {
      budget: requestedBudget,
      requestedBudget,
      source: 'planning-default',
      occupiedContextChars,
      nonSkillPromptChars,
      occupiedContextTokenUpperBound,
      nonSkillPromptTokenUpperBound,
    };
  }
  const reservedOutputTokens = Math.max(
    1,
    Math.floor(input.reservedOutputTokens ?? MANAGER_OUTPUT_TOKEN_LIMIT),
  );
  const availableTokens = Math.max(
    0,
    Math.floor(window) -
      occupiedContextTokenUpperBound -
      nonSkillPromptTokenUpperBound -
      reservedOutputTokens,
  );
  return {
    // Skill definitions are currently budgeted in JS characters. Capping that
    // count at the remaining token upper bound is safe for ASCII; compilePrompt
    // performs a final UTF-8 bound over the exact provider-rendered prompt to
    // catch non-ASCII skills and adapter framing before any provider call.
    budget: Math.max(1, Math.min(requestedBudget, availableTokens)),
    requestedBudget,
    source: 'trusted-model-window',
    contextWindowTokens: Math.floor(window),
    occupiedContextChars,
    nonSkillPromptChars,
    occupiedContextTokenUpperBound,
    nonSkillPromptTokenUpperBound,
    reservedOutputTokens,
  };
}

/** Fail-closed tokenizer-independent upper bound for serialized conversation/tool context. */
export function estimateOccupiedContextTokenUpperBound(messages: readonly unknown[]): number {
  return messages.reduce<number>((total, message) => {
    try {
      return total + textTokenUpperBound(JSON.stringify(message));
    } catch {
      return total + textTokenUpperBound(String(message));
    }
  }, 0);
}

/** @deprecated Use estimateOccupiedContextTokenUpperBound for live budgeting. */
export const estimateOccupiedContextChars = estimateOccupiedContextTokenUpperBound;

function providerAdapter(provider: ProviderName | string): string {
  if (provider === 'openai' || provider === 'codex') return 'openai-v1';
  if (provider === 'anthropic' || provider === 'claude') return 'anthropic-v1';
  if (
    provider === 'google' ||
    provider === 'google-ai-studio' ||
    provider === 'aistudio' ||
    provider === 'vertex' ||
    provider === 'vertexai' ||
    provider === 'gemini-cli'
  )
    return 'google-v1';
  return 'native-generic-v1';
}

function capabilities(provider: ProviderName | string): ProviderCapabilityProfile {
  const harness = getProviderHarnessCapabilities(provider);
  return {
    mode: harness.mode,
    hardToolPolicy: harness.hardRoleToolPolicy,
    edit: harness.edit,
    shell: harness.shell,
    browser: harness.browser,
    filesystemIsolation: harness.filesystemIsolation,
    qualifiedRoles: ['manager', 'worker', 'critic'],
    version: harness.version,
    hash: harness.hash,
    isolationMechanism: harness.isolationMechanism,
    verificationEligible: harness.verificationEligible,
    limitations: harness.limitations,
  };
}

function renderTaskContract(contract: TaskContract): string {
  const goalContext = contract.goalContext
    ? `\n\n## Goal Mode execution context (immutable)\nGoal ID: ${contract.goalContext.goalId}\nGoal objective: ${contract.goalContext.objective}\nActive checklist item: ${contract.goalContext.itemTitle} (${contract.goalContext.itemId})\nProvider verification: ${contract.goalContext.verification}\nDo not mark this item or goal complete without concrete verified evidence. ${contract.goalContext.verification === 'eligible' ? '' : 'This provider result is not sufficient completion evidence; require independent managed/local verification.'}`
    : '';
  return `## Immutable task contract
Goal: ${contract.goal}
Kind: ${contract.taskKind}
Scope: ${contract.scope.length ? contract.scope.join(', ') : 'the user-requested workspace scope'}
Non-goals: ${contract.nonGoals.join('; ')}
Constraints: ${contract.constraints.length ? contract.constraints.join('; ') : 'none supplied'}
Acceptance criteria:\n${contract.acceptanceCriteria.map((item) => `- ${item}`).join('\n')}
Risk: ${contract.risk}
Required evidence:\n${contract.requiredEvidence.map((item) => `- ${item}`).join('\n')}${goalContext}`;
}

function renderForProvider(adapter: string, sections: string[]): string {
  if (adapter === 'anthropic-v1') {
    return sections
      .map((section, index) => `<kory_section index="${index + 1}">\n${section}\n</kory_section>`)
      .join('\n\n');
  }
  if (adapter === 'google-v1') {
    return sections
      .map((section, index) => `--- KORY SECTION ${index + 1} ---\n${section}`)
      .join('\n\n');
  }
  return sections.join('\n\n');
}

export function compilePrompt(input: {
  role: PromptRole;
  mode: UIMode;
  provider: ProviderName | string;
  /** Exact selected model ID; context capacity is used only when live-verified. */
  model?: string;
  /** Conversation/tool context already occupying the model window. */
  occupiedContextChars?: number;
  /** Tokenizer-independent UTF-8 upper bound for live occupied context. */
  occupiedContextTokenUpperBound?: number;
  /** Exact maximum completion requested by the caller. */
  reservedOutputTokens?: number;
  /** Live execution must not guess a model window from its name or a default. */
  requireVerifiedContextWindow?: boolean;
  workingDirectory: string;
  taskContract: TaskContract;
  contextPaths?: string[];
  skillSelection?: {
    pins?: string[];
    remove?: string[];
    collisionChoices?: Record<string, 'personal' | 'project'>;
    targetMedium?: string;
    contextBudget?: number;
  };
}): CompiledPrompt {
  const instructionState = inspectInstructionSources(input.workingDirectory, input.contextPaths);
  const sources = instructionState.sources;
  const adapter = providerAdapter(input.provider);
  const capabilityProfile = capabilities(input.provider);
  const roleRules =
    input.role === 'manager'
      ? 'You are Kory, the user-facing manager. The user manually chose your model; never replace or auto-rank the manager. Choose subagents only from the user-enabled category pool. Prefer an agent identity distinct from yourself and prefer a different provider harness for material work, but when the user enabled only one eligible model, reuse it rather than blocking delegation. Disclose that the agent is not independent. Apply the same evidence standard to direct and delegated edits.'
      : input.role === 'worker'
        ? 'You are a bounded implementation worker. Preserve the immutable objective across retries, stay within granted paths, and return changed files plus exact verification evidence.'
        : 'You are a fresh independent critic. You are read-only. Judge the actual diff and evidence against every acceptance criterion. Missing or malformed evidence is not a pass.';
  const criticOutputContract =
    input.role === 'critic'
      ? 'Return JSON only with this exact shape: {"verdict":"PASS|FAIL","findings":[{"severity":"critical|major|minor","evidence":"file, line, artifact, or check","criterion":"affected acceptance criterion","finding":"actionable defect"}],"checksReviewed":["exact check or artifact"],"unmetCriteria":["criterion"]}. PASS requires no critical or major findings. Malformed output fails closed.'
      : '';
  const style =
    input.mode === 'beginner'
      ? 'Explain outcomes in plain, respectful language without weakening technical rigor or hiding failures.'
      : 'Communicate concisely and technically. Lead with outcomes and exact evidence.';
  const instructionText = sources.length
    ? sources
        .map(
          (source) =>
            `### ${source.path} (scope: ${source.scope}, priority: ${source.priority}, sha256: ${source.hash}${source.truncated ? ', TRUNCATED' : ''})\n${source.content}`,
        )
        .join('\n\n')
    : 'No repository instruction files were found.';
  const providerRules =
    capabilityProfile.mode === 'native-passthrough'
      ? 'This provider uses a native harness wrapped by Kory role policy and verification. Filesystem isolation is guaranteed only when the runtime capability manifest reports it active; otherwise label it unavailable. Provider-specific quality measurements may influence recommendations but never remove role capability.'
      : 'This is Kory-managed execution. Tool and filesystem policy are enforced by the harness; do not attempt to bypass them.';
  const baseSections = [
    `# Koryphaios prompt ${PROMPT_VERSION} (${adapter})`,
    roleRules,
    criticOutputContract,
    style,
    UNIVERSAL_CORE,
    renderTaskContract(input.taskContract),
    `## Provider capability truth\n${providerRules}`,
    `## Applicable repository instructions (broad to specific)\n${instructionText}`,
  ];
  const trustedWindow = input.model
    ? resolveTrustedContextWindow(input.model, input.provider as ProviderName)
    : { contextKnown: false as const };
  const warnings: string[] = [];
  if (input.requireVerifiedContextWindow && !trustedWindow.contextKnown) {
    // Don't hard-block — warn instead.  Without a verified context window,
    // skill budgeting falls back to a conservative default and compaction
    // may be less precise, but the agent can still work.
    warnings.push(
      `Context window unverified for ${input.provider}/${input.model ?? 'unknown model'} — skill budgeting and compaction may be less precise.`,
    );
  }
  const renderedBasePrompt = renderForProvider(adapter, baseSections);
  const occupiedContextTokenUpperBound = Math.max(
    0,
    Math.floor(input.occupiedContextTokenUpperBound ?? input.occupiedContextChars ?? 0),
  );
  const skillContextBudget = deriveSkillContextBudget({
    requestedBudget: input.skillSelection?.contextBudget,
    contextWindowTokens: trustedWindow.contextKnown ? trustedWindow.contextWindow : undefined,
    occupiedContextChars: input.occupiedContextChars,
    nonSkillPromptChars: renderedBasePrompt.length,
    occupiedContextTokenUpperBound,
    nonSkillPromptTokenUpperBound: textTokenUpperBound(renderedBasePrompt),
    reservedOutputTokens: input.reservedOutputTokens ?? MANAGER_OUTPUT_TOKEN_LIMIT,
  });
  const targetMedium =
    input.skillSelection?.targetMedium ?? deriveAuthoritativeTargetMedium(input.taskContract.goal);
  const skillResolution: SkillResolverResult = resolveSkills(
    input.workingDirectory,
    input.taskContract.goal,
    input.taskContract,
    {
      ...input.skillSelection,
      targetMedium,
      contextBudget: skillContextBudget.budget,
    },
  );
  if (skillResolution.blocked) {
    const conflicts = [
      ...skillResolution.collisions.map((item) => item.name),
      ...skillResolution.selectionConflicts.map((item) => `${item.left} <> ${item.right}`),
      ...skillResolution.hierarchyErrors,
    ];
    throw new Error(`Skill resolution blocked before work starts: ${conflicts.join(', ')}`);
  }
  const skillManifest = skillResolution.selected.map(
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
  const systemPrompt = renderForProvider(adapter, [...baseSections, skillResolution.promptText]);
  const systemPromptTokenUpperBound = textTokenUpperBound(systemPrompt);
  const totalContextTokenUpperBound =
    occupiedContextTokenUpperBound +
    systemPromptTokenUpperBound +
    (skillContextBudget.reservedOutputTokens ??
      input.reservedOutputTokens ??
      MANAGER_OUTPUT_TOKEN_LIMIT);
  if (
    trustedWindow.contextKnown &&
    trustedWindow.contextWindow !== undefined &&
    totalContextTokenUpperBound > trustedWindow.contextWindow
  ) {
    throw new Error(
      `Skill resolution blocked before work starts: exact provider-rendered context requires at most ${totalContextTokenUpperBound} tokens by the fail-closed UTF-8 bound, exceeding the verified ${trustedWindow.contextWindow}-token window`,
    );
  }
  const manifestBase = {
    version: PROMPT_VERSION,
    role: input.role,
    taskContract: input.taskContract,
    instructions: sources.map(({ content: _content, ...source }) => source),
    providerAdapter: adapter,
    capabilityProfile,
    skills: skillManifest,
    skillManifestHash: skillResolution.manifestHash,
    ...(targetMedium ? { targetMedium } : {}),
    skillContextBudget,
    skillContextCost: skillResolution.totalContextCost,
    systemPromptTokenUpperBound,
    totalContextTokenUpperBound,
    conflicts: instructionState.conflicts,
    taskContractHash: sha256(JSON.stringify(input.taskContract)),
  };
  return {
    systemPrompt,
    manifest: { ...manifestBase, hash: sha256(JSON.stringify(manifestBase) + systemPrompt) },
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

/** Compatibility helper for mode-specific status copy. Quality rules are compiled above. */
export function getPrompts(mode: UIMode): PromptTemplate {
  const beginner = mode === 'beginner';
  return {
    managerSystem:
      'Live manager prompts are generated by the versioned Koryphaios prompt compiler.',
    workerSystem: 'Live worker prompts are generated by the versioned Koryphaios prompt compiler.',
    criticSystem: 'Live critic prompts are generated by the versioned Koryphaios prompt compiler.',
    workerDelegation: (domain: string) =>
      beginner ? `Starting the ${domain} work…` : `Delegating bounded ${domain} work…`,
    criticReview: beginner ? 'Checking the result…' : 'Running independent review…',
    toolDescriptions: {},
    errors: {
      noProvider: beginner
        ? 'No AI provider is available. Add one in Settings.'
        : 'No provider available.',
      toolFailed: beginner ? 'A tool failed: ${error}' : 'Tool execution failed: ${error}',
      workerFailed: beginner
        ? 'The delegated work failed: ${error}'
        : 'Worker failed after ${attempts} attempts: ${error}',
      noGitRepo: beginner
        ? 'No Git repository was detected, so repository recovery features are unavailable.'
        : 'No Git repository detected.',
    },
    thoughts: {
      analyzing: beginner ? 'Understanding the request…' : 'Analyzing request…',
      planning: beginner ? 'Preparing the approach…' : 'Planning approach…',
      executing: beginner ? 'Working on it…' : 'Executing…',
      reviewing: beginner ? 'Checking the result…' : 'Reviewing output…',
      complete: beginner ? 'Complete.' : 'Complete.',
    },
  };
}

export function formatPrompt(template: string, vars: Record<string, string>): string {
  return template.replace(/\$\{(\w+)\}/g, (match, key) => vars[key] ?? match);
}
