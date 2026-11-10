/**
 * Standalone, deliberately adversarial evaluator sensitivity check.
 *
 * The samples are synthetic negative controls containing only search terms.
 * They are NOT model outputs, task successes, AT evidence, paired experiments
 * or independent/blind reviews. This script does not write an evaluation ledger.
 *
 * Run explicitly:
 *   bun run skills-v5/accessibility-practice/evals/scorer-calibration.ts
 *
 * Exit 1 means a registered scorer falsely accepted at least one obviously
 * incomplete artifact. Because the shared scorers are outside this package,
 * a failure is a promotion blocker for the evaluator owner to address.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ACCESSIBILITY_SKILL_EVAL_MATERIALIZERS,
  ACCESSIBILITY_SKILL_EVAL_SCORERS,
} from '../../../backend/src/kory/skill-eval-accessibility-fixtures';
import type { SkillEvalScenarioV3 } from '../../../backend/src/kory/skill-eval-harness';

const negativeControls = [
  {
    id: 'accessibility-practice-full-task-cross-platform-editor',
    artifact: 'editor-contract.json',
    words:
      'open-project navigate-project edit search diagnostics command-discovery ' +
      'conflict-resolution interruption-recovery macos windows tree grid keyboard ' +
      'role contrast motion untested not tested',
  },
  {
    id: 'accessibility-practice-full-task-game-system',
    artifact: 'game-accessibility.json',
    words:
      'menu tutorial combat recovery status co-op communication pause settings ' +
      'dialogue non-speech audio visual cue controller remap redundant motion ' +
      'readable untested not compliance',
  },
];

let falseAccepts = 0;
for (const control of negativeControls) {
  const scenario = { id: control.id } as SkillEvalScenarioV3;
  const materializer = ACCESSIBILITY_SKILL_EVAL_MATERIALIZERS.find((m) => m.matches(scenario));
  const scorer = ACCESSIBILITY_SKILL_EVAL_SCORERS.find((s) => s.scenarioIds.includes(control.id));
  if (!materializer || !scorer) throw new Error(`Unregistered full-task control: ${control.id}`);
  const root = mkdtempSync(join(tmpdir(), 'kory-a11y-scorer-calibration-'));
  try {
    await materializer.materialize(root, scenario);
    mkdirSync(join(root, '.kory-eval'));
    writeFileSync(
      join(root, '.kory-eval', control.artifact),
      JSON.stringify({ note: control.words }),
    );
    const score = await scorer.score({ workingDirectory: root } as Parameters<
      typeof scorer.score
    >[0]);
    if (score.passed) {
      falseAccepts += 1;
      console.error(`FAIL ${control.id}: keyword-only JSON falsely accepted as a complete task`);
    } else {
      console.log(`PASS ${control.id}: keyword-only JSON rejected`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
console.log(
  `Scorer sensitivity: ${negativeControls.length - falseAccepts} rejected, ${falseAccepts} falsely accepted`,
);
if (falseAccepts > 0) process.exitCode = 1;
