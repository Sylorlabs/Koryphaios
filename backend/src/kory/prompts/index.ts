/** Versioned prompt compiler shared by manager, worker, and critic execution. */

import type { ProviderName, UIMode, WorkerDomain } from '@koryphaios/shared';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

export const PROMPT_VERSION = 'kory-workflow-v1';

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
}

export interface PromptManifest {
  version: string;
  hash: string;
  role: PromptRole;
  taskContract: TaskContract;
  instructions: Array<Omit<InstructionSource, 'content'>>;
  providerAdapter: string;
  capabilityProfile: ProviderCapabilityProfile;
  qualityProfile: TaskKind;
  conflicts: string[];
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
    /\b(ui|ux|interface|layout|screen|component|responsive|accessibility)\b/.test(text)
  )
    return 'ui';
  if (/\b(security|permission|auth|secret|infra|deploy|migration|database)\b/.test(text))
    return 'security-infra';
  if (/\b(bug|fix|broken|error|regression|fails?|crash)\b/.test(text)) return 'bug';
  if (/\b(refactor|restructure|architecture|extract|consolidate)\b/.test(text)) return 'refactor';
  if (/\b(research|document|docs|readme|investigate|compare)\b/.test(text)) return 'research-docs';
  if (/\b(add|build|implement|create|feature)\b/.test(text)) return 'feature';
  if (/\b(rename|replace|format|bump|update string|mechanical)\b/.test(text))
    return 'mechanical-edit';
  return 'question';
}

export function createTaskContract(
  goal: string,
  options: Partial<Omit<TaskContract, 'goal' | 'taskKind'>> & { taskKind?: TaskKind } = {},
): TaskContract {
  const taskKind = options.taskKind ?? classifyTask(goal);
  const changesCode = taskKind !== 'question' && taskKind !== 'research-docs';
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
      ...(changesCode ? ['Relevant repository checks pass without weakening tests'] : []),
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
      (changesCode ? ['Actual diff', 'Relevant deterministic checks'] : ['Evidence-backed answer']),
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

  const candidates = directories.map((directory) => join(directory, 'AGENTS.md'));
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

const UNIVERSAL_CORE = `## Non-negotiable execution contract
- Obey the current task scope and applicable repository instructions. Current user constraints override standing preferences; more specific repository instructions override broader ones.
- Inspect relevant code, tests, configuration, and existing patterns before changing anything.
- Preserve the existing architecture and design system. Make the minimum sufficient change and fix root causes.
- Prefer modifying an appropriate existing file over creating a new file. Create a file only when it has a distinct durable responsibility or the repository convention requires it; never create speculative wrappers, abstractions, or duplicate implementations.
- Never hard-code a narrow domain assumption into a universal workflow. Domain expertise belongs in a conditional quality profile or separately versioned skill. UI guidance is medium-neutral: native, terminal, embedded, game, spatial, mobile, and web interfaces must follow their own toolkit and repository rules.
- Do not disguise stubs, uncertainty, skipped checks, unavailable evidence, or partial work. Never claim completion without exact evidence.
- Publishing is separate from implementation. Do not commit, push, or open a pull request unless the user or an explicit workspace policy requested it.
- Work autonomously inside the granted project jail. Do not ask for routine edits, shell commands, tests, installs, network access, or delegation. Ask only immediately before catastrophic broad destruction such as recursively deleting a home/root directory, formatting a disk, destructive raw-device writes, or powering down the host.`;

const QUALITY_PROFILES: Record<TaskKind, string> = {
  question:
    'Answer directly. Inspect or research when correctness depends on repository or current facts. Do not mutate the workspace.',
  bug: 'Reproduce or establish the failure, trace the root cause, implement the narrow fix, and add or run regression evidence.',
  'mechanical-edit':
    'Confirm the exact match set, make only the requested transformation, and check for accidental replacements.',
  refactor:
    'Preserve observable behavior, reuse existing abstractions, avoid parallel architecture, and verify before and after behavior.',
  feature:
    'Identify acceptance criteria and integration points first. Implement in coherent slices, including failure states and regression coverage.',
  ui: 'Inspect the existing interface, components, tokens, interaction patterns, target medium, and accessibility conventions. Reuse the native toolkit. Verify real interactions and relevant states when browser, device, terminal, game, spatial, or other runtime tooling is available. Visual design expertise must come from a domain-specific skill/profile, not generic web assumptions.',
  'research-docs':
    'Separate sourced fact from inference, use authoritative evidence, preserve documentation conventions, and do not present research as implementation proof.',
  'security-infra':
    'Fail closed, preserve hard permission boundaries, avoid exposing secrets, require explicit approval for consequential changes, and verify the real boundary rather than prompt intent.',
};

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
  const native = [
    'claude',
    'grok',
    'antigravity',
    'gemini-cli',
    'jules',
    'cursor',
    'devin',
    'cline',
  ].includes(provider);
  return {
    mode: native ? 'native-passthrough' : 'managed',
    hardToolPolicy: !native,
    edit: true,
    shell: true,
    browser: false,
    filesystemIsolation: !native,
    qualifiedRoles: ['manager', 'worker', 'critic'],
  };
}

