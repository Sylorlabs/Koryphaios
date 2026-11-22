import { resolve } from 'node:path';
import { listOpenSkillRegressionSources } from '../../backend/src/kory/skill-evaluations';

const root = resolve(import.meta.dir, '../..');
const group = [
  'react-engineering','nextjs-engineering','vue-engineering','svelte-engineering','angular-engineering',
  'web-interface','visual-interface-design','interaction-design','information-architecture',
  'accessibility-practice','accessibility-verification','novel-ui-toolkit','three-d-graphics',
  'terminal-interface','human-experience','usability-evaluation','visual-verification',
  'content-error-design','frontend-engineering','interface-usability-testing','user-research',
];
const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
for (const name of only.length ? only : group) {
  const open = listOpenSkillRegressionSources(root, name);
  if (!open.length) continue;
  console.log(`\n### ${name} open=${open.length}`);
  for (const r of open) {
    console.log(`  ${r.scenarioId} variant=${r.variant} model=${r.provider}/${r.model} rec=${r.recordedAt}`);
    console.log(`    mat=${r.materializerId} scorer=${r.deterministicScorerId} contract=${r.evaluationContractHash}`);
    for (const e of r.evidence.slice(0, 6)) console.log(`    ev: ${String(e).slice(0, 200)}`);
  }
}
