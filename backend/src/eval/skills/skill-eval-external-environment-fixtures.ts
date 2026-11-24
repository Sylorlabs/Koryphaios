import type {
  SkillEvalDeterministicScorer,
  SkillEvalFixtureMaterializer,
} from './skill-eval-execution';
import { writeFixtureFile } from './skill-eval-fixture-helpers';
import {
  VUE_BROWSER_SKILL_EVAL_MATERIALIZERS,
  VUE_BROWSER_SKILL_EVAL_SCORERS,
} from './skill-eval-vue-browser-fixtures';
import {
  NATIVE_OPERATIONS_SKILL_EVAL_MATERIALIZERS,
  NATIVE_OPERATIONS_SKILL_EVAL_SCORERS,
  VISUAL_NATIVE_SKILL_EVAL_MATERIALIZERS,
  VISUAL_NATIVE_SKILL_EVAL_SCORERS,
} from './skill-eval-visual-native-fixtures';
import {
  NEXTJS_RUNTIME_SKILL_EVAL_MATERIALIZERS,
  NEXTJS_RUNTIME_SKILL_EVAL_SCORERS,
} from './skill-eval-nextjs-runtime-fixtures';
import {
  COMPUTER_USE_SKILL_EVAL_MATERIALIZERS,
  COMPUTER_USE_SKILL_EVAL_SCORERS,
} from './skill-eval-computer-use-desktop';

export {
  EXTERNAL_ENVIRONMENT_GATES,
  type ExternalEnvironmentGate,
} from './skill-eval-external-environment-boundaries';
import { EXTERNAL_ENVIRONMENT_GATES } from './skill-eval-external-environment-boundaries';

const definitions = EXTERNAL_ENVIRONMENT_GATES.flatMap((gate) =>
  gate.scenarioIds.map((scenarioId) => ({ ...gate, scenarioId })),
);

// Literature research is materialized by the live public-research runtime above
// the fallback lane. Research is materialized by the dated-corpus runtime, whose
// historical snapshots now verify against the Internet Archive and pinned GitHub
// blobs. Keep both gate definitions as historical inventory, but do not register a
// second matcher that would make contract identity ambiguous. The replacements
// declare their own corpus blockers, so a scenario with no verified corpus still
// fails closed instead of becoming executable.
const REAL_RUNTIME_REPLACED_SKILLS = new Set(['literature-research', 'research']);
const fallbackDefinitions = definitions.filter(
  (definition) => !REAL_RUNTIME_REPLACED_SKILLS.has(definition.skill),
);

// Retain the historical inventory while promoting only genuinely executable,
// independently scored fixture pairs. Each replacement itself declares any
// missing pinned runtime or browser prerequisites as fail-closed blockers.
const executableMaterializers = [
  ...VUE_BROWSER_SKILL_EVAL_MATERIALIZERS,
  ...NEXTJS_RUNTIME_SKILL_EVAL_MATERIALIZERS,
  ...VISUAL_NATIVE_SKILL_EVAL_MATERIALIZERS,
  ...NATIVE_OPERATIONS_SKILL_EVAL_MATERIALIZERS,
  ...COMPUTER_USE_SKILL_EVAL_MATERIALIZERS,
];
const executableScorers = [
  ...VUE_BROWSER_SKILL_EVAL_SCORERS,
  ...NEXTJS_RUNTIME_SKILL_EVAL_SCORERS,
  ...VISUAL_NATIVE_SKILL_EVAL_SCORERS,
  ...NATIVE_OPERATIONS_SKILL_EVAL_SCORERS,
  ...COMPUTER_USE_SKILL_EVAL_SCORERS,
];

export const EXTERNAL_ENVIRONMENT_SKILL_EVAL_MATERIALIZERS: readonly SkillEvalFixtureMaterializer[] =
  fallbackDefinitions.map(
    (definition) =>
      executableMaterializers.find((candidate) =>
        candidate.matches({ id: definition.scenarioId } as Parameters<typeof candidate.matches>[0]),
      ) ?? {
        id: `${definition.skill}/external-environment-gate/${definition.scenarioId}@1`,
        readinessBlockers: [definition.blocker],
        matches: (scenario) => scenario.id === definition.scenarioId,
        materialize: (root) => {
          writeFixtureFile(
            root,
            'BLOCKED.md',
            `# Full-task environment gate\n\nScenario: ${definition.scenarioId}\n\n${definition.blocker}\n`,
          );
        },
      },
  );

export const EXTERNAL_ENVIRONMENT_SKILL_EVAL_SCORERS: readonly SkillEvalDeterministicScorer[] =
  fallbackDefinitions.map(
    (definition) =>
      executableScorers.find((candidate) =>
        candidate.scenarioIds.includes(definition.scenarioId),
      ) ?? {
        id: `${definition.skill}/external-environment-gate-scorer/${definition.scenarioId}@1`,
        scenarioIds: [definition.scenarioId],
        score: () => ({
          passed: false,
          quality: 0,
          verification: 0,
          integrityFailure: false,
          evidence: [definition.blocker],
        }),
      },
  );
