import { resolve } from 'node:path';
import { syncSkillStewardRegistry } from '../backend/src/kory/skill-stewards';

const projectRoot = resolve(import.meta.dir, '..');
const snapshot = syncSkillStewardRegistry(projectRoot);

console.log(
  JSON.stringify(
    {
      path: '.koryphaios/skills/stewards.json',
      revision: snapshot.revision,
      stewards: snapshot.stewards.length,
      active: snapshot.stewards.filter((steward) => steward.status === 'active').length,
      displayLabels: snapshot.stewards.filter((steward) =>
        steward.displayLabel.startsWith('ChatGPT web — '),
      ).length,
      models: [...new Set(snapshot.stewards.map((steward) => steward.model))].sort(),
      leases: snapshot.leases.length,
    },
    null,
    2,
  ),
);
