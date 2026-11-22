import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  VISUAL_DIRECTION_SKILL_EVAL_MATERIALIZERS,
  VISUAL_DIRECTION_SKILL_EVAL_SCORERS,
  EDITOR_DIRECTION_SCENARIO,
} from '../../backend/src/kory/skill-eval-visual-direction-fixtures.ts';

const dir = mkdtempSync(join(tmpdir(), 'vid-probe-'));
const m = VISUAL_DIRECTION_SKILL_EVAL_MATERIALIZERS[0];
m.materialize(dir, { id: EDITOR_DIRECTION_SCENARIO } as any);
console.log('files', readdirSync(dir).join(','));
console.log('captures', readdirSync(join(dir, 'captures')).join(','));
const g: any = JSON.parse(readFileSync(join(dir, 'geometry/min-dark-de-large.json'), 'utf8'));
console.log('truncated in min-dark-de-large:', g.elements.filter((e: any) => e.truncated).map((e: any) => e.id).join(',') || 'none');
const score = await VISUAL_DIRECTION_SKILL_EVAL_SCORERS[0].score({ workingDirectory: dir } as any);
console.log('placeholder score', score.passed, score.quality?.toFixed(2));
for (const e of score.evidence) console.log('  -', String(e).slice(0, 110));
