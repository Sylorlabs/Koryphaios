import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isUnix, terminateProviderProcessGroup } from '../../runtime/platform';
import { createOpenCodeTextOnlyPatchSkillEvalExecutor } from '../../eval/skills/skill-eval-opencode';
import type { SkillEvalExperimentV3, SkillEvalScenarioV3 } from '../../eval/skills/skill-eval-harness';

const roots: string[] = [];
const environmentKeys = ['KORY_SKILL_EVAL_OPENCODE_BINARY', 'KORY_TEST_OPENCODE_MODE'] as const;
const savedEnvironment = Object.fromEntries(
  environmentKeys.map((key) => [key, process.env[key]]),
) as Record<(typeof environmentKeys)[number], string | undefined>;
const originalPath = process.env.PATH;

const scenario = (): SkillEvalScenarioV3 =>
  ({
    id: 'opencode-text-patch-test',
    skill: 'test-skill',
    category: 'full-task',
    prompt: 'Update the fixture.',
    expectedSelection: true,
    expectedSkills: [],
    forbiddenSkills: [],
    heldOut: true,
    adjacentSkills: [],
    tags: [],
    environment: { kind: 'synthetic', startingState: 'fixture', requirements: [] },
    falsifiableChecks: [],
    scorers: [],
    requiredEvidence: [],
    requiredArtifacts: [],
  }) as SkillEvalScenarioV3;

function writeOpenCodeStub(root: string, name = 'opencode-stub'): string {
  const binary = join(root, name);
  const patch =
    '<kory-eval-patch>[{"operation":"write","path":"result.txt","content":"done\\n"}]</kory-eval-patch>';
  writeFileSync(
    binary,
    [
      `#!${process.execPath}`,
      'const mode = process.env.KORY_TEST_OPENCODE_MODE;',
      "const { spawn } = require('node:child_process');",
      "const { writeFileSync } = require('node:fs');",
      'const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\\n`);',
      `const patch = ${JSON.stringify(patch)};`,
      "if (mode === 'success') {",
      "  process.stdout.write('not-json\\n');",
      "  emit({ part: { id: 'answer', type: 'text', text: 'partial', sessionID: 'session-success' } });",
      "  emit({ part: { id: 'ignored', type: 'step-start' } });",
      "  emit({ part: { id: 'tail', type: 'text', text: '\\n' } });",
      "  emit({ part: { id: 'answer', type: 'text', text: patch, sessionID: 'session-success' } });",
      "} else if (mode.startsWith('tool:')) {",
      "  const [, location, type, outcome] = mode.split(':');",
      "  const answer = { sessionID: 'session-tool', part: { id: 'answer', type: 'text', text: patch } };",
      "  if (outcome !== 'only') emit(answer);",
      "  const tool = { type, tool: 'private-tool-name', state: { input: { command: 'private-tool-argument' }, output: 'private-tool-output' } };",
      "  emit(location === 'part' ? { type: 'message.part.updated', part: tool } : tool);",
      "  if (outcome !== 'only') process.stderr.write('private-tool-stderr\\n');",
      "  if (outcome === 'patch') emit({ ...answer, part: { ...answer.part, text: patch + '\\nprivate-tool-output' } });",
      "  if (outcome === 'error') emit({ type: 'error', error: 'private-tool-error' });",
      "  if (outcome === 'nonzero') process.exit(7);",
      "  if (outcome === 'timeout') await new Promise((resolve) => setTimeout(resolve, 1000));",
      "} else if (mode === 'timeout') {",
      "  emit({ sessionID: 'session-timeout', part: { id: 'answer', type: 'text', text: patch } });",
      '  await new Promise((resolve) => setTimeout(resolve, 250));',
      "} else if (mode === 'orphan' || mode === 'group-survivor') {",
      '  const pidFile = process.env.KORY_TEST_OPENCODE_DESCENDANT_PID_FILE;',
      '  writeFileSync(`${pidFile}.leader`, String(process.pid));',
      '  const descendant = `',
      "    const { writeFileSync } = require('node:fs');",
      '    const pidFile = process.env.KORY_TEST_OPENCODE_DESCENDANT_PID_FILE;',
      "    process.on('SIGTERM', () => {});",
      '    writeFileSync(pidFile, String(process.pid));',
      '    let ticks = 0;',
      '    const heartbeat = () => writeFileSync(pidFile + ".heartbeat", String(++ticks));',
      '    heartbeat();',
      '    setInterval(heartbeat, 25);',
      '  `;',
      "  const child = spawn(process.execPath, ['-e', descendant], { detached: mode === 'orphan', stdio: mode === 'orphan' ? ['ignore', 'inherit', 'inherit'] : 'ignore' });",
      '  child.unref();',
      '  setInterval(() => {}, 1000);',
      "} else if (mode === 'structured-error' || mode === 'empty-structured-error') {",
      "  emit({ sessionID: 'session-error', part: { id: 'answer', type: 'text', text: patch } });",
      "  emit(mode === 'structured-error' ? { type: 'error', error: { name: 'ProviderError', data: { message: 'provider unavailable Bearer secret-token', apiKey: 'private-api-key' } } } : { type: 'error' });",
      "} else if (mode === 'provider-error') {",
      "  process.stderr.write('provider unavailable Bearer secret-token\\n');",
      '  process.exit(7);',
      "} else if (mode === 'missing-session') {",
      "  emit({ part: { id: 'answer', type: 'text', text: patch } });",
      "} else if (mode === 'malformed-patch') {",
      "  emit({ sessionID: 'session-malformed', part: { id: 'answer', type: 'text', text: 'not a patch' } });",
      '} else {',
      '  process.stderr.write(`unknown test mode: ${mode}\\n`);',
      '  process.exit(8);',
      '}',
      '',
    ].join('\n'),
    { mode: 0o700 },
  );
  chmodSync(binary, 0o700);
  return binary;
}

