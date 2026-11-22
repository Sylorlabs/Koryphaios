import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import {
  findExecutableOnPath,
  looksLikePath,
  providerProcessGroupOptions,
  terminateProviderProcessGroup,
} from '../../runtime/platform';
import type { SkillEvalExecutionObservation, SkillEvalExecutor } from './skill-eval-execution';
import type { SkillInfrastructureFailure } from '../../kory/skill-evaluations';
import {
  applySkillEvalTextPatch,
  parseSkillEvalTextPatch,
  snapshotSkillEvalWorkspace,
  textPatchPrompt,
} from './skill-eval-text-patch';

const DEFAULT_MODEL = 'openrouter/openrouter/free';
const DEFAULT_AGENT = 'kory-skill-eval-candidate';
const DEFAULT_TIMEOUT_MS = 300_000;

function binary(): string {
  return process.env.KORY_SKILL_EVAL_OPENCODE_BINARY?.trim() || 'opencode';
}

function resolveBinary(configured: string): string | null {
  if (looksLikePath(configured)) return existsSync(configured) ? configured : null;
  return findExecutableOnPath(configured);
}

function bounded(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/giu, 'Bearer [redacted]')
    .trim()
    .slice(-2_000);
}

function infra(
  kind: SkillInfrastructureFailure['kind'],
  detail: string,
  retryable = false,
): SkillInfrastructureFailure {
  return { kind, retryable, detail: bounded(detail), evidence: [bounded(detail)] };
}

function isToolEventType(type: unknown): boolean {
  // Conservatively include tool-call/use/result events and their lifecycle variants.
  return typeof type === 'string' && /^tool(?:$|[-_.]|call|use|result)/iu.test(type);
}

function parseStream(stdout: string): {
  sessionId: string | null;
  text: string;
  hasError: boolean;
  hasToolUse: boolean;
} {
  let sessionId: string | null = null;
  let hasError = false;
  let hasToolUse = false;
  const parts = new Map<string, { order: number; text: string }>();
  let order = 0;
  for (const line of stdout.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    const part = event.part;
    const record = part && typeof part === 'object' ? (part as Record<string, unknown>) : null;
    if (isToolEventType(event.type) || isToolEventType(record?.type)) {
      hasToolUse = true;
      continue;
    }
    if (!sessionId && typeof event.sessionID === 'string') sessionId = event.sessionID;
    if (event.type === 'error') {
      hasError = true;
      continue;
    }
    if (!record) continue;
    if (!sessionId && typeof record.sessionID === 'string') sessionId = record.sessionID;
    if (record.type !== 'text' || typeof record.text !== 'string') continue;
    const id = typeof record.id === 'string' ? record.id : `part-${order}`;
    const prior = parts.get(id);
    if (prior) prior.text = record.text;
    else parts.set(id, { order: order++, text: record.text });
  }
  return {
    sessionId,
    hasError,
    hasToolUse,
    text: [...parts.values()]
      .sort((a, b) => a.order - b.order)
      .map((part) => part.text)
      .join(''),
  };
}

function runOpenCode(
  binaryPath: string,
  prompt: string,
  model: string,
  wallClockMs: number,
): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(
      binaryPath,
      [
        'run',
        '--format',
        'json',
        '--agent',
        process.env.KORY_SKILL_EVAL_OPENCODE_AGENT?.trim() || DEFAULT_AGENT,
        '-m',
        model,
        prompt,
      ],
      {
        cwd: process.cwd(),
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        ...providerProcessGroupOptions(),
        // The evaluation prompt is an opaque argv value, never shell source.
        shell: false,
      },
    );
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let killFallback: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: {
      code: number | null;
      stdout: string;
      stderr: string;
      timedOut: boolean;
    }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killFallback) clearTimeout(killFallback);
      // A leader's close does not mean its descendants exited. Force cleanup
      // before settling even when close beats the timeout fallback.
      if (timedOut) terminateProviderProcessGroup(child.pid);
      // Escaped descendants may retain inherited pipes after group cleanup.
      // Dispose our endpoints so settlement also permits natural caller exit.
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      resolve(result);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killFallback = setTimeout(() => {
        finish({ code: null, stdout, stderr, timedOut });
      }, 2_000);
      child.kill('SIGTERM');
    }, wallClockMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      finish({ code: 1, stdout, stderr: `${stderr}\n${error.message}`, timedOut });
    });
    child.on('close', (code) => {
      finish({ code, stdout, stderr, timedOut });
    });
  });
}

