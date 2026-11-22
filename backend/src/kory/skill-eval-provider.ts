import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Provider, ProviderEvent, StreamRequest } from '../providers/types';
import type { ProviderContentBlock } from '../providers/types';
import {
  OmnirushCliProvider,
  resolveOmnirushRuntimeBinding,
  readOmnirushCliCatalog,
  resolveOmnirushReasoningLevel,
} from '../providers/omnirush-cli';
import { OpenAIProvider } from '../providers/openai';
import { SANDBOX_PRESETS, type ModelDef, type ProviderConfig } from '@koryphaios/shared';
import type {
  SkillEvalExecutionObservation,
  SkillEvalExecutor,
  SkillEvalImageAttachment,
} from './skill-eval-execution';
import type { SkillInfrastructureFailure } from './skill-evaluations';
import {
  applySkillEvalTextPatch,
  parseSkillEvalTextPatch,
  snapshotSkillEvalWorkspace,
  textPatchPrompt,
} from './skill-eval-text-patch';

const DEFAULT_OMNIRUSH_MODEL = 'gpt-6-astra';
const DEFAULT_WALL_CLOCK_MS = 180_000;
const PROVIDER_TEARDOWN_TIMEOUT_MS = 2_000;
const TEXT_PATCH_TOOLS = ['workspace-snapshot', 'patch-apply'];

export interface ProviderTextPatchExecutorOptions {
  provider: Provider;
  model: string;
  runtimeIdentity: string;
  reasoningLevel?: string;
  wallClockMs?: number;
}

/**
 * Project fixture images into the request as real image content parts.
 *
 * A text-only model gets the same parts: the provider adapter is the component that
 * decides whether it can accept them, so transport is never downgraded silently here.
 * Every attachment is read from the materialized fixture, which both arms share, so the
 * bytes a candidate sees are the bytes the fixture recorded.
 */
function attachmentBlocks(
  workingDirectory: string,
  prompt: string,
  attachments: readonly SkillEvalImageAttachment[],
): string | ProviderContentBlock[] {
  if (attachments.length === 0) return prompt;
  const blocks: ProviderContentBlock[] = [{ type: 'text', text: prompt }];
  for (const attachment of attachments) {
    const path = join(workingDirectory, attachment.relativePath);
    const stats = statSync(path);
    if (!stats.isFile()) {
      throw new Error(`Image attachment ${attachment.relativePath} is not a regular file`);
    }
    // Screenshots are bounded so one fixture cannot inflate the request without limit.
    if (stats.size > 8 * 1024 * 1024) {
      throw new Error(`Image attachment ${attachment.relativePath} exceeds 8 MiB`);
    }
    blocks.push({
      type: 'text',
      text: `Attached image: ${attachment.label}`,
    });
    blocks.push({
      type: 'image',
      imageData: readFileSync(path).toString('base64'),
      imageMimeType: attachment.mimeType,
    });
  }
  return blocks;
}

function boundedDetail(value: string): string {  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/giu, 'Bearer [redacted]')
    .replace(/(?:api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/giu, '$1=[redacted]')
    .trim()
    .slice(-2_000);
}

function failure(
  kind: SkillInfrastructureFailure['kind'],
  detail: string,
  evidence: string[],
  retryable = false,
): SkillInfrastructureFailure {
  return { kind, retryable, detail: boundedDetail(detail), evidence };
}

function observationFailure(
  started: number,
  infrastructureFailure: SkillInfrastructureFailure,
  evidence: string[],
): SkillEvalExecutionObservation {
  return {
    output: '',
    evidence,
    artifacts: [],
    durationMs: Date.now() - started,
    infrastructureFailure,
  };
}

function providerEventFailure(event: ProviderEvent): SkillInfrastructureFailure {
  const detail = boundedDetail(event.error?.trim() || 'Provider emitted an error event.');
  return failure('provider', detail, [`${event.type}: ${detail}`], event.errorTransient === true);
}

function modelIsKnown(provider: Provider, model: string): boolean | undefined {
  if (!provider.isModelCatalogAuthoritative?.()) return undefined;
  return provider.listModels().some((candidate) => candidate.id === model);
}