function input(root: string) {
  return {
    experiment: {} as SkillEvalExperimentV3,
    scenario: scenario(),
    workingDirectory: root,
    taskPrompt: 'Update the fixture.',
    skillContext: null,
  };
}

function executor(binary: string, mode: string, wallClockMs = 1_000) {
  process.env.KORY_SKILL_EVAL_OPENCODE_BINARY = binary;
  process.env.KORY_TEST_OPENCODE_MODE = mode;
  return createOpenCodeTextOnlyPatchSkillEvalExecutor({ model: 'stub', wallClockMs });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  for (const key of environmentKeys) {
    const value = savedEnvironment[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
});

describe('OpenCode text-patch evaluator boundary', () => {
  for (const name of ['kory-skill-eval-candidate', 'kory-blind-reviewer']) {
    test(`${name} declares deny-all permissions, including search and MCP tools`, () => {
      const agent = readFileSync(
        join(import.meta.dir, `../../../../.opencode/agents/${name}.md`),
        'utf8',
      );
      const frontmatter = agent.split('---')[1]!;
      const config = Bun.YAML.parse(frontmatter) as { permissions: unknown };
      expect(config.permissions).toEqual([{ action: '*', resource: '*', effect: 'deny' }]);
    });
  }

  test('uses the bundled agent contract expected by the host patch parser', () => {
    const agent = readFileSync(
      join(import.meta.dir, '../../../../.opencode/agents/kory-skill-eval-candidate.md'),
      'utf8',
    );

    expect(agent).toContain('<kory-eval-patch>...</kory-eval-patch>');
    expect(agent).toContain('operation "write"');
    expect(agent).not.toContain('"changes"');
  });

  test('discovers the OpenCode CLI from PATH when no binary override is set', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kory-opencode-eval-'));
    roots.push(root);
    writeOpenCodeStub(root, 'opencode');
    delete process.env.KORY_SKILL_EVAL_OPENCODE_BINARY;
    process.env.KORY_TEST_OPENCODE_MODE = 'success';
    process.env.PATH = [root, originalPath].filter(Boolean).join(':');

    const result = await createOpenCodeTextOnlyPatchSkillEvalExecutor({ model: 'stub' }).execute(
      input(root),
    );

    expect(result.taskFailure).toBeUndefined();
    expect(readFileSync(join(root, 'result.txt'), 'utf8')).toBe('done\n');
  });

  test('fails closed when an explicitly configured binary is missing', () => {
    const root = mkdtempSync(join(tmpdir(), 'kory-opencode-eval-'));
    roots.push(root);
    const missing = join(root, 'missing-opencode');
    process.env.KORY_SKILL_EVAL_OPENCODE_BINARY = missing;

    expect(() => createOpenCodeTextOnlyPatchSkillEvalExecutor({ model: 'stub' })).toThrow(
      `OpenCode text-patch executor is unavailable: binary not found at ${missing}`,
    );
  });

  test('parses noisy JSONL streams, replaces repeated parts, and applies the completed patch', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kory-opencode-eval-'));
    roots.push(root);
    const binary = writeOpenCodeStub(root);

    const candidate = executor(binary, 'success');
    expect(candidate.runtimeIdentity).toBe(
      `opencode-cli:${binary}:text-only-patch:tool-event-guard-v1`,
    );
    const result = await candidate.execute(input(root));

    expect(result.infrastructureFailure).toBeUndefined();
    expect(result.taskFailure).toBeUndefined();
    expect(readFileSync(join(root, 'result.txt'), 'utf8')).toBe('done\n');
    expect(result.output).toContain('<kory-eval-patch>');
    expect(result.evidence).toContain('OpenCode session session-success completed.');
    expect(result.evidence).toContain('Applied 1 text-patch operation(s).');
  });

  const toolEvents = ['part', 'event'].flatMap((location) =>
    ['tool', 'tool-call', 'tool_call', 'tool_use', 'tool_result', 'toolCall'].map(
      (type) => [location, type] as const,
    ),
  );

  test.each(toolEvents)(
    'rejects valid patches surrounding a %s %s event without exposing tool data',
    async (location, type) => {
      const root = mkdtempSync(join(tmpdir(), 'kory-opencode-eval-'));
      roots.push(root);
      writeFileSync(join(root, 'result.txt'), 'original\n');
      const result = await executor(
        writeOpenCodeStub(root),
        `tool:${location}:${type}:patch`,
      ).execute(input(root));

      expect(readFileSync(join(root, 'result.txt'), 'utf8')).toBe('original\n');
      expect(result.infrastructureFailure).toMatchObject({ kind: 'tool', retryable: false });
      expect(result.infrastructureFailure?.detail).toContain('text-only');
      expect(result.output).toBe('');
      expect(result.artifacts).toEqual([]);
      expect(result.taskFailure).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain('private-tool-');
      expect(result.evidence.join('\n')).not.toContain('completed');
      expect(result.evidence.join('\n')).not.toContain('Applied');
    },
  );

  test.each(toolEvents)(
    'rejects tool-only %s %s output without a session or raw diagnostics',
    async (location, type) => {
      const root = mkdtempSync(join(tmpdir(), 'kory-opencode-eval-'));
      roots.push(root);
      const result = await executor(
        writeOpenCodeStub(root),
        `tool:${location}:${type}:only`,
      ).execute(input(root));

      expect(existsSync(join(root, 'result.txt'))).toBe(false);
      expect(result.infrastructureFailure).toMatchObject({ kind: 'tool', retryable: false });
      expect(result.output).toBe('');
      expect(result.artifacts).toEqual([]);
      expect(result.taskFailure).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain('private-tool-');
    },
  );

  test.each(['error', 'nonzero', 'timeout'])(
    'retains the tool boundary failure when the process also reports %s',
    async (outcome) => {
      const root = mkdtempSync(join(tmpdir(), 'kory-opencode-eval-'));
      roots.push(root);
      const result = await executor(
        writeOpenCodeStub(root),
        `tool:part:tool:${outcome}`,
        500,
      ).execute(input(root));

      expect(existsSync(join(root, 'result.txt'))).toBe(false);
      expect(result.infrastructureFailure).toMatchObject({ kind: 'tool', retryable: false });
      expect(result.output).toBe('');
      expect(JSON.stringify(result)).not.toContain('private-tool-');
    },
  );

  test('classifies a wall-clock timeout and does not apply partial output', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kory-opencode-eval-'));
    roots.push(root);
    const binary = writeOpenCodeStub(root);

    const result = await executor(binary, 'timeout', 20).execute(input(root));

    expect(result.infrastructureFailure).toMatchObject({ kind: 'timeout', retryable: false });
    expect(existsSync(join(root, 'result.txt'))).toBe(false);
  });

  test.skipIf(!isUnix()).each(['orphan', 'group-survivor'])(
    'allows natural outer harness exit on timeout with descendant mode %s',
    async (mode) => {
      const root = mkdtempSync(join(tmpdir(), 'kory-opencode-eval-'));
      roots.push(root);
      const binary = writeOpenCodeStub(root);
      const pidFile = join(root, 'descendant.pid');
      const harness = Bun.spawn(
        [
          process.execPath,
          '--eval',
          `import { createOpenCodeTextOnlyPatchSkillEvalExecutor } from ${JSON.stringify(join(import.meta.dir, '../../eval/skills/skill-eval-opencode.ts'))};
        const result = await createOpenCodeTextOnlyPatchSkillEvalExecutor({ model: 'stub', wallClockMs: 500 }).execute(${JSON.stringify(input(root))});
        console.log(JSON.stringify(result));`,
        ],
        {
          env: {
            ...process.env,
            KORY_SKILL_EVAL_OPENCODE_BINARY: binary,
            KORY_TEST_OPENCODE_MODE: mode,
            KORY_TEST_OPENCODE_DESCENDANT_PID_FILE: pidFile,
          },
          stdin: 'ignore',
          stdout: 'pipe',
          stderr: 'pipe',
        },
      );
      const stdout = new Response(harness.stdout).text();
      const stderr = new Response(harness.stderr).text();
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        const exitCode = await Promise.race([
          harness.exited,
          new Promise<never>((_, reject) => {
            deadline = setTimeout(
              () => reject(new Error('Outer harness did not exit naturally within 6s')),
              6_000,
            );
          }),
        ]);
        expect(await stderr).toBe('');
        expect(exitCode).toBe(0);
        const result = JSON.parse(await stdout);
        expect(result.infrastructureFailure).toMatchObject({ kind: 'timeout', retryable: false });
        expect(existsSync(join(root, 'result.txt'))).toBe(false);
        // Ensure the descendant actually started, rather than passing on a startup race.
        const pid = Number(readFileSync(pidFile, 'utf8'));
        expect(pid).toBeGreaterThan(0);
        if (mode === 'orphan') {
          // It escaped the group and still holds the executor's pipes at outer exit.
          expect(() => process.kill(pid, 0)).not.toThrow();
        } else {
          // The leader closes its own pipes on TERM; its surviving group must still
          // receive force cleanup. A heartbeat also works with unreaped Unix zombies.
          await Bun.sleep(100);
          const heartbeat = readFileSync(`${pidFile}.heartbeat`, 'utf8');
          await Bun.sleep(150);
          expect(readFileSync(`${pidFile}.heartbeat`, 'utf8')).toBe(heartbeat);
        }
      } finally {
        clearTimeout(deadline);
        // Explicit PID cleanup is essential even when the natural-exit assertion fails.
        if (existsSync(pidFile)) {
          try {
            process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL');
          } catch {}
        }
        if (existsSync(`${pidFile}.leader`)) {
          terminateProviderProcessGroup(Number(readFileSync(`${pidFile}.leader`, 'utf8')));
        }
        harness.kill();
        await harness.exited;
        await Promise.all([stdout, stderr]);
      }
    },
    10_000,
  );

  test.each(['structured-error', 'empty-structured-error'])(
    'rejects a valid patch followed by %s and exit zero, with redacted details',
    async (mode) => {
      const root = mkdtempSync(join(tmpdir(), 'kory-opencode-eval-'));
      roots.push(root);
      const result = await executor(writeOpenCodeStub(root), mode).execute(input(root));

      expect(existsSync(join(root, 'result.txt'))).toBe(false);
      expect(result.infrastructureFailure).toMatchObject({ kind: 'provider', retryable: true });
      expect(result.infrastructureFailure?.detail).toContain('error');
      expect(result.taskFailure).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain('secret-token');
      expect(JSON.stringify(result)).not.toContain('private-api-key');
    },
  );

  test('reports provider process errors without applying stdout or leaking credentials', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kory-opencode-eval-'));
    roots.push(root);
    const binary = writeOpenCodeStub(root);

    const result = await executor(binary, 'provider-error').execute(input(root));

    expect(result.infrastructureFailure).toMatchObject({ kind: 'provider', retryable: true });
    expect(result.infrastructureFailure?.detail).toContain('provider unavailable');
    expect(result.infrastructureFailure?.detail).not.toContain('secret-token');
    expect(existsSync(join(root, 'result.txt'))).toBe(false);
  });

  test('rejects otherwise valid output when the provider omits a session id', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kory-opencode-eval-'));
    roots.push(root);
    const binary = writeOpenCodeStub(root);

    const result = await executor(binary, 'missing-session').execute(input(root));

    expect(result.infrastructureFailure).toMatchObject({ kind: 'provider', retryable: true });
    expect(result.infrastructureFailure?.detail).toContain('kory-eval-patch');
    expect(existsSync(join(root, 'result.txt'))).toBe(false);
  });

  test('surfaces malformed patch output as a task failure after a completed session', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kory-opencode-eval-'));
    roots.push(root);
    const binary = writeOpenCodeStub(root);

    const result = await executor(binary, 'malformed-patch').execute(input(root));

    expect(result.infrastructureFailure).toBeUndefined();
    expect(result.taskFailure).toContain('patch contract');
    expect(result.evidence).toContain('OpenCode session session-malformed completed.');
    expect(existsSync(join(root, 'result.txt'))).toBe(false);
  });
});
