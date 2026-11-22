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
} from '../../eval/skills/skill-eval-execution';

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); });
const skillPackage = loadV5SkillPackages().packages.find(item => item.sidecar.name === 'deterministic-debugging')!;
const scenario = skillPackage.evaluation.tasks[0]!;

function fixture(
  mutate: 'executor' | 'scorer' | 'replace-base' | 'fingerprint-collision' | 'infrastructure' | null,
) {
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
      if (mutate === 'infrastructure') {
        // A provider outage must not become a zero-quality candidate row.
        return {
          output: 'provider unavailable',
          evidence: ['synthetic provider outage'],
          artifacts: [],
          durationMs: 0,
          infrastructureFailure: {
            kind: 'provider' as const,
            retryable: true,
            detail: 'synthetic provider outage',
            evidence: ['synthetic provider outage'],
          },
        };
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

test('harness scratch is excluded from the workspace fingerprint while candidate files stay', () => {
  const clean = mkdtempSync(join(tmpdir(), 'fingerprint-clean-'));
  const scratchy = mkdtempSync(join(tmpdir(), 'fingerprint-scratch-'));
  for (const root of [clean, scratchy]) writeFileSync(join(root, 'Sources.swift'), 'candidate\n');
  mkdirSync(join(scratchy, '.kory-tmp/swift-cache'), { recursive: true });
  writeFileSync(join(scratchy, '.kory-tmp/swift-cache/Foundation.swiftmodule'), 'derived\n');
  // Positive control: derived scratch under .kory-tmp cannot change the fingerprint.
  expect(fingerprintSkillEvalWorkspace(scratchy)).toBe(fingerprintSkillEvalWorkspace(clean));
  // Negative control: a candidate source change still does.
  writeFileSync(join(clean, 'Sources.swift'), 'candidate changed\n');
  expect(fingerprintSkillEvalWorkspace(clean)).not.toBe(fingerprintSkillEvalWorkspace(scratchy));
});

test('an infrastructure failure is not recorded as a candidate run', async () => {
  const f = fixture('infrastructure');
  const result = await f.run();
  expect(result.withSkill.observation.infrastructureFailure?.kind).toBe('provider');
  expect(result.withoutSkill.observation.infrastructureFailure?.kind).toBe('provider');
  expect(listSkillEvaluationRuns(f.projectRoot)).toEqual([]);
});

test('a Rust build tree is excluded from the fingerprint wherever the crate sits', () => {
  const root = canonicalizePath(mkdtempSync(join(tmpdir(), 'kory-fingerprint-rust-target-')));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  // A desktop shell keeps its crate at `src-tauri`, so its build tree is nested and a name check at
  // the workspace root never saw it: one arm archived gigabytes of objects and the disk filled.
  mkdirSync(join(root, 'src-tauri', 'src'), { recursive: true });
  writeFileSync(join(root, 'src-tauri', 'Cargo.toml'), '[package]\nname = "fixture"\n');
  writeFileSync(join(root, 'src-tauri', 'src', 'main.rs'), 'fn main() {}\n');
  // A directory that merely happens to be called `target`, with no crate beside it, is ordinary
  // content: the exclusion is scoped to build output, not to the word.
  mkdirSync(join(root, 'assets', 'target'), { recursive: true });
  writeFileSync(join(root, 'assets', 'target', 'notes.txt'), 'kept\n');

  const base = fingerprintSkillEvalWorkspace(root);
  mkdirSync(join(root, 'src-tauri', 'target', 'debug', 'deps'), { recursive: true });
  writeFileSync(join(root, 'src-tauri', 'target', 'debug', 'deps', 'object.o'), 'x'.repeat(64));
  expect(fingerprintSkillEvalWorkspace(root)).toBe(base);

  writeFileSync(join(root, 'assets', 'target', 'notes.txt'), 'changed\n');
  expect(fingerprintSkillEvalWorkspace(root)).not.toBe(base);

  const afterAssetEdit = fingerprintSkillEvalWorkspace(root);
  writeFileSync(join(root, 'src-tauri', 'src', 'main.rs'), 'fn main() { println!("hi"); }\n');
  expect(fingerprintSkillEvalWorkspace(root)).not.toBe(afterAssetEdit);
});
