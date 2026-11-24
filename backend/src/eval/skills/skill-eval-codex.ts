import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import type { SkillEvalExecutionObservation, SkillEvalExecutor } from './skill-eval-execution';
import type { SkillEvalScenarioV3 } from './skill-eval-harness';
import type { SkillInfrastructureFailure } from '../../kory/skill-evaluations';
import {
  applySkillEvalTextPatch,
  parseSkillEvalTextPatch,
  snapshotSkillEvalWorkspace,
  textPatchPrompt,
} from './skill-eval-text-patch';
import {
  isReactBrowserScenario,
  REACT_BROWSER_BROKER_INSTRUCTIONS,
  startReactBrowserBroker,
  type ReactBrowserBroker,
} from './skill-eval-react-browser-broker';
import {
  isVisualBrowserScenario,
  startVisualBrowserBroker,
  VISUAL_BROKER_INSTRUCTIONS,
  type VisualBrowserBroker,
} from './skill-eval-visual-browser-broker';
import { isUnix } from '../../runtime/platform';

const DEFAULT_CODEX_BINARY = '/Applications/ChatGPT.app/Contents/Resources/codex';
const DEFAULT_STANDALONE_CODEX_BINARIES = ['/opt/homebrew/bin/codex', '/usr/local/bin/codex'];
const DEFAULT_CODEX_MODEL = 'gpt-5.6-sol';

function codexBinary(): string {
  const configured = process.env.KORY_SKILL_EVAL_CODEX_BINARY?.trim();
  if (configured) return configured;
  if (process.env.KORY_SKILL_EVAL_USE_DESKTOP_CODEX !== '1') {
    const standalone = DEFAULT_STANDALONE_CODEX_BINARIES.find((binary) => existsSync(binary));
    if (standalone) return standalone;
  }
  if (existsSync(DEFAULT_CODEX_BINARY)) return DEFAULT_CODEX_BINARY;
  return 'codex';
}

function codexVersion(binary: string): string {
  const result = spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 5_000 });
  if (result.status !== 0) {
    throw new Error(`Codex CLI version probe failed with exit ${String(result.status)}`);
  }
  return result.stdout.trim();
}

function isolatedCodexHome(): string {
  const sourceHome =
    process.env.KORY_SKILL_EVAL_SOURCE_CODEX_HOME?.trim() || join(process.env.HOME ?? '', '.codex');
  const authSource = join(sourceHome, 'auth.json');
  if (!existsSync(authSource)) {
    throw new Error(`Codex authentication was not found at ${authSource}`);
  }
  const destination = mkdtempSync(join(tmpdir(), 'kory-skill-eval-codex-home-'));
  const authDestination = join(destination, 'auth.json');
  copyFileSync(authSource, authDestination);
  chmodSync(authDestination, 0o600);
  const bridgeUrl = process.env.KORY_SKILL_EVAL_OPENAI_BASE_URL?.trim();
  if (bridgeUrl) {
    const model = process.env.KORY_SKILL_EVAL_MODEL?.trim() || DEFAULT_CODEX_MODEL;
    const reasoningEffort = process.env.KORY_SKILL_EVAL_REASONING_EFFORT?.trim() || 'none';
    writeFileSync(
      join(destination, 'config.toml'),
      [
        `openai_base_url = ${JSON.stringify(bridgeUrl)}`,
        `model = ${JSON.stringify(model)}`,
        `model_reasoning_effort = ${JSON.stringify(reasoningEffort)}`,
        'approval_policy = "never"',
        'sandbox_mode = "workspace-write"',
        '',
      ].join('\n'),
      { mode: 0o600 },
    );
  }
  return destination;
}

/** Availability probe for auto-selection; it checks only binary/auth presence. */
export function isCodexSkillEvalAvailable(): boolean {
  try {
    codexVersion(codexBinary());
    const sourceHome =
      process.env.KORY_SKILL_EVAL_SOURCE_CODEX_HOME?.trim() ||
      join(process.env.HOME ?? '', '.codex');
    return existsSync(join(sourceHome, 'auth.json'));
  } catch {
    return false;
  }
}

