import {
  createIsolatedCodexSkillEvalExecutor,
  isCodexSkillEvalAvailable,
  createTextOnlyPatchSkillEvalExecutor,
} from '../backend/src/eval/skills/skill-eval-codex';
import { createOmnirushTextOnlyPatchSkillEvalExecutor } from '../backend/src/eval/skills/skill-eval-provider';
import { createOpenRouterTextOnlyPatchSkillEvalExecutor } from '../backend/src/eval/skills/skill-eval-provider';
import { createLogfareTextOnlyPatchSkillEvalExecutor } from '../backend/src/eval/skills/skill-eval-provider';
import { createOpenCodeTextOnlyPatchSkillEvalExecutor } from '../backend/src/eval/skills/skill-eval-opencode';
import { createOpenCodeStatelessTextPatchSkillEvalExecutor } from '../backend/src/eval/skills/skill-eval-opencode-stateless';
import { createNativeStatelessTextPatchSkillEvalExecutor } from '../backend/src/eval/skills/skill-eval-native-stateless';
import {
  createOpenCodeLogfareAgenticExecutor,
  opencodeBinary,
  readLogfareProviderFromOperatorConfig,
} from '../backend/src/eval/skills/skill-eval-opencode-agentic';
import { createLocalLlamaTextPatchSkillEvalExecutor } from '../backend/src/eval/skills/skill-eval-local-llama';
import {
  assertApprovedKoryCliModel,
  createKoryCliAgenticExecutor,
} from '../backend/src/eval/skills/skill-eval-kory-cli';
import {
  LOCAL_LLAMA_TEXT_PATCH_QUARANTINE_REASON,
  OPENCODE_STATELESS_QUARANTINE_REASON,
  OPENCODE_TEXT_PATCH_QUARANTINE_REASON,
} from '../backend/src/eval/skills/skill-eval-eligibility';
import type {
  SkillEvalExecutor,
  SkillEvalExecutionReadiness,
  SkillEvalFixtureMaterializer,
} from '../backend/src/eval/skills/skill-eval-execution';
import type { V5EvalEnvironmentKind } from '../backend/src/kory/skill-packages';

export type SkillEvalExecutorMode =
  | 'auto'
  | 'codex'
  | 'codex-text-patch'
  | 'omnirush-text-patch'
  | 'openrouter-text-patch'
  | 'logfare-text-patch'
  | 'opencode-text-patch'
  | 'opencode-stateless-text-patch'
  | 'local-llama-text-patch'
  | 'native-stateless-text-patch'
  | 'opencode-logfare-agentic'
  | 'kory-cli-agentic';

export interface SkillEvalExecutorDescriptor {
  mode: Exclude<SkillEvalExecutorMode, 'auto'>;
  id: string;
  provider: string;
  model: string;
  runtimeIdentity: string;
}

export class SkillEvalExecutorUnavailableError extends Error {
  readonly code = 'SKILL_EVAL_EXECUTOR_UNAVAILABLE';
}

export function parseSkillEvalExecutorMode(
  argv: readonly string[],
  env = process.env,
): SkillEvalExecutorMode {
  const argument = argv.find((value) => value.startsWith('--executor='));
  const requested = argument
    ? argument.slice('--executor='.length).trim()
    : env.KORY_SKILL_EVAL_EXECUTOR?.trim();
  if (argument && !requested) throw new Error('Explicit --executor requires a mode.');
  if (requested === undefined || requested === '') {
    return argv.includes('--text-patch') || env.KORY_SKILL_EVAL_TEXT_PATCH === '1'
      ? 'codex-text-patch'
      : 'auto';
  }
  if (requested === 'text-patch') return 'codex-text-patch';
  if (
    requested !== 'auto' &&
    requested !== 'codex' &&
    requested !== 'codex-text-patch' &&
    requested !== 'omnirush-text-patch' &&
    requested !== 'openrouter-text-patch' &&
    requested !== 'logfare-text-patch' &&
    requested !== 'opencode-text-patch' &&
    requested !== 'opencode-stateless-text-patch' &&
    requested !== 'local-llama-text-patch' &&
    requested !== 'native-stateless-text-patch' &&
    requested !== 'kory-cli-agentic' &&
    requested !== 'opencode-logfare-agentic'
  ) {
    throw new Error(
      `Invalid skill evaluation executor ${JSON.stringify(requested)}; expected auto|codex|codex-text-patch|omnirush-text-patch|openrouter-text-patch|opencode-text-patch|opencode-stateless-text-patch|local-llama-text-patch|native-stateless-text-patch|opencode-logfare-agentic|kory-cli-agentic`,
    );
  }
  return requested;
}

