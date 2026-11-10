import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  ACCESSIBILITY_SKILL_EVAL_MATERIALIZERS,
  ACCESSIBILITY_SKILL_EVAL_SCORERS,
} from '../../../backend/src/kory/skill-eval-accessibility-fixtures';
import { auditSkillEvalExecutionReadiness } from '../../../backend/src/kory/skill-eval-execution';
import { validateV5SkillPackage } from '../../../backend/src/kory/skill-packages';
import type { SkillEvalScenarioV3 } from '../../../backend/src/kory/skill-eval-harness';
import type { SkillEvalDeterministicScorer } from '../../../backend/src/kory/skill-eval-execution';

const packageDirectory = resolve(import.meta.dir, '..');
const taskIds = [
  'accessibility-practice-full-task-cross-platform-editor',
  'accessibility-practice-full-task-game-system',
];
const artifacts: Record<string, string> = {
  'accessibility-practice-full-task-cross-platform-editor': 'editor-contract.json',
  'accessibility-practice-full-task-game-system': 'game-accessibility.json',
};

function validated() {
  const result = validateV5SkillPackage(packageDirectory);
  expect(result.errors).toEqual([]);
  expect(result.warnings).toEqual([]);
  expect(result.valid).toBe(true);
  expect(result.package).toBeDefined();
  return result.package!;
}

test('individual package schema and hard held-out routing boundaries', () => {
  const pkg = validated();
  expect(pkg.sidecar.authoringMaturity).toBe('individual');
  expect(pkg.evaluation.tasks.map((task) => task.id).sort()).toEqual([...taskIds].sort());
  const counts = pkg.evaluation.routing.reduce<Record<string, number>>((acc, row) => {
    acc[row.category] = (acc[row.category] ?? 0) + 1;
    return acc;
  }, {});
  expect(counts).toEqual({ positive: 7, negative: 7, ambiguous: 5, adversarial: 5 });
  expect(
    pkg.evaluation.routing.some(
      (row) =>
        row.category === 'negative' &&
        row.selectionScope === 'direct' &&
        row.expectedSelection === false &&
        row.adjacentSkills.includes('accessibility-verification'),
    ),
  ).toBe(true);
  expect(
    pkg.evaluation.routing.some(
      (row) =>
        row.category === 'ambiguous' &&
        row.selectionScope === 'direct' &&
        row.expectedSelection === true &&
        row.adjacentSkills.includes('accessibility-verification'),
    ),
  ).toBe(true);
  for (const task of pkg.evaluation.tasks) {
    expect(task.maturity).toBe('individual');
    expect(task.scorers.reduce((sum, s) => sum + s.weight, 0)).toBeCloseTo(1);
    expect(task.scorers.some((s) => s.kind === 'deterministic')).toBe(true);
    expect(
      task.scorers.some(
        (s) =>
          s.kind === 'blind-semantic' &&
          s.blindTo?.includes('skill-variant') &&
          s.blindTo?.includes('expected-outcome'),
      ),
    ).toBe(true);
  }
});

test('two full tasks have registered materializers and deterministic scorers', () => {
  const pkg = validated();
  const readiness = auditSkillEvalExecutionReadiness(
    [pkg],
    ACCESSIBILITY_SKILL_EVAL_MATERIALIZERS,
    ACCESSIBILITY_SKILL_EVAL_SCORERS,
  );
  expect(readiness.map((row) => row.scenarioId).sort()).toEqual([...taskIds].sort());
  for (const row of readiness) {
    expect(row.ready).toBe(true);
    expect(row.reasons).toEqual([]);
    expect(row.materializerId).toBeTruthy();
    expect(row.deterministicScorerId).toBeTruthy();
  }
});

test('both registered full-task materializers carry the fixed synthetic corpus', async () => {
  const pkg = validated();
  const roots: string[] = [];
  try {
    for (const task of pkg.evaluation.tasks) {
      const scenario = { id: task.id } as SkillEvalScenarioV3;
      const materializer = ACCESSIBILITY_SKILL_EVAL_MATERIALIZERS.find((m) => m.matches(scenario));
      expect(materializer).toBeDefined();
      const directory = mkdtempSync(join(tmpdir(), 'kory-a11y-fixture-'));
      roots.push(directory);
      await materializer!.materialize(directory, scenario);
      const scope = JSON.parse(
        readFileSync(join(directory, 'evidence/accessibility-scope.json'), 'utf8'),
      );
      expect(scope.editorTasks).toEqual([
        'open-project',
        'navigate-project',
        'edit',
        'search',
        'diagnostics',
        'command-discovery',
        'conflict-resolution',
        'interruption-recovery',
      ]);
      expect(scope.editorPlatforms).toEqual(['macOS', 'Windows']);
      expect(scope.gameTasks).toEqual([
        'menu',
        'tutorial',
        'combat',
        'coop-communication',
        'pause-settings',
        'recovery',
      ]);
      expect(scope.gameChannels).toEqual([
        'dialogue',
        'non-speech-audio',
        'visual-events',
        'combat-status',
        'communication',
      ]);
      const readme = readFileSync(join(directory, 'README.md'), 'utf8');
      expect(readme).toContain(artifacts[task.id]!);
      expect(readme).toContain('not claim');
    }
  } finally {
    for (const directory of roots) rmSync(directory, { recursive: true, force: true });
  }
});

// These are evaluator-integrity negative controls, not generated model output,
// fabricated AT runs, a paired evaluation, or an independent blind review.
test('both registered scorers reject missing, incomplete, and tampered evidence', async () => {
  const pkg = validated();
  const roots: string[] = [];
  try {
    for (const task of pkg.evaluation.tasks) {
      const scenario = { id: task.id } as SkillEvalScenarioV3;
      const materializer = ACCESSIBILITY_SKILL_EVAL_MATERIALIZERS.find((m) => m.matches(scenario))!;
      const scorer: SkillEvalDeterministicScorer = ACCESSIBILITY_SKILL_EVAL_SCORERS.find((s) =>
        s.scenarioIds.includes(task.id),
      )!;
      expect(scorer).toBeDefined();
      const directory = mkdtempSync(join(tmpdir(), 'kory-a11y-integrity-'));
      roots.push(directory);
      await materializer.materialize(directory, scenario);
      // The registered scorer currently needs only workingDirectory.
      const score = () =>
        scorer.score({ workingDirectory: directory } as Parameters<typeof scorer.score>[0]);
      const missing = await score();
      expect(missing.passed).toBe(false);
      expect(missing.integrityFailure).toBe(false);

      mkdirSync(join(directory, '.kory-eval'));
      writeFileSync(
        join(directory, '.kory-eval', artifacts[task.id]!),
        JSON.stringify({ tasks: ['menu'], status: 'untested' }),
      );
      const incomplete = await score();
      expect(incomplete.passed).toBe(false);
      expect(incomplete.integrityFailure).toBe(false);

      const corpusPath = join(directory, 'evidence/accessibility-scope.json');
      const scope = JSON.parse(readFileSync(corpusPath, 'utf8'));
      scope.gameTasks.pop();
      writeFileSync(corpusPath, JSON.stringify(scope, null, 2) + '\n');
      const tampered = await score();
      expect(tampered.passed).toBe(false);
      expect(tampered.integrityFailure).toBe(true);
    }
  } finally {
    for (const directory of roots) rmSync(directory, { recursive: true, force: true });
  }
});
