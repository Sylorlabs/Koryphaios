import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { canonicalizePath, findExecutableOnPath, isUnix } from '../../runtime/platform';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { completePairForScenario } from '../skill-eval-blind-review';
import { hasCompleteCurrentSkillPair } from '../skill-eval-campaign-resume';
import {
  OPENCODE_TEXT_PATCH_QUARANTINE_REASON,
  OPENCODE_STATELESS_QUARANTINE_REASON,
  NATIVE_STATELESS_EXCLUSION_REASON,
  selectEligibleSkillEvaluationEvidence,
  skillEvaluationExecutionExclusionReason,
} from '../skill-eval-eligibility';
import {
  CURRENT_SKILL_EVAL_CONTRACT_VERSION,
  evaluateSkillPromotion,
  listOpenSkillRegressionSources,
  listSkillEvaluationRuns,
  recordSkillEvaluationRuns,
  type SkillEvaluationRun,
} from '../skill-evaluations';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function ledger(runs: SkillEvaluationRun[]): string {
  const root = mkdtempSync(join(tmpdir(), 'kory-eligibility-'));
  roots.push(root);
  recordSkillEvaluationRuns(root, runs);
  return root;
}

const oldHarness = 'v5-campaign-2026-09-08:opencode-text-patch:opencode-text-patch:subject:runtime';
const guardHarness = `${oldHarness}:tool-event-guard-v1`;

function pair(id: string, changes: Partial<SkillEvaluationRun> = {}): SkillEvaluationRun[] {
  return (['with-skill', 'without-skill'] as const).map((variant) => ({
    id: `${id}:${variant}`,
    skill: 'quarantine-test',
    revisionHash: 'current',
    caseId: 'task-1',
    provider: 'valid-provider',
    model: 'subject',
    harnessVersion: 'valid-text-patch:runtime',
    role: 'worker',
    evaluator: 'deterministic',
    passed: true,
    quality: variant === 'with-skill' ? 1 : 0.9,
    verification: 1,
    integrityFailure: false,
    evidence: ['original observed evidence'],
    recordedAt: '2026-10-01T00:00:00Z',
    protocolVersion: 3,
    variant,
    caseCategory: 'full-task',
    comparisonId: id,
    routing: { expectedSelection: true, selected: true },
    suiteId: 'test-suite',
    scenarioId: 'task-1',
    experimentId: `${id}:${variant}`,
    evaluationContractHash: 'a'.repeat(16),
    evaluationContractVersion: CURRENT_SKILL_EVAL_CONTRACT_VERSION,
    materializerId: 'fixture@1',
    deterministicScorerId: 'scorer@1',
    ...changes,
  }));
}

function review(
  source: SkillEvaluationRun,
  changes: Partial<SkillEvaluationRun> = {},
): SkillEvaluationRun {
  return {
    ...source,
    id: `review:${source.id}`,
    evaluator: 'blind-review',
    role: 'critic',
    provider: 'independent-provider',
    harnessVersion: 'blind-review-v99',
    evaluatorProvenance: {
      evaluatorId: 'independent-reviewer',
      kind: 'model',
      provider: 'independent-provider',
      model: 'review-model',
      blindTo: ['skill-variant'],
      evidence: ['anonymous assignment'],
    },
    ...changes,
  };
}

function expected(run: SkillEvaluationRun) {
  return {
    skill: run.skill,
    revisionHash: run.revisionHash,
    scenarioId: run.scenarioId!,
    evaluationContractHash: run.evaluationContractHash!,
    evaluationContractVersion: run.evaluationContractVersion!,
    harnessVersion: run.harnessVersion,
    provider: run.provider,
    model: run.model,
  };
}