export function skillEvalExecutorModel(
  mode: Exclude<SkillEvalExecutorMode, 'auto'>,
  explicitModel?: string,
  env = process.env,
): string {
  if (explicitModel?.trim()) return explicitModel.trim();
  if (mode === 'native-stateless-text-patch') return 'gpt-6.1-sol';
  if (mode === 'opencode-logfare-agentic') {
    // Pinned, not `auto`. The router alias answers each request with whichever backend it
    // chooses, so two arms of one pair can be different models and the same case passes and
    // then fails with no change to the skill. A declared id keeps one evidence identity.
    // `KORY_SKILL_EVAL_MODEL` is the provider-neutral name, since the executor can now run
    // against any provider block the operator has configured.
    return (
      env.KORY_SKILL_EVAL_MODEL?.trim() ||
      env.KORY_SKILL_EVAL_LOGFARE_MODEL?.trim() ||
      'deepseek-v4.1-flash-1017'
    );
  }
  if (mode === 'kory-cli-agentic') {
    // The operator named one primary subject and one fallback. Pinning it here keeps the
    // recorded identity equal to the model that actually answered.
    return env.KORY_SKILL_EVAL_KORY_CLI_MODEL?.trim() || 'logfare/deepseek-v4.1-flash-1017';
  }
  if (mode === 'local-llama-text-patch') return 'qwen2.5-coder-14b-instruct-q4_k_m';
  if (mode === 'omnirush-text-patch') {
    return env.KORY_SKILL_EVAL_OMNIRUSH_MODEL?.trim() || 'gpt-6-astra';
  }
  if (mode === 'openrouter-text-patch') {
    return env.KORY_SKILL_EVAL_OPENROUTER_MODEL?.trim() || 'openrouter/openrouter/free';
  }
  if (mode === 'logfare-text-patch') {
    return env.KORY_SKILL_EVAL_LOGFARE_MODEL?.trim() || 'deepseek-v4.1-flash-1017';
  }
  if (mode === 'opencode-text-patch' || mode === 'opencode-stateless-text-patch') {
    return env.KORY_SKILL_EVAL_OPENCODE_MODEL?.trim() || 'openrouter/openrouter/free';
  }
  return env.KORY_SKILL_EVAL_MODEL?.trim() || 'gpt-5.6-sol';
}

function descriptorFromExecutor(
  mode: Exclude<SkillEvalExecutorMode, 'auto'>,
  executor: SkillEvalExecutor,
): SkillEvalExecutorDescriptor {
  return {
    mode,
    id: executor.id,
    provider: executor.provider,
    model: executor.model,
    runtimeIdentity: executor.runtimeIdentity,
  };
}

interface SkillEvalExecutorOptions {
  mode: SkillEvalExecutorMode;
  model?: string;
  reasoningEffort?: string;
  wallClockMs: number;
}

export interface SkillEvalExecutorDependencies {
  env: NodeJS.ProcessEnv;
  isCodexAvailable: () => boolean;
  create: typeof createExecutor;
}

const executorDependencies: SkillEvalExecutorDependencies = {
  env: process.env,
  isCodexAvailable: isCodexSkillEvalAvailable,
  create: createExecutor,
};

export type SkillEvalExecutorSelection =
  | { status: 'available'; descriptor: SkillEvalExecutorDescriptor; executor: SkillEvalExecutor }
  | { status: 'unavailable'; descriptor: null; executor: null; reason: string };

