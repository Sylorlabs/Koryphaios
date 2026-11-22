import { loadV5SkillPackages } from '../../backend/src/kory/skill-packages.ts';
import { currentV5SkillEvaluationContracts } from '../../backend/src/kory/skill-eval-current-contract.ts';

const pkg = loadV5SkillPackages().packages.find((p: any) => p.sidecar.name === 'visual-interface-design')!;
for (const version of [2, 3, 4]) {
  const contracts = currentV5SkillEvaluationContracts(pkg, version);
  for (const [id, contract] of contracts) {
    console.log('v' + version, id, '| mat', contract.materializerIds.join(','), '| scorer', contract.scorerIds.join(','));
  }
}
