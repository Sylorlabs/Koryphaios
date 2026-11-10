import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BUN_MIGRATION_SCENARIO,
  BUN_RUNTIME_SKILL_EVAL_MATERIALIZERS,
  BUN_MIGRATION_VERSIONS,
  bunMigrationReadiness,
  scoreBunMigration,
} from '../skill-eval-bun-runtime-fixtures';
import { loadV5SkillPackages } from '../skill-packages';
import type { SkillEvalScenarioV3 } from '../skill-eval-harness';
import { auditSkillEvalExecutionReadiness } from '../skill-eval-execution';
import {
  BUILTIN_SKILL_EVAL_MATERIALIZERS,
  BUILTIN_SKILL_EVAL_SCORERS,
} from '../skill-eval-fixtures';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const prerequisites = bunMigrationReadiness();
const skillPackage = loadV5SkillPackages().packages.find(
  (p) => p.sidecar.name === 'bun-deno-runtime',
)!;
const task = skillPackage.evaluation.tasks.find((t) => t.id === BUN_MIGRATION_SCENARIO)!;
const scenario: SkillEvalScenarioV3 = {
  ...task,
  skill: 'bun-deno-runtime',
  category: 'full-task',
  expectedSelection: true,
  expectedSkills: [],
  forbiddenSkills: [],
  heldOut: true,
  adjacentSkills: [],
  tags: [],
};

async function fixture(valid = false): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'kory-bun-migration-control-'));
  roots.push(root);
  await BUN_RUNTIME_SKILL_EVAL_MATERIALIZERS[0]!.materialize(root, scenario);
  if (valid)
    for (const name of ['api', 'cli', 'timer'])
      writeFileSync(
        join(root, `src/${name}.mjs`),
        readFileSync(join(root, `reference/${name}.mjs`)),
      );
  return root;
}