/** Construct once: resume identity and persisted runs use this same executor. */
export function selectSkillEvalExecutor(
  options: SkillEvalExecutorOptions,
  dependencies = executorDependencies,
): Extract<SkillEvalExecutorSelection, { status: 'available' }> {
  const modes: Array<Exclude<SkillEvalExecutorMode, 'auto'>> =
    options.mode === 'auto' ? ['omnirush-text-patch', 'codex'] : [options.mode];
  const failures: string[] = [];
  for (const mode of modes) {
    try {
      if (mode.startsWith('codex') && !dependencies.isCodexAvailable()) {
        throw new SkillEvalExecutorUnavailableError(
          'Codex CLI or isolated authentication is unavailable.',
        );
      }
      const model = skillEvalExecutorModel(mode, options.model, dependencies.env);
      const executor = dependencies.create({ ...options, mode, model });
      const expectedProvider =
        mode === 'omnirush-text-patch'
          ? 'omnirush'
          : mode === 'openrouter-text-patch'
            ? 'openrouter'
            : mode === 'logfare-text-patch'
              ? 'logfare'
              : mode === 'opencode-text-patch' || mode === 'opencode-stateless-text-patch'
                ? 'opencode'
                : mode === 'local-llama-text-patch'
                  ? 'local-llama'
                  : mode === 'native-stateless-text-patch'
                    ? 'native-cli'
                    : mode === 'opencode-logfare-agentic'
                      ? // The agentic OpenCode path is provider-neutral: it stages whichever
                        // provider block the operator selected, so the recorded provider is that
                        // block's key rather than a channel name baked into this table.
                        dependencies.env.KORY_SKILL_EVAL_OPENCODE_PROVIDER?.trim() || 'logfare'
                      : mode === 'kory-cli-agentic'
                        ? // The Kory CLI subject is whatever provider/model the operator named; the
                          // prefix of that id is the provider the run is recorded against.
                          model.includes('/')
                          ? model.slice(0, model.indexOf('/'))
                          : 'logfare'
                        : 'codex';
      if (executor.provider !== expectedProvider || executor.model !== model) {
        throw new Error(
          `Skill evaluation executor factory returned a different provider/model for ${mode}.`,
        );
      }
      if (!executor.id.trim() || !executor.runtimeIdentity.trim()) {
        throw new Error(
          `Skill evaluation executor factory returned an empty identity for ${mode}.`,
        );
      }
      return { status: 'available', descriptor: descriptorFromExecutor(mode, executor), executor };
    } catch (error: unknown) {
      if (
        mode === 'omnirush-text-patch' &&
        error instanceof Error &&
        /^(?:OmniRush text-patch executor is unavailable:|Omnirush CLI (?:not found|version probe failed|did not report a version)\.)/u.test(
          error.message,
        )
      ) {
        const unavailable = new SkillEvalExecutorUnavailableError(error.message, { cause: error });
        if (options.mode !== 'auto') throw unavailable;
        failures.push(`${mode}: ${unavailable.message}`);
        continue;
      }
      if (
        mode === 'openrouter-text-patch' &&
        error instanceof Error &&
        /^OpenRouter text-patch executor is unavailable:/u.test(error.message)
      ) {
        const unavailable = new SkillEvalExecutorUnavailableError(error.message, { cause: error });
        if (options.mode !== 'auto') throw unavailable;
        failures.push(`${mode}: ${unavailable.message}`);
        continue;
      }
      if (
        mode === 'logfare-text-patch' &&
        error instanceof Error &&
        /^Logfare text-patch executor is unavailable:/u.test(error.message)
      ) {
        const unavailable = new SkillEvalExecutorUnavailableError(error.message, { cause: error });
        if (options.mode !== 'auto') throw unavailable;
        failures.push(`${mode}: ${unavailable.message}`);
        continue;
      }
      if (
        mode === 'opencode-text-patch' &&
        error instanceof Error &&
        /^OpenCode text-patch executor is unavailable:/u.test(error.message)
      ) {
        const unavailable = new SkillEvalExecutorUnavailableError(error.message, { cause: error });
        if (options.mode !== 'auto') throw unavailable;
        failures.push(`${mode}: ${unavailable.message}`);
        continue;
      }
      if (
        mode === 'opencode-stateless-text-patch' &&
        error instanceof Error &&
        /^OpenCode stateless text-patch executor is unavailable:/u.test(error.message)
      ) {
        throw new SkillEvalExecutorUnavailableError(error.message, { cause: error });
      }
      if (
        mode === 'local-llama-text-patch' &&
        error instanceof Error &&
        /^Local llama text-patch executor is unavailable:/u.test(error.message)
      ) {
        throw new SkillEvalExecutorUnavailableError(error.message, { cause: error });
      }
      if (
        mode === 'native-stateless-text-patch' &&
        error instanceof Error &&
        /^Native stateless text-patch executor is unavailable:/u.test(error.message)
      ) {
        throw new SkillEvalExecutorUnavailableError(error.message, { cause: error });
      }
      if (options.mode !== 'auto' || !(error instanceof SkillEvalExecutorUnavailableError))
        throw error;
      failures.push(`${mode}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new SkillEvalExecutorUnavailableError(
    `No configured skill evaluation executor is available (${failures.join(' | ')})`,
  );
}

export function resolveSkillEvalExecutor(
  options: SkillEvalExecutorOptions & { dryRun: boolean },
  dependencies = executorDependencies,
): SkillEvalExecutorSelection {
  try {
    return selectSkillEvalExecutor(options, dependencies);
  } catch (error: unknown) {
    if (!options.dryRun || !(error instanceof SkillEvalExecutorUnavailableError)) throw error;
    return { status: 'unavailable', descriptor: null, executor: null, reason: error.message };
  }
}

export function createSkillEvalExecutorDescriptor(
  options: SkillEvalExecutorOptions,
): SkillEvalExecutorDescriptor {
  return selectSkillEvalExecutor(options).descriptor;
}

/** Combine host-fixture readiness with the selected executor's tool surface. */
export function applySkillEvalExecutorReadiness(
  readiness: readonly SkillEvalExecutionReadiness[],
  scenarios: readonly { skill: string; id: string; environmentKind: V5EvalEnvironmentKind }[],
  selection: SkillEvalExecutorSelection,
  materializers: readonly SkillEvalFixtureMaterializer[] = [],
): SkillEvalExecutionReadiness[] {
  const environments = new Map(
    scenarios.map((scenario) => [
      `${scenario.skill}\u0000${scenario.id}`,
      scenario.environmentKind,
    ]),
  );
  return readiness.map((row) => {
    const reasons = [...row.reasons];
    if (selection.status === 'unavailable') {
      reasons.push(`Executor unavailable/unverified: ${selection.reason}`);
    } else if (selection.descriptor.mode === 'opencode-text-patch') {
      // Stream guards detect contamination after execution, not enforce isolation.
      // Do not spend provider calls on evidence the qualification gate must exclude.
      reasons.push(OPENCODE_TEXT_PATCH_QUARANTINE_REASON);
    } else if (selection.descriptor.mode === 'opencode-stateless-text-patch') {
      // A no-tools provider API is not a verified isolation or identity receipt.
      reasons.push(OPENCODE_STATELESS_QUARANTINE_REASON);
    } else if (selection.descriptor.mode === 'local-llama-text-patch') {
      reasons.push(LOCAL_LLAMA_TEXT_PATCH_QUARANTINE_REASON);
    } else if (selection.descriptor.mode.endsWith('text-patch')) {
      const kind = environments.get(`${row.skill}\u0000${row.scenarioId}`);
      // A text-patch subject can assess a recorded device or browser session when the
      // fixture delivers it as image attachments: that is observation, not live control.
      // The executor still refuses at run time if the attachments are absent, so this
      // only removes the up-front refusal for fixtures that actually ship them.
      const deliversRecordedEvidence =
        Boolean(row.materializerId) &&
        materializers.some(
          (materializer) =>
            materializer.id === row.materializerId &&
            typeof materializer.imageAttachments === 'function',
        );
      if (
        !deliversRecordedEvidence &&
        (!kind || !['synthetic', 'repository', 'cli'].includes(kind))
      ) {
        reasons.push(
          `${selection.descriptor.mode} cannot execute ${kind ?? 'unknown'} environments; text-patch mode supports only synthetic, repository, and cli scenarios.`,
        );
      }
    }
    return { ...row, ready: row.ready && reasons.length === 0, reasons };
  });
}

export function skillEvalCampaignHarnessVersion(options: {
  descriptor: SkillEvalExecutorDescriptor;
  executionMode: string;
  reasoningEffort: string;
  wallClockMs: number;
  evaluationContractHash: string;
}): string {
  const { descriptor, executionMode, reasoningEffort, wallClockMs, evaluationContractHash } =
    options;
  return `v5-campaign-2026-09-08:${descriptor.mode}:${descriptor.id}:${descriptor.provider}:${descriptor.model}:${descriptor.runtimeIdentity}:${executionMode}:${reasoningEffort}:${wallClockMs}ms:${evaluationContractHash}`;
}

export function createExecutor(options: {
  mode: Exclude<SkillEvalExecutorMode, 'auto'>;
  model: string;
  reasoningEffort?: string;
  wallClockMs: number;
}): SkillEvalExecutor {
  if (options.mode === 'omnirush-text-patch') {
    try {
      return createOmnirushTextOnlyPatchSkillEvalExecutor({
        model: options.model,
        reasoningEffort: options.reasoningEffort,
        wallClockMs: options.wallClockMs,
      });
    } catch (error: unknown) {
      if (
        error instanceof Error &&
        /^OmniRush text-patch executor is unavailable:/u.test(error.message)
      ) {
        throw new SkillEvalExecutorUnavailableError(error.message, { cause: error });
      }
      throw error;
    }
  }
  if (options.mode === 'openrouter-text-patch') {
    return createOpenRouterTextOnlyPatchSkillEvalExecutor({
      model: options.model,
      wallClockMs: options.wallClockMs,
    });
  }
  if (options.mode === 'logfare-text-patch') {
    return createLogfareTextOnlyPatchSkillEvalExecutor({
      model: options.model,
      wallClockMs: options.wallClockMs,
    });
  }
  if (options.mode === 'opencode-text-patch') {
    return createOpenCodeTextOnlyPatchSkillEvalExecutor({
      model: options.model,
      wallClockMs: options.wallClockMs,
    });
  }
  if (options.mode === 'opencode-stateless-text-patch') {
    return createOpenCodeStatelessTextPatchSkillEvalExecutor({
      model: options.model,
      wallClockMs: options.wallClockMs,
    });
  }
  if (options.mode === 'native-stateless-text-patch') {
    return createNativeStatelessTextPatchSkillEvalExecutor({
      model: options.model,
      wallClockMs: options.wallClockMs,
    });
  }
  if (options.mode === 'local-llama-text-patch') {
    return createLocalLlamaTextPatchSkillEvalExecutor({
      model: options.model,
      wallClockMs: options.wallClockMs,
    });
  }
  if (options.mode === 'opencode-logfare-agentic') {
    return createOpenCodeLogfareAgenticExecutor({
      modelName: options.model,
      wallClockMs: options.wallClockMs,
    });
  }
  if (options.mode === 'kory-cli-agentic') {
    // The operator named the approved subjects explicitly; a typo must fail loudly
    // instead of evaluating a model nobody asked for.
    const model = options.model.includes('/') ? options.model : `logfare/${options.model}`;
    assertApprovedKoryCliModel(model);
    return createKoryCliAgenticExecutor({
      model,
      reasoning: options.reasoningEffort ?? 'high',
      wallClockMs: options.wallClockMs,
    });
  }
  if (options.mode === 'codex-text-patch') {
    return createTextOnlyPatchSkillEvalExecutor({
      model: options.model,
      reasoningEffort: options.reasoningEffort,
      wallClockMs: options.wallClockMs,
    });
  }
  return createIsolatedCodexSkillEvalExecutor({
    model: options.model,
    reasoningEffort: options.reasoningEffort,
    wallClockMs: options.wallClockMs,
  });
}