function nativeRun(variant: 'with-skill' | 'without-skill' = 'with-skill') {
  const root = mkdtempSync(join(tmpdir(), 'kory-native-eligibility-'));
  roots.push(root);
  const contract = 'a'.repeat(16);
  const binary = '/opt/homebrew/bin/claude';
  const harnessVersion = `v5-campaign-2026-09-08:native-stateless-text-patch:native-stateless-text-patch:gpt-6.1-sol:${binary}:native-cli:gpt-6.1-sol:native-cli:${binary}:v2.1.309:no-tools-text-patch-v1:text-only-patch:none:180000ms:${contract}`;
  const output = '<kory-eval-patch>[]</kory-eval-patch>';
  const sessionId = `native-session-${variant}`;
  let stream =
    [
      {
        type: 'system',
        subtype: 'init',
        session_id: sessionId,
        model: 'gpt-6.1-sol',
        tools: [],
        mcp_servers: [],
        skills: [],
      },
      {
        type: 'assistant',
        session_id: sessionId,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: output }],
          stop_reason: 'end_turn',
        },
      },
      {
        type: 'result',
        subtype: 'success',
        session_id: sessionId,
        is_error: false,
        result: output,
      },
    ]
      .map((event) => JSON.stringify(event))
      .join('\n') + '\n';
  const sha = (text: string) => createHash('sha256').update(text).digest('hex');
  const receipt = {
    kind: 'host-observed-unsigned',
    runtime: 'no-tools-text-patch-v1',
    cliVersion: '2.1.309',
    requestedModel: 'gpt-6.1-sol',
    boundary: 'native-no-tools-bare-restricted-explicit-stdin',
    boundaryBasis: 'measured-version-dependent',
    osIsolationVerified: false,
    upstreamIdentityVerified: false,
    upstreamCancellationAcknowledged: false,
    requestSerialization: 'host-declared-system-prompt-model-not-upstream-wire',
    request: { sha256: 'b'.repeat(64), bytes: 1000 },
    response: { sha256: sha(stream), bytes: Buffer.byteLength(stream), complete: true },
    exitCode: 0,
    elapsedMs: 1000,
  };
  const completion = {
    sessionId: `native-session-${variant}`,
    observedModel: 'gpt-6.1-sol',
    tools: [] as string[],
    mcpServers: [] as string[],
    skills: [] as string[],
    signed: false,
    outputSha256: sha(output),
  };
  const evidence = () => [
    `Native stateless host receipt: ${JSON.stringify(receipt)}`,
    `Native stateless completed session: ${JSON.stringify(completion)}`,
  ];
  const run = pair('native-pair', {
    variant,
    provider: 'native-cli',
    model: 'gpt-6.1-sol',
    harnessVersion,
  }).find((row) => row.variant === variant)!;
  const directory = join(root, variant);
  mkdirSync(directory);
  const outputPath = join(directory, 'final-output.txt');
  const manifestPath = join(directory, 'run-manifest.json');
  const streamPath = join(directory, 'native-text-events.jsonl');
  const refresh = () => {
    run.evidence = evidence();
    writeFileSync(outputPath, output);
    writeFileSync(streamPath, stream, { mode: 0o600 });
    const manifest = JSON.stringify({
      artifactSchemaVersion: 3,
      pairId: run.comparisonId,
      variant: run.variant,
      harnessVersion: run.harnessVersion,
      evaluationContractHash: run.evaluationContractHash,
      evaluationContractVersion: run.evaluationContractVersion,
      materializerId: run.materializerId,
      deterministicScorerId: run.deterministicScorerId,
      scenario: { id: run.scenarioId, skill: run.skill },
      score: {
        passed: run.passed,
        quality: run.quality,
        verification: run.verification,
        integrityFailure: run.integrityFailure,
      },
      infrastructureFailure: null,
      nativeTextEventArchive: {
        location: canonicalizePath(streamPath),
        sha256: sha(stream), bytes: Buffer.byteLength(stream),
        workspaceRoot: join(canonicalizePath(root), 'candidate-workspaces'),
      },
      evidence: run.evidence,
    });
    writeFileSync(manifestPath, manifest);
    run.artifacts = [
      { kind: 'report', location: outputPath, sha256: sha(output) },
      { kind: 'report', location: manifestPath, sha256: sha(manifest) },
      { kind: 'report', location: streamPath, sha256: sha(stream) },
    ];
  };
  refresh();
  const changeStream = (change: (text: string) => string) => {
    stream = change(stream);
    receipt.response.sha256 = sha(stream);
    receipt.response.bytes = Buffer.byteLength(stream);
    refresh();
  };
  return { run, receipt, completion, refresh, changeStream, outputPath, manifestPath, streamPath };
}

