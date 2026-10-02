import { resolve } from 'node:path';
import { auditSkillEvalExecutionReadiness } from '../backend/src/kory/skill-eval-execution';
import {
  BUILTIN_SKILL_EVAL_MATERIALIZERS,
  BUILTIN_SKILL_EVAL_SCORERS,
} from '../backend/src/kory/skill-eval-fixtures';
import { loadV5SkillPackages } from '../backend/src/kory/skill-packages';

const projectRoot = resolve(import.meta.dir, '..');
const rows = auditSkillEvalExecutionReadiness(
  loadV5SkillPackages(resolve(projectRoot, 'skills-v5')).packages,
  BUILTIN_SKILL_EVAL_MATERIALIZERS,
  BUILTIN_SKILL_EVAL_SCORERS,
);
const ready = rows.filter((row) => row.ready);
const blocked = rows.filter((row) => !row.ready);
const summaryOnly = process.argv.includes('--summary');
const report = {
  schemaVersion: 1,
  scenarios: rows.length,
  ready: ready.length,
  blocked: blocked.length,
  ...(summaryOnly
    ? {}
    : {
        readyScenarios: ready,
        blockers: blocked.map(({ skill, scenarioId, startingState, reasons }) => ({
          skill,
          scenarioId,
          startingState,
          reasons,
        })),
      }),
};
// Large reports must drain before setting the nonzero readiness exit code.
// Otherwise Bun can leave a piped JSON report truncated at the pipe capacity.
await new Promise<void>((resolveOutput, rejectOutput) => {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`, (error) => {
    if (error) rejectOutput(error);
    else resolveOutput();
  });
});

if (blocked.length) process.exitCode = 1;
