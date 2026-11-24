import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { listSkillEvaluationRuns } from '../backend/src/kory/skill-evaluations';
const root = resolve(import.meta.dir, '..');
for (const skill of process.argv.slice(2)) {
  const runs = listSkillEvaluationRuns(root, skill);
  const groups = new Map<string, any[]>();
  for (const r of runs) {
    if (!r.comparisonId) continue;
    if (!groups.has(r.comparisonId)) groups.set(r.comparisonId, []);
    groups.get(r.comparisonId)!.push(r);
  }
  const keys = [...groups.keys()].slice(-4);
  console.log(`\n### ${skill} comparisons=${groups.size}`);
  for (const k of keys) {
    const rows = groups.get(k)!;
    const variants = rows
      .map((r) => `${r.variant}:${r.passed ? 'P' : 'F'}:${r.protocolVersion}`)
      .join(' ');
    const missing = rows
      .flatMap((r) => (r.artifacts ?? []).map((a: any) => a.location))
      .filter((l) => !existsSync(l)).length;
    console.log(
      `   ${k.slice(0, 64)} [${variants}] missingArtifacts=${missing} contract=${rows[0].evaluationContractHash?.slice(0, 8)}`,
    );
  }
}