const mkfifoBinary = findExecutableOnPath('mkfifo');

async function replacedArchiveEligibility(
  run: SkillEvaluationRun,
  path: string,
  replacement: 'fifo' | 'symlink',
) {
  // The synchronous open under test must never be allowed to hang the test host.
  // Replace only after the real lstat in a disposable, deadline-bounded child.
  const source = `
import { mock } from 'bun:test';
import * as fs from 'node:fs';
import { spawnSync } from 'node:child_process';
const { run, path, replacement, mkfifoBinary } = JSON.parse(await Bun.stdin.text());
const originalLstat = fs.lstatSync;
let swapped = false;
mock.module('node:fs', () => ({ ...fs, lstatSync(...args) {
  const stat = originalLstat(...args);
  if (!swapped && String(args[0]) === path) {
    swapped = true;
    if (replacement === 'fifo') {
      fs.rmSync(path);
      const result = spawnSync(mkfifoBinary, [path], { timeout: 500, stdio: 'ignore' });
      if (result.error || result.status !== 0) throw new Error('FIFO setup failed');
    } else {
      fs.renameSync(path, path + '.original');
      fs.symlinkSync(path + '.original', path);
    }
    process.stdout.write('archive-replaced\\n');
  }
  return stat;
}}));
const { skillEvaluationExecutionExclusionReason } = await import(${JSON.stringify(resolve(import.meta.dir, '../skill-eval-eligibility.ts'))});
process.stdout.write(JSON.stringify({ reason: skillEvaluationExecutionExclusionReason(run) }) + '\\n');
`;
  const child = Bun.spawn([process.execPath, '-e', source], {
    cwd: dirname(path), stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
  });
  child.stdin.write(JSON.stringify({ run, path, replacement, mkfifoBinary }));
  child.stdin.end();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, 1_200);
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    return { code, stdout, stderr, timedOut };
  } finally {
    clearTimeout(timer);
    child.kill('SIGKILL');
    await child.exited;
  }
}

