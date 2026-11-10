import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { canonicalizePath } from '../../runtime/platform';
import { loadV5SkillPackages } from '../skill-packages';
import { listSkillEvaluationRuns } from '../skill-evaluations';
import {
  fingerprintSkillEvalWorkspace,
  runPairedSkillEvaluationV3,
  SKILL_EVAL_WORKSPACE_FINGERPRINT_FORMAT,
  type SkillEvalDeterministicScorer,
  type SkillEvalExecutor,
  type SkillEvalFixtureMaterializer,
} from '../skill-eval-execution';

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); });
const skillPackage = loadV5SkillPackages().packages.find(item => item.sidecar.name === 'deterministic-debugging')!;
const scenario = skillPackage.evaluation.tasks[0]!;

function fixture(mutate: 'executor' | 'scorer' | 'replace-base' | 'fingerprint-collision' | null) {
  const projectRoot = canonicalizePath(mkdtempSync(join(tmpdir(), 'kory-base-integrity-')));
  cleanups.push(() => rmSync(projectRoot, { recursive: true, force: true }));
  let executions = 0;
  let scores = 0;
  let observedBase: string | undefined;
  const materializer: SkillEvalFixtureMaterializer = {
    id: 'base-integrity-test-fixture',
    matches: candidate => candidate.id === scenario.id,
    materialize: root => {
      if (mutate === 'fingerprint-collision') {
        writeFileSync(join(root, 'a'), 'one');
        writeFileSync(join(root, 'b'), 'two');
      } else writeFileSync(join(root, 'state.txt'), 'original\n');
    },
  };
  const scorer: SkillEvalDeterministicScorer = {
    id: 'base-integrity-test-scorer',
    scenarioIds: [scenario.id],
    score: ({ workingDirectory }) => {
      scores += 1;
      if (mutate === 'scorer') writeFileSync(join(dirname(workingDirectory), 'base', 'state.txt'), 'forged baseline\n');
      return { passed: true, quality: 1, verification: 1, integrityFailure: false, evidence: ['Synthetic integrity control only'] };
    },
  };
  const executor: SkillEvalExecutor = {
    id: 'base-integrity-test-executor',
    subject: 'other',
    provider: 'synthetic',
    model: 'no-model-call',
    runtimeIdentity: 'fixture-only',
    tools: [],
    budget: { wallClockMs: 1_000 },
    execute: async ({ workingDirectory, experiment }) => {
      executions += 1;
      observedBase = join(dirname(workingDirectory), 'base');
      if (mutate === 'executor') writeFileSync(join(observedBase, 'state.txt'), 'forged baseline\n');
      if (mutate === 'fingerprint-collision') {
        writeFileSync(join(observedBase, 'a'), 'one\0b\0file\0two');
        rmSync(join(observedBase, 'b'), { force: true });
      }
      if (mutate === 'replace-base') {
        renameSync(observedBase, `${observedBase}-original`);
        mkdirSync(observedBase);
        writeFileSync(join(observedBase, 'state.txt'), 'original\n');
      }
      writeFileSync(join(workingDirectory, 'state.txt'), `${experiment.variant}\n`);
      return { output: 'Synthetic integrity control only', evidence: [], artifacts: [], durationMs: 0 };
    },
  };
  const run = () => runPairedSkillEvaluationV3({
    projectRoot,
    skillPackage,
    scenarioId: scenario.id,
    skillRevisionHash: 'a'.repeat(64),
    harnessVersion: 'base-integrity-control',
    evaluationContractHash: 'b'.repeat(16),
    evaluationContractVersion: 3,
    materializers: [materializer],
    scorers: [scorer],
    executor,
    persist: true,
  }).then(result => {
    cleanups.push(result.cleanup);
    return result;
  });
  return { projectRoot, run, executions: () => executions, scores: () => scores, base: () => observedBase };
}

test('workspace fingerprints distinguish binary content from a different file-tree structure', () => {
  const root = canonicalizePath(mkdtempSync(join(tmpdir(), 'kory-fingerprint-framing-')));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'a'), 'one');
  writeFileSync(join(root, 'b'), 'two');
  const before = fingerprintSkillEvalWorkspace(root);
  writeFileSync(join(root, 'a'), 'one\0b\0file\0two');
  rmSync(join(root, 'b'));
  expect(fingerprintSkillEvalWorkspace(root)).not.toBe(before);
});

for (const phase of ['executor', 'scorer', 'replace-base', 'fingerprint-collision'] as const) {
  test(`refuses ${phase} mutation of the original base before recording or dispatching the other arm`, async () => {
    const f = fixture(phase);
    await expect(f.run()).rejects.toThrow('base workspace changed');
    expect(f.executions()).toBe(1);
    expect(f.scores()).toBe(phase === 'scorer' ? 1 : 0);
    expect(listSkillEvaluationRuns(f.projectRoot)).toEqual([]);
    expect(existsSync(join(f.projectRoot, '.koryphaios', 'skills', 'eval-artifacts'))).toBe(false);
    expect(existsSync(f.base()!)).toBe(false);
  });
}

test('candidate-only edits retain the captured original fingerprint and exact before-file evidence in both manifests', async () => {
  const f = fixture(null);
  const result = await f.run();
  expect(f.executions()).toBe(2);
  expect(f.scores()).toBe(2);
  expect(readFileSync(join(f.base()!, 'state.txt'), 'utf8')).toBe('original\n');
  const rows = listSkillEvaluationRuns(f.projectRoot);
  expect(rows).toHaveLength(2);
  for (const row of rows) {
    const artifact = row.artifacts?.find(item => item.location.endsWith('run-manifest.json'));
    expect(artifact).toBeDefined();
    const manifest = JSON.parse(readFileSync(artifact!.location, 'utf8'));
    expect(manifest.workspaceFingerprintFormat).toBe(SKILL_EVAL_WORKSPACE_FINGERPRINT_FORMAT);
    expect(manifest.initialFingerprint).toBe(result.initialFingerprint);
    expect(manifest.changes).toEqual([expect.objectContaining({ path: 'state.txt', change: 'modified' })]);
    expect(readFileSync(join(dirname(artifact!.location), 'before-files', 'state.txt'), 'utf8')).toBe('original\n');
  }
});