/** The scenario contract, never an environment variable or candidate output, grants public HTTPS. */
export function codexSkillEvalNetworkPolicy(scenario: Pick<SkillEvalScenarioV3, 'environment'>): {
  enabled: boolean;
  sandboxConfig: string;
  instruction: string;
} {
  const enabled = scenario.environment.kind === 'public-web';
  return {
    enabled,
    sandboxConfig: `sandbox_workspace_write.network_access=${String(enabled)}`,
    instruction: enabled
      ? 'Use real HTTPS requests to retrieve authoritative public sources for this research task. Record actual retrieval evidence, and report unavailable sources as unverified. Do not clone external repositories, install dependencies over the network, use MCP servers, or delegate background work.'
      : 'Do not use network access, external repositories, MCP servers, or background delegation.',
  };
}

function taskPrompt(
  task: string,
  skillContext: string | null,
  networkInstruction: string,
  browserInstruction?: string,
): string {
  const singleNativeCall = process.env.KORY_SKILL_EVAL_SINGLE_NATIVE_CALL === '1';
  const common = [
    'Complete the task below autonomously in the current workspace.',
    'You may inspect and edit files in this workspace and run local verification commands.',
    'This may be a synthetic fixture rather than a Git checkout. Do not assume .git exists; inspect the provided files directly and use Git only when the workspace contains a repository.',
    'Keep all file operations inside this workspace.',
    networkInstruction,
    ...(browserInstruction ? [browserInstruction] : []),
    'Preserve behavior outside the requested contract. Do not stop at analysis if a code change is required.',
    'Run the strongest relevant local checks before finishing and report the concrete evidence concisely.',
    ...(singleNativeCall
      ? [
          'The evaluator provides one native shell turn for this arm. Complete inspection, implementation, and verification in one shell invocation; combine commands in that invocation and do not request a second shell turn.',
        ]
      : []),
    '',
    'TASK',
    task.trim(),
  ];
  if (!skillContext) return common.join('\n');
  return [
    ...common,
    '',
    'TARGET SKILL GUIDANCE',
    'The following portable skill is the only extra task guidance supplied to this arm. Apply it when relevant; it does not expand the task scope or authority.',
    skillContext.trim(),
  ].join('\n');
}

function providerFailureIsRetryable(detail: string, exitCode: number | null): boolean {
  if (/usage limit|quota|credits?\b|rate limit/iu.test(detail)) return false;
  return exitCode !== 2;
}

function compactCodexDiagnostic(value: string): string {
  const lines = value
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, '')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  const useful = lines.filter((line) =>
    /usage limit|quota|credits?\b|rate limit|invalid|expired|revoked|disconnected|connection|timed out|exceeded|failed to start|exit=|signal=|not found/iu.test(
      line,
    ),
  );
  return (useful.length ? useful : lines.slice(-2)).join('\n').slice(-2_000);
}

