import { describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isUnix } from '../../runtime/platform';
import {
  classifyCodexInfrastructureFailure,
  codexSkillEvalNetworkPolicy,
  createIsolatedCodexSkillEvalExecutor,
  createTextOnlyPatchSkillEvalExecutor,
} from '../../eval/skills/skill-eval-codex';
import type { SkillEvalExperimentV3, SkillEvalScenarioV3 } from '../../eval/skills/skill-eval-harness';

describe('Codex evaluator infrastructure boundary', () => {
  const classify = (stderr: string, overrides: Record<string, unknown> = {}) =>
    classifyCodexInfrastructureFailure({
      stderr,
      output: '',
      exitCode: 1,
      timedOut: false,
      ...overrides,
    });

  test.each([
    [
      'ERROR: error sending request for url: dns error: failed to lookup address information',
      'provider',
    ],
    [
      '2026-09-15T10:00:00Z WARN codex_core::responses_retry: stream disconnected before completion; retry limit exhausted',
      'provider',
    ],
    ['ERROR: Failed to download remote plugin catalog: connection unavailable', 'setup'],
    ['ERROR: MCP client for fixture startup timed out', 'tool'],
    // Recorded verbatim on 2026-11-03 from two data-pipeline-engineering arms that were
    // persisted as candidate task failures even though no model turn completed. The
    // manager could not reach its route, so the empty output is a host fault.
    [
      '2026-11-03T20:27:44.433490Z ERROR codex_models_manager::manager: failed to refresh available models: Connection failed: error sending request',
      'provider',
    ],
  ])('classifies concrete host failure: %s', (detail, kind) => {
    expect(classify(detail)).toMatchObject({ kind, evidence: [detail] });
    expect(classify(detail, { timedOut: true, exitCode: null })?.kind).toBe(kind);
  });

  test('a model budget timeout or candidate failure is not an infrastructure waiver', () => {
    for (const detail of [
      'model exceeded 120000ms',
      'ERROR: task exceeded wall-clock budget',
      'ERROR: assertion failed',
      'DNS lookup failed in the application test',
      'ERROR: request handler returned 500',
      'ERROR: the connection failed test expectation',
    ]) {
      expect(classify(detail, { timedOut: true, exitCode: null })).toBeUndefined();
    }
  });

  test('recovered startup warnings and completed candidate output do not suppress scoring', () => {
    const warning =
      '2026-09-15T10:00:00Z WARN codex_core::responses_retry: stream disconnected before completion';
    expect(classify(warning, { exitCode: 0 })).toBeUndefined();
    expect(
      classify(warning, { output: '<kory-eval-patch>[]</kory-eval-patch>', timedOut: true }),
    ).toBeUndefined();
    expect(
      classify(`${warning}\nERROR: candidate task exceeded wall-clock budget`, { timedOut: true }),
    ).toBeUndefined();
  });

  test('does not scan a candidate response or echoed fixture for infrastructure phrases', () => {
    expect(classify('A test should reject DNS lookup failure.')).toBeUndefined();
    expect(classify('', { output: 'ERROR: MCP startup timed out' })).toBeUndefined();
  });

  test('an invocation the CLI itself rejects is a setup fault, not a candidate outcome', () => {
    // Recorded verbatim from a run whose model does not accept the requested effort.
    const rejected =
      `ERROR: {"type":"error","error":{"message":"Unsupported value: 'none' is not supported with the 'gpt-6.1-sol' model. Supported values are: 'low', 'medium', 'high'."}}`;
    expect(classify(rejected, { exitCode: 1 })).toMatchObject({ kind: 'setup' });
    expect(classify("ERROR: unknown model 'gpt-9' selected", { exitCode: 1 })).toMatchObject({
      kind: 'setup',
    });
    // A model's own refusal of a candidate request is still a candidate outcome.
    expect(classify("ERROR: model refused the request as unsafe", { exitCode: 1 })).toBeUndefined();
    expect(classify('ERROR: Unsupported value in the candidate fixture parser', {
      output: 'candidate output',
      exitCode: 1,
    })).toBeUndefined();
  });

  test('provider quota failures remain nonretryable and carry concrete evidence', () => {
    expect(classify("ERROR: You've hit your usage limit for gpt-reserve")).toMatchObject({
      kind: 'provider',
      retryable: false,
    });
  });
});

