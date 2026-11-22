import { resolve } from 'node:path';
import type { BunPlugin } from 'bun';
import { currentV5SkillEvaluationContracts } from '../src/eval/skills/skill-eval-current-contract';
import type { EmbeddedCurrentV5SkillEvaluationContracts } from '../src/eval/skills/skill-eval-embedded-contracts';
import { CURRENT_SKILL_EVAL_CONTRACT_VERSION } from '../src/kory/skill-evaluations';
import { loadV5SkillPackages } from '../src/kory/skill-packages';

const SOURCE_PACKAGE_ROOT = resolve(import.meta.dir, '../../skills-v5');
const EMBEDDED_STUB_PATH = resolve(import.meta.dir, '../src/eval/skills/skill-eval-embedded-contracts.ts');

/** Collect at build time from source, never from a ledger, manifest, or override. */
export function collectCurrentV5SkillEvaluationContracts(): EmbeddedCurrentV5SkillEvaluationContracts {
  const catalog = loadV5SkillPackages(SOURCE_PACKAGE_ROOT);
  if (catalog.errors.length || !catalog.packages.length) {
    throw new Error(`Cannot embed current V5 contracts: invalid/empty source packages. ${catalog.errors.join('; ')}`);
  }
  const packages = catalog.packages.map((pkg) => ({
    packageName: pkg.sidecar.name,
    packageVersion: pkg.sidecar.version,
    tasks: [...currentV5SkillEvaluationContracts(pkg, CURRENT_SKILL_EVAL_CONTRACT_VERSION)]
      .map(([taskId, contract]) => ({
        taskId,
        evaluationContractHash: contract.evaluationContractHash,
        materializerIds: [...contract.materializerIds],
        scorerIds: [...contract.scorerIds],
      })),
  }));
  if (!packages.some((pkg) => pkg.tasks.length > 0)) {
    throw new Error('Cannot embed current V5 contracts: source execution registry unavailable or empty.');
  }
  return { schemaVersion: 1, contractVersion: CURRENT_SKILL_EVAL_CONTRACT_VERSION, packages };
}

/** Only the null stub is replaced; execution modules never enter the build graph. */
export function currentV5SkillEvaluationContractsPlugin(): BunPlugin {
  // This runs on each build invocation, including builds in the same process.
  const contracts = collectCurrentV5SkillEvaluationContracts();
  const literal = JSON.stringify(contracts);
  return {
    name: 'current-v5-skill-evaluation-contracts',
    setup(build) {
      build.onLoad({ filter: /skill-eval-embedded-contracts\.ts$/ }, (args) => {
        if (args.path !== EMBEDDED_STUB_PATH) return undefined;
        return {
          loader: 'js',
          contents: `const contracts = ${literal};
function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
export const EMBEDDED_CURRENT_V5_SKILL_EVALUATION_CONTRACTS = freeze(contracts);`,
        };
      });
    },
  };
}