describe('real Node-to-Bun migration evaluator', () => {
  test('the runtime fixture replaces the simulator without duplicate dispatch', () => {
    expect(BUILTIN_SKILL_EVAL_MATERIALIZERS.filter((m) => m.matches(scenario))).toHaveLength(1);
    expect(
      BUILTIN_SKILL_EVAL_SCORERS.filter((s) => s.scenarioIds.includes(scenario.id)),
    ).toHaveLength(1);
    const row = auditSkillEvalExecutionReadiness(
      [skillPackage],
      BUILTIN_SKILL_EVAL_MATERIALIZERS,
      BUILTIN_SKILL_EVAL_SCORERS,
    ).find((r) => r.scenarioId === scenario.id)!;
    expect(row.materializerId).toBe('bun-deno-runtime/actual-bun-migration@3');
    expect(row.ready).toBe(prerequisites.length === 0);
    expect(row.reasons).toEqual(prerequisites);
  });

  test.skipIf(prerequisites.length > 0)(
    'a stuck interrupt handler is bounded and rejected',
    async () => {
      const root = await fixture(true),
        path = join(root, 'src/cli.mjs');
      writeFileSync(path, readFileSync(path, 'utf8').replace("child.kill('SIGTERM');", 'return;'));
      const result = await scoreBunMigration(root);
      expect(result.passed).toBe(false);
      expect(result.evidence.join('\n')).toContain('"timedOut":true');
    },
    20_000,
  );

  test.skipIf(prerequisites.length > 0)(
    'parent-directory and report symlinks fail closed without overwriting their targets',
    async () => {
      const root = await fixture(true);
      renameSync(join(root, 'reference'), join(root, 'reference-original'));
      symlinkSync(join(root, 'reference-original'), join(root, 'reference'));
      expect((await scoreBunMigration(root)).integrityFailure).toBe(true);
      const other = await fixture(true),
        target = mkdtempSync(join(tmpdir(), 'kory-bun-report-target-'));
      roots.push(target);
      writeFileSync(join(target, 'bun-runtime-evidence.json'), 'preserve me');
      symlinkSync(target, join(other, '.kory-eval'));
      expect((await scoreBunMigration(other)).integrityFailure).toBe(true);
      expect(readFileSync(join(target, 'bun-runtime-evidence.json'), 'utf8')).toBe('preserve me');
    },
    20_000,
  );

  test('unsupported platform, missing binary and wrong version are explicit readiness blockers', () => {
    const exact = (runtime: string) =>
      BUN_MIGRATION_VERSIONS[runtime as keyof typeof BUN_MIGRATION_VERSIONS];
    expect(bunMigrationReadiness(exact, 'darwin')).toEqual([]);
    expect(bunMigrationReadiness(exact, 'win32').join(' ')).toContain('POSIX');
    expect(bunMigrationReadiness(() => 'unavailable', 'linux')).toHaveLength(3);
    expect(
      bunMigrationReadiness(
        (runtime) => (runtime === 'bun' ? 'different' : exact(runtime)),
        'linux',
      ).join(' '),
    ).toContain('different');
  });

  test.skipIf(prerequisites.length > 0)(
    'broken start is genuinely red after actual installation/build',
    async () => {
      const root = await fixture();
      const result = await scoreBunMigration(root);
      expect(result.passed).toBe(false);
      expect(result.integrityFailure).toBe(false);
      expect(result.evidence).toContain('bun-frozen-install: exit 0');
      expect(result.evidence).toContain('bun-build: exit 0');
      const evidence = JSON.parse(
        readFileSync(join(root, '.kory-eval/bun-runtime-evidence.json'), 'utf8'),
      );
      expect(evidence.evidenceKind).toBe('actual-local-runtime');
      expect(evidence.phases.find((p: { phase: string }) => p.phase === 'bun-tests').code).not.toBe(
        0,
      );
    },
    20_000,
  );

  test.skipIf(prerequisites.length > 0)(
    'valid control preserves exports, CLI, timers and actual SIGINT child cleanup',
    async () => {
      const root = await fixture(true);
      const lock = readFileSync(join(root, 'bun.lock'), 'utf8');
      const result = await scoreBunMigration(root);
      expect(result.evidence.join('\n')).not.toContain('mismatch');
      expect(result.passed, JSON.stringify(result)).toBe(true);
      expect(result.integrityFailure).toBe(false);
      expect(readFileSync(join(root, 'bun.lock'), 'utf8')).toBe(lock);
      const evidence = JSON.parse(
        readFileSync(join(root, '.kory-eval/bun-runtime-evidence.json'), 'utf8'),
      );
      expect(evidence.versions).toEqual(BUN_MIGRATION_VERSIONS);
      expect(evidence.checks.join('\n')).toContain('"ownedLiveWorker":true');
      expect(evidence.checks.join('\n')).toContain('"stopped":true');
      expect(evidence.bunLockSha256).toHaveLength(64);
    },
    20_000,
  );

  test.skipIf(prerequisites.length > 0)(
    'alternative cancellation implementation satisfies the same contract',
    async () => {
      const root = await fixture(true);
      writeFileSync(
        join(root, 'src/timer.mjs'),
        'export function defer(fn,ms,clock=globalThis){let active=true;const id=clock.setTimeout(()=>{if(active)fn()},ms);return()=>{if(active){active=false;clock.clearTimeout(id)}}}\n',
      );
      expect((await scoreBunMigration(root)).passed).toBe(true);
    },
    20_000,
  );

  for (const [name, before, after] of [
    ['stale CLI exit-code shortcut', 'process.exitCode = 2;', 'process.exitCode = 0;'],
    ['exit without reaping worker', "child.kill('SIGTERM');", 'process.exit(130);'],
    ['incorrect interruption status', 'stopping ? 130', 'stopping ? 0'],
  ]) {
    test.skipIf(prerequisites.length > 0)(
      `rejects ${name}`,
      async () => {
        const root = await fixture(true),
          path = join(root, 'src/cli.mjs');
        const original = readFileSync(path, 'utf8');
        expect(original).toContain(before!);
        writeFileSync(path, original.replace(before!, after!));
        const result = await scoreBunMigration(root);
        expect(result.passed, result.evidence.join('\n')).toBe(false);
        expect(result.integrityFailure).toBe(false);
      },
      20_000,
    );
  }

  test.skipIf(prerequisites.length > 0)(
    'corrupt lock cannot pass through stale generated/build outputs',
    async () => {
      const root = await fixture(true);
      writeFileSync(join(root, 'bun.lock'), 'not a lockfile');
      const result = await scoreBunMigration(root);
      expect(result.passed).toBe(false);
      expect(result.evidence).not.toContain('bun-frozen-install: exit 0');
    },
    20_000,
  );

  test.skipIf(prerequisites.length > 0)(
    'baseline/source symlink tampering cannot reach execution',
    async () => {
      const root = await fixture(true);
      writeFileSync(join(root, 'reference/api.mjs'), 'export const fake = true;');
      expect((await scoreBunMigration(root)).integrityFailure).toBe(true);
      const other = await fixture(true);
      rmSync(join(other, 'src/api.mjs'));
      symlinkSync(join(other, 'reference/api.mjs'), join(other, 'src/api.mjs'));
      expect((await scoreBunMigration(other)).integrityFailure).toBe(true);
    },
    20_000,
  );
});