describe('derived native stateless receipt eligibility', () => {
  test.skipIf(!isUnix() || !mkfifoBinary).each(['streamPath', 'outputPath', 'manifestPath'] as const)(
    'rejects a FIFO swapped after lstat of %s without blocking', async (field) => {
      const f = nativeRun();
      const result = await replacedArchiveEligibility(f.run, f[field], 'fifo');
      expect(result.stdout).toContain('archive-replaced\n');
      expect(result.stderr).toBe('');
      expect(result.timedOut).toBe(false);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain(JSON.stringify({ reason: NATIVE_STATELESS_EXCLUSION_REASON }));
    },
  );
  test.skipIf(!isUnix()).each(['outputPath', 'manifestPath'] as const)(
    'rejects an inode-preserving symlink swapped after lstat of %s', async (field) => {
      const f = nativeRun();
      const result = await replacedArchiveEligibility(f.run, f[field], 'symlink');
      expect(result.stdout).toContain('archive-replaced\n');
      expect(result.stderr).toBe('');
      expect(result.timedOut).toBe(false);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain(JSON.stringify({ reason: NATIVE_STATELESS_EXCLUSION_REASON }));
    },
  );
  test('complete pinned semantic pass or failure is evidence, without granting blind-review credit', () => {
    const f = nativeRun();
    expect(skillEvaluationExecutionExclusionReason(f.run)).toBeNull();
    f.run.passed = false;
    f.run.quality = 0;
    f.refresh();
    expect(skillEvaluationExecutionExclusionReason(f.run)).toBeNull();
    expect(selectEligibleSkillEvaluationEvidence([f.run]).runs).toEqual([f.run]);
  });
  test('a mode suffix or missing receipt cannot grant eligibility', () => {
    const f = nativeRun();
    for (const changes of [
      { evidence: [] },
      { artifacts: [] },
      { provider: 'codex' },
      { model: 'other' },
      { harnessVersion: `${f.run.harnessVersion}:forged-proof` },
      { harnessVersion: f.run.harnessVersion.replace('v2.1.309', 'v2.1.310') },
      { harnessVersion: f.run.harnessVersion.replace('text-only-patch', 'multi-turn') },
    ])
      expect(skillEvaluationExecutionExclusionReason({ ...f.run, ...changes })).toBe(
        NATIVE_STATELESS_EXCLUSION_REASON,
      );
  });
  test.each([
    'cliVersion',
    'boundary',
    'upstreamIdentityVerified',
    'osIsolationVerified',
    'exitCode',
  ])('rejects forged receipt field %s', (field) => {
    const f = nativeRun();
    (f.receipt as Record<string, unknown>)[field] = 'forged';
    f.refresh();
    expect(skillEvaluationExecutionExclusionReason(f.run)).toBe(NATIVE_STATELESS_EXCLUSION_REASON);
  });
  test.each([
    'tools',
    'mcpServers',
    'skills',
    'sessionId',
    'observedModel',
    'signed',
    'outputSha256',
  ])('rejects missing/forged completion field %s', (field) => {
    const f = nativeRun();
    delete (f.completion as Record<string, unknown>)[field];
    f.refresh();
    expect(skillEvaluationExecutionExclusionReason(f.run)).toBe(NATIVE_STATELESS_EXCLUSION_REASON);
  });
  test('rejects advertised native tools, duplicate receipts and response truncation', () => {
    const f = nativeRun();
    f.completion.tools.push('Read');
    f.refresh();
    expect(skillEvaluationExecutionExclusionReason(f.run)).toBe(NATIVE_STATELESS_EXCLUSION_REASON);
    f.completion.tools = [];
    f.receipt.response.complete = false;
    f.refresh();
    expect(skillEvaluationExecutionExclusionReason(f.run)).toBe(NATIVE_STATELESS_EXCLUSION_REASON);
    f.receipt.response.complete = true;
    f.refresh();
    f.run.evidence.push(f.run.evidence[0]!);
    expect(skillEvaluationExecutionExclusionReason(f.run)).toBe(NATIVE_STATELESS_EXCLUSION_REASON);
  });
  test('archived output and manifest hashes must bind to the completed native text', () => {
    const f = nativeRun();
    writeFileSync(f.outputPath, 'tampered output');
    expect(skillEvaluationExecutionExclusionReason(f.run)).toBe(NATIVE_STATELESS_EXCLUSION_REASON);
    f.refresh();
    writeFileSync(f.manifestPath, '{}');
    expect(skillEvaluationExecutionExclusionReason(f.run)).toBe(NATIVE_STATELESS_EXCLUSION_REASON);
    f.refresh();
    f.completion.outputSha256 = 'f'.repeat(64);
    f.refresh();
    expect(skillEvaluationExecutionExclusionReason(f.run)).toBe(NATIVE_STATELESS_EXCLUSION_REASON);
  });
  test.each([
    (stream: string) => stream.split('\n').slice(1).join('\n'),
    (stream: string) => stream.replace('"tools":[]', '"tools":["Read"]'),
    (stream: string) => stream.replace('"mcp_servers":[]', '"mcp_servers":[{}]'),
    (stream: string) => stream.replace('"skills":[]', '"skills":["hidden"]'),
    (stream: string) => stream.replace('"model":"gpt-6.1-sol"', '"model":"other"'),
    (stream: string) => stream.replace('"is_error":false', '"is_error":true'),
    (stream: string) => stream.split('\n').slice(0, 2).join('\n'),
    (stream: string) => stream.replace('native-session-with-skill', 'other-session'),
    (stream: string) => stream.replace('"tools":[]', '"tools":["Read"],"tools":[]'),
  ])('matching hashes cannot repair an invalid actual init/session/completion', (change) => {
    const f = nativeRun();
    f.changeStream(change);
    expect(skillEvaluationExecutionExclusionReason(f.run)).toBe(NATIVE_STATELESS_EXCLUSION_REASON);
  });
  test.skipIf(!isUnix())('refuses exposed or symlinked raw transport archives', () => {
    const f = nativeRun();
    chmodSync(f.streamPath, 0o644);
    expect(skillEvaluationExecutionExclusionReason(f.run)).toBe(NATIVE_STATELESS_EXCLUSION_REASON);
    chmodSync(f.streamPath, 0o600);
    const bytes = readFileSync(f.streamPath);
    const target = `${f.streamPath}.target`;
    writeFileSync(target, bytes, { mode: 0o600 });
    rmSync(f.streamPath);
    symlinkSync(target, f.streamPath);
    expect(skillEvaluationExecutionExclusionReason(f.run)).toBe(NATIVE_STATELESS_EXCLUSION_REASON);
  });
  test('missing actual stream, forged response and completion-session mismatch fail closed', () => {
    const f = nativeRun();
    rmSync(f.streamPath);
    expect(skillEvaluationExecutionExclusionReason(f.run)).toBe(NATIVE_STATELESS_EXCLUSION_REASON);
    f.refresh();
    f.receipt.response.sha256 = 'd'.repeat(64);
    f.refresh();
    expect(skillEvaluationExecutionExclusionReason(f.run)).toBe(NATIVE_STATELESS_EXCLUSION_REASON);
    f.changeStream((stream) => stream);
    f.completion.sessionId = 'valid-but-unrelated';
    f.refresh();
    expect(skillEvaluationExecutionExclusionReason(f.run)).toBe(NATIVE_STATELESS_EXCLUSION_REASON);
  });
  test.each(['request', 'response', 'extra'])('rejects non-exact receipt shape %s', (field) => {
    const f = nativeRun();
    if (field === 'extra') (f.receipt as Record<string, unknown>).extra = true;
    else (f.receipt as Record<string, unknown>)[field] = [];
    f.refresh();
    expect(skillEvaluationExecutionExclusionReason(f.run)).toBe(NATIVE_STATELESS_EXCLUSION_REASON);
  });
  test('native provider cannot evade validation by removing its mode token', () => {
    const f = nativeRun();
    f.run.harnessVersion = 'forged-runtime';
    f.refresh();
    expect(skillEvaluationExecutionExclusionReason(f.run)).toBe(NATIVE_STATELESS_EXCLUSION_REASON);
  });
  test('manifest scores, contract and duplicate native receipts must match history', () => {
    const f = nativeRun();
    const mutate = (field: string, value: unknown) => {
      const manifest = JSON.parse(readFileSync(f.manifestPath, 'utf8'));
      manifest[field] = value;
      const text = JSON.stringify(manifest);
      writeFileSync(f.manifestPath, text);
      f.run.artifacts!.find((artifact) => artifact.location === f.manifestPath)!.sha256 =
        createHash('sha256').update(text).digest('hex');
    };
    for (const [field, value] of [
      ['score', null],
      ['score', { passed: !f.run.passed }],
      ['scenario', { id: 'other', skill: f.run.skill }],
      ['materializerId', 'other'],
      ['evaluationContractVersion', -1],
      ['evidence', [...f.run.evidence, f.run.evidence[0]]],
    ] as const) {
      mutate(field, value);
      expect(skillEvaluationExecutionExclusionReason(f.run)).toBe(
        NATIVE_STATELESS_EXCLUSION_REASON,
      );
      f.refresh();
    }
  });
  test('rechecks the protected raw archive manifest binding and candidate workspace exclusion', () => {
    const f = nativeRun();
    for (const overrides of [
      { location: f.outputPath },
      { sha256: 'f'.repeat(64) },
      { bytes: 1 },
      { workspaceRoot: 'relative-workspace' },
      { workspaceRoot: canonicalizePath(join(f.streamPath, '..')) },
      { extra: true },
    ]) {
      const manifest = JSON.parse(readFileSync(f.manifestPath, 'utf8'));
      Object.assign(manifest.nativeTextEventArchive, overrides);
      const text = JSON.stringify(manifest);
      writeFileSync(f.manifestPath, text);
      f.run.artifacts!.find((artifact) => artifact.location === f.manifestPath)!.sha256 =
        createHash('sha256').update(text).digest('hex');
      expect(skillEvaluationExecutionExclusionReason(f.run)).toBe(NATIVE_STATELESS_EXCLUSION_REASON);
      f.refresh();
    }
    const manifest = JSON.parse(readFileSync(f.manifestPath, 'utf8'));
    delete manifest.nativeTextEventArchive;
    const text = JSON.stringify(manifest);
    writeFileSync(f.manifestPath, text);
    f.run.artifacts!.find((artifact) => artifact.location === f.manifestPath)!.sha256 =
      createHash('sha256').update(text).digest('hex');
    expect(skillEvaluationExecutionExclusionReason(f.run)).toBe(NATIVE_STATELESS_EXCLUSION_REASON);
  });

  test('infrastructure failure excludes the native arm and linked review without changing history', () => {
    const f = nativeRun('without-skill');
    f.run.infrastructureFailure = {
      kind: 'provider',
      detail: 'details redacted',
      retryable: false,
      evidence: ['details redacted'],
    };
    const linked = review(f.run);
    const selection = selectEligibleSkillEvaluationEvidence([f.run, linked]);
    expect(selection.runs).toEqual([]);
    expect(selection.excludedEvidence).toHaveLength(2);
    expect(selection.excludedEvidence[1]!.reason).toContain(NATIVE_STATELESS_EXCLUSION_REASON);
    expect(f.run.infrastructureFailure.kind).toBe('provider');
  });
});