/** Classify host diagnostics only, never candidate prose, code, or fixture output. */
export function classifyCodexInfrastructureFailure(input: {
  stderr: string;
  output: string;
  exitCode: number | null;
  timedOut: boolean;
}): SkillInfrastructureFailure | undefined {
  if (input.output.trim() || (!input.timedOut && input.exitCode === 0)) return undefined;
  const lines = input.stderr.replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, '').split(/\r?\n/u);
  const diagnostics = lines.filter((line) =>
    /^(?:ERROR:|\d{4}-\d{2}-\d{2}T\S+\s+(?:WARN|ERROR)\s+codex_[\w:]+:)/u.test(line.trim()),
  );
  const terminal = diagnostics.at(-1)?.trim();
  if (!terminal) return undefined;
  let kind: SkillInfrastructureFailure['kind'] | undefined;
  if (
    /usage limit|rate limit|quota|insufficient.credits|invalid.api.key|authentication.*(?:failed|expired)|model.*(?:not supported|not found)/iu.test(
      terminal,
    )
  )
    kind = 'provider';
  else if (
    // The CLI rejecting its own invocation (an unsupported reasoning effort for the
    // selected model, for example) is a harness configuration fault, not evidence
    // about the candidate. Observed verbatim: ERROR: {"type":"error","error":
    // {"message":"Unsupported value: 'none' is not supported with the 'gpt-6.1-sol'
    // model. Supported values are: ..."}}
    /unsupported value|not supported with the ['"]?[\w.:-]+['"]? model|unknown (?:model|parameter|option)/iu.test(
      terminal,
    )
  )
    kind = 'setup';
  else if (
    /dns error|dns lookup.*(?:failed|error)|failed to lookup address|name or service not known|failed to resolve|ENOTFOUND|EAI_AGAIN/iu.test(
      terminal,
    )
  )
    kind = 'provider';
  else if (
    /(?:responses_retry|stream disconnected before completion).*(?:disconnect|error|retry|failed)|stream disconnected before completion|error sending request|connection (?:reset|refused)/iu.test(
      terminal,
    )
  )
    kind = 'provider';
  else if (
    /(?:remote )?plugin.*(?:catalog|download).*(?:failed|error|timed out)|failed to (?:download|fetch).*(?:plugin|catalog)/iu.test(
      terminal,
    )
  )
    kind = 'setup';
  else if (
    /MCP.*(?:startup|start|initializ|handshake).*(?:timed out|timeout|failed)|MCP client.*timed out/iu.test(
      terminal,
    )
  )
    kind = 'tool';
  if (!kind) return undefined;
  return {
    kind,
    retryable: providerFailureIsRetryable(terminal, input.exitCode),
    evidence: [terminal.slice(-2_000)],
    detail: terminal.slice(-2_000),
  };
}