describe('Codex V5 research network boundary', () => {
  const scenario = (kind: SkillEvalScenarioV3['environment']['kind']): SkillEvalScenarioV3 =>
    ({ environment: { kind, startingState: 'fixture', requirements: [] } }) as SkillEvalScenarioV3;

  test('only public-web tasks receive HTTPS retrieval guidance and a network grant', () => {
    const research = codexSkillEvalNetworkPolicy(scenario('public-web'));
    expect(research.enabled).toBe(true);
    expect(research.sandboxConfig).toBe('sandbox_workspace_write.network_access=true');
    expect(research.instruction).toContain('real HTTPS requests');
    expect(research.instruction).toContain('unverified');

    for (const kind of ['repository', 'browser', 'synthetic', 'cli', 'device'] as const) {
      const local = codexSkillEvalNetworkPolicy(scenario(kind));
      expect(local.enabled).toBe(false);
      expect(local.sandboxConfig).toBe('sandbox_workspace_write.network_access=false');
      expect(local.instruction).toContain('Do not use network access');
    }
  });

  test('both native arms inherit the same scenario-scoped CLI sandbox and prompt', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kory-eval-network-boundary-'));
    const sourceHome = join(root, 'source-home');
    const capture = join(root, 'capture.json');
    const binary = join(root, 'codex-stub');
    const saved = Object.fromEntries(
      ['KORY_SKILL_EVAL_CODEX_BINARY', 'KORY_SKILL_EVAL_SOURCE_CODEX_HOME', 'KORY_SKILL_EVAL_TEST_CAPTURE']
        .map((key) => [key, process.env[key]]),
    );
    try {
      mkdirSync(sourceHome);
      writeFileSync(join(sourceHome, 'auth.json'), '{}');
      writeFileSync(binary, `#!/usr/bin/env bun
import { writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log('codex-stub 1.0');
  process.exit(0);
}
const prompt = await Bun.stdin.text();
writeFileSync(process.env.KORY_SKILL_EVAL_TEST_CAPTURE, JSON.stringify({ args, prompt,
  home: process.env.HOME, bunCache: process.env.BUN_INSTALL_CACHE_DIR }));
const outputPath = args[args.indexOf('--output-last-message') + 1];
writeFileSync(outputPath, 'stub completed');
`);
      chmodSync(binary, 0o700);
      process.env.KORY_SKILL_EVAL_CODEX_BINARY = binary;
      process.env.KORY_SKILL_EVAL_SOURCE_CODEX_HOME = sourceHome;
      process.env.KORY_SKILL_EVAL_TEST_CAPTURE = capture;
      const executor = createIsolatedCodexSkillEvalExecutor({ model: 'stub', wallClockMs: 5_000 });
      expect(executor.toolsForScenario?.(scenario('public-web'))).toEqual([
        'filesystem', 'shell', 'public-https',
      ]);
      expect(executor.toolsForScenario?.(scenario('repository'))).toEqual([
        'filesystem', 'shell',
      ]);

      for (const kind of ['public-web', 'repository'] as const) {
        for (const skillContext of [null, 'Use the provided portable skill.']) {
          const result = await executor.execute({
            experiment: {} as SkillEvalExperimentV3,
            scenario: scenario(kind),
            workingDirectory: root,
            taskPrompt: 'Complete the fixture.',
            skillContext,
          });
          expect(result.infrastructureFailure).toBeUndefined();
          expect(result.output).toBe('stub completed');
          const captured = JSON.parse(readFileSync(capture, 'utf8')) as {
            args: string[];
            prompt: string;
            home: string;
            bunCache?: string;
          };
          expect(captured.home).not.toBe(process.env.HOME);
          if (existsSync(join(process.env.HOME ?? '', '.bun', 'install', 'cache'))) {
            expect(captured.bunCache).toBe(join(process.env.HOME ?? '', '.bun', 'install', 'cache'));
          }
          expect(captured.args).toContain('--sandbox');
          expect(captured.args[captured.args.indexOf('--sandbox') + 1]).toBe('workspace-write');
          expect(captured.args).toContain(
            `sandbox_workspace_write.network_access=${kind === 'public-web' ? 'true' : 'false'}`,
          );
          expect(captured.args).toContain('mcp_servers={}');
          expect(captured.prompt).toContain('Complete the fixture.');
          expect(captured.prompt).toContain(
            kind === 'public-web' ? 'Use real HTTPS requests' : 'Do not use network access',
          );
        }
      }

      const patchExecutor = createTextOnlyPatchSkillEvalExecutor({ model: 'stub' });
      const unavailable = await patchExecutor.execute({
        experiment: {} as SkillEvalExperimentV3,
        scenario: scenario('public-web'),
        workingDirectory: root,
        taskPrompt: 'Read official sources live.',
        skillContext: null,
      });
      expect(unavailable.infrastructureFailure).toMatchObject({
        kind: 'tool',
        retryable: false,
      });
      expect(unavailable.evidence).toContain(
        'Text-only patch evaluation cannot retrieve live public-web evidence',
      );
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  test.skipIf(!isUnix())('a detached descendant holding stdio cannot keep a timed-out evaluation pending', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kory-eval-orphan-pipe-'));
    const sourceHome = join(root, 'source-home');
    const orphanPidFile = join(root, 'orphan.pid');
    const binary = join(root, 'codex-stub');
    const saved = Object.fromEntries(
      ['KORY_SKILL_EVAL_CODEX_BINARY', 'KORY_SKILL_EVAL_SOURCE_CODEX_HOME', 'KORY_SKILL_EVAL_TEST_ORPHAN_PID']
        .map((key) => [key, process.env[key]]),
    );
    try {
      mkdirSync(sourceHome);
      writeFileSync(join(sourceHome, 'auth.json'), '{}');
      writeFileSync(binary, `#!/usr/bin/env bun
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
if (process.argv[2] === '--version') process.exit(0);
const args = process.argv.slice(2);
const outputPath = args[args.indexOf('--output-last-message') + 1];
const orphan = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {
  detached: true, stdio: ['ignore', 'inherit', 'inherit'],
});
writeFileSync(process.env.KORY_SKILL_EVAL_TEST_ORPHAN_PID, String(orphan.pid));
writeFileSync(outputPath, 'completed output with an inherited pipe');
orphan.unref();
`);
      chmodSync(binary, 0o700);
      process.env.KORY_SKILL_EVAL_CODEX_BINARY = binary;
      process.env.KORY_SKILL_EVAL_SOURCE_CODEX_HOME = sourceHome;
      process.env.KORY_SKILL_EVAL_TEST_ORPHAN_PID = orphanPidFile;
      const executor = createIsolatedCodexSkillEvalExecutor({ model: 'stub', wallClockMs: 300 });
      const started = Date.now();
      const result = await executor.execute({
        experiment: {} as SkillEvalExperimentV3,
        scenario: scenario('repository'),
        workingDirectory: root,
        taskPrompt: 'Exercise the inherited pipe timeout.',
        skillContext: null,
      });
      expect(Date.now() - started).toBeLessThan(8_000);
      expect(result.output).toBe('completed output with an inherited pipe');
      expect(result.taskFailure).toContain('Model exceeded 300ms task budget');
      expect(result.infrastructureFailure).toBeUndefined();
    } finally {
      if (existsSync(orphanPidFile)) {
        const orphanPid = Number(readFileSync(orphanPidFile, 'utf8'));
        if (Number.isSafeInteger(orphanPid) && orphanPid > 100) {
          try { process.kill(-orphanPid, 'SIGKILL'); } catch { /* The orphan already exited. */ }
        }
      }
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
});
