/** Versioned prompt compiler shared by manager, worker, and critic execution. */

import type { ProviderName, WorkerDomain } from '@koryphaios/shared';
import type { PromptCachePlan } from '../../providers/types';
import { createPromptCachePlan } from '../../providers/prompt-cache';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { getProviderHarnessCapabilities } from '../../providers/provider-harness';
import { applyContextWindowOverride, resolveTrustedContextWindow } from '../../providers/models';
import {
  deriveAuthoritativeTargetMedium,
  deriveDefaultSkillContextBudget,
  MAX_SKILL_CONTEXT_BUDGET,
  MIN_SKILL_CONTEXT_BUDGET,
  resolveSkills,
  TOKEN_CHARS,
  type SkillResolverResult,
} from '../skills';
import { routingRelevantText } from '../routing-text';
import {
  createSkillDeliveryEvidence,
  normalizeSkillAssignment,
  type SkillAssignment,
  type SkillDeliveryEvidence,
} from '../skill-assignment';
import { CRITIC_OUTPUT_CONTRACT } from '../critic-util';

export {
  deriveDefaultSkillContextBudget,
  MAX_SKILL_CONTEXT_BUDGET,
  MIN_SKILL_CONTEXT_BUDGET,
  TOKEN_CHARS,
};

export const PROMPT_VERSION = 'kory-workflow-v7-hierarchical-cache';

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

/**
 * The delegation surface the manager can actually use this turn.
 *
 * A static instruction to "choose from the user's pool" is not actionable: the
 * model cannot name a category it cannot see, and Kory silently degraded to
 * `general` when the manager guessed. Rendering the real pools (and the real
 * failure state of an empty pool) is what makes subagent choice deterministic.
 */
export interface DelegationContext {
  available: boolean;
  reason?: string;
  /** Plan mode: delegation is for investigation and design, not implementation. */
  planning?: boolean;
  /** Chat's worker-isolation preset: 'auto' defers to the worktree argument,
   *  'always'/'never' are the user's fixed choice and ignore it. */
  worktreeMode?: 'auto' | 'always' | 'never';
  pools: Array<{ domain: string; models: readonly string[]; unrestricted?: boolean }>;
}

