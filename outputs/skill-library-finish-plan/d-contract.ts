import { loadV5SkillPackages } from '../../backend/src/kory/skill-packages.ts';
import { currentV5SkillEvaluationContracts } from '../../backend/src/kory/skill-eval-current-contract.ts';
const name = process.argv[2]!;
const pkg = loadV5SkillPackages().packages.find((p: any) => p.sidecar.name === name)!;
for (const [id, c] of currentV5SkillEvaluationContracts(pkg, 3)) {
  console.log(id, '| mat', c.materializerIds.join(','), '| scorer', c.scorerIds.join(','));
}
