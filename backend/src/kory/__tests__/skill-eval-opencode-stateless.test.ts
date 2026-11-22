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
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, relative } from 'node:path';
import {
  canonicalizePath,
  isContainedBy,
  isUnix,
  terminateProviderProcessGroup,
} from '../../runtime/platform';
import {
  createOpenCodeStatelessTextPatchSkillEvalExecutor,
  MAX_SERIALIZED_REQUEST_BYTES,
} from '../../eval/skills/skill-eval-opencode-stateless';
import { snapshotSkillEvalWorkspace, textPatchPrompt } from '../../eval/skills/skill-eval-text-patch';
import type { SkillEvalExperimentV3, SkillEvalScenarioV3 } from '../../eval/skills/skill-eval-harness';
import type { SkillEvalExecutionObservation } from '../../eval/skills/skill-eval-execution';
import { createExecutor } from '../../../../scripts/skill-v5-qualification-executor';

const roots: string[] = [];
const environmentKeys = [
  'KORY_SKILL_EVAL_OPENCODE_BINARY',
  'KORY_SKILL_EVAL_OPENCODE_MODEL',
  'PATH',
  'TMPDIR',
  'TMP',
  'TEMP',
] as const;
const saved = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
const patch =
  '<kory-eval-patch>[{"operation":"write","path":"result.txt","content":"done\\n"}]</kory-eval-patch>';
const envelope = JSON.stringify({ data: { text: patch } });
const privateData = 'private-provider-payload-api-key';

interface StubOptions {
  version?: string;
  versionCode?: number;
  versionDelay?: number;
  stdout?: string;
  stderr?: string;
  code?: number;
  mode?: string;
}

function fixture(options: StubOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), 'kory-stateless-test-'));
  roots.push(root);
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  writeFileSync(join(workspace, 'TASK.md'), 'fixture-input');
  const log = join(root, 'invocations.jsonl');
  const binary = join(root, 'opencode');
  const pidFile = join(root, 'descendant.pid');
  const writeBinary = (settings: StubOptions) => {
    writeFileSync(
      binary,
      `#!${process.execPath}
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const options = ${JSON.stringify(settings)};
const args = process.argv.slice(2);
const pidFile = ${JSON.stringify(pidFile)};
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, cwd: process.cwd(), files: fs.readdirSync('.'), home: process.env.HOME }) + '\\n');
if (args.length === 1 && args[0] === '--version') {
  if (options.versionDelay) await new Promise(r => setTimeout(r, options.versionDelay));
  process.stdout.write(options.version ?? 'opencode v2.0.32\\n');
  process.exit(options.versionCode ?? 0);
}
if (args.length !== 4 || args[0] !== 'api' || args[1] !== 'experimental.generate.text' || args[2] !== '--data') process.exit(98);
const request = JSON.parse(args[3]);
if (Object.keys(request).sort().join(',') !== 'model,prompt' || typeof request.prompt !== 'string' || Object.keys(request.model).sort().join(',') !== 'id,providerID') process.exit(99);
if (options.mode === 'orphan' || options.mode === 'group-survivor') {
  fs.writeFileSync(pidFile + '.leader', String(process.pid));
  const source = \
    "const fs = require('node:fs'); const p = " + JSON.stringify(pidFile) + "; process.on('SIGTERM', () => {}); fs.writeFileSync(p, String(process.pid)); let ticks = 0; setInterval(() => fs.writeFileSync(p + '.heartbeat', String(++ticks)), 25);";
  const child = spawn(process.execPath, ['-e', source], { detached: options.mode === 'orphan', stdio: options.mode === 'orphan' ? ['ignore', 'inherit', 'inherit'] : 'ignore' });
  child.unref();
  setInterval(() => {}, 1000);
} else {
  if (options.mode === 'stdout-overflow') process.stdout.write('x'.repeat(4_100_000));
  else if (options.mode === 'invalid-utf8') process.stdout.write(Buffer.from([0xff]));
  else process.stdout.write(options.stdout ?? ${JSON.stringify(envelope)});
  process.stderr.write(options.mode === 'stderr-overflow' ? 'x'.repeat(65_000) : (options.stderr ?? ''));
  if (options.mode === 'timeout') await new Promise(r => setTimeout(r, 5000));
  process.exit(options.code ?? 0);
}
`,
      { mode: 0o700 },
    );
    chmodSync(binary, 0o700);
  };
  writeBinary(options);
  process.env.KORY_SKILL_EVAL_OPENCODE_BINARY = binary;
  delete process.env.KORY_SKILL_EVAL_OPENCODE_MODEL;
  const calls = () =>
    existsSync(log)
      ? readFileSync(log, 'utf8')
          .trim()
          .split('\n')
          .map(
            (line) =>
              JSON.parse(line) as { args: string[]; cwd: string; files: string[]; home: string },
          )
      : [];
  return { root, workspace, binary, pidFile, calls, writeBinary };
}