async function collectProviderText(input: {
  provider: Provider;
  request: StreamRequest;
  wallClockMs: number;
}): Promise<
  | { output: string; evidence: string[] }
  | { output: string; evidence: string[]; taskFailure: string }
  | { infrastructureFailure: SkillInfrastructureFailure; evidence: string[] }
> {
  const controller = new AbortController();
  const request = { ...input.request, signal: controller.signal };
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stream: AsyncGenerator<ProviderEvent> | undefined;
  const consume = (async () => {
    const content: string[] = [];
    const evidence: string[] = [];
    let completed = false;
    try {
      stream = input.provider.streamResponse(request);
      for await (const event of stream) {
        if (event.type === 'content_delta') {
          if (completed) {
            return {
              output: content.join(''),
              evidence,
              taskFailure: 'Provider emitted content after the complete event.',
            };
          }
          if (event.content) content.push(event.content);
          continue;
        }
        if (event.type === 'error') {
          return { infrastructureFailure: providerEventFailure(event), evidence };
        }
        if (event.type === 'complete') {
          if (completed) {
            return {
              output: content.join(''),
              evidence,
              taskFailure: 'Provider emitted more than one complete event.',
            };
          }
          completed = true;
          if (event.finishReason !== 'end_turn' && event.finishReason !== 'stop') {
            return {
              output: content.join(''),
              evidence,
              taskFailure: `Provider completed with unsupported finish reason ${String(event.finishReason)}.`,
            };
          }
          continue;
        }
        if (
          event.type.startsWith('tool_') ||
          event.type === 'tool_executed' ||
          event.type === 'file_edit' ||
          event.type === 'cli_commands'
        ) {
          return {
            output: content.join(''),
            evidence,
            taskFailure: `Provider emitted unsupported ${event.type} event in text-patch mode.`,
          };
        }
      }
      if (!completed) {
        // A stream that ends without its completion event is a provider-side
        // truncation: no patch was produced and no test ran, so there is no
        // skill outcome to score. Classify it as infrastructure, not failure.
        return {
          infrastructureFailure: failure('provider', 'Provider stream ended without a complete event.', [
            'Provider stream ended without a complete event.',
          ]),
          evidence,
        };
      }
      return { output: content.join(''), evidence };
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      return {
        infrastructureFailure: failure('provider', detail, ['Provider stream failed.']),
        evidence,
      };
    }
  })();
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new Error(`Direct provider text-patch response exceeded ${input.wallClockMs}ms`));
    }, input.wallClockMs);
  });
  try {
    return await Promise.race([consume, timeout]);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      infrastructureFailure: failure(timedOut ? 'timeout' : 'provider', detail, [
        timedOut ? `Provider response exceeded ${input.wallClockMs}ms.` : 'Provider stream failed.',
      ]),
      evidence: [],
    };
  } finally {
    if (timer) clearTimeout(timer);
    if (timedOut) {
      controller.abort();
      // The timeout result must not outrun provider cleanup. Providers normally
      // terminate their child transport from the abort signal; the bound keeps
      // a broken provider from holding the executor open indefinitely.
      let close: Promise<unknown> = Promise.resolve();
      try {
        close = stream ? Promise.resolve(stream.return(undefined)) : Promise.resolve();
      } catch {
        // The timeout classification above is authoritative.
      }
      let teardownTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.allSettled([consume, close]),
          new Promise<void>((resolve) => {
            teardownTimer = setTimeout(resolve, PROVIDER_TEARDOWN_TIMEOUT_MS);
          }),
        ]);
      } finally {
        if (teardownTimer) clearTimeout(teardownTimer);
      }
    }
  }
}

/**
 * Execute a V5 full-task arm through a provider's text interface only.
 * The provider never receives tools or a writable workspace; the host applies
 * the returned structured patch after the stream has completed.
 */
