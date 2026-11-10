import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalizePath, isContainedBy, isUnix } from '../../runtime/platform';
import {
  createNativeStatelessTextPatchSkillEvalExecutor,
  MAX_NATIVE_SERIALIZED_REQUEST_BYTES,
} from '../skill-eval-native-stateless';
import type { SkillEvalExperimentV3, SkillEvalScenarioV3 } from '../skill-eval-harness';
import {
  runPairedSkillEvaluationV3,
  type SkillEvalExecutionObservation,
} from '../skill-eval-execution';
import { loadV5SkillPackages } from '../skill-packages';
import { CURRENT_SKILL_EVAL_CONTRACT_VERSION, listSkillEvaluationRuns } from '../skill-evaluations';
import { selectEligibleSkillEvaluationEvidence } from '../skill-eval-eligibility';
import { skillEvalCampaignHarnessVersion } from '../../../../scripts/skill-v5-qualification-executor';
import { snapshotSkillEvalWorkspace, textPatchPrompt } from '../skill-eval-text-patch';
import { createExecutor } from '../../../../scripts/skill-v5-qualification-executor';

const roots: string[] = [];
const keys = [
  'KORY_SKILL_EVAL_NATIVE_BINARY',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CONFIG_DIR',
  'NODE_OPTIONS',
  'TMPDIR',
] as const;
const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
const privateData = 'private-provider-diagnostic-api-key';
const patch =
  '<kory-eval-patch>[{"operation":"write","path":"result.txt","content":"done\\n"}]</kory-eval-patch>';