export interface TaskContract {
  goal: string;
  taskKind: TaskKind;
  scope: string[];
  nonGoals: string[];
  constraints: string[];
  acceptanceCriteria: string[];
  risk: 'low' | 'medium' | 'high';
  requiredEvidence: string[];
  /** Manager supplied skills, preserved across worker retries and independent review. */
  skillAssignment?: SkillAssignment;
  /** Durable Goal Mode context; preserved through manager, worker, critic, and retries. */
  goalContext?: {
    goalId: string;
    objective: string;
    itemId: string;
    itemTitle: string;
    verification: 'eligible' | 'unverified';
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
  /** Non-fatal skill-budget degradation notes (also surfaced via CompiledPrompt.warnings). */
  skillWarnings: string[];
  /** Auto-included ancestors pruned because every dependent rendered minimal. */
  omittedLazyAncestors: string[];
  /** Chars/4 planning estimate for the compiled system prompt. */
  systemPromptTokenUpperBound: number;
  /** Occupied context + compiled prompt + the actual reserved completion limit. */
  totalContextTokenUpperBound: number;
  conflicts: string[];
  taskContractHash: string;
  stablePrefixHash: string;
  stablePrefixTokenEstimate: number;
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
  promptCache: PromptCachePlan;
  manifest: PromptManifest;
  skillDelivery: SkillDeliveryEvidence;
  /** Non-fatal issues encountered during compilation. Callers may surface
   *  these to the user as warnings (e.g. via a system.warning WS event). */
  warnings?: string[];
}

export interface SkillContextBudgetDecision {
  budget: number;
  requestedBudget: number;
  source: 'planning-default' | 'trusted-model-window';
  contextWindowTokens?: number;
  /** Legacy diagnostic retained for clients; live budgeting uses the chars/4 planning estimates below. */
  occupiedContextChars: number;
  nonSkillPromptChars: number;
  occupiedContextTokenUpperBound: number;
  nonSkillPromptTokenUpperBound: number;
  reservedOutputTokens?: number;
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

export function classifyTask(goal: string, domain?: WorkerDomain): TaskKind {
  const text = routingRelevantText(goal).toLowerCase();
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
  const normalizedGoal = routingRelevantText(goal).toLowerCase();
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
    ...(options.skillAssignment
      ? { skillAssignment: normalizeSkillAssignment(options.skillAssignment) }
      : {}),
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
- Work autonomously inside the granted project jail. Never ask permission for routine edits, shell commands, tests, installs, network access, or delegation. Ask before catastrophic broad destruction such as recursively deleting a home/root directory, formatting a disk, destructive raw-device writes, or powering down the host.
- Asking permission and asking for clarification are different. When you are confused, the request is ambiguous or underspecified, or a choice would materially change the result and the repository cannot settle it, ask instead of guessing: a manager calls ask_user, a worker calls ask_manager, and a critic names the ambiguity in its verdict. Inspect first so the question is specific to what you found, ask one decision per call, and offer 2-4 short concrete options with your recommendation first. Never ask what you can find out yourself.`;

const COMPUTE_DELEGATION = `## Linked computers and compute delegation
A linked computer can be used for the work itself or for its compute. The difference must be explicit, because the user's files should not be flooded and their public repository should not receive unreviewed work.

Placements:
- stay: the work lives on the target. This is the default when the user chose that computer for the chat.
- return: the other computer is used for compute, and the changed files come back here for review.

Rules:
- Default to one computer per task. Keep the manager and every worker for that task on the machine where the chat runs. Do not mirror the same workstream with local workers and a remote chat.
- If the chat's selected device is another computer, keep the work there unless the user asks for it back. Do not copy it back on your own.
- If the user says "use my compute on my VPS", "run this on the server", or names another machine only as faster hardware, use placement return.
- When the user asks for work on another computer, call delegate once. The target chat's manager owns that work and spawns its workers on the target itself. Do not keep a local copy of the same task running alongside it.
- Split one task across machines only for genuinely independent workstreams, an explicit user request, or a concrete resource constraint. Say why before doing it. Independent fan-out targets are allowed, but do not default to two machines.
- A turn started on a linked computer is owned by that computer's backend. It continues if this app quits, loses its connection, or the local machine sleeps. Only local agents and a local manager controlling another machine depend on this process. Never tell the user remote work needs this machine kept open.
- If this machine is struggling with a heavy build, test, or job, you may move only that compute to another granted computer, and then return the result. Say so first.
- Before starting remote work, state the machine, workspace, placement, and execution owner in one sentence so the user can stop you. For return: "I'll run this on <machine> (<workspace>) and bring the changed files back here, without committing or pushing anything." For stay: "I'll run this on <machine> (<workspace>) and keep the work there; its manager and workers run on that machine."
- Never commit, push, or open a pull request on a linked computer. Never push returned work. Returned changes are written under .koryphaios/incoming/<transferId>/ and the user applies them.
- Use delegate to start one remote chat, snapshot to inspect it, and collect_work to bring a return-policy chat's changes back. A stay-policy chat cannot be collected.
- Workers cannot contact another machine, so remote fan-out belongs to the target chat's manager. Provider credentials and logins are never transferred by an agent. Only the user can stage a login on a target.
`;

export const MANAGER_OUTPUT_TOKEN_LIMIT = 16_384;
export const WORKER_OUTPUT_TOKEN_LIMIT = 16_384;
export const CRITIC_OUTPUT_TOKEN_LIMIT = 2_048;

const SESSION_NAMING = `## Session naming
Koryphaios assigns a concise, specific fallback title from the first user message without delaying the first response, then may refine it in the background.
Session naming and renaming apply in every interaction, permission, and agent mode. You can call rename_session (kory__rename_session through the MCP bridge) at any time to improve the title when the conversation topic evolves or the user requests a rename.
Use 3-6 descriptive words; never use New Session or generic filler. Preserve an explicitly user-chosen title unless the user asks to change it. Do not ask for approval or announce routine title changes.`;

/**
 * Chat-response formatting available to user-facing text. This is a stable
 * cached section: it describes the renderer's real capabilities so agents
 * emphasize effectively instead of guessing at unsupported syntax. The
 * user's theme accent stays the default voice — custom colors are for
 * genuine emphasis, never a replacement theme.
 */
export const RESPONSE_FORMATTING = `## Response formatting (chat text only, never files)
- Keep all user facing prose, including highlighted text, free of dash characters and semicolons. Use commas, periods, or separate sentences instead.
- Standard GFM works: headings, **bold**, *italic*, ~~strikethrough~~, tables, task lists, code fences.
- Inline emphasis: [text]{attrs} — e.g. [alert]{red, large, bold}, [note]{color=accent, size=xl}. Colors accept #hex, rgb()/hsl(), CSS names, or \`accent\` for the user's theme accent. Sizes: xs/sm/base/lg/xl/2xl/3xl or 10-48px. Flags: bold, italic, underline, strike, mark. Prefer \`accent\` and default styles; use custom colors sparingly for genuine emphasis.
- ==highlight== and ++underline++ are available. A safe <span style="color:...; font-size:..."> subset (color, background-color, font-size, font-weight, font-style, text-decoration) is also honored.
- Links: [label](https://example.com) render with the site's icon and open externally. Use descriptive labels, never bare URLs for important links.
- File and symbol navigation: Create clickable links for files and code symbols using [filename.ts](file:///absolute/path/to/filename.ts#L10-L20) or [\`SymbolName\`](file:///absolute/path/to/file.ts#L10-L20), and link sessions as [title](kory-session://<sessionId>). Link Notes with [label](kory-note://id/<encoded-note-id>), or [label](kory-note://path/<encoded-path>). Percent encode the ID or path with encodeURIComponent, preserving case. Paths can be Notes folder/title paths such as /Findings/Guide, or indexed project source paths such as docs/notes-workspace.md. Prefer IDs when known. [[Title]] and [[/Folder/Title|label]] also navigate within the active project.
- Fenced blocks: chart (bar/line/pie JSON with labels+datasets), color (swatch chips), html (sandboxed iframe, no scripts). Math: $...$ / $$...$$ / \`\`\`math.`;

/**
 * Chars-per-token planning estimate shared by skill budgeting, the
 * context-usage bar, compaction accounting, and CLI bridges (see TOKEN_CHARS).
 *
 * Previously this was a UTF-8 byte count used as a fail-closed token upper
 * bound. That counted 30k chars as 30k tokens in budgeting while the display
 * showed chars/4 (7.5k) — a 4x mismatch that starved skills as chat grew.
 * Unifying on TOKEN_CHARS keeps every surface consistent. It is NOT a
 * fail-closed bound for non-ASCII text, so capacity checks keep the
 * reserved-output margin instead of relying on this to overcount.
 */
export function estimateTextTokens(value: string): number {
  return Math.ceil(value.length / TOKEN_CHARS);
}

/** Chars-to-tokens planning estimate for already-measured char counts. */
export function estimateCharsAsTokens(chars: number): number {
  return Math.ceil(Math.max(0, chars) / TOKEN_CHARS);
}

/**
 * @deprecated Use estimateTextTokens (chars/4 planning estimate). Kept under
 * the old name for existing call sites.
 */
export const textTokenUpperBound = estimateTextTokens;

/**
 * Auto-compact trigger accounting. Provider-reported `tokensIn` already
 * includes injected skill guidance, so without this subtraction a skill-heavy
 * turn self-triggers compaction that pruning cannot relieve (skills are
 * re-injected every turn). `skillContextCostChars` is the already-tracked
 * `skillContextCost` manifest field (totalContextCost, which includes the
 * manifest overhead). The result is clamped at zero and is a trigger
 * heuristic, not a billing count.
 */
export function nonSkillTokensForCompaction(
  tokensIn: number,
  skillContextCostChars: number,
): number {
  return Math.max(0, Math.floor(tokensIn) - estimateCharsAsTokens(skillContextCostChars));
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
  const window = input.contextWindowTokens;
  // Window-relative default: 10% of a verified model window clamped to
  // [8_000, 30_000], so small windows don't starve and large windows don't
  // waste a fixed 30k chars once chat grows. Unverified windows keep the
  // planning-only ceiling.
  const requestedBudget = Math.max(
    MIN_SKILL_CONTEXT_BUDGET,
    Math.floor(input.requestedBudget ?? deriveDefaultSkillContextBudget(window)),
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
    // Skill definitions are budgeted in JS characters against the remaining
    // chars/4 planning estimate. compilePrompt performs a final chars/4 pass
    // over the exact provider-rendered prompt (plus the reserved-output
    // margin) before any provider call. The budget floors at
    // MIN_SKILL_CONTEXT_BUDGET: a crowded window degrades to minimal-only
    // guidance plus a warning instead of a `max(1, …)` dead end.
    budget: Math.max(
      MIN_SKILL_CONTEXT_BUDGET,
      Math.min(requestedBudget, availableTokens * TOKEN_CHARS),
    ),
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

/** Chars/4 planning estimate for serialized conversation/tool context (legacy name retained for call-site stability). */
export function estimateOccupiedContextTokenUpperBound(messages: readonly unknown[]): number {
  return messages.reduce<number>((total, message) => {
    try {
      if (
        message !== null &&
        typeof message === 'object' &&
        'content' in (message as Record<string, unknown>) &&
        Array.isArray((message as { content: unknown }).content)
      ) {
        const blocks = (message as { content: unknown[] }).content;
        let blockTokens = 0;
        for (const block of blocks) {
          if (
            block !== null &&
            typeof block === 'object' &&
            'type' in (block as Record<string, unknown>)
          ) {
            const typed = block as {
              type: string;
              text?: string;
              imageData?: string;
              mediaData?: string;
              data?: string;
            };
            if (typed.type === 'image') {
              const rawLen =
                typeof typed.imageData === 'string'
                  ? typed.imageData.length
                  : typeof typed.data === 'string'
                    ? typed.data.length
                    : 0;
              const approxBytes = Math.ceil((rawLen * 3) / 4);
              blockTokens += Math.max(
                1024,
                Math.min(4096, Math.ceil(approxBytes / 1024) * 256 + 1024),
              );
              continue;
            }
            if (typed.type === 'audio' || typed.type === 'video') {
              // Conservative payload-size estimate until the provider reports
              // actual modality usage; never tokenize the base64 as prose.
              blockTokens += Math.max(1024, Math.ceil(((typed.mediaData?.length ?? 0) * 3) / 16));
              continue;
            }
            if (typed.type === 'text' && typeof typed.text === 'string') {
              blockTokens += textTokenUpperBound(typed.text);
              continue;
            }
          }
          blockTokens += textTokenUpperBound(JSON.stringify(block));
        }
        const meta = { ...(message as Record<string, unknown>), content: undefined };
        return total + blockTokens + textTokenUpperBound(JSON.stringify(meta));
      }
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

function renderExecutionContext(
  input: { role: PromptRole; provider: ProviderName | string; model?: string },
  capability: ProviderCapabilityProfile,
): string {
  const roleMeaning =
    input.role === 'manager'
      ? 'You own the user-facing outcome and the final answer.'
      : input.role === 'worker'
        ? 'You are a bounded worker. Your output goes to the manager as evidence, not to the user as a completion.'
        : 'You are an independent reviewer. Your verdict is advisory to the host and must rest on inspected evidence.';
  const isolation = capability.filesystemIsolation
    ? 'OS-confined to the granted workspace paths.'
    : 'Policy-gated, not OS-confined. Every write and command still goes through the host tool policy.';
  return `## Your execution context
- Role: ${input.role}. ${roleMeaning}
- Harness: ${input.provider} (${capability.mode}${input.model ? `, model ${input.model}` : ''}).
- Filesystem: ${isolation}
- Native shell: ${capability.shell ? 'available through Kory tool policy' : 'not available; use Kory-managed tools only'}.
- Never claim a capability this harness does not have. Report an unavailable tool as unavailable instead of simulating its result.`;
}

function renderDelegation(delegation: DelegationContext | undefined): string {
  if (!delegation) return '';
  if (!delegation.available) {
    return `## Sub-agents (delegation)
Delegation is unavailable this turn${delegation.reason ? ` (${delegation.reason})` : ''}. Do the work directly. Do not claim to have spawned or consulted an agent.`;
  }
  const pools = delegation.pools.length
    ? delegation.pools
        .map(
          (pool) =>
            `- ${pool.domain}: ${
              pool.unrestricted
                ? 'all enabled models (no category allowlist)'
                : pool.models.length
                  ? pool.models.join(', ')
                  : 'NO ELIGIBLE MODEL configured for this category'
            }`,
        )
        .join('\n')
    : '- none configured';
  const worktreeGuidance =
    delegation.worktreeMode === 'always'
      ? 'The user set Worktree to Always for this chat; every worker runs in an isolated worktree and the worktree argument is ignored.'
      : delegation.worktreeMode === 'never'
        ? 'The user set Worktree to Never for this chat; every worker writes directly into this checkout and the worktree argument is ignored.'
        : 'You decide worktree isolation for every delegation and must pass worktree explicitly. Use worktree: true when two or more workers may edit files at the same time, for risky or experimental changes, or when the user asks for isolation — a new worktree starts from the last commit and cannot see uncommitted work. Use worktree: false for read-only research, for a single worker making a focused edit, and whenever the task depends on uncommitted changes in the chat checkout.';
  return `## Sub-agents (delegation)
You are the only agent permitted to start a sub-agent. Call delegate_to_worker with a self-contained task and the domain whose pool fits the work.
${pools}
Before a fan-out or any long delegation, call get_resource_budget to check provider-reported balances, live rate-limit windows, and this chat's spend. Never assign work to a route you know is exhausted or rate limited; prefer a healthy route or configure a fallback chain. manage_agents list shows every manager, worker, and critic with its model, provider, reasoning, fallback chain, permission posture, worktree isolation, and busy state. You may change a worker's or the manager's next-turn model, reasoning, or fallback chain when the user asks or the task requires it, but permissions remain exactly as the user configured them and are view-only here. A manager control persists for this chat and applies to manager turns until changed, but never overrides a model the user explicitly pinned on a request. Do not change controls routinely, and do not silently widen a worker's authority.${delegation.planning ? '\nPlan mode: delegation is available for investigation, design analysis, and independent evidence gathering. Do not ask a worker to implement or reconcile changes yet; keep the plan in your response and durable plan note.' : ''}
The user chooses the manager and each pool; choose only within the named pool. Prefer an independent model from that pool. When a pool has no eligible model, the host reuses the manager model and reports the worker as non-independent, so say so rather than pretending the work was independent. Each worker starts from its own dedicated context — your conversation is not replayed into it — so make every task self-contained and say what evidence to return. ${worktreeGuidance} Issue one call per independent workstream; calls emitted together run concurrently. There is no fixed host concurrency cap by default: excess delegations queue until a worker slot is free instead of failing, and a positive workspace.worktreeLimit is the user's own choice. Never state that a worker ran before the tool returns its result, and never present a worker's summary as your own verification. Use schedule_monitor when the user asks for a recurring check or a later wake-up; the host starts a real turn in this chat at that cadence and queues it while the chat is busy.`;

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
Required evidence:\n${contract.requiredEvidence.map((item) => `- ${item}`).join('\n')}${goalContext}${contract.skillAssignment ? `\nAssigned worker skills: ${contract.skillAssignment.worker.join(', ') || 'none'}\nAssigned critic skills: ${contract.skillAssignment.critic.join(', ') || 'none'}` : ''}`;
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
  provider: ProviderName | string;
  /** Exact selected model ID; context capacity is used only when live-verified. */
  model?: string;
  /** Conversation/tool context already occupying the model window. */
  occupiedContextChars?: number;
  /** Chars/4 planning estimate of live occupied context (see estimateTextTokens). */
  occupiedContextTokenUpperBound?: number;
  /** Exact maximum completion requested by the caller. */
  reservedOutputTokens?: number;
  /** Live execution must not guess a model window from its name or a default. */
  requireVerifiedContextWindow?: boolean;
  /** Optional session context budget; honored only under the trusted window. */
  contextWindowOverride?: number;
  workingDirectory: string;
  taskContract: TaskContract;
  contextPaths?: string[];
  /** Live chat metadata belongs after the stable cache prefix. */
  sessionTitle?: string;
  /** Manager-only: the worker pools this turn can actually delegate into. */
  delegation?: DelegationContext;
  skillSelection?: {
    pins?: string[];
    remove?: string[];
    collisionChoices?: Record<string, 'personal' | 'project'>;
    targetMedium?: string;
    contextBudget?: number;
    /** Only report authored per-skill budget overflow when the user enabled an
     * explicit skill-context cap. Authored budgets remain advisory metadata. */
    warnOnAuthoredBudgetOverflow?: boolean;
    activePaths?: string[];
    /** Skills the chat's agent blocked via manage_skill_feeding; the feeder
     * stops injecting them (see resolveSkills for the exact semantics). */
    agentBlocked?: string[];
    /** Skills whose full text the agent already holds in context from
     * load_skill_detail; they are fed as minimal pointers only. */
    detailAlreadyInContext?: string[];
  };
}): CompiledPrompt {
  const instructionState = inspectInstructionSources(input.workingDirectory, input.contextPaths);
  const sources = instructionState.sources;
  const adapter = providerAdapter(input.provider);
  const capabilityProfile = capabilities(input.provider);
  const roleRules =
    input.role === 'manager'
      ? 'You are Kory, the user-facing manager. The user manually chose your model; never replace or auto-rank the manager. Choose subagents only from the user-enabled category pool. Prefer an agent identity distinct from yourself and prefer a different provider harness for material work, but when the user enabled only one eligible model, reuse it rather than blocking delegation. Disclose that the agent is not independent. Apply the same evidence standard to direct and delegated edits. Use send_agent_message (exposed as kory__send_agent_message through the MCP bridge) for manager-to-manager cross-project coordination and same-project agent handoffs. Reply with replyToMessageId so message threads remain correlated.'
      : input.role === 'worker'
        ? 'You are a bounded implementation worker. Preserve the immutable objective across retries, stay within granted paths, and return changed files plus exact verification evidence. You may message your manager or same-project agents with send_agent_message. You cannot contact another project directly; use request_manager_relay and let your manager decide whether to forward the request.'
        : 'You are the universal independent Critic. Evaluate every proposed response against the original request, including answers, plans, research, and code. Inspect actual artifacts, run terminal commands to reproduce claims, and red-team edge cases when useful. Your workspace is a disposable verification copy: changes there are experiments, never fixes to the producer project. Commands and delegation require host approval: the manager decides in YOLO/Guarded, and the user decides in other modes. Delegate focused checks to specialists with delegate_to_worker and manage your review team with manage_review_agents; you remain responsible for their evidence and the final verdict. Do not recursively request another Critic to review your own verdict. Judge every acceptance criterion. Missing or malformed evidence is not a pass.';
  const criticOutputContract = input.role === 'critic' ? CRITIC_OUTPUT_CONTRACT : '';
  const style =
    'Communicate clearly, concisely, and respectfully. Lead with outcomes and exact evidence; explain non-obvious details without hiding failures or weakening technical rigor.';
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
  // Exact-prefix caches are invalidated by the first changed byte. Keep the
  // cross-task contract stable first; task, selected skills, memory, and live
  // mode notices are appended later by decreasing expected lifetime.
  const stableSections = [
    `# Koryphaios prompt ${PROMPT_VERSION} (${adapter})`,
    roleRules,
    input.role === 'manager' ? SESSION_NAMING : '',
    criticOutputContract,
    style,
    UNIVERSAL_CORE,
    RESPONSE_FORMATTING,
    `## Provider capability truth\n${providerRules}`,
    `## Applicable repository instructions (broad to specific)\n${instructionText}`,
  ];
  const taskSections = [
    renderTaskContract(input.taskContract),
    renderExecutionContext(input, capabilityProfile),
    input.role === 'manager' ? COMPUTE_DELEGATION : '',
    input.role === 'manager' ? renderDelegation(input.delegation) : '',
  ];
  if (input.role === 'manager' && input.sessionTitle) {
    taskSections.push(`## Current session title\n${JSON.stringify(input.sessionTitle)}`);
  }
  const baseSections = [...stableSections, ...taskSections];
  const trustedWindow = applyContextWindowOverride(
    input.model
      ? resolveTrustedContextWindow(input.model, input.provider as ProviderName)
      : { contextKnown: false as const },
    input.contextWindowOverride,
  );
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
  const assignments = normalizeSkillAssignment(input.taskContract.skillAssignment);
  const requiredSkills =
    input.role === 'worker'
      ? assignments.worker
      : input.role === 'critic'
        ? assignments.critic
        : [];
  const pins = [
    ...new Set([
      ...(input.skillSelection?.pins ?? []),
      ...requiredSkills,
      ...(input.role === 'critic' ? ['verification', 'critic-review'] : []),
      ...(input.role === 'manager' && input.skillSelection?.pins?.includes('critic-auto-selection')
        ? ['critic-auto-selection']
        : []),
    ]),
  ];
  const skillResolution: SkillResolverResult = resolveSkills(
    input.workingDirectory,
    input.taskContract.goal,
    input.taskContract,
    {
      ...input.skillSelection,
      pins,
      activePaths: input.skillSelection?.activePaths ?? input.contextPaths,
      targetMedium,
      contextBudget: skillContextBudget.budget,
      // The model-window budget is always computed for execution, but authored
      // per-skill budgets are only a diagnostic for users who explicitly turn
      // on a skill-context cap. A normal turn must not warn merely because a
      // skill's advisory metadata is smaller than its rendered guidance.
      warnOnAuthoredBudgetOverflow:
        input.skillSelection?.warnOnAuthoredBudgetOverflow ??
        input.skillSelection?.contextBudget !== undefined,
    },
  );
  // A manager's explicit assignment is part of the delegated contract. A
  // missing assigned skill cannot be represented as a successful delivery
  // receipt, even when optional skill discovery degrades gracefully.
  const deliveredNames = new Set(skillResolution.selected.map(({ skill }) => skill.name));
  const missingRequired = requiredSkills.filter((name) => !deliveredNames.has(name));
  if (missingRequired.length > 0) {
    throw new Error(`Skill resolution blocked: required ${input.role} skills unavailable: ${missingRequired.join(', ')}`);
  }
  if (skillResolution.blocked) {
    const conflicts = [
      ...skillResolution.collisions.map((item) => item.name),
      ...skillResolution.selectionConflicts.map((item) => `${item.left} <> ${item.right}`),
      ...skillResolution.hierarchyErrors,
    ];
    // Broken or conflicting skills must not break the agent: surface the
    // resolution problem as a turn warning and continue with whatever skills
    // the resolver could safely select. A skill issue is not an agent failure.
    warnings.push(`Skill resolution warning: ${conflicts.join(', ')}`);
  }
  // Budget overflow no longer blocks: surface the resolver's graceful-
  // degradation notes as turn warnings and keep them in the manifest.
  warnings.push(...skillResolution.warnings);
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
  const systemPrompt = renderForProvider(adapter, [
    ...stableSections,
    ...taskSections,
    skillResolution.promptText,
  ]);
  const stableSystemPrompt = renderForProvider(adapter, stableSections);
  const promptCache = createPromptCachePlan({
    stableSystemPrompt,
    providerAdapter: adapter,
    role: input.role,
    workspaceScope: input.workingDirectory,
    stableComponents: {
      header: stableSections[0] ?? '',
      role: roleRules,
      criticContract: criticOutputContract,
      style,
      universalCore: UNIVERSAL_CORE,
      responseFormatting: RESPONSE_FORMATTING,
      providerCapabilities: `## Provider capability truth\n${providerRules}`,
      repositoryInstructions: `## Applicable repository instructions (broad to specific)\n${instructionText}`,
    },
  });
  const systemPromptTokenUpperBound = estimateTextTokens(systemPrompt);
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
      `Skill resolution blocked before work starts: estimated provider-rendered context requires ~${totalContextTokenUpperBound} tokens by the chars/4 planning estimate, exceeding the verified ${trustedWindow.contextWindow}-token window`,
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
    skillWarnings: skillResolution.warnings,
    omittedLazyAncestors: skillResolution.omittedLazyAncestors,
    systemPromptTokenUpperBound,
    totalContextTokenUpperBound,
    conflicts: instructionState.conflicts,
    taskContractHash: sha256(JSON.stringify(input.taskContract)),
    stablePrefixHash: promptCache.stablePrefixHash,
    stablePrefixTokenEstimate: promptCache.estimatedStableTokens,
  };
  const manifest = { ...manifestBase, hash: sha256(JSON.stringify(manifestBase) + systemPrompt) };
  return {
    systemPrompt,
    promptCache,
    manifest,
    skillDelivery: createSkillDeliveryEvidence(manifest, skillResolution.selected, requiredSkills),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

export function formatPrompt(template: string, vars: Record<string, string>): string {
  return template.replace(/\$\{(\w+)\}/g, (match, key) => vars[key] ?? match);
}