export function createDirectProviderTextPatchSkillEvalExecutor(
  options: ProviderTextPatchExecutorOptions,
): SkillEvalExecutor {
  const model = options.model.trim();
  if (!model) throw new Error('Direct provider text-patch executor requires a model.');
  const wallClockMs = options.wallClockMs ?? DEFAULT_WALL_CLOCK_MS;
  if (!Number.isFinite(wallClockMs) || wallClockMs < 1) {
    throw new Error(`Invalid direct provider text-patch wall-clock budget ${String(wallClockMs)}`);
  }
  const providerName = options.provider.name;
  const id = `direct-provider-text-patch:${providerName}:${model}:${options.runtimeIdentity}`;
  return {
    id,
    subject: 'other',
    provider: providerName,
    model,
    runtimeIdentity: options.runtimeIdentity,
    tools: [...TEXT_PATCH_TOOLS],
    budget: { wallClockMs },
    execute: async ({ scenario, workingDirectory, taskPrompt, skillContext, attachments }) => {
      const started = Date.now();
      const imageAttachments = attachments ?? [];
      if (
        imageAttachments.length === 0 &&
        (scenario.environment.kind === 'browser' ||
          scenario.environment.kind === 'device' ||
          scenario.environment.kind === 'public-web')
      ) {
        const detail = `Direct provider text-patch evaluation cannot execute ${scenario.environment.kind} environments; source-patch mode is limited to synthetic, repository, and cli scenarios.`;
        return observationFailure(started, failure('tool', detail, [detail]), [
          detail,
          'No provider request was made; no live-source or test evidence exists.',
        ]);
      }

      let snapshot: string;
      try {
        snapshot = snapshotSkillEvalWorkspace(workingDirectory);
      } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : String(error);
        return observationFailure(
          started,
          failure('setup', detail, ['Text-only evaluator could not snapshot the workspace.']),
          ['Text-only evaluator could not snapshot the workspace.'],
        );
      }

      let available = false;
      try {
        available = options.provider.isAvailable();
      } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : String(error);
        return observationFailure(
          started,
          failure('setup', detail, ['Provider availability check failed.']),
          ['Provider availability check failed.'],
        );
      }
      if (!available) {
        const detail = `${providerName} provider is unavailable or not configured.`;
        return observationFailure(started, failure('setup', detail, [detail]), [
          detail,
          'No provider request was made; no tests ran.',
        ]);
      }
      try {
        if (modelIsKnown(options.provider, model) === false) {
          const detail = `${providerName} does not report model ${model} as available.`;
          return observationFailure(started, failure('provider', detail, [detail]), [
            detail,
            'No patch was applied; no tests ran.',
          ]);
        }
      } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : String(error);
        return observationFailure(
          started,
          failure('setup', detail, ['Provider model catalog check failed.']),
          ['Provider model catalog check failed.'],
        );
      }

      const collected = await collectProviderText({
        provider: options.provider,
        request: {
          model,
          messages: [
            {
              role: 'user',
              content: attachmentBlocks(
                workingDirectory,
                textPatchPrompt(taskPrompt, skillContext, snapshot),
                imageAttachments,
              ),
            },
          ],
          systemPrompt: '',
          ...(options.reasoningLevel ? { reasoningLevel: options.reasoningLevel } : {}),
          tools: [],
          allowedToolNames: [],
          nativeToolsDisabled: true,
          workingDirectory,
          // Keep the provider's internal turn watchdog aligned with the
          // evaluator's host-owned deadline. Omnirush reads this field when it
          // creates its subprocess timer; without it, the provider silently
          // falls back to its independent default cap.
          sandbox: {
            ...SANDBOX_PRESETS.readonly,
            maxRuntimeSeconds: Math.max(1, Math.ceil(wallClockMs / 1000)),
          },
        },
        wallClockMs,
      });
      if ('infrastructureFailure' in collected) {
        return {
          output: '',
          evidence: [
            ...collected.evidence,
            'Direct provider text-patch mode produced no test-execution evidence.',
          ],
          artifacts: [],
          durationMs: Date.now() - started,
          infrastructureFailure: collected.infrastructureFailure,
        };
      }
      if ('taskFailure' in collected) {
        return {
          output: collected.output,
          evidence: [
            ...collected.evidence,
            collected.taskFailure,
            'No patch was applied; no tests ran.',
          ],
          artifacts: [],
          durationMs: Date.now() - started,
          taskFailure: collected.taskFailure,
        };
      }
      if (!collected.output.trim()) {
        const detail = `${providerName} returned no text output for the patch contract.`;
        return {
          output: '',
          evidence: [...collected.evidence, detail, 'No patch was applied; no tests ran.'],
          artifacts: [],
          durationMs: Date.now() - started,
          taskFailure: detail,
        };
      }
      try {
        const parsed = parseSkillEvalTextPatch(collected.output);
        if (parsed.format !== 'tagged-json') {
          throw new Error('Provider output must use the tagged JSON patch format.');
        }
        const changedPaths = applySkillEvalTextPatch(workingDirectory, parsed.operations);
        return {
          output: collected.output,
          evidence: [
            ...collected.evidence,
            ...(imageAttachments.length
              ? [
                  `Provider request carried ${String(imageAttachments.length)} image attachment(s) as image content parts: ${imageAttachments
                    .map((attachment) => `${attachment.relativePath} (${attachment.mimeType}, ${attachment.label})`)
                    .join('; ')}.`,
                ]
              : []),
            'Direct provider text-patch mode produced no test-execution evidence; host checks remain authoritative.',
            `Text-only patch adapter parsed ${parsed.operations.length} operation(s) in ${parsed.format} format.`,
            ...(changedPaths.length
              ? [`Text-only patch adapter applied: ${changedPaths.join(', ')}.`]
              : ['Text-only patch adapter applied no file changes.']),
          ],
          artifacts: [],
          durationMs: Date.now() - started,
        };
      } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : String(error);
        return {
          output: collected.output,
          evidence: [
            ...collected.evidence,
            `Text-only patch adapter rejected the provider output: ${detail}`,
          ],
          artifacts: [],
          durationMs: Date.now() - started,
          taskFailure: `Provider output violated the patch contract: ${detail}`,
        };
      }
    },
  };
}

