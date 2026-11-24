import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import {
  appendFileSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { canonicalizePath, directoryLinkType, findExecutableOnPath } from '../../runtime/platform';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadV5SkillPackages } from '../skill-packages';
import {
  auditSkillEvalExecutionReadiness,
  captureSkillEvalPublicContractSnapshot,
  fingerprintSkillEvalWorkspace,
  runPairedSkillEvaluationV3,
  type SkillEvalDeterministicScorer,
  type SkillEvalFixtureMaterializer,
} from '../../eval/skills/skill-eval-execution';
import {
  BUILTIN_SKILL_EVAL_MATERIALIZERS,
  BUILTIN_SKILL_EVAL_SCORERS,
} from '../../eval/skills/skill-eval-fixtures';
import { listSkillEvaluationRuns } from '../skill-evaluations';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

describe('public contract capture reader', () => {
  const unavailable = {
    available: false,
    sha256: null,
    byteLength: 0,
    text: null,
    reason: 'not-present',
  };
  function fixture() {
    const root = canonicalizePath(mkdtempSync(join(tmpdir(), 'kory-public-capture-')));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    return { root, path: join(root, 'README.md') };
  }

  for (const mutation of ['replacement', 'symlink', 'growth'] as const)
    test(`refuses ${mutation} after the initial pathname stat`, () => {
      const { root, path } = fixture();
      writeFileSync(path, 'original');
      const target = join(root, 'outside-canary');
      writeFileSync(target, 'replacement must not become public evidence');
      const original = fs.lstatSync;
      let changed = false;
      const stat = spyOn(fs, 'lstatSync').mockImplementation(((
        ...args: Parameters<typeof fs.lstatSync>
      ) => {
        const result = original(...args);
        if (args[0] === path && !changed) {
          changed = true;
          if (mutation === 'growth') appendFileSync(path, 'concurrent-growth');
          else {
            rmSync(path);
            if (mutation === 'symlink') symlinkSync(target, path);
            else writeFileSync(path, 'replacement must not become public evidence');
          }
        }
        return result;
      }) as typeof fs.lstatSync);
      try {
        const snapshot = captureSkillEvalPublicContractSnapshot(root, 'task');
        expect(changed).toBe(true);
        expect(snapshot.fixtureFiles['README.md']).toEqual(unavailable);
      } finally {
        stat.mockRestore();
      }
    });

  test('keeps exact UTF-8 bytes, raw hashes, empty files, and frozen before-execution evidence', () => {
    const { root, path } = fixture();
    const text = '﻿Résumé λ\r\nsource $x^2$\n';
    const prompt = 'Task λ\r\n';
    const bytes = Buffer.from(text);
    writeFileSync(path, bytes);
    writeFileSync(join(root, 'contract.json'), Buffer.alloc(0));
    const snapshot = captureSkillEvalPublicContractSnapshot(root, prompt);
    expect(snapshot.fixtureFiles['README.md']).toEqual({
      available: true,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      byteLength: bytes.length,
      text,
    });
    expect(snapshot.fixtureFiles['contract.json']).toEqual({
      available: true,
      sha256: createHash('sha256').update(Buffer.alloc(0)).digest('hex'),
      byteLength: 0,
      text: '',
    });
    expect(snapshot.taskPrompt).toEqual({
      available: true,
      sha256: createHash('sha256').update(Buffer.from(prompt)).digest('hex'),
      byteLength: Buffer.byteLength(prompt),
      text: prompt,
    });
    for (const value of [
      snapshot,
      snapshot.taskPrompt,
      snapshot.fixtureFiles,
      ...Object.values(snapshot.fixtureFiles),
    ]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
    writeFileSync(path, 'later candidate mutation');
    expect(snapshot.fixtureFiles['README.md'].text).toBe(text);
  });

  for (const kind of ['missing', 'directory', 'symlink', 'invalid-utf8', 'oversized'] as const)
    test(`marks ${kind} unavailable without truncating or inventing content`, () => {
      const { root, path } = fixture();
      if (kind === 'directory') mkdirSync(path);
      else if (kind === 'symlink') {
        const target = join(root, 'outside-canary');
        writeFileSync(target, 'not public evidence');
        symlinkSync(target, path);
      } else if (kind === 'invalid-utf8') writeFileSync(path, Buffer.from([0xff, 0xfe]));
      else if (kind === 'oversized') {
        writeFileSync(path, 'small');
        truncateSync(path, 67_108_865); // Sparse fixture: exceeds the 64 MiB contract by one byte.
      }
      expect(
        captureSkillEvalPublicContractSnapshot(root, 'task').fixtureFiles['README.md'],
      ).toEqual(unavailable);
    });

  for (const mutation of ['grow', 'truncate', 'replace-path'] as const)
    test(`rejects concurrent ${mutation} during a bounded descriptor read`, () => {
      const { root, path } = fixture();
      writeFileSync(path, 'original');
      const original = fs.readSync;
      const lengths: number[] = [];
      let changed = false;
      const read = spyOn(fs, 'readSync').mockImplementation(
        (
          fd: number,
          buffer: NodeJS.ArrayBufferView,
          offsetOrOptions?: number | fs.ReadOptions,
          length?: number,
          position?: fs.ReadPosition | null,
        ) => {
          if (typeof offsetOrOptions === 'number') lengths.push(length!);
          if (!changed) {
            changed = true;
            if (mutation === 'grow') appendFileSync(path, Buffer.alloc(100_000, 32));
            else if (mutation === 'truncate') truncateSync(path, 3);
            else {
              rmSync(path);
              writeFileSync(path, 'original');
            }
          }
          return typeof offsetOrOptions === 'number'
            ? original(fd, buffer, offsetOrOptions, length!, position ?? null)
            : original(fd, buffer, offsetOrOptions);
        },
      );
      try {
        expect(
          captureSkillEvalPublicContractSnapshot(root, 'task').fixtureFiles['README.md'],
        ).toEqual(unavailable);
        expect(changed).toBe(true);
        expect(lengths[0]).toBe(9);
        expect(Math.max(...lengths)).toBeLessThanOrEqual(9);
      } finally {
        read.mockRestore();
      }
    });

  const mkfifo = findExecutableOnPath('mkfifo');
  (mkfifo ? test : test.skip)(
    'refuses a real FIFO replacement before open without blocking',
    () => {
      const { root, path } = fixture();
      writeFileSync(path, 'original');
      const original = fs.openSync;
      let flags = 0;
      let changed = false;
      let created = false;
      const open = spyOn(fs, 'openSync').mockImplementation(
        (...args: Parameters<typeof fs.openSync>) => {
          if (args[0] === path && !changed) {
            changed = true;
            flags = args[1] as number;
            // Guard before opening so this regression cannot hang on an unsafe reader;
            // assertions stay outside capture's catch so a swallowed error cannot pass.
            if (!(flags & constants.O_NONBLOCK) || !(flags & constants.O_NOFOLLOW))
              throw new Error('Unsafe FIFO open');
            rmSync(path);
            const result = spawnSync(mkfifo!, [path], { timeout: 1000, stdio: 'ignore' });
            created = result.status === 0;
          }
          return original(...args);
        },
      );
      try {
        expect(
          captureSkillEvalPublicContractSnapshot(root, 'task').fixtureFiles['README.md'],
        ).toEqual(unavailable);
        expect(changed).toBe(true);
        expect(created).toBe(true);
        expect(flags & constants.O_NONBLOCK).toBe(constants.O_NONBLOCK);
        expect(flags & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW);
      } finally {
        open.mockRestore();
      }
    },
  );
});

describe('V5 skill evaluation execution', () => {
  const skillPackage = loadV5SkillPackages().packages.find(
    (item) => item.sidecar.name === 'deterministic-debugging',
  )!;
  const scenario = skillPackage.evaluation.tasks[0]!;
  const materializer: SkillEvalFixtureMaterializer = {
    id: 'test-fixture',
    matches: (candidate) => candidate.id === scenario.id,
    materialize: (destination) => {
      writeFileSync(join(destination, 'state.txt'), 'broken\n');
    },
  };
  const scorer: SkillEvalDeterministicScorer = {
    id: 'test-scorer',
    scenarioIds: [scenario.id],
    score: ({ workingDirectory }) => ({
      passed: true,
      quality: 1,
      verification: 1,
      integrityFailure: false,
      evidence: [fingerprintSkillEvalWorkspace(workingDirectory)],
    }),
  };

  test('rejects an unverified regression link before dispatch', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'kory-regression-link-control-'));
    cleanups.push(() => rmSync(projectRoot, { recursive: true, force: true }));
    let calls = 0;
    await expect(
      runPairedSkillEvaluationV3({
        projectRoot,
        skillPackage,
        scenarioId: scenario.id,
        skillRevisionHash: 'a'.repeat(64),
        harnessVersion: 'regression-link-control',
        regressionId: 'unobserved-failure',
        materializers: [materializer],
        scorers: [scorer],
        executor: {
          id: 'should-not-dispatch',
          subject: 'other',
          provider: 'synthetic',
          model: 'control',
          runtimeIdentity: 'test',
          tools: [],
          budget: { wallClockMs: 1000 },
          execute: async () => {
            calls++;
            return { output: '', evidence: [], artifacts: [], durationMs: 0 };
          },
        },
        persist: true,
      }),
    ).rejects.toThrow('regression source is not open for this task');
    expect(calls).toBe(0);
    expect(listSkillEvaluationRuns(projectRoot)).toHaveLength(0);
  });

  test('fails readiness closed when fixtures or deterministic scorers are not registered', () => {
    const unready = auditSkillEvalExecutionReadiness([skillPackage], [], []);
    expect(unready.every((item) => !item.ready)).toBe(true);
    expect(unready[0]!.reasons).toEqual(
      expect.arrayContaining([
        expect.stringContaining('no materializer'),
        'no registered deterministic scorer',
      ]),
    );
  });

  test('a registered runtime with missing prerequisites wins dispatch but cannot execute', async () => {
    const calls: string[] = [];
    const blocker = 'Required test runtime is unavailable';
    const runtimeMaterializer: SkillEvalFixtureMaterializer = {
      ...materializer,
      id: 'registered-runtime-test-fixture',
      realRuntime: true,
      readinessBlockers: [blocker],
      materialize: () => {
        calls.push('materialize');
      },
    };
    // Even an executable fallback and a passing scorer cannot turn a missing
    // runtime into readiness or silently redirect the evaluation.
    const materializers = [runtimeMaterializer, materializer];
    const row = auditSkillEvalExecutionReadiness([skillPackage], materializers, [scorer]).find(
      (item) => item.scenarioId === scenario.id,
    )!;
    expect(row).toMatchObject({
      materializerId: runtimeMaterializer.id,
      deterministicScorerId: scorer.id,
      ready: false,
      reasons: [blocker],
    });
    await expect(
      runPairedSkillEvaluationV3({
        projectRoot: process.cwd(),
        skillPackage,
        scenarioId: scenario.id,
        skillRevisionHash: 'a'.repeat(64),
        harnessVersion: 'missing-runtime-gate-test',
        materializers,
        scorers: [
          {
            ...scorer,
            score: (context) => {
              calls.push('score');
              return scorer.score(context);
            },
          },
        ],
        executor: {
          id: 'must-not-run',
          subject: 'other',
          provider: 'synthetic',
          model: 'no-op',
          runtimeIdentity: 'test',
          tools: [],
          budget: { wallClockMs: 1_000 },
          execute: async () => {
            calls.push('execute');
            return { output: '', evidence: [], artifacts: [], durationMs: 0 };
          },
        },
      }),
    ).rejects.toThrow(blocker);
    expect(calls).toEqual([]);
  });

  test('model budget exhaustion is a failed task even if workspace checks could pass', async () => {
    const result = await runPairedSkillEvaluationV3({
      projectRoot: process.cwd(),
      skillPackage,
      scenarioId: scenario.id,
      skillRevisionHash: 'a'.repeat(64),
      harnessVersion: 'test-model-budget',
      materializers: [materializer],
      scorers: [scorer],
      executor: {
        id: 'test-timeout',
        subject: 'other',
        provider: 'synthetic',
        model: 'timeout-control',
        runtimeIdentity: 'test',
        tools: [],
        budget: { wallClockMs: 1_000 },
        execute: async () => ({
          output: '',
          evidence: ['Task budget exhausted'],
          artifacts: [],
          durationMs: 1_000,
          taskFailure: 'Task budget exhausted',
        }),
      },
    });
    cleanups.push(result.cleanup);
    expect(result.withSkill.observation.infrastructureFailure).toBeUndefined();
    expect(result.withSkill.score).toMatchObject({
      passed: false,
      quality: 0,
      verification: 0,
      integrityFailure: false,
    });
    expect(result.withoutSkill.score?.passed).toBe(false);
  });

  test('runs same-snapshot skill and no-skill arms while changing only the skill context', async () => {
    const observations: Array<{
      prompt: string;
      skillContext: string | null;
      before: string;
    }> = [];
    const result = await runPairedSkillEvaluationV3({
      projectRoot: process.cwd(),
      skillPackage,
      scenarioId: scenario.id,
      skillRevisionHash: 'a'.repeat(64),
      harnessVersion: 'test-v3',
      materializers: [materializer],
      scorers: [scorer],
      executor: {
        id: 'synthetic-executor',
        subject: 'kory',
        provider: 'synthetic',
        model: 'deterministic-test',
        runtimeIdentity: 'bun-test',
        tools: ['filesystem'],
        budget: { wallClockMs: 1_000 },
        execute: async ({ taskPrompt, skillContext, workingDirectory }) => {
          observations.push({
            prompt: taskPrompt,
            skillContext,
            before: fingerprintSkillEvalWorkspace(workingDirectory),
          });
          writeFileSync(
            join(workingDirectory, 'result.txt'),
            skillContext ? 'with\n' : 'without\n',
          );
          return { output: 'done', evidence: ['synthetic run'], artifacts: [], durationMs: 1 };
        },
      },
    });
    cleanups.push(result.cleanup);

    expect(observations).toHaveLength(2);
    expect(observations[0]!.prompt).toBe(observations[1]!.prompt);
    expect(observations[0]!.before).toBe(result.initialFingerprint);
    expect(observations[1]!.before).toBe(result.initialFingerprint);
    expect(observations[0]!.skillContext).toContain('deterministic-debugging');
    expect(observations[1]!.skillContext).toBeNull();
    expect(result.withSkill.score?.passed).toBe(true);
    expect(result.withoutSkill.score?.passed).toBe(true);
  });

  test('freezes the candidate-visible public contract before either arm can mutate it', async () => {
    const artifactProjectRoot = mkdtempSync(join(tmpdir(), 'kory-public-contract-artifacts-'));
    cleanups.push(() => rmSync(artifactProjectRoot, { recursive: true, force: true }));
    const publicMaterializer: SkillEvalFixtureMaterializer = {
      id: 'public-contract-test-fixture',
      matches: (candidate) => candidate.id === scenario.id,
      materialize: (destination) => {
        writeFileSync(join(destination, 'README.md'), 'original README\n');
        writeFileSync(join(destination, 'contract.json'), '{"version":1}\n');
      },
    };
    const result = await runPairedSkillEvaluationV3({
      projectRoot: artifactProjectRoot,
      skillPackage,
      scenarioId: scenario.id,
      skillRevisionHash: 'a'.repeat(64),
      harnessVersion: 'public-contract-snapshot-test',
      evaluationContractHash: 'b'.repeat(16),
      evaluationContractVersion: 1,
      materializers: [publicMaterializer],
      scorers: [scorer],
      executor: {
        id: 'mutating-executor',
        subject: 'other',
        provider: 'synthetic',
        model: 'deterministic-test',
        runtimeIdentity: 'bun-test',
        tools: ['filesystem'],
        budget: { wallClockMs: 1_000 },
        execute: async ({ workingDirectory }) => {
          writeFileSync(join(workingDirectory, 'README.md'), 'candidate replacement\n');
          writeFileSync(join(workingDirectory, 'contract.json'), '{"version":2}\n');
          return { output: 'done', evidence: [], artifacts: [], durationMs: 1 };
        },
      },
      persist: true,
    });
    cleanups.push(result.cleanup);

    expect(Object.isFrozen(result.publicContractSnapshot)).toBe(true);
    expect(result.publicContractSnapshot.capturedBeforeExecution).toBe(true);
    expect(result.publicContractSnapshot.taskPrompt.text).toBe(scenario.prompt);
    expect(result.publicContractSnapshot.fixtureFiles['README.md'].text).toBe('original README\n');
    expect(result.publicContractSnapshot.fixtureFiles['contract.json'].text).toBe(
      '{"version":1}\n',
    );
    expect(result.publicContractSnapshot.fixtureFiles['README.md'].sha256).toHaveLength(64);
    expect(result.publicContractSnapshot.fixtureFiles['contract.json'].sha256).toHaveLength(64);

    const persistedRuns = listSkillEvaluationRuns(artifactProjectRoot);
    expect(persistedRuns).toHaveLength(2);
    const manifestArtifact = persistedRuns[0]!.artifacts!.find((artifact) =>
      artifact.location.endsWith('run-manifest.json'),
    )!;
    const manifest = JSON.parse(readFileSync(manifestArtifact.location, 'utf8')) as {
      publicContractSnapshot: typeof result.publicContractSnapshot;
    };
    expect(manifest.publicContractSnapshot.taskPrompt.text).toBe(scenario.prompt);
    expect(
      readFileSync(join(manifestArtifact.location, '..', 'public-contract', 'README.md'), 'utf8'),
    ).toBe('original README\n');
    expect(
      readFileSync(
        join(manifestArtifact.location, '..', 'public-contract', 'contract.json'),
        'utf8',
      ),
    ).toBe('{"version":1}\n');
  });

  test('refuses a raw native archive redirected into either candidate workspace', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'kory-native-archive-boundary-'));
    cleanups.push(() => rmSync(projectRoot, { recursive: true, force: true }));
    const artifactsParent = join(projectRoot, '.koryphaios', 'skills');
    mkdirSync(artifactsParent, { recursive: true });
    let archivePath = '';
    await expect(
      runPairedSkillEvaluationV3({
        projectRoot,
        skillPackage,
        scenarioId: scenario.id,
        skillRevisionHash: 'a'.repeat(64),
        harnessVersion: 'native-archive-boundary-test',
        evaluationContractHash: 'a'.repeat(16),
        evaluationContractVersion: 1,
        pairId: 'native-archive-boundary',
        materializers: [materializer],
        scorers: [scorer],
        persist: true,
        executor: {
          id: 'native-archive-boundary',
          subject: 'other',
          provider: 'native-cli',
          model: 'gpt-6.1-sol',
          runtimeIdentity: 'test',
          tools: [],
          budget: { wallClockMs: 1_000 },
          execute: async ({ workingDirectory }) => {
            const candidateRoot = join(workingDirectory, '..', 'without-skill');
            symlinkSync(
              candidateRoot,
              join(artifactsParent, 'eval-artifacts'),
              directoryLinkType(),
            );
            archivePath = join(
              candidateRoot,
              'native-archive-boundary',
              'with-skill',
              'native-text-events.jsonl',
            );
            const observation = { output: 'done', evidence: [], artifacts: [], durationMs: 1 };
            Object.defineProperty(observation, 'nativeTextEventStream', {
              value: Buffer.from('private raw native stream'),
            });
            return observation;
          },
        },
      }).then((result) => {
        cleanups.push(result.cleanup);
        return result;
      }),
    ).rejects.toThrow('Native text event archive must be outside the evaluation workspace');
    expect(archivePath).not.toBe('');
    expect(existsSync(archivePath)).toBe(false);
    expect(listSkillEvaluationRuns(projectRoot)).toEqual([]);
  });

  test('materializes the deterministic-debugging pilot and proves the starting revision fails hidden checks', async () => {
    const readiness = auditSkillEvalExecutionReadiness(
      [skillPackage],
      BUILTIN_SKILL_EVAL_MATERIALIZERS,
      BUILTIN_SKILL_EVAL_SCORERS,
    );
    expect(readiness).toHaveLength(2);
    expect(readiness.every((item) => item.ready)).toBe(true);

    const result = await runPairedSkillEvaluationV3({
      projectRoot: process.cwd(),
      skillPackage,
      scenarioId: scenario.id,
      skillRevisionHash: 'b'.repeat(64),
      harnessVersion: 'fixture-self-test-v3',
      materializers: BUILTIN_SKILL_EVAL_MATERIALIZERS,
      scorers: BUILTIN_SKILL_EVAL_SCORERS,
      executor: {
        id: 'no-op-executor',
        subject: 'other',
        provider: 'synthetic',
        model: 'no-op',
        runtimeIdentity: 'fixture-self-test',
        tools: ['filesystem'],
        budget: { wallClockMs: 1_000 },
        execute: async () => ({
          output: 'unchanged',
          evidence: ['fixture intentionally left unchanged'],
          artifacts: [],
          durationMs: 1,
        }),
      },
    });
    cleanups.push(result.cleanup);
    expect(result.withSkill.score?.passed).toBe(false);
    expect(result.withoutSkill.score?.passed).toBe(false);
  });

  test('keeps every representative six-domain pilot executable and red before model intervention', async () => {
    const pilotSkills = new Set([
      'agentic-systems',
      'application-security',
      'backend-engineering',
      'data-analysis',
      'deterministic-debugging',
      'interaction-design',
    ]);
    const packages = loadV5SkillPackages().packages.filter((item) =>
      pilotSkills.has(item.sidecar.name),
    );
    expect(packages).toHaveLength(6);

    const readiness = auditSkillEvalExecutionReadiness(
      packages,
      BUILTIN_SKILL_EVAL_MATERIALIZERS,
      BUILTIN_SKILL_EVAL_SCORERS,
    );
    expect(readiness).toHaveLength(12);
    expect(readiness.every((item) => item.ready)).toBe(true);

    for (const candidate of packages) {
      for (const task of candidate.evaluation.tasks) {
        const result = await runPairedSkillEvaluationV3({
          projectRoot: process.cwd(),
          skillPackage: candidate,
          scenarioId: task.id,
          skillRevisionHash: 'c'.repeat(64),
          harnessVersion: 'pilot-fixture-self-test-v3',
          materializers: BUILTIN_SKILL_EVAL_MATERIALIZERS,
          scorers: BUILTIN_SKILL_EVAL_SCORERS,
          executor: {
            id: 'pilot-no-op-executor',
            subject: 'other',
            provider: 'synthetic',
            model: 'no-op',
            runtimeIdentity: 'fixture-self-test',
            tools: ['filesystem'],
            budget: { wallClockMs: 1_000 },
            execute: async () => ({
              output: 'unchanged',
              evidence: ['fixture intentionally left unchanged'],
              artifacts: [],
              durationMs: 1,
            }),
          },
        });
        cleanups.push(result.cleanup);
        expect(
          result.withSkill.score?.passed,
          `${candidate.sidecar.name}/${task.id} should start red`,
        ).toBe(false);
        expect(
          result.withoutSkill.score?.passed,
          `${candidate.sidecar.name}/${task.id} baseline should start red`,
        ).toBe(false);
      }
    }
  });

  test('keeps the task-routing expansion executable and red before model intervention', async () => {
    const routingPackage = loadV5SkillPackages().packages.find(
      (item) => item.sidecar.name === 'task-routing',
    )!;
    const readiness = auditSkillEvalExecutionReadiness(
      [routingPackage],
      BUILTIN_SKILL_EVAL_MATERIALIZERS,
      BUILTIN_SKILL_EVAL_SCORERS,
    );
    expect(readiness).toHaveLength(2);
    expect(readiness.every((item) => item.ready)).toBe(true);

    for (const task of routingPackage.evaluation.tasks) {
      const result = await runPairedSkillEvaluationV3({
        projectRoot: process.cwd(),
        skillPackage: routingPackage,
        scenarioId: task.id,
        skillRevisionHash: 'd'.repeat(64),
        harnessVersion: 'routing-fixture-self-test-v3',
        materializers: BUILTIN_SKILL_EVAL_MATERIALIZERS,
        scorers: BUILTIN_SKILL_EVAL_SCORERS,
        executor: {
          id: 'routing-no-op-executor',
          subject: 'other',
          provider: 'synthetic',
          model: 'no-op',
          runtimeIdentity: 'fixture-self-test',
          tools: ['filesystem'],
          budget: { wallClockMs: 1_000 },
          execute: async () => ({
            output: 'unchanged',
            evidence: ['fixture intentionally left unchanged'],
            artifacts: [],
            durationMs: 1,
          }),
        },
      });
      cleanups.push(result.cleanup);
      expect(result.withSkill.score?.passed, `${task.id} should start red`).toBe(false);
      expect(result.withoutSkill.score?.passed, `${task.id} baseline should start red`).toBe(false);
    }
  });

  test('keeps repository discovery fixtures executable and red before model intervention', async () => {
    const discoveryPackage = loadV5SkillPackages().packages.find(
      (item) => item.sidecar.name === 'repository-environment-discovery',
    )!;
    const readiness = auditSkillEvalExecutionReadiness(
      [discoveryPackage],
      BUILTIN_SKILL_EVAL_MATERIALIZERS,
      BUILTIN_SKILL_EVAL_SCORERS,
    );
    expect(readiness).toHaveLength(2);
    expect(readiness.every((item) => item.ready)).toBe(true);

    for (const task of discoveryPackage.evaluation.tasks) {
      const result = await runPairedSkillEvaluationV3({
        projectRoot: process.cwd(),
        skillPackage: discoveryPackage,
        scenarioId: task.id,
        skillRevisionHash: 'e'.repeat(64),
        harnessVersion: 'repository-discovery-fixture-self-test-v3',
        materializers: BUILTIN_SKILL_EVAL_MATERIALIZERS,
        scorers: BUILTIN_SKILL_EVAL_SCORERS,
        executor: {
          id: 'repository-discovery-no-op-executor',
          subject: 'other',
          provider: 'synthetic',
          model: 'no-op',
          runtimeIdentity: 'fixture-self-test',
          tools: ['filesystem'],
          budget: { wallClockMs: 1_000 },
          execute: async () => ({
            output: 'unchanged',
            evidence: ['fixture intentionally left unchanged'],
            artifacts: [],
            durationMs: 1,
          }),
        },
      });
      cleanups.push(result.cleanup);
      expect(result.withSkill.score?.passed, `${task.id} should start red`).toBe(false);
      expect(result.withoutSkill.score?.passed, `${task.id} baseline should start red`).toBe(false);
    }
  });

  test('keeps Plan-mode fixtures executable and red before model intervention', async () => {
    const planModePackage = loadV5SkillPackages().packages.find(
      (item) => item.sidecar.name === 'plan-mode',
    )!;
    const readiness = auditSkillEvalExecutionReadiness(
      [planModePackage],
      BUILTIN_SKILL_EVAL_MATERIALIZERS,
      BUILTIN_SKILL_EVAL_SCORERS,
    );
    expect(readiness).toHaveLength(2);
    expect(readiness.every((item) => item.ready)).toBe(true);

    for (const task of planModePackage.evaluation.tasks) {
      const result = await runPairedSkillEvaluationV3({
        projectRoot: process.cwd(),
        skillPackage: planModePackage,
        scenarioId: task.id,
        skillRevisionHash: 'f'.repeat(64),
        harnessVersion: 'plan-mode-fixture-self-test-v3',
        materializers: BUILTIN_SKILL_EVAL_MATERIALIZERS,
        scorers: BUILTIN_SKILL_EVAL_SCORERS,
        executor: {
          id: 'plan-mode-no-op-executor',
          subject: 'other',
          provider: 'synthetic',
          model: 'no-op',
          runtimeIdentity: 'fixture-self-test',
          tools: ['filesystem'],
          budget: { wallClockMs: 1_000 },
          execute: async () => ({
            output: 'unchanged',
            evidence: ['fixture intentionally left unchanged'],
            artifacts: [],
            durationMs: 1,
          }),
        },
      });
      cleanups.push(result.cleanup);
      expect(result.withSkill.score?.passed, `${task.id} should start red`).toBe(false);
      expect(result.withoutSkill.score?.passed, `${task.id} baseline should start red`).toBe(false);
    }
  });

  test('keeps webhook integration fixtures executable and red before model intervention', async () => {
    const webhookPackage = loadV5SkillPackages().packages.find(
      (item) => item.sidecar.name === 'webhook-integration',
    )!;
    const readiness = auditSkillEvalExecutionReadiness(
      [webhookPackage],
      BUILTIN_SKILL_EVAL_MATERIALIZERS,
      BUILTIN_SKILL_EVAL_SCORERS,
    );
    expect(readiness).toHaveLength(2);
    expect(readiness.every((item) => item.ready)).toBe(true);

    for (const task of webhookPackage.evaluation.tasks) {
      const result = await runPairedSkillEvaluationV3({
        projectRoot: process.cwd(),
        skillPackage: webhookPackage,
        scenarioId: task.id,
        skillRevisionHash: 'a'.repeat(64),
        harnessVersion: 'webhook-fixture-self-test-v3',
        materializers: BUILTIN_SKILL_EVAL_MATERIALIZERS,
        scorers: BUILTIN_SKILL_EVAL_SCORERS,
        executor: {
          id: 'webhook-no-op-executor',
          subject: 'other',
          provider: 'synthetic',
          model: 'no-op',
          runtimeIdentity: 'fixture-self-test',
          tools: ['filesystem'],
          budget: { wallClockMs: 1_000 },
          execute: async () => ({
            output: 'unchanged',
            evidence: ['fixture intentionally left unchanged'],
            artifacts: [],
            durationMs: 1,
          }),
        },
      });
      cleanups.push(result.cleanup);
      expect(result.withSkill.score?.passed, `${task.id} should start red`).toBe(false);
      expect(result.withoutSkill.score?.passed, `${task.id} baseline should start red`).toBe(false);
    }
  });

  test('keeps API contract design fixtures executable and red before model intervention', async () => {
    const apiPackage = loadV5SkillPackages().packages.find(
      (item) => item.sidecar.name === 'api-contract-design',
    )!;
    const readiness = auditSkillEvalExecutionReadiness(
      [apiPackage],
      BUILTIN_SKILL_EVAL_MATERIALIZERS,
      BUILTIN_SKILL_EVAL_SCORERS,
    );
    expect(readiness).toHaveLength(2);
    expect(readiness.every((item) => item.ready)).toBe(true);

    for (const task of apiPackage.evaluation.tasks) {
      const result = await runPairedSkillEvaluationV3({
        projectRoot: process.cwd(),
        skillPackage: apiPackage,
        scenarioId: task.id,
        skillRevisionHash: 'b'.repeat(64),
        harnessVersion: 'api-contract-fixture-self-test-v3',
        materializers: BUILTIN_SKILL_EVAL_MATERIALIZERS,
        scorers: BUILTIN_SKILL_EVAL_SCORERS,
        executor: {
          id: 'api-contract-no-op-executor',
          subject: 'other',
          provider: 'synthetic',
          model: 'no-op',
          runtimeIdentity: 'fixture-self-test',
          tools: ['filesystem'],
          budget: { wallClockMs: 1_000 },
          execute: async () => ({
            output: 'unchanged',
            evidence: ['fixture intentionally left unchanged'],
            artifacts: [],
            durationMs: 1,
          }),
        },
      });
      cleanups.push(result.cleanup);
      expect(result.withSkill.score?.passed, `${task.id} should start red`).toBe(false);
      expect(result.withoutSkill.score?.passed, `${task.id} baseline should start red`).toBe(false);
    }
  });

  test('keeps every executable V5 full-task fixture red before model intervention', async () => {
    const packages = loadV5SkillPackages().packages;
    const readiness = auditSkillEvalExecutionReadiness(
      packages,
      BUILTIN_SKILL_EVAL_MATERIALIZERS,
      BUILTIN_SKILL_EVAL_SCORERS,
    );
    const readyScenarioIds = new Set(
      readiness.filter((item) => item.ready).map((item) => item.scenarioId),
    );
    // Real-runtime fixtures drive bounded child processes and real browser sessions. They assert
    // red-then-green in their own dedicated suites; sweeping them here would accumulate
    // process/browser spawn churn inside one test process. Keep the exclusion auditable.
    const realRuntimeMaterializerIds = new Set(
      BUILTIN_SKILL_EVAL_MATERIALIZERS.filter((item) => item.realRuntime).map((item) => item.id),
    );
    const registeredRealRuntimeScenarioIds = readiness
      .filter(
        (item) =>
          item.materializerId !== null && realRuntimeMaterializerIds.has(item.materializerId),
      )
      .map((item) => item.scenarioId)
      .sort();
    const expectedRealRuntimeScenarioIds = [
      'android-compose-full-task-1-individual',
      'android-compose-full-task-2-individual',
      'angular-engineering-full-task-1-individual',
      'angular-engineering-full-task-2-individual',
      'audio-production-full-task-1-individual',
      'computer-use-full-task-authorized-export',
      'computer-use-full-task-revocation-race',
      'audio-production-full-task-2-individual',
      'embedded-firmware-full-task-1-individual',
      'embedded-firmware-full-task-2-individual',
      'csharp-dotnet-engineering-full-task-1-individual',
      'csharp-dotnet-engineering-full-task-2-individual',
      'desktop-electron-tauri-full-task-1-individual',
      'desktop-electron-tauri-full-task-2-individual',
      'frontend-engineering-full-task-confirmed-native',
      'factual-research-full-task-1-individual',
      'factual-research-full-task-2-individual',
      'hardware-runtime-debugging-full-task-1',
      'hardware-runtime-debugging-full-task-2',
      'go-engineering-full-task-1-individual',
      'go-engineering-full-task-2-individual',
      'image-generation-practice-full-task-1-individual',
      'image-generation-practice-full-task-2-individual',
      'integration-fault-testing-full-task-1',
      'integration-fault-testing-full-task-2',
      'ios-swiftui-full-task-1-individual',
      'ios-swiftui-full-task-2-individual',
      'kotlin-engineering-full-task-1-individual',
      'kotlin-engineering-full-task-2-individual',
      'literature-research-full-task-1-individual',
      'literature-research-full-task-2-individual',
      'market-competitive-research-full-task-1-individual',
      'market-competitive-research-full-task-2-individual',
      'native-interface-full-task-desktop-operations',
      'mongodb-engineering-full-task-1-individual',
      'mongodb-engineering-full-task-2-individual',
      'mysql-engineering-full-task-1-individual',
      'mysql-engineering-full-task-2-individual',
      'nextjs-engineering-full-task-1-individual',
      'nextjs-engineering-full-task-2-individual',
      'novel-ui-toolkit-full-task-1-individual',
      'novel-ui-toolkit-full-task-2-individual',
      'performance-debugging-full-task-1',
      'performance-debugging-full-task-2',
      'performance-testing-full-task-1',
      'php-engineering-full-task-1-individual',
      'php-engineering-full-task-2-individual',
      'postgres-engineering-full-task-1-individual',
      'postgres-engineering-full-task-2-individual',
      'property-fuzz-differential-testing-full-task-1-individual',
      'property-fuzz-differential-testing-full-task-2-individual',
      'research-full-task-1-individual',
      'research-full-task-2-individual',
      'robotics-control-full-task-1-individual',
      'robotics-control-full-task-2-individual',
      'react-engineering-full-task-1-individual',
      'react-engineering-full-task-2-individual',
      'speech-audio-ai-full-task-1-individual',
      'speech-audio-ai-full-task-2-individual',
      'search-indexing-full-task-1-individual',
      'search-indexing-full-task-2-individual',
      'swift-engineering-full-task-1-individual',
      'swift-engineering-full-task-2-individual',
      'vector-search-systems-full-task-1-individual',
      'vector-search-systems-full-task-2-individual',
      'visual-verification-full-task-2',
      'video-production-full-task-1-individual',
      'video-production-full-task-2-individual',
      'vue-engineering-full-task-1-individual',
      'vue-engineering-full-task-2-individual',
    ];
    // The inventory proves registration even on hosts without the runtime.
    // Readiness controls execution, not whether an evaluator must be registered.
    expect(registeredRealRuntimeScenarioIds).toEqual(expectedRealRuntimeScenarioIds.sort());
    for (const scenarioId of registeredRealRuntimeScenarioIds) readyScenarioIds.delete(scenarioId);

    for (const skillPackage of packages) {
      for (const task of skillPackage.evaluation.tasks) {
        if (!readyScenarioIds.has(task.id)) continue;
        const result = await runPairedSkillEvaluationV3({
          projectRoot: process.cwd(),
          skillPackage,
          scenarioId: task.id,
          skillRevisionHash: 'd'.repeat(64),
          harnessVersion: 'all-ready-fixture-self-test-v3',
          materializers: BUILTIN_SKILL_EVAL_MATERIALIZERS,
          scorers: BUILTIN_SKILL_EVAL_SCORERS,
          executor: {
            id: 'all-ready-no-op-executor',
            subject: 'other',
            provider: 'synthetic',
            model: 'no-op',
            runtimeIdentity: 'fixture-self-test',
            tools: ['filesystem'],
            budget: { wallClockMs: 1_000 },
            execute: async () => ({
              output: 'unchanged',
              evidence: ['fixture intentionally left unchanged'],
              artifacts: [],
              durationMs: 1,
            }),
          },
        });
        cleanups.push(result.cleanup);
        expect(result.withSkill.score?.passed, `${skillPackage.sidecar.name}/${task.id}`).toBe(
          false,
        );
        expect(result.withoutSkill.score?.passed, `${skillPackage.sidecar.name}/${task.id}`).toBe(
          false,
        );
      }
    }
    // Ready fixtures now include real-runtime evaluators (bounded local processes and real
    // browser sessions), so the full sweep needs a wider budget than the source-only fixtures.
  }, 240_000);
});