function input(workspace: string, kind = 'synthetic') {
  return {
    experiment: {} as SkillEvalExperimentV3,
    scenario: { id: 'stateless-test', environment: { kind } } as SkillEvalScenarioV3,
    workingDirectory: workspace,
    taskPrompt: 'Update the fixture. Literal shell text: $(touch should-not-exist) "quote"\n新',
    skillContext: 'Use the provided skill guidance.',
  };
}

function receipt(result: SkillEvalExecutionObservation) {
  const prefix = 'OpenCode stateless host receipt: ';
  return JSON.parse(result.evidence.find((item) => item.startsWith(prefix))!.slice(prefix.length));
}

function expectCleaned(f: ReturnType<typeof fixture>) {
  for (const call of f.calls()) {
    expect(isContainedBy(canonicalizePath(process.cwd()), call.cwd)).toBe(false);
    expect(isContainedBy(canonicalizePath(f.workspace), call.cwd)).toBe(false);
    expect(call.files).toEqual([]);
    expect(existsSync(call.cwd)).toBe(false);
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  for (const key of environmentKeys) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe.skipIf(!isUnix())('OpenCode stateless text-patch executor (fake CLI only)', () => {
  test('dispatches the explicit API argv from an empty disposable cwd and records exact host hashes', async () => {
    const f = fixture();
    const requestInput = input(f.workspace);
    const expectedRequest = JSON.stringify({
      prompt: textPatchPrompt(
        requestInput.taskPrompt,
        requestInput.skillContext,
        snapshotSkillEvalWorkspace(f.workspace),
      ),
      model: { providerID: 'openrouter', id: 'openrouter/free' },
    });
    const candidate = createExecutor({
      mode: 'opencode-stateless-text-patch',
      model: 'openrouter/openrouter/free',
      wallClockMs: 5_000,
    });
    expect(candidate).toMatchObject({
      subject: 'other',
      provider: 'opencode',
      model: 'openrouter/openrouter/free',
    });
    expect(candidate.id).toContain('opencode-stateless-text-patch:openrouter/openrouter/free:');
    expect(candidate.runtimeIdentity).toContain(':v2.0.32:stateless-generate-v1');
    const result = await candidate.execute(requestInput);
    expect(result.infrastructureFailure).toBeUndefined();
    expect(result.taskFailure).toBeUndefined();
    expect(result.output).toBe(patch);
    expect(readFileSync(join(f.workspace, 'result.txt'), 'utf8')).toBe('done\n');
    expect(f.calls().map((call) => call.args)).toEqual([
      ['--version'],
      ['--version'],
      ['api', 'experimental.generate.text', '--data', expectedRequest],
    ]);
    expect(f.calls().every((call) => call.home === process.env.HOME)).toBe(true);
    expect(receipt(result)).toMatchObject({
      kind: 'host-observed-unsigned',
      runtime: 'stateless-generate-v1',
      cliVersion: '2.0.32',
      requestedModel: 'openrouter/openrouter/free',
      boundary: 'no-local-tools',
      boundaryBasis: 'source-inspected-version-dependent',
      providerRoute: 'base-configured-route',
      upstreamIdentityVerified: false,
      upstreamCancellationAcknowledged: false,
      exitCode: 0,
      request: {
        sha256: createHash('sha256').update(expectedRequest).digest('hex'),
        bytes: Buffer.byteLength(expectedRequest),
      },
      response: {
        sha256: createHash('sha256').update(envelope).digest('hex'),
        bytes: Buffer.byteLength(envelope),
        complete: true,
      },
    });
    expect(receipt(result).elapsedMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(result.evidence)).not.toContain('fixture-input');
    expectCleaned(f);
  });

  test('defaults to the literal free route and resolves an executable from PATH', async () => {
    const f = fixture({ version: 'v2.0.32\n' });
    delete process.env.KORY_SKILL_EVAL_OPENCODE_BINARY;
    process.env.PATH = [f.root, saved.PATH].filter(Boolean).join(delimiter);
    const candidate = createOpenCodeStatelessTextPatchSkillEvalExecutor();
    expect(candidate.model).toBe('openrouter/openrouter/free');
    expect((await candidate.execute(input(f.workspace))).infrastructureFailure).toBeUndefined();
    expectCleaned(f);
  });

  test('rejects an oversized serialized UTF-8 argv request before generation dispatch', async () => {
    const f = fixture();
    const requestInput = {
      ...input(f.workspace),
      taskPrompt: `${'新😀"\\'.repeat(6_000)} marker`,
    };
    const expectedRequest = JSON.stringify({
      prompt: textPatchPrompt(
        requestInput.taskPrompt,
        requestInput.skillContext,
        snapshotSkillEvalWorkspace(f.workspace),
      ),
      model: { providerID: 'openrouter', id: 'openrouter/free' },
    });
    expect(Buffer.byteLength(expectedRequest, 'utf8')).toBeGreaterThan(
      MAX_SERIALIZED_REQUEST_BYTES,
    );

    const result = await createOpenCodeStatelessTextPatchSkillEvalExecutor().execute(requestInput);

    expect(result.infrastructureFailure).toMatchObject({ kind: 'setup', retryable: false });
    expect(result.infrastructureFailure?.detail).toContain(
      `${MAX_SERIALIZED_REQUEST_BYTES}-byte argv limit`,
    );
    expect(result.infrastructureFailure?.detail).toContain('generation was not dispatched');
    expect(JSON.stringify(result)).not.toContain('marker');
    expect(f.calls().map((call) => call.args)).toEqual([['--version'], ['--version']]);
    expect(existsSync(join(f.workspace, 'result.txt'))).toBe(false);
    expectCleaned(f);
  });

  test('preserves a nested literal model ID and canonicalizes relative binary paths before changing cwd', async () => {
    const f = fixture();
    process.env.KORY_SKILL_EVAL_OPENCODE_BINARY = relative(process.cwd(), f.binary);
    const model = 'openrouter/vendor/family/model:free';
    const candidate = createOpenCodeStatelessTextPatchSkillEvalExecutor({ model });
    const result = await candidate.execute(input(f.workspace));
    expect(candidate.model).toBe(model);
    expect(candidate.id).toContain(model);
    expect(JSON.parse(f.calls()[2]!.args[3]!).model).toEqual({
      providerID: 'openrouter',
      id: 'vendor/family/model:free',
    });
    expect(receipt(result).requestedModel).toBe(model);
  });

  test.each([
    '',
    'free',
    '/model',
    'provider/',
    'provider//model',
    'provider/../model',
    ' provider/model',
    'provider/model\n',
    'provider/model;touch',
    'provider/model?api_key=secret',
  ])('rejects invalid model %j before spawning', (model) => {
    const f = fixture();
    expect(() => createOpenCodeStatelessTextPatchSkillEvalExecutor({ model })).toThrow(
      'provider/model',
    );
    expect(f.calls()).toEqual([]);
  });

  test.each([0, -1, NaN, Infinity, 1.5, 2_147_483_648])(
    'rejects invalid timer budget %s',
    (wallClockMs) => {
      const f = fixture();
      expect(() => createOpenCodeStatelessTextPatchSkillEvalExecutor({ wallClockMs })).toThrow(
        'budget',
      );
      expect(f.calls()).toEqual([]);
    },
  );

  test.each(['missing', 'non-executable', 'directory', 'missing-path'])(
    'fails closed on %s binary',
    (mode) => {
      const f = fixture();
      if (mode === 'missing') process.env.KORY_SKILL_EVAL_OPENCODE_BINARY = join(f.root, 'missing');
      if (mode === 'non-executable') chmodSync(f.binary, 0o600);
      if (mode === 'directory') process.env.KORY_SKILL_EVAL_OPENCODE_BINARY = f.root;
      if (mode === 'missing-path') {
        delete process.env.KORY_SKILL_EVAL_OPENCODE_BINARY;
        process.env.PATH = f.workspace;
      }
      expect(() => createOpenCodeStatelessTextPatchSkillEvalExecutor()).toThrow(
        'executor is unavailable',
      );
      expect(f.calls()).toEqual([]);
    },
  );

  test.each(['2.0.31', '2.0.33', '2.0.32-dev', '', 'noise\n2.0.32', privateData])(
    'rejects uninspected version %j before API use',
    (version) => {
      const f = fixture({ version });
      expect(() => createOpenCodeStatelessTextPatchSkillEvalExecutor()).toThrow(
        'source-inspected CLI v2.0.32',
      );
      expect(f.calls().map((call) => call.args)).toEqual([['--version']]);
      expectCleaned(f);
    },
  );

  test('rejects a failed or timed out initial version probe', () => {
    for (const settings of [{ versionCode: 7 }, { versionDelay: 1000 }]) {
      const f = fixture(settings);
      expect(() => createOpenCodeStatelessTextPatchSkillEvalExecutor({ wallClockMs: 300 })).toThrow(
        'executor is unavailable',
      );
      expect(f.calls().every((call) => call.args[0] === '--version')).toBe(true);
      expectCleaned(f);
    }
  });

  test('revalidates version per execution and refuses upgrades after selection', async () => {
    const f = fixture();
    const candidate = createOpenCodeStatelessTextPatchSkillEvalExecutor();
    f.writeBinary({ version: `2.0.33 ${privateData}` });
    const result = await candidate.execute(input(f.workspace));
    expect(result.infrastructureFailure?.kind).toBe('setup');
    expect(f.calls().map((call) => call.args)).toEqual([['--version'], ['--version']]);
    expect(JSON.stringify(result)).not.toContain(privateData);
    expect(existsSync(join(f.workspace, 'result.txt'))).toBe(false);
    expectCleaned(f);
  });

  test('bounds and cleans an execution-time version probe timeout', async () => {
    const f = fixture();
    const candidate = createOpenCodeStatelessTextPatchSkillEvalExecutor({ wallClockMs: 300 });
    f.writeBinary({ versionDelay: 5_000 });
    const result = await candidate.execute(input(f.workspace));
    expect(result.infrastructureFailure?.kind).toBe('timeout');
    expect(f.calls().every((call) => call.args[0] === '--version')).toBe(true);
    expectCleaned(f);
  });

  test.each(['browser', 'device', 'public-web', 'unknown'])(
    'blocks %s environments before generation',
    async (kind) => {
      const f = fixture();
      const result = await createOpenCodeStatelessTextPatchSkillEvalExecutor().execute(
        input(f.workspace, kind),
      );
      expect(result.infrastructureFailure?.kind).toBe('tool');
      expect(f.calls()).toHaveLength(1);
      expect(existsSync(join(f.workspace, 'result.txt'))).toBe(false);
    },
  );

  test.each(['repository', 'cli'])('supports %s fixture environments', async (kind) => {
    const f = fixture();
    const result = await createOpenCodeStatelessTextPatchSkillEvalExecutor().execute(
      input(f.workspace, kind),
    );
    expect(result.infrastructureFailure).toBeUndefined();
    expect(result.taskFailure).toBeUndefined();
    expect(readFileSync(join(f.workspace, 'result.txt'), 'utf8')).toBe('done\n');
  });

  test('refuses a temp root inside the evaluator workspace and never starts generation', async () => {
    const f = fixture();
    const candidate = createOpenCodeStatelessTextPatchSkillEvalExecutor();
    process.env.TMPDIR = f.workspace;
    process.env.TMP = f.workspace;
    process.env.TEMP = f.workspace;
    const result = await candidate.execute(input(f.workspace));
    expect(result.infrastructureFailure?.kind).toBe('setup');
    expect(f.calls()).toHaveLength(1);
  });

  const invalidEnvelopes = [
    '',
    'null',
    '[]',
    '{}',
    '{"data":null}',
    '{"data":[]}',
    '{"data":{"text":42}}',
    '{"data":{"text":""}}',
    '{"data":{"text":"  "}}',
    `noise\n${envelope}`,
    `\uFEFF${envelope}`,
    `${envelope}\n${envelope}`,
    `${envelope}\ntrailer`,
    envelope.slice(0, -1),
    JSON.stringify({ data: { text: patch }, error: { apiKey: privateData } }),
    JSON.stringify({ data: { text: patch, error: privateData } }),
    JSON.stringify({ data: { text: patch, toolCalls: [{ arguments: privateData }] } }),
    JSON.stringify({ data: { text: patch }, tools: [] }),
    JSON.stringify({ data: { text: patch }, sessionID: privateData }),
    `{"data":{"error":"${privateData}"},"data":{"text":${JSON.stringify(patch)}}}`,
    `{"data":{"text":"${privateData}","text":${JSON.stringify(patch)}}}`,
    `{"data":{"text":${JSON.stringify(patch)},}}`,
  ];
  test.each(invalidEnvelopes.map((stdout, index) => [index, stdout] as const))(
    'rejects non-contract envelope %s before patch application without raw payloads',
    async (_index, stdout) => {
      const f = fixture({ stdout, stderr: privateData });
      writeFileSync(join(f.workspace, 'result.txt'), 'original');
      const result = await createOpenCodeStatelessTextPatchSkillEvalExecutor().execute(
        input(f.workspace),
      );
      expect(result.infrastructureFailure).toMatchObject({ kind: 'provider', retryable: false });
      expect(result.output).toBe('');
      expect(result.taskFailure).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain(privateData);
      expect(readFileSync(join(f.workspace, 'result.txt'), 'utf8')).toBe('original');
      expect(receipt(result).response.sha256).toBe(
        createHash('sha256').update(stdout).digest('hex'),
      );
      expectCleaned(f);
    },
  );

  test('accepts exactly one whitespace-formatted envelope with escaped UTF-8 text', async () => {
    const text = '<kory-eval-patch>[]</kory-eval-patch>\n新 \\ "quoted"';
    const f = fixture({ stdout: ` \n${JSON.stringify({ data: { text } }, null, 2)}\t` });
    const result = await createOpenCodeStatelessTextPatchSkillEvalExecutor().execute(
      input(f.workspace),
    );
    expect(result.infrastructureFailure).toBeUndefined();
    expect(result.taskFailure).toBeUndefined();
    expect(result.output).toBe(text);
  });

  test.each(['stdout-overflow', 'stderr-overflow', 'invalid-utf8', 'nonzero', 'timeout'])(
    'rejects %s transport even with patch text and cleans the cwd',
    async (mode) => {
      const f = fixture({ mode, code: mode === 'nonzero' ? 7 : 0, stderr: privateData });
      const result = await createOpenCodeStatelessTextPatchSkillEvalExecutor({
        wallClockMs: 500,
      }).execute(input(f.workspace));
      expect(result.infrastructureFailure?.kind).toBe(mode === 'timeout' ? 'timeout' : 'provider');
      expect(result.output).toBe('');
      expect(existsSync(join(f.workspace, 'result.txt'))).toBe(false);
      expect(JSON.stringify(result)).not.toContain(privateData);
      if (mode === 'timeout') {
        expect(receipt(result).upstreamCancellationAcknowledged).toBe(false);
        expect(result.infrastructureFailure?.detail).toContain(
          'does not certify upstream cancellation',
        );
      }
      expectCleaned(f);
    },
  );

  test.each([
    [
      'TLS issuer certificate',
      'UNABLE_TO_GET_ISSUER_CERT_LOCALLY: unable to get local issuer certificate',
      'TLS certificate verification failed',
    ],
    [
      'free usage quota',
      'Free usage limit reached. Subscribe at https://example.invalid/',
      'free usage limit reached',
    ],
  ])('categorizes %s without exposing upstream diagnostics', async (_case, message, expected) => {
    const stdout = JSON.stringify({
      _tag: 'ServiceUnavailableError',
      service: 'openrouter',
      message: `${message}; ${privateData}`,
    });
    const f = fixture({ code: 1, stdout, stderr: privateData });
    const result = await createOpenCodeStatelessTextPatchSkillEvalExecutor().execute(
      input(f.workspace),
    );
    expect(result.infrastructureFailure).toMatchObject({ kind: 'provider', retryable: false });
    expect(result.infrastructureFailure?.detail).toContain(expected);
    expect(result.output).toBe('');
    expect(JSON.stringify(result)).not.toContain(privateData);
    expect(existsSync(join(f.workspace, 'result.txt'))).toBe(false);
    expectCleaned(f);
  });

  test('keeps unknown provider errors redacted', async () => {
    const f = fixture({
      code: 1,
      stdout: JSON.stringify({
        _tag: 'ServiceUnavailableError',
        message: `Unexpected diagnostic: ${privateData}`,
      }),
    });
    const result = await createOpenCodeStatelessTextPatchSkillEvalExecutor().execute(
      input(f.workspace),
    );
    expect(result.infrastructureFailure?.detail).toBe(
      'OpenCode stateless process failed (details redacted).',
    );
    expect(JSON.stringify(result)).not.toContain(privateData);
    expectCleaned(f);
  });

  test.each([
    'not a patch',
    '<kory-eval-patch>[{"operation":"write","path":"../outside","content":"unsafe candidate output"}]</kory-eval-patch>',
  ])(
    'preserves failed candidate evidence without applying unsafe operations or echoing provider errors',
    async (text) => {
      const f = fixture({ stdout: JSON.stringify({ data: { text } }), stderr: privateData });
      const result = await createOpenCodeStatelessTextPatchSkillEvalExecutor().execute(
        input(f.workspace),
      );
      expect(result.infrastructureFailure).toBeUndefined();
      expect(result.taskFailure).toContain('patch contract');
      expect(result.output).toBe(text);
      expect(JSON.stringify(result)).not.toContain(privateData);
      expect(existsSync(join(f.root, 'outside'))).toBe(false);
      expect(existsSync(join(f.workspace, 'result.txt'))).toBe(false);
      expectCleaned(f);
    },
  );

  test.each(['orphan', 'group-survivor'])(
    'drains and permits natural harness exit after timeout with %s',
    async (mode) => {
      const f = fixture({ mode });
      const harness = Bun.spawn(
        [
          process.execPath,
          '--eval',
          `
      import { createOpenCodeStatelessTextPatchSkillEvalExecutor } from ${JSON.stringify(join(import.meta.dir, '../../eval/skills/skill-eval-opencode-stateless.ts'))};
      const result = await createOpenCodeStatelessTextPatchSkillEvalExecutor({ wallClockMs: 700 }).execute(${JSON.stringify(input(f.workspace))});
      console.log(JSON.stringify(result));
    `,
        ],
        { env: { ...process.env }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
      );
      const stdout = new Response(harness.stdout).text();
      const stderr = new Response(harness.stderr).text();
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        const exit = await Promise.race([
          harness.exited,
          new Promise<never>((_, reject) => {
            deadline = setTimeout(() => reject(new Error('Harness did not exit naturally')), 5_000);
          }),
        ]);
        expect(exit).toBe(0);
        expect(await stderr).toBe('');
        const result = JSON.parse(await stdout) as SkillEvalExecutionObservation;
        expect(result.infrastructureFailure?.kind).toBe('timeout');
        expect(result.output).toBe('');
        expect(receipt(result).response.complete).toBe(false);
        const pid = Number(readFileSync(f.pidFile, 'utf8'));
        expect(pid).toBeGreaterThan(0);
        if (mode === 'orphan') {
          // Deliberately escaped descendant: endpoint disposal must still let the
          // harness exit. Group cleanup cannot promise to kill escaped processes.
          expect(() => process.kill(pid, 0)).not.toThrow();
        } else {
          await Bun.sleep(100);
          const heartbeat = readFileSync(`${f.pidFile}.heartbeat`, 'utf8');
          await Bun.sleep(150);
          expect(readFileSync(`${f.pidFile}.heartbeat`, 'utf8')).toBe(heartbeat);
        }
        expectCleaned(f);
      } finally {
        clearTimeout(deadline);
        if (existsSync(f.pidFile)) {
          try {
            process.kill(Number(readFileSync(f.pidFile, 'utf8')), 'SIGKILL');
          } catch {}
        }
        if (existsSync(`${f.pidFile}.leader`))
          terminateProviderProcessGroup(Number(readFileSync(`${f.pidFile}.leader`, 'utf8')));
        harness.kill();
        await harness.exited;
        await Promise.all([stdout, stderr]);
      }
    },
    8_000,
  );
});