function resolveQualificationReasoningLevel(
  model: ModelDef,
  reasoningEffort: string | undefined,
): string | undefined {
  const requested = reasoningEffort?.trim();
  if (!requested) return undefined;

  // `none` is a campaign-level generic. Only translate it when the
  // authoritative catalog advertises an equivalent no-budget state.
  const candidates = requested.toLowerCase() === 'none' ? ['none', 'off', 'minimal'] : [requested];
  for (const candidate of candidates) {
    const resolved = resolveOmnirushReasoningLevel(model, candidate);
    if (resolved !== undefined) return resolved;
  }
  return undefined;
}

/** Create the qualification-only OmniRush text-patch executor. */
export function createOmnirushTextOnlyPatchSkillEvalExecutor(options?: {
  model?: string;
  reasoningEffort?: string;
  wallClockMs?: number;
}): SkillEvalExecutor {
  const config: ProviderConfig = { name: 'omnirush', disabled: false };
  let runtime: ReturnType<typeof resolveOmnirushRuntimeBinding>;
  try {
    runtime = resolveOmnirushRuntimeBinding();
  } catch {
    throw new Error(
      'OmniRush text-patch executor is unavailable: the verified Omnirush launcher/auth state cannot be used.',
    );
  }
  const provider = new OmnirushCliProvider(config, runtime);
  if (!provider.isAvailable()) {
    throw new Error(
      'OmniRush text-patch executor is unavailable: the verified Omnirush launcher/auth state cannot be used.',
    );
  }
  const model =
    options?.model?.trim() ||
    process.env.KORY_SKILL_EVAL_OMNIRUSH_MODEL?.trim() ||
    DEFAULT_OMNIRUSH_MODEL;
  const requestedReasoningEffort = options?.reasoningEffort?.trim();
  let reasoningLevel: string | undefined;
  try {
    const catalog = readOmnirushCliCatalog(runtime.stateRoot);
    const catalogModel = catalog.find((candidate) => candidate.id === model);
    if (!catalogModel) {
      throw new Error(`OmniRush model ${model} is not present in its authoritative CLI catalog.`);
    }
    reasoningLevel = resolveQualificationReasoningLevel(catalogModel, requestedReasoningEffort);
    if (
      requestedReasoningEffort &&
      requestedReasoningEffort.toLowerCase() !== 'none' &&
      reasoningLevel === undefined
    ) {
      throw new Error(
        `OmniRush model ${model} does not advertise reasoning level ${requestedReasoningEffort}.`,
      );
    }
  } catch (error: unknown) {
    if (error instanceof Error && /not present in its authoritative/u.test(error.message)) {
      throw error;
    }
    if (
      !(error instanceof Error) ||
      !('code' in error) ||
      (error as NodeJS.ErrnoException).code !== 'ENOENT'
    ) {
      throw error;
    }
    // Legacy OmniRush releases discover models through RPC and do not expose
    // model-catalog.json. Leave that supported path for the first request.
    reasoningLevel =
      requestedReasoningEffort && requestedReasoningEffort.toLowerCase() !== 'none'
        ? requestedReasoningEffort
        : undefined;
  }
  return createDirectProviderTextPatchSkillEvalExecutor({
    provider,
    model,
    runtimeIdentity: `${runtime.identity}:text-only-patch`,
    reasoningLevel,
    wallClockMs: options?.wallClockMs,
  });
}