function events(output = patch, changes: Record<string, unknown> = {}) {
  return (
    [
      { type: 'system', subtype: 'ui_invalidate' },
      {
        type: 'system',
        subtype: 'init',
        model: 'gpt-6.1-sol',
        session_id: 'test-session',
        tools: [],
        mcp_servers: [],
        skills: [],
        ...changes,
      },
      {
        type: 'assistant',
        session_id: 'test-session',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: output }],
          stop_reason: 'end_turn',
        },
      },
      {
        type: 'result',
        subtype: 'success',
        session_id: 'test-session',
        is_error: false,
        result: output,
      },
    ]
      .map((event) => JSON.stringify(event))
      .join('\n') + '\n'
  );
}
interface StubOptions {
  version?: string;
  mode?: string;
  stdout?: string;
  code?: number;
  versionDelay?: number;
}
function fixture(options: StubOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), 'kory-native-executor-test-'));
  roots.push(root);
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  writeFileSync(join(workspace, 'README.md'), 'PUBLIC_CONTRACT_ONLY');
  const binary = join(root, 'claude');
  const log = join(root, 'invocations.jsonl');
  const writeBinary = (settings: StubOptions) => {
    writeFileSync(
      binary,
      `#!${process.execPath}
const fs = require('node:fs');
const options = ${JSON.stringify(settings)};
const args = process.argv.slice(2);
let input = '';
for await (const chunk of process.stdin) input += chunk.toString();
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, input, cwd:process.cwd(), env:process.env, files:fs.readdirSync('.') })+'\\n');
if (args.length === 1 && args[0] === '--version') {
 if(options.versionDelay) await new Promise(r=>setTimeout(r,options.versionDelay));
 process.stdout.write(options.version ?? '2.1.309 (Claude Code)\\n'); process.exit(0);
}
if(options.mode === 'stdout-overflow') process.stdout.write('x'.repeat(4100000));
else if(options.mode === 'invalid-utf8') process.stdout.write(Buffer.from([0xff]));
else await new Promise(resolve => process.stdout.write(options.stdout ?? ${JSON.stringify(events())}, resolve));
process.stderr.write(options.mode === 'stderr-overflow' ? 'x'.repeat(65000) : ${JSON.stringify(privateData)});
if(options.mode === 'timeout') await new Promise(r=>setTimeout(r,5000));
process.exit(options.code ?? 0);
`,
      { mode: 0o700 },
    );
    chmodSync(binary, 0o700);
  };
  writeBinary(options);
  process.env.KORY_SKILL_EVAL_NATIVE_BINARY = binary;
  process.env.ANTHROPIC_API_KEY = 'test-key-only';
  process.env.ANTHROPIC_BASE_URL = 'https://example.invalid';
  process.env.ANTHROPIC_AUTH_TOKEN = 'ambient-token-must-not-leak';
  process.env.CLAUDE_CONFIG_DIR = root;
  process.env.NODE_OPTIONS = '--ambient-invalid';
  const calls = () =>
    existsSync(log)
      ? readFileSync(log, 'utf8')
          .trim()
          .split('\n')
          .map(
            (line) =>
              JSON.parse(line) as {
                args: string[];
                input: string;
                cwd: string;
                env: NodeJS.ProcessEnv;
                files: string[];
              },
          )
      : [];
  return { root, workspace, binary, writeBinary, calls };
}
function input(workspace: string, kind = 'synthetic') {
  return {
    experiment: { secret: 'HIDDEN_EVALUATOR_CANARY' } as unknown as SkillEvalExperimentV3,
    scenario: {
      id: 'native-test',
      environment: { kind },
      hiddenTests: 'HIDDEN_EVALUATOR_CANARY',
    } as unknown as SkillEvalScenarioV3,
    workingDirectory: workspace,
    taskPrompt: 'Implement public task.',
    skillContext: 'ONLY_TARGET_SKILL',
  };
}
function receipt(result: SkillEvalExecutionObservation) {
  const prefix = 'Native stateless host receipt: ';
  return JSON.parse(result.evidence.find((item) => item.startsWith(prefix))!.slice(prefix.length));
}
function expectCleaned(f: ReturnType<typeof fixture>) {
  for (const call of f.calls()) {
    expect(isContainedBy(canonicalizePath(f.workspace), call.cwd)).toBe(false);
    expect(existsSync(call.cwd)).toBe(false);
  }
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  for (const key of keys) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe.skipIf(!isUnix())('native stateless text-patch executor (fake CLI only)', () => {
  test('uses exact public inputs, native no-tools argv, fresh private state and unsigned receipts', async () => {
    const f = fixture();
    const requestInput = input(f.workspace);
    const expectedPrompt = textPatchPrompt(
      requestInput.taskPrompt,
      requestInput.skillContext,
      snapshotSkillEvalWorkspace(f.workspace),
    );
    const candidate = createExecutor({
      mode: 'native-stateless-text-patch',
      model: 'gpt-6.1-sol',
      wallClockMs: 5000,
    });
    expect(candidate.provider).toBe('native-cli');
    expect(candidate.subject).toBe('other');
    const result = await candidate.execute(requestInput);
    expect(result.infrastructureFailure).toBeUndefined();
    expect(result.taskFailure).toBeUndefined();
    expect(result.output).toBe(patch);
    expect(result.nativeTextEventStream?.equals(Buffer.from(events()))).toBe(true);
    expect(Object.keys(result)).not.toContain('nativeTextEventStream');
    expect(readFileSync(join(f.workspace, 'result.txt'), 'utf8')).toBe('done\n');
    const calls = f.calls();
    expect(calls.length).toBe(3);
    expect(calls[2]!.input).toBe(expectedPrompt);
    expect(calls[2]!.input).not.toContain('HIDDEN_EVALUATOR_CANARY');
    expect(calls[2]!.args).toEqual([
      '--bare',
      '--restricted',
      '--strict-mcp-config',
      '--disable-slash-commands',
      '--no-session-persistence',
      '--tools',
      '',
      '--system-prompt',
      expect.any(String),
      '--model',
      'gpt-6.1-sol',
      '--output-format',
      'stream-json',
      '--verbose',
      '--max-turns',
      '1',
      '--print',
    ]);
    for (const call of calls) {
      expect(call.env.HOME).toBe(call.cwd);
      expect(call.env.USERPROFILE).toBe(call.cwd);
      expect(call.env.CLAUDE_CONFIG_DIR).toBe(join(call.cwd, 'config'));
      expect(call.env.CLAUDE_CODE_TMPDIR).toBe(join(call.cwd, 'temp'));
      expect(call.env.ANTHROPIC_API_KEY).toBe('test-key-only');
      expect(call.env.ANTHROPIC_BASE_URL).toBe('https://example.invalid');
      expect(call.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
      expect(call.env.NODE_OPTIONS).toBeUndefined();
      expect(call.files.sort()).toEqual(['cache', 'config', 'data', 'state', 'temp']);
    }
    expect(calls[0]!.cwd).not.toBe(calls[1]!.cwd);
    const request = JSON.stringify({
      system: calls[2]!.args[8],
      prompt: expectedPrompt,
      model: 'gpt-6.1-sol',
    });
    expect(receipt(result)).toMatchObject({
      kind: 'host-observed-unsigned',
      cliVersion: '2.1.309',
      requestedModel: 'gpt-6.1-sol',
      osIsolationVerified: false,
      upstreamIdentityVerified: false,
      upstreamCancellationAcknowledged: false,
      exitCode: 0,
      request: {
        sha256: createHash('sha256').update(request).digest('hex'),
        bytes: Buffer.byteLength(request),
      },
      response: {
        sha256: createHash('sha256').update(events()).digest('hex'),
        bytes: Buffer.byteLength(events()),
        complete: true,
      },
    });
    expect(JSON.stringify(result)).not.toContain(privateData);
    expectCleaned(f);
  });
  test('fake completed semantic-false arms remain eligible with protected actual transport archives', async () => {
    const lines = events('not a patch').trim().split('\n');
    lines.splice(2, 0, JSON.stringify({
      type: 'assistant', session_id: 'test-session', message: {
        role: 'assistant', stop_reason: 'end_turn',
        content: [{ type: 'redacted_thinking', data: privateData }],
      },
    }));
    const actualStream = lines.join('\n') + '\n';
    const f = fixture({ stdout: actualStream });
    const original = loadV5SkillPackages().packages.find(
      (pkg) => pkg.sidecar.name === 'deterministic-debugging',
    )!;
    const task = original.evaluation.tasks[0]!;
    const skillPackage = {
      ...original,
      sourceContent: 'Short test guidance.',
      evaluation: { ...original.evaluation, tasks: [{ ...task, prompt: 'Complete test task.' }] },
    };
    const executor = createNativeStatelessTextPatchSkillEvalExecutor({ wallClockMs: 5000 });
    const evaluationContractHash = 'a'.repeat(16);
    const harnessVersion = skillEvalCampaignHarnessVersion({
      descriptor: {
        mode: 'native-stateless-text-patch',
        id: executor.id,
        provider: executor.provider,
        model: executor.model,
        runtimeIdentity: executor.runtimeIdentity,
      },
      executionMode: 'text-only-patch',
      reasoningEffort: 'none',
      wallClockMs: 5000,
      evaluationContractHash,
    });
    const result = await runPairedSkillEvaluationV3({
      projectRoot: f.root,
      skillPackage,
      scenarioId: task.id,
      skillRevisionHash: 'a'.repeat(64),
      harnessVersion,
      evaluationContractHash,
      evaluationContractVersion: CURRENT_SKILL_EVAL_CONTRACT_VERSION,
      executor,
      persist: true,
      materializers: [
        {
          id: 'test-native-materializer',
          matches: () => true,
          materialize: (destination) => {
            writeFileSync(join(destination, 'README.md'), 'Public contract.');
          },
        },
      ],
      scorers: [
        {
          id: 'must-not-score-task-failure',
          scenarioIds: [task.id],
          score: () => {
            throw new Error('Failed patch must not invoke scorer.');
          },
        },
      ],
    });
    try {
      const runs = listSkillEvaluationRuns(f.root);
      expect(runs).toHaveLength(2);
      expect(runs.every((run) => !run.passed && !run.infrastructureFailure)).toBe(true);
      expect(selectEligibleSkillEvaluationEvidence(runs).runs).toEqual(runs);
      for (const run of runs) {
        const archive = run.artifacts!.find((artifact) =>
          artifact.location.endsWith('/native-text-events.jsonl'),
        )!;
        expect(readFileSync(archive.location).equals(Buffer.from(actualStream))).toBe(true);
        expect(statSync(archive.location).mode & 0o777).toBe(0o600);
        const manifestArtifact = run.artifacts!.find((artifact) =>
          artifact.location.endsWith('/run-manifest.json'),
        )!;
        const manifestText = readFileSync(manifestArtifact.location, 'utf8');
        expect(manifestText).not.toContain(privateData);
        const manifest = JSON.parse(manifestText);
        expect(manifest.nativeTextEventArchive).toMatchObject({
          location: canonicalizePath(archive.location),
          sha256: archive.sha256, bytes: Buffer.byteLength(actualStream),
        });
        for (const arm of [result.withSkill, result.withoutSkill]) {
          expect(arm.observation.nativeTextEventStream?.equals(Buffer.from(actualStream))).toBe(true);
          expect(isContainedBy(manifest.nativeTextEventArchive.workspaceRoot, canonicalizePath(arm.workspace))).toBe(true);
          expect(isContainedBy(canonicalizePath(arm.workspace), canonicalizePath(archive.location))).toBe(false);
        }
        expect(existsSync(join(result.withSkill.workspace, 'native-text-events.jsonl'))).toBe(
          false,
        );
      }
      expect(JSON.stringify(result)).not.toContain('nativeTextEventStream');
      expect(JSON.stringify(result)).not.toContain(privateData);
    } finally {
      result.cleanup();
    }
    const durableRuns = listSkillEvaluationRuns(f.root);
    expect(selectEligibleSkillEvaluationEvidence(durableRuns).runs).toEqual(durableRuns);
    expectCleaned(f);
  });
  test('new executions receive distinct private HOME and null guidance stays absent', async () => {
    const f = fixture();
    const candidate = createNativeStatelessTextPatchSkillEvalExecutor();
    await candidate.execute({ ...input(f.workspace), skillContext: null });
    await candidate.execute({ ...input(f.workspace), skillContext: null });
    const generations = f.calls().filter((call) => call.args.includes('--print'));
    expect(generations.length).toBe(2);
    expect(generations[0]!.cwd).not.toBe(generations[1]!.cwd);
    expect(generations[0]!.input).not.toContain('ONLY_TARGET_SKILL');
    expectCleaned(f);
  });
  test('oversized serialized UTF-8 request fails before generation without truncation', async () => {
    const f = fixture();
    const candidate = createNativeStatelessTextPatchSkillEvalExecutor();
    const result = await candidate.execute({
      ...input(f.workspace),
      taskPrompt: '新'.repeat(MAX_NATIVE_SERIALIZED_REQUEST_BYTES),
    });
    expect(result.infrastructureFailure?.kind).toBe('setup');
    expect(result.infrastructureFailure?.detail).toContain('generation was not dispatched');
    expect(f.calls().length).toBe(1);
    expectCleaned(f);
  });
  test.each(['browser', 'device', 'public-web', 'unknown'])(
    'blocks %s before native dispatch',
    async (kind) => {
      const f = fixture();
      const result = await createNativeStatelessTextPatchSkillEvalExecutor().execute(
        input(f.workspace, kind),
      );
      expect(result.infrastructureFailure?.kind).toBe('tool');
      expect(f.calls().length).toBe(1);
      expectCleaned(f);
    },
  );
  test.each(['repository', 'cli'])('supports %s without native workspace access', async (kind) => {
    const f = fixture();
    const result = await createNativeStatelessTextPatchSkillEvalExecutor().execute(
      input(f.workspace, kind),
    );
    expect(result.infrastructureFailure).toBeUndefined();
    expectCleaned(f);
  });
  test('requires explicit key and measured model before any executable call', () => {
    const f = fixture();
    delete process.env.ANTHROPIC_API_KEY;
    expect(() => createNativeStatelessTextPatchSkillEvalExecutor()).toThrow('unavailable');
    expect(() => createNativeStatelessTextPatchSkillEvalExecutor({ model: 'other' })).toThrow(
      'measured model',
    );
    expect(f.calls().length).toBe(0);
  });
  test.each(['2.1.308 (Claude Code)', '2.1.310 (Claude Code)', 'noise\n2.1.309 (Claude Code)'])(
    'rejects unmeasured version %s',
    (version) => {
      const f = fixture({ version });
      expect(() => createNativeStatelessTextPatchSkillEvalExecutor()).toThrow('unavailable');
      expect(f.calls().length).toBe(1);
      expectCleaned(f);
    },
  );
  test.each([0, -1, NaN, Infinity, 2_147_483_648])(
    'rejects invalid deadline budget before spawning',
    (wallClockMs) => {
      const f = fixture();
      expect(() => createNativeStatelessTextPatchSkillEvalExecutor({ wallClockMs })).toThrow(
        'timer-safe',
      );
      expect(f.calls().length).toBe(0);
    },
  );
  test('version revalidation shares the execution deadline and never generates after timeout', async () => {
    const f = fixture();
    const candidate = createNativeStatelessTextPatchSkillEvalExecutor({ wallClockMs: 200 });
    f.writeBinary({ versionDelay: 5000 });
    const started = performance.now();
    const result = await candidate.execute(input(f.workspace));
    expect(result.infrastructureFailure?.kind).toBe('timeout');
    expect(result.infrastructureFailure?.detail).toContain('version probe');
    expect(f.calls().filter((call) => call.args.includes('--print')).length).toBe(0);
    expect(performance.now() - started).toBeLessThan(2000);
    expectCleaned(f);
  });
  test('lost explicit API key fails closed without restoring ambient token authentication', async () => {
    const f = fixture();
    const candidate = createNativeStatelessTextPatchSkillEvalExecutor();
    delete process.env.ANTHROPIC_API_KEY;
    const result = await candidate.execute(input(f.workspace));
    expect(result.infrastructureFailure?.kind).toBe('setup');
    expect(f.calls().length).toBe(1);
    expectCleaned(f);
  });
  test('refuses caller temp roots inside the evaluation workspace before generation', async () => {
    const f = fixture();
    const candidate = createNativeStatelessTextPatchSkillEvalExecutor();
    process.env.TMPDIR = f.workspace;
    const result = await candidate.execute(input(f.workspace));
    expect(result.infrastructureFailure?.kind).toBe('setup');
    expect(f.calls().length).toBe(1);
  });
  test('reprobes version per execution and refuses a changed binary', async () => {
    const f = fixture();
    const candidate = createNativeStatelessTextPatchSkillEvalExecutor();
    f.writeBinary({ version: '2.1.310 (Claude Code)' });
    const result = await candidate.execute(input(f.workspace));
    expect(result.infrastructureFailure?.kind).toBe('setup');
    expect(f.calls().length).toBe(2);
    expectCleaned(f);
  });
  test.each([
    events(patch, { tools: ['Read'] }),
    events(patch, { mcp_servers: [{}] }),
    events(patch, { skills: ['skill'] }),
    events(patch, { model: 'wrong' }),
    events(patch, { session_id: 'wrong' }),
    events().replace('"is_error":false', '"is_error":true'),
    events().replace('"type":"text"', '"type":"tool_use"'),
    events().replace('"stop_reason":"end_turn"', '"stop_reason":"max_tokens"'),
    events().replace('"subtype":"success"', '"subtype":"error_during_execution"'),
    events() + '{"type":"tool_result"}\n',
    events().split('\n').slice(0, 3).join('\n'),
    events().replace('"tools":[]', '"tools":["Read"],"tools":[]'),
  ])('rejects contaminated/incomplete event stream before patch application', async (stdout) => {
    const f = fixture({ stdout });
    const result = await createNativeStatelessTextPatchSkillEvalExecutor().execute(
      input(f.workspace),
    );
    expect(result.infrastructureFailure?.kind).toBe('provider');
    expect(result.output).toBe('');
    expect(result.nativeTextEventStream).toBeUndefined();
    expect(existsSync(join(f.workspace, 'result.txt'))).toBe(false);
    expect(JSON.stringify(result)).not.toContain(privateData);
    expectCleaned(f);
  });
  test('accepts measured thinking-only native prefix without using or publishing opaque data', async () => {
    const thinking = JSON.stringify({
      type: 'assistant',
      session_id: 'test-session',
      message: {
        role: 'assistant',
        stop_reason: 'end_turn',
        content: [{ type: 'redacted_thinking', data: privateData }],
      },
    });
    const lines = events().trim().split('\n');
    lines.splice(2, 0, thinking);
    const f = fixture({ stdout: lines.join('\n') + '\n' });
    const result = await createNativeStatelessTextPatchSkillEvalExecutor().execute(
      input(f.workspace),
    );
    expect(result.infrastructureFailure).toBeUndefined();
    expect(result.taskFailure).toBeUndefined();
    expect(result.output).toBe(patch);
    expect(JSON.stringify(result)).not.toContain(privateData);
    expect(readFileSync(join(f.workspace, 'result.txt'), 'utf8')).toBe('done\n');
    expectCleaned(f);
  });
  test.each(['tool_use', 'thinking', 'unknown'])(
    'rejects unknown or tool native prefix %s before patch application',
    async (type) => {
      const prefix = JSON.stringify({
        type: 'assistant',
        session_id: 'test-session',
        message: {
          role: 'assistant',
          stop_reason: 'end_turn',
          content: [{ type, data: privateData }],
        },
      });
      const lines = events().trim().split('\n');
      lines.splice(2, 0, prefix);
      const f = fixture({ stdout: lines.join('\n') + '\n' });
      const result = await createNativeStatelessTextPatchSkillEvalExecutor().execute(
        input(f.workspace),
      );
      expect(result.infrastructureFailure?.kind).toBe('provider');
      expect(result.output).toBe('');
      expect(JSON.stringify(result)).not.toContain(privateData);
      expect(existsSync(join(f.workspace, 'result.txt'))).toBe(false);
      expectCleaned(f);
    },
  );
  test.each(['```text\nfile data\n```', '```json [] ```'])(
    'strict JSON content may contain literal Markdown fences as file data: %s',
    async (content) => {
      const f = fixture({
        stdout: events(`<kory-eval-patch>${JSON.stringify([
          { operation: 'write', path: 'result.txt', content },
        ])}</kory-eval-patch>`),
      });
      const result = await createNativeStatelessTextPatchSkillEvalExecutor().execute(
        input(f.workspace),
      );
      expect(result.infrastructureFailure).toBeUndefined();
      expect(result.taskFailure).toBeUndefined();
      expect(readFileSync(join(f.workspace, 'result.txt'), 'utf8')).toBe(content);
      expectCleaned(f);
    },
  );
  test.each([
    'Literal </kory-eval-patch> content',
    'Literal <kory-eval-patch> and </kory-eval-patch> content',
    'Escaped "quote" and \\ before </kory-eval-patch> content',
    'Literal <kory-eval-patch>```json [] ```</kory-eval-patch> content',
  ])('strict JSON file data may contain patch tags: %s', async (content) => {
    const output = `<kory-eval-patch>${JSON.stringify([
      { operation: 'write', path: 'result.txt', content },
    ])}</kory-eval-patch>`;
    const f = fixture({ stdout: events(output) });
    const result = await createNativeStatelessTextPatchSkillEvalExecutor().execute(input(f.workspace));
    expect(result.infrastructureFailure).toBeUndefined();
    expect(result.taskFailure).toBeUndefined();
    expect(readFileSync(join(f.workspace, 'result.txt'), 'utf8')).toBe(content);
    expectCleaned(f);
  });
  test('backtick-rich file data stays within its actual patch byte budget', async () => {
    const content = '`'.repeat(340_000);
    const output = `<kory-eval-patch>${JSON.stringify([
      { operation: 'write', path: 'result.txt', content },
    ])}</kory-eval-patch>`;
    const f = fixture({ stdout: events(output) });
    const result = await createNativeStatelessTextPatchSkillEvalExecutor().execute(input(f.workspace));
    expect(result.infrastructureFailure).toBeUndefined();
    expect(result.taskFailure).toBeUndefined();
    expect(readFileSync(join(f.workspace, 'result.txt'), 'utf8')).toBe(content);
    expectCleaned(f);
  });
  test.each([
    'not a patch',
    '<kory-eval-patch>[{"operation":"write","path":"../outside","content":"unsafe"}]</kory-eval-patch>',
    '<kory-eval-patch>[{"operation":"write","path":"result.txt","content":"wrong",}]</kory-eval-patch>',
    '<kory-eval-patch>[{"operation":"write","path":"result.txt","content":"wrong","content":"done"}]</kory-eval-patch>',
    '<kory-eval-patch>[{"operation":"write","path":"result.txt","content":123}]</kory-eval-patch>',
    '<kory-eval-patch>[{"operation":"write","path":"result.txt","content":"wrong","executable":"yes"}]</kory-eval-patch>',
    '<kory-eval-patch>\\[\\]</kory-eval-patch>',
    '```json\n[]\n```',
    '<kory-eval-patch>[]</kory-eval-patch><kory-eval-patch>[]</kory-eval-patch>',
    '<kory-eval-patch>[]',
    '<kory-eval-patch>[{"operation":"write","path":"result.txt","content":"unterminated </kory-eval-patch>',
    '<kory-eval-patch><kory-eval-patch>[]</kory-eval-patch>',
    '<kory-eval-patch>[]</kory-eval-patch><kory-eval-patch>',
    '</kory-eval-patch><kory-eval-patch>[]</kory-eval-patch>',
    '<kory-eval-patch>[]</kory-eval-patch></kory-eval-patch>',
    '<kory-eval-patch>[{"operation":"write","path":"result.txt","content":"Literal </kory-eval-patch>"}]</kory-eval-patch><kory-eval-patch>[]</kory-eval-patch>',
    '<kory-eval-patch>[]</kory-eval-patch> ```json [] ```',
  ])(
    'retains validated candidate patch-contract failures without applying operations',
    async (output) => {
      const f = fixture({ stdout: events(output) });
      const result = await createNativeStatelessTextPatchSkillEvalExecutor().execute(
        input(f.workspace),
      );
      expect(result.infrastructureFailure).toBeUndefined();
      expect(result.taskFailure).toContain('strict patch contract');
      expect(result.output).toBe(output);
      expect(existsSync(join(f.workspace, 'result.txt'))).toBe(false);
      expect(existsSync(join(f.root, 'outside'))).toBe(false);
      expectCleaned(f);
    },
  );
  test.each(['stdout-overflow', 'stderr-overflow', 'invalid-utf8', 'nonzero', 'timeout'])(
    'rejects %s without leaking provider text',
    async (mode) => {
      const f = fixture({ mode, code: mode === 'nonzero' ? 1 : 0 });
      const result = await createNativeStatelessTextPatchSkillEvalExecutor({
        wallClockMs: 500,
      }).execute(input(f.workspace));
      expect(result.infrastructureFailure?.kind).toBe(mode === 'timeout' ? 'timeout' : 'provider');
      expect(result.output).toBe('');
      expect(existsSync(join(f.workspace, 'result.txt'))).toBe(false);
      expect(JSON.stringify(result)).not.toContain(privateData);
      if (mode === 'timeout') expect(receipt(result).upstreamCancellationAcknowledged).toBe(false);
      expectCleaned(f);
    },
  );
});
