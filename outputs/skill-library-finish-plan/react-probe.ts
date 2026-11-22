import { mkdtempSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIsolatedCodexSkillEvalExecutor } from '../../backend/src/kory/skill-eval-codex.ts';
import { REACT_BROWSER_SKILL_EVAL_MATERIALIZERS, REACT_BROWSER_SKILL_EVAL_SCORERS } from '../../backend/src/kory/skill-eval-react-browser-fixtures.ts';

const dir = mkdtempSync(join(tmpdir(), 'react-probe-'));
const scenarioId = 'react-engineering-full-task-1-individual';
const materializer = REACT_BROWSER_SKILL_EVAL_MATERIALIZERS.find((m) => m.matches({ id: scenarioId, environment: { kind: 'fixture' } } as any))!;
materializer.materialize(dir);
const readme = readFileSync(join(dir, 'README.md'), 'utf8');
const executor = createIsolatedCodexSkillEvalExecutor({ model: 'gpt-6-luna', wallClockMs: 600_000 });
const obs = await executor.execute({
  scenario: { id: scenarioId, environment: { kind: 'fixture' } },
  workingDirectory: dir,
  taskPrompt: readme,
  skillContext: null,
} as any);
console.log('dir', dir, 'durationMs', obs.durationMs);
console.log('verification files:', existsSync(join(dir, 'verification')) ? readdirSync(join(dir, 'verification')) : 'MISSING');
for (const f of existsSync(join(dir, 'verification')) ? readdirSync(join(dir, 'verification')) : []) {
  if (f.endsWith('.json')) console.log(f, '=>', readFileSync(join(dir, 'verification', f), 'utf8').replace(/\s+/gu, ' ').slice(0, 260));
}
const score = await REACT_BROWSER_SKILL_EVAL_SCORERS[0].score({ workingDirectory: dir, scenario: { id: scenarioId } } as any);
console.log('score', score.passed, score.quality?.toFixed(2), score.verification?.toFixed(2));
for (const e of score.evidence) console.log('  -', String(e).slice(0, 120));