function renderTaskContract(contract: TaskContract): string {
  return `## Immutable task contract
Goal: ${contract.goal}
Kind: ${contract.taskKind}
Scope: ${contract.scope.length ? contract.scope.join(', ') : 'the user-requested workspace scope'}
Non-goals: ${contract.nonGoals.join('; ')}
Constraints: ${contract.constraints.length ? contract.constraints.join('; ') : 'none supplied'}
Acceptance criteria:\n${contract.acceptanceCriteria.map((item) => `- ${item}`).join('\n')}
Risk: ${contract.risk}
Required evidence:\n${contract.requiredEvidence.map((item) => `- ${item}`).join('\n')}`;
}

export function compilePrompt(input: {
  role: PromptRole;
  mode: UIMode;
  provider: ProviderName | string;
  workingDirectory: string;
  taskContract: TaskContract;
  contextPaths?: string[];
}): CompiledPrompt {
  const sources = loadRepositoryInstructions(input.workingDirectory, input.contextPaths);
  const adapter = providerAdapter(input.provider);
  const capabilityProfile = capabilities(input.provider);
  const roleRules =
    input.role === 'manager'
      ? 'You are Kory, the user-facing manager. Handle direct work yourself and delegate only substantial bounded work. Apply the same evidence standard to direct and delegated edits.'
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
      ? 'This provider uses a native harness wrapped by Kory role policy, filesystem isolation, and verification. Provider-specific quality measurements may influence recommendations but never remove role capability.'
      : 'This is Kory-managed execution. Tool and filesystem policy are enforced by the harness; do not attempt to bypass them.';
  const systemPrompt = [
    `# Koryphaios prompt ${PROMPT_VERSION} (${adapter})`,
    roleRules,
    criticOutputContract,
    style,
    UNIVERSAL_CORE,
    renderTaskContract(input.taskContract),
    `## Conditional quality profile: ${input.taskContract.taskKind}\n${QUALITY_PROFILES[input.taskContract.taskKind]}`,
    `## Provider capability truth\n${providerRules}`,
    `## Applicable repository instructions (broad to specific)\n${instructionText}`,
  ].join('\n\n');
  const manifestBase = {
    version: PROMPT_VERSION,
    role: input.role,
    taskContract: input.taskContract,
    instructions: sources.map(({ content: _content, ...source }) => source),
    providerAdapter: adapter,
    capabilityProfile,
    qualityProfile: input.taskContract.taskKind,
    conflicts: [],
  };
  return {
    systemPrompt,
    manifest: { ...manifestBase, hash: sha256(JSON.stringify(manifestBase) + systemPrompt) },
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