async function runCodex(input: {
  binary: string;
  model: string;
  reasoningEffort?: string;
  workingDirectory: string;
  prompt: string;
  wallClockMs: number;
  sandbox?: 'read-only' | 'workspace-write';
  /** Public-web scenarios alone may retrieve live research sources from HTTPS. */
  networkAccess?: boolean;
}): Promise<SkillEvalExecutionObservation> {
  const started = Date.now();
  let codexHome: string;
  try {
    codexHome = isolatedCodexHome();
  } catch (error: unknown) {
    return {
      output: '',
      evidence: ['Codex auth-only home could not be prepared'],
      artifacts: [],
      durationMs: Date.now() - started,
      infrastructureFailure: {
        kind: 'setup',
        retryable: false,
        evidence: ['Codex auth-only home could not be prepared'],
        detail: error instanceof Error ? error.message : String(error),
      },
    };
  }
  const outputPath = join(codexHome, 'last-message.txt');
  const args = [
    'exec',
    ...(process.env.KORY_SKILL_EVAL_OPENAI_BASE_URL?.trim() ? [] : ['--ignore-user-config']),
    '--ignore-rules',
    '--ephemeral',
    '--skip-git-repo-check',
    '--color',
    'never',
    '--sandbox',
    input.sandbox ?? 'workspace-write',
    '--config',
    `sandbox_workspace_write.network_access=${String(input.networkAccess === true)}`,
    '--config',
    'mcp_servers={}',
    '--config',
    'approval_policy="never"',
    '--model',
    input.model,
    ...(input.reasoningEffort
      ? ['--config', `model_reasoning_effort=${JSON.stringify(input.reasoningEffort)}`]
      : []),
    '--cd',
    input.workingDirectory,
    '--output-last-message',
    outputPath,
    '-',
  ];
  // The sandbox runs with workspace-write and the per-turn HOME replaced, so a
  // host TMPDIR is outside every writable root. Bun, npm and compilers then fail
  // with PermissionDenied and an honest candidate marks its verification
  // unverified. Keep the temp root inside the writable checkout instead.
  const turnTempDir = join(input.workingDirectory, '.kory-tmp');
  try {
    mkdirSync(turnTempDir, { recursive: true });
  } catch {
    // A fixture that forbids the path simply keeps the inherited TMPDIR.
  }
  const env = {
    ...process.env,
    CODEX_HOME: codexHome,
    HOME: codexHome,
    USERPROFILE: codexHome,
    TMPDIR: turnTempDir,
    TMP: turnTempDir,
    TEMP: turnTempDir,
    // Keep Codex auth and config isolated while allowing offline fixture tests
    // to resolve the same pinned Bun packages in either experiment arm. Bun
    // otherwise searches the deliberately empty per-turn HOME and reports
    // missing dependencies despite the host having the pinned cache.
    ...(existsSync(join(homedir(), '.bun', 'install', 'cache'))
      ? {
          BUN_INSTALL_CACHE_DIR:
            process.env.BUN_INSTALL_CACHE_DIR?.trim() ||
            join(homedir(), '.bun', 'install', 'cache'),
        }
      : {}),
  };
  try {
    return await new Promise<SkillEvalExecutionObservation>((resolve) => {
      const child = spawn(input.binary, args, {
        cwd: input.workingDirectory,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: isUnix(),
      });
      let stderr = '';
      let stdout = '';
      let timedOut = false;
      let settled = false;
      let forceKillTimeout: ReturnType<typeof setTimeout> | undefined;
      let closeFallbackTimeout: ReturnType<typeof setTimeout> | undefined;
      const terminateProcessGroup = (signal: NodeJS.Signals) => {
        if (child.pid && isUnix()) {
          try {
            process.kill(-child.pid, signal);
            return;
          } catch {
            // The process may have exited between the timeout and group kill.
          }
        }
        child.kill(signal);
      };
      const clearTimers = () => {
        clearTimeout(timeout);
        if (forceKillTimeout) clearTimeout(forceKillTimeout);
        if (closeFallbackTimeout) clearTimeout(closeFallbackTimeout);
      };
      const finish = (code: number | null, signal: NodeJS.Signals | null) => {
        if (settled) return;
        settled = true;
        clearTimers();
        const output = existsSync(outputPath) ? readFileSync(outputPath, 'utf8').trim() : '';
        const durationMs = Date.now() - started;
        const infrastructureFailure = classifyCodexInfrastructureFailure({
          stderr,
          output,
          exitCode: code,
          timedOut,
        });
        if (timedOut) {
          const diagnostic = compactCodexDiagnostic(stderr || stdout);
          resolve({
            output,
            evidence: [
              `Codex exceeded ${input.wallClockMs}ms wall-clock budget`,
              ...(diagnostic ? [diagnostic] : []),
            ],
            artifacts: [],
            durationMs,
            ...(infrastructureFailure
              ? { infrastructureFailure }
              : {
                  taskFailure: `Model exceeded ${input.wallClockMs}ms task budget without a proven infrastructure failure`,
                }),
          });
          return;
        }
        if (code !== 0 || !output) {
          const rawDiagnostic = stderr || stdout || `Codex exited ${String(code)}`;
          const diagnostic = compactCodexDiagnostic(rawDiagnostic);
          resolve({
            output,
            evidence: [`Codex CLI exit=${String(code)} signal=${signal ?? 'none'}`, diagnostic],
            artifacts: [],
            durationMs,
            ...(infrastructureFailure
              ? { infrastructureFailure }
              : {
                  taskFailure: `Model did not complete its output contract (exit ${String(code)})`,
                }),
          });
          return;
        }
        resolve({
          output,
          evidence: [`Codex CLI completed successfully in ${durationMs}ms`],
          artifacts: [],
          durationMs,
        });
      };
      const timeout = setTimeout(() => {
        timedOut = true;
        terminateProcessGroup('SIGTERM');
        forceKillTimeout = setTimeout(() => {
          terminateProcessGroup('SIGKILL');
          // A detached descendant can keep stdout/stderr open after the direct
          // child exits. Node then never emits 'close'; settle the budget anyway.
          closeFallbackTimeout = setTimeout(() => finish(child.exitCode, child.signalCode), 1_000);
        }, 2_000);
      }, input.wallClockMs);
      child.stdout.on('data', (chunk) => {
        stdout = `${stdout}${String(chunk)}`.slice(-16_000);
      });
      child.stderr.on('data', (chunk) => {
        stderr = `${stderr}${String(chunk)}`.slice(-16_000);
      });
      child.once('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimers();
        resolve({
          output: '',
          evidence: ['Codex process failed to start'],
          artifacts: [],
          durationMs: Date.now() - started,
          infrastructureFailure: {
            kind: 'provider',
            retryable: true,
            evidence: ['Codex process failed to start'],
            detail: error.message,
          },
        });
      });
      child.once('close', finish);
      child.stdin.end(input.prompt);
    });
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
  }
}