export function createOpenCodeTextOnlyPatchSkillEvalExecutor(options?: {
  model?: string;
  wallClockMs?: number;
}): SkillEvalExecutor {
  const model =
    options?.model?.trim() || process.env.KORY_SKILL_EVAL_OPENCODE_MODEL?.trim() || DEFAULT_MODEL;
  const wallClockMs = options?.wallClockMs ?? DEFAULT_TIMEOUT_MS;
  const configuredBinary = binary();
  const binaryPath = resolveBinary(configuredBinary);
  if (!binaryPath)
    throw new Error(
      `OpenCode text-patch executor is unavailable: binary not found at ${configuredBinary}`,
    );
  return {
    id: `opencode-text-patch:${model}:${binaryPath}`,
    subject: 'other',
    provider: 'opencode',
    model,
    runtimeIdentity: `opencode-cli:${binaryPath}:text-only-patch:tool-event-guard-v1`,
    tools: ['workspace-snapshot', 'patch-apply'],
    budget: { wallClockMs },
    execute: async ({
      scenario,
      workingDirectory,
      taskPrompt,
      skillContext,
    }): Promise<SkillEvalExecutionObservation> => {
      const started = Date.now();
      if (
        scenario.environment.kind === 'browser' ||
        scenario.environment.kind === 'device' ||
        scenario.environment.kind === 'public-web'
      ) {
        const detail = `OpenCode text-patch evaluation cannot execute ${scenario.environment.kind} environments.`;
        return {
          output: '',
          evidence: [detail],
          artifacts: [],
          durationMs: Date.now() - started,
          infrastructureFailure: infra('tool', detail),
        };
      }
      let snapshot: string;
      try {
        snapshot = snapshotSkillEvalWorkspace(workingDirectory);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return {
          output: '',
          evidence: [detail],
          artifacts: [],
          durationMs: Date.now() - started,
          infrastructureFailure: infra('setup', detail),
        };
      }
      const prompt = textPatchPrompt(taskPrompt, skillContext, snapshot);
      const result = await runOpenCode(binaryPath, prompt, model, wallClockMs);
      const parsed = parseStream(result.stdout);
      if (parsed.hasToolUse) {
        // This detects a reported breach after execution; it does not prevent tool use.
        // Reject before patch application or any fallback that exposes raw diagnostics.
        // Even assistant text may echo tool arguments/output, so discard it as well.
        const detail =
          'OpenCode emitted a tool event in a text-only evaluation; patch rejected (details redacted).';
        return {
          output: '',
          evidence: [detail],
          artifacts: [],
          durationMs: Date.now() - started,
          infrastructureFailure: infra('tool', detail),
        };
      }
      if (result.timedOut)
        return {
          output: parsed.text,
          evidence: ['OpenCode response exceeded the evaluator wall-clock budget.'],
          artifacts: [],
          durationMs: Date.now() - started,
          infrastructureFailure: infra('timeout', `OpenCode response exceeded ${wallClockMs}ms.`),
        };
      if (parsed.hasError) {
        // Error payloads are provider-controlled and may contain credentials or
        // request bodies. Do not copy them into output, evidence, or diagnostics.
        const detail = 'OpenCode emitted a structured error event (details redacted).';
        return {
          output: parsed.text,
          evidence: [detail],
          artifacts: [],
          durationMs: Date.now() - started,
          infrastructureFailure: infra('provider', detail, true),
        };
      }
      if (result.code !== 0 || !parsed.text.trim() || !parsed.sessionId) {
        const detail = bounded(
          result.stderr || result.stdout || `OpenCode exited ${String(result.code)}`,
        );
        return {
          output: parsed.text,
          evidence: [detail],
          artifacts: [],
          durationMs: Date.now() - started,
          infrastructureFailure: infra('provider', detail, true),
        };
      }
      try {
        const patch = parseSkillEvalTextPatch(parsed.text);
        const changed = applySkillEvalTextPatch(workingDirectory, patch.operations);
        return {
          output: parsed.text,
          evidence: [
            `OpenCode session ${parsed.sessionId} completed.`,
            `Applied ${changed.length} text-patch operation(s).`,
          ],
          artifacts: [],
          durationMs: Date.now() - started,
        };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return {
          output: parsed.text,
          evidence: [`OpenCode session ${parsed.sessionId} completed.`, detail],
          artifacts: [],
          durationMs: Date.now() - started,
          taskFailure: `OpenCode output violated the patch contract: ${detail}`,
        };
      }
    },
  };
}