/** Create a qualification-only OpenRouter free-model text-patch executor. */
export function createOpenRouterTextOnlyPatchSkillEvalExecutor(options?: {
  model?: string;
  wallClockMs?: number;
}): SkillEvalExecutor {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      'OpenRouter text-patch executor is unavailable: OPENROUTER_API_KEY is not configured.',
    );
  }
  const model = options?.model?.trim() || 'openrouter/openrouter/free';
  const config: ProviderConfig = {
    name: 'openrouter',
    apiKey,
    baseUrl: 'https://openrouter.ai/api/v1',
    disabled: false,
    headers: {
      'HTTP-Referer': 'https://koryphaios.local',
      'X-Title': 'Koryphaios V5 qualification',
    },
  };
  const provider = new OpenAIProvider(config, 'openrouter', config.baseUrl);
  if (!provider.isAvailable()) {
    throw new Error(
      'OpenRouter text-patch executor is unavailable: the configured provider is disabled or missing credentials.',
    );
  }
  return createDirectProviderTextPatchSkillEvalExecutor({
    provider,
    model,
    runtimeIdentity: `openrouter-api:${model}:text-only-patch`,
    wallClockMs: options?.wallClockMs,
  });
}

/**
 * Create a qualification-only Logfare text-patch executor.
 *
 * Same stateless text-only contract as the OpenRouter executor: the provider
 * never receives tools or a writable workspace, and the host applies the
 * returned structured patch after the stream completes. Credentials come from
 * the environment only (KORY_SKILL_EVAL_LOGFARE_API_KEY).
 */
export function createLogfareTextOnlyPatchSkillEvalExecutor(options?: {
  model?: string;
  wallClockMs?: number;
}): SkillEvalExecutor {
  const apiKey = process.env.KORY_SKILL_EVAL_LOGFARE_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      'Logfare text-patch executor is unavailable: KORY_SKILL_EVAL_LOGFARE_API_KEY is not configured.',
    );
  }
  const model = options?.model?.trim() || 'deepseek-v4.1-flash-1017';
  const baseUrl =
    process.env.KORY_SKILL_EVAL_LOGFARE_BASE_URL?.trim() || 'https://logfare.ai/v1';
  const config: ProviderConfig = {
    name: 'logfare',
    apiKey,
    baseUrl,
    disabled: false,
    headers: {
      'X-Title': 'Koryphaios V5 qualification',
    },
  };
  const provider = new OpenAIProvider(config, 'logfare', baseUrl);
  if (!provider.isAvailable()) {
    throw new Error(
      'Logfare text-patch executor is unavailable: the configured provider is disabled or missing credentials.',
    );
  }
  return createDirectProviderTextPatchSkillEvalExecutor({
    provider,
    model,
    runtimeIdentity: `logfare-api:${model}:text-only-patch`,
    wallClockMs: options?.wallClockMs,
  });
}