async function runTextOnlyPatch(input: {
  binary: string;
  model: string;
  reasoningEffort?: string;
  workingDirectory: string;
  task: string;
  skillContext: string | null;
  wallClockMs: number;
}): Promise<SkillEvalExecutionObservation> {
  const started = Date.now();
  let snapshot: string;
  try {
    snapshot = snapshotSkillEvalWorkspace(input.workingDirectory);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      output: '',
      evidence: ['Text-only evaluator could not snapshot the disposable workspace'],
      artifacts: [],
      durationMs: Date.now() - started,
      infrastructureFailure: {
        kind: 'setup',
        retryable: false,
        evidence: ['Text-only evaluator could not snapshot the disposable workspace'],
        detail,
      },
    };
  }
  const observation = await runCodex({
    binary: input.binary,
    model: input.model,
    reasoningEffort: input.reasoningEffort,
    workingDirectory: input.workingDirectory,
    prompt: textPatchPrompt(input.task, input.skillContext, snapshot),
    wallClockMs: input.wallClockMs,
    sandbox: 'read-only',
  });
  if (observation.infrastructureFailure || observation.taskFailure) return observation;
  try {
    const parsed = parseSkillEvalTextPatch(observation.output);
    const changedPaths = applySkillEvalTextPatch(input.workingDirectory, parsed.operations);
    return {
      ...observation,
      evidence: [
        ...observation.evidence,
        `Text-only patch adapter parsed ${parsed.operations.length} operation(s) in ${parsed.format} format.`,
        ...(changedPaths.length
          ? [`Text-only patch adapter applied: ${changedPaths.join(', ')}.`]
          : ['Text-only patch adapter applied no file changes.']),
      ],
    };
  } catch (error: unknown) {
    return {
      ...observation,
      evidence: [
        ...observation.evidence,
        `Text-only patch adapter rejected the model output: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }
}

/** Run one isolated Codex prompt without adding skill context or task wrappers. */
export async function runIsolatedCodexPrompt(options: {
  workingDirectory: string;
  prompt: string;
  model?: string;
  reasoningEffort?: string;
  wallClockMs?: number;
}): Promise<SkillEvalExecutionObservation> {
  const binary = codexBinary();
  return runCodex({
    binary,
    model: options.model ?? DEFAULT_CODEX_MODEL,
    reasoningEffort: options.reasoningEffort,
    workingDirectory: options.workingDirectory,
    prompt: options.prompt,
    wallClockMs: options.wallClockMs ?? 180_000,
  });
}

export function createIsolatedCodexSkillEvalExecutor(options?: {
  model?: string;
  reasoningEffort?: string;
  wallClockMs?: number;
}): SkillEvalExecutor {
  const binary = codexBinary();
  const runtimeIdentity = codexVersion(binary);
  const model = options?.model ?? DEFAULT_CODEX_MODEL;
  const reasoningEffort = options?.reasoningEffort;
  const wallClockMs = options?.wallClockMs ?? 180_000;
  const executionMode =
    process.env.KORY_SKILL_EVAL_SINGLE_NATIVE_CALL === '1' ? 'single-native-call' : 'multi-turn';
  return {
    id: `codex-cli-isolated:${runtimeIdentity}${reasoningEffort ? `:reasoning=${reasoningEffort}` : ''}:${executionMode}`,
    subject: 'codex',
    provider: 'codex',
    model,
    runtimeIdentity: `${runtimeIdentity}${reasoningEffort ? `:reasoning=${reasoningEffort}` : ''}:${executionMode}`,
    tools: ['filesystem', 'shell'],
    toolsForScenario: (scenario) =>
      codexSkillEvalNetworkPolicy(scenario).enabled
        ? ['filesystem', 'shell', 'public-https']
        : ['filesystem', 'shell'],
    budget: { wallClockMs },
    execute: async ({ scenario, workingDirectory, taskPrompt: task, skillContext }) => {
      const policy = codexSkillEvalNetworkPolicy(scenario);
      const reactBrowser = isReactBrowserScenario(scenario.id);
      const visualBrowser = !reactBrowser && isVisualBrowserScenario(scenario.id);
      let broker: ReactBrowserBroker | VisualBrowserBroker | undefined;
      if (reactBrowser || visualBrowser) {
        try {
          broker = reactBrowser
            ? await startReactBrowserBroker(workingDirectory)
            : await startVisualBrowserBroker(workingDirectory);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          return {
            output: '',
            evidence: [
              `${reactBrowser ? 'React' : 'Visual'} browser inspector could not start: ${detail}`,
            ],
            artifacts: [],
            durationMs: 0,
            infrastructureFailure: {
              kind: 'setup',
              retryable: false,
              evidence: [detail],
              detail,
            },
          };
        }
      }
      try {
        return await runCodex({
          binary,
          model,
          reasoningEffort,
          workingDirectory,
          prompt: taskPrompt(
            task,
            skillContext,
            policy.instruction,
            reactBrowser
              ? REACT_BROWSER_BROKER_INSTRUCTIONS
              : visualBrowser
                ? VISUAL_BROKER_INSTRUCTIONS
                : undefined,
          ),
          networkAccess: policy.enabled,
          wallClockMs,
        });
      } finally {
        await broker?.close();
      }
    },
  };
}

/**
 * Use the same Codex model without native tools by providing a bounded
 * snapshot and applying its structured patch inside the disposable fixture.
 * This is a fallback for Web bridges that can answer text but cannot authorize
 * a child process's native shell token. Both arms still use the same model,
 * prompt contract, workspace materializer, and deterministic scorer.
 */
export function createTextOnlyPatchSkillEvalExecutor(options?: {
  model?: string;
  reasoningEffort?: string;
  wallClockMs?: number;
}): SkillEvalExecutor {
  const binary = codexBinary();
  const runtimeIdentity = codexVersion(binary);
  const model = options?.model ?? DEFAULT_CODEX_MODEL;
  const reasoningEffort = options?.reasoningEffort;
  const wallClockMs = options?.wallClockMs ?? 180_000;
  return {
    id: `codex-cli-text-patch:${runtimeIdentity}${reasoningEffort ? `:reasoning=${reasoningEffort}` : ''}`,
    subject: 'codex',
    provider: 'codex',
    model,
    runtimeIdentity: `${runtimeIdentity}${reasoningEffort ? `:reasoning=${reasoningEffort}` : ''}:text-only-patch`,
    tools: ['workspace-snapshot', 'patch-apply'],
    budget: { wallClockMs },
    execute: async ({ scenario, workingDirectory, taskPrompt: task, skillContext }) => {
      if (codexSkillEvalNetworkPolicy(scenario).enabled) {
        const detail = 'Text-only patch evaluation cannot retrieve live public-web evidence';
        return {
          output: '',
          evidence: [detail],
          artifacts: [],
          durationMs: 0,
          infrastructureFailure: {
            kind: 'tool',
            retryable: false,
            detail,
            evidence: [detail],
          },
        };
      }
      return runTextOnlyPatch({
        binary,
        model,
        reasoningEffort,
        workingDirectory,
        task,
        skillContext,
        wallClockMs,
      });
    },
  };
}