describe('derived OpenCode text-patch eligibility quarantine', () => {
  test('blind assignment never combines arms from different revisions or suites', () => {
    const arms = pair('reused-comparison-id');
    const withSkill = arms[0]!;
    const withoutSkill = arms[1]!;
    expect(completePairForScenario(arms, 'task-1', 'a'.repeat(16))).not.toBeNull();
    for (const mismatch of [
      { revisionHash: 'older-revision' },
      { suiteId: 'other-suite' },
      { caseId: 'other-case' },
      { caseCategory: 'regression' as const },
      { protocolVersion: 2 as const },
    ]) {
      expect(completePairForScenario([withSkill, { ...withoutSkill, ...mismatch }], 'task-1', 'a'.repeat(16)))
        .toBeNull();
    }
  });

  test('orphan blind review never promotes a quarantined execution pair', () => {
    const good = (
      ['positive', 'negative', 'ambiguous', 'adversarial', 'full-task'] as const
    ).flatMap((category) => pair(`good-${category}`, {
      caseCategory: category,
      caseId: category === 'full-task' ? 'task-1' : category,
      scenarioId: category === 'full-task' ? 'task-1' : category,
    }));
    const excluded = pair('quarantined', {
      harnessVersion: guardHarness,
      provider: 'opencode',
    });
    const root = ledger([...good, ...excluded]);
    expect(evaluateSkillPromotion(root, 'quarantine-test', 'current').status)
      .toBe('insufficient-evidence');

    for (const comparisonId of [undefined, 'fabricated-pair']) {
      const orphan = review(excluded[0]!, {
        id: `orphan-${comparisonId ?? 'missing'}`,
        comparisonId,
      });
      recordSkillEvaluationRuns(root, [orphan]);
      const gate = evaluateSkillPromotion(root, 'quarantine-test', 'current');
      expect(gate.provenancedBlindReviews).toBe(0);
      expect(gate.status).toBe('insufficient-evidence');
    }
    recordSkillEvaluationRuns(root, [review(good[0]!, { id: 'real-review' })]);
    const gate = evaluateSkillPromotion(root, 'quarantine-test', 'current');
    expect(gate.provenancedBlindReviews).toBe(1);
    expect(gate.status).toBe('ready');
  });

  test('excludes unsigned stateless execution and linked blind review without mutating the ledger', () => {
    const harnessVersion = 'v5-campaign-2026-09-08:opencode-stateless-text-patch:opencode-stateless-text-patch:openrouter/openrouter/free:opencode:openrouter/openrouter/free:stateless-generate-v1:text-only-patch:none:120000ms:0d18c327f9b2ca75';
    const runs = pair('stateless-unattested', { provider: 'opencode', harnessVersion });
    runs.push(review(runs[0]!));
    const root = ledger(runs);
    const path = join(root, '.koryphaios/skills/evaluations.json');
    const original = readFileSync(path, 'utf8');
    const gate = evaluateSkillPromotion(root, 'quarantine-test', 'current');
    expect(gate.candidateRuns).toBe(0);
    expect(gate.baselineRuns).toBe(0);
    expect(gate.provenancedBlindReviews).toBe(0);
    expect(gate.excludedEvidence).toHaveLength(3);
    expect(gate.reasons.join(' ')).toContain(OPENCODE_STATELESS_QUARANTINE_REASON);
    expect(hasCompleteCurrentSkillPair(runs, expected(runs[0]!))).toBe(false);
    expect(readFileSync(path, 'utf8')).toBe(original);
  });

  for (const harnessVersion of [oldHarness, guardHarness]) {
    test(`excludes successful execution and all review credit: ${harnessVersion}`, () => {
      const runs = pair('excluded', { provider: 'opencode', harnessVersion });
      runs.push(
        review(runs[0]!),
        review(runs[0]!, {
          id: 'human-review',
          evaluator: 'human-blind-review',
        }),
      );
      const root = ledger(runs);
      const path = join(root, '.koryphaios/skills/evaluations.json');
      const original = readFileSync(path, 'utf8');
      const gate = evaluateSkillPromotion(root, 'quarantine-test', 'current');
      expect(gate.candidateRuns).toBe(0);
      expect(gate.baselineRuns).toBe(0);
      expect(gate.categoryCoverage['full-task']).toBe(0);
      expect(gate.pairedBaselineCategoryCounts['full-task']).toBe(0);
      expect(gate.provenancedBlindReviews).toBe(0);
      expect(gate.humanBlindReviews).toBe(0);
      expect(gate.openRegressions).toBe(0);
      expect(gate.excludedEvidence).toHaveLength(4);
      expect(gate.reasons.join(' ')).toContain(OPENCODE_TEXT_PATCH_QUARANTINE_REASON);
      expect(hasCompleteCurrentSkillPair(runs, expected(runs[0]!))).toBe(false);
      expect(completePairForScenario(runs, 'task-1', 'a'.repeat(16))).toBeNull();
      expect(listSkillEvaluationRuns(root)).toEqual(runs);
      expect(readFileSync(path, 'utf8')).toBe(original);
    });
  }

  test('does not trust any guard suffix or quarantine a provider name or reviewer identity alone', () => {
    for (const suffix of ['', ':tool-event-guard-v1', ':enforced-guard-v999']) {
      expect(
        skillEvaluationExecutionExclusionReason({ harnessVersion: `${oldHarness}${suffix}` }),
      ).toBe(OPENCODE_TEXT_PATCH_QUARANTINE_REASON);
    }
    const routing = pair('routing', {
      provider: 'opencode',
      caseCategory: 'positive',
      harnessVersion: 'routing-selection-v1',
    });
    const good = pair('good');
    const opencodeReviewer = review(good[0]!, { provider: 'opencode' });
    expect(
      selectEligibleSkillEvaluationEvidence([...routing, ...good, opencodeReviewer]).runs,
    ).toEqual([...routing, ...good, opencodeReviewer]);
  });

  test('mixed good evidence stays ready; excluded newer generation/reviews do not suppress it', () => {
    const good = (
      ['positive', 'negative', 'ambiguous', 'adversarial', 'full-task'] as const
    ).flatMap((category) =>
      pair(`good-${category}`, {
        caseCategory: category,
        caseId: category === 'full-task' ? 'task-1' : category,
        scenarioId: category === 'full-task' ? 'task-1' : category,
      }),
    );
    good.push(
      review(
        good.find((run) => run.caseCategory === 'full-task')!,
        {
          harnessVersion: 'blind-review-v1',
        },
      ),
    );
    const root = ledger(good);
    const before = evaluateSkillPromotion(root, 'quarantine-test', 'current');
    expect(before.status).toBe('ready');
    const excluded = pair('excluded-newer', {
      provider: 'opencode',
      harnessVersion: guardHarness,
      materializerId: 'fixture@99',
      evaluationContractHash: 'b'.repeat(16),
      recordedAt: '2026-10-02T00:00:00Z',
    });
    recordSkillEvaluationRuns(root, [...excluded, review(excluded[0]!)]);
    const after = evaluateSkillPromotion(root, 'quarantine-test', 'current');
    const comparable: typeof before = { ...after, reasons: [], excludedEvidence: [] };
    expect(comparable).toEqual(before);
    expect(after.reasons.join(' ')).toContain('Excluded execution evidence');
    const all = [...good, ...excluded];
    expect(completePairForScenario(all, 'task-1', 'a'.repeat(16))?.withSkill.comparisonId).toBe(
      'good-full-task',
    );
    expect(hasCompleteCurrentSkillPair(all, expected(good.at(-2)!))).toBe(true);
  });

  test('review selection falls back to an eligible pair and linked reviews lose credit', () => {
    const good = pair('good');
    const excluded = pair('excluded', {
      harnessVersion: guardHarness,
      provider: 'opencode',
      recordedAt: '2026-10-02T00:00:00Z',
    });
    const oldReview = review(excluded[0]!);
    const selection = selectEligibleSkillEvaluationEvidence([...good, ...excluded, oldReview]);
    expect(
      completePairForScenario(selection.runs, 'task-1', 'a'.repeat(16))?.withSkill.comparisonId,
    ).toBe('good');
    expect(
      selection.excludedEvidence.find((item) => item.runId === oldReview.id)?.reason,
    ).toContain('Review of excluded execution pair excluded');
    // Pair IDs alone do not quarantine another skill, revision, or scenario.
    for (const changes of [
      { skill: 'other' },
      { revisionHash: 'other' },
      { scenarioId: 'other', caseId: 'other' },
    ]) {
      const unrelatedPair = pair('excluded', changes);
      const unrelated = review(unrelatedPair[0]!);
      expect(selectEligibleSkillEvaluationEvidence([...excluded, ...unrelatedPair, unrelated]).runs)
        .toEqual([...unrelatedPair, unrelated]);
    }
  });

  test('quarantined success cannot close an existing failure, including via a newer generation', () => {
    const failed = pair('failed', { revisionHash: 'old' });
    failed[0] = { ...failed[0]!, passed: false, quality: 0 };
    for (const materializerId of ['fixture@1', 'fixture@99']) {
      const excluded = pair('retest', {
        harnessVersion: guardHarness,
        provider: 'opencode',
        materializerId,
        recordedAt: '2026-10-02T00:00:00Z',
      });
      const root = ledger([...failed, ...excluded]);
      expect(evaluateSkillPromotion(root, 'quarantine-test', 'current').openRegressions).toBe(1);
      expect(
        listOpenSkillRegressionSources(root, 'quarantine-test', 'current').map((run) => run.id),
      ).toEqual([failed[0]!.id]);
    }
  });

  test('preserves quarantined failed history, rejects explicit retest credit, and accepts valid closure', () => {
    const failed = pair('failed', { harnessVersion: oldHarness, revisionHash: 'old' });
    failed[0] = { ...failed[0]!, passed: false, quality: 0 };
    const excluded = pair('explicit-retest', {
      harnessVersion: guardHarness,
      caseCategory: 'regression',
      regressionId: failed[0]!.id,
      recordedAt: '2026-10-02T00:00:00Z',
    });
    const root = ledger([...failed, ...excluded]);
    expect(evaluateSkillPromotion(root, 'quarantine-test', 'current').openRegressions).toBe(1);
    recordSkillEvaluationRuns(root, pair('valid-retest', { recordedAt: '2026-10-03T00:00:00Z' }));
    expect(evaluateSkillPromotion(root, 'quarantine-test', 'current').openRegressions).toBe(0);
    expect(listSkillEvaluationRuns(root).find((run) => run.id === failed[0]!.id)).toEqual(
      failed[0],
    );
  });

  test('does not manufacture regressions from excluded tied failed pairs', () => {
    const tied = pair('tied', { harnessVersion: oldHarness, passed: false, quality: 0.4 });
    const root = ledger(tied);
    expect(evaluateSkillPromotion(root, 'quarantine-test', 'current').openRegressions).toBe(0);
    expect(listOpenSkillRegressionSources(root, 'quarantine-test', 'current')).toEqual([]);
    expect(listSkillEvaluationRuns(root)).toEqual(tied);
  });
});
