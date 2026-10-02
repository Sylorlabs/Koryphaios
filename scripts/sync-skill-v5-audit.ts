import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import {
  BUNDLED_SKILL_DEFINITIONS,
  V5_SKILL_PACKAGE_CATALOG,
  auditBundledSkillDefinitions,
  listSkills,
} from '../backend/src/kory/skills';
import { evaluateSkillPromotion } from '../backend/src/kory/skill-evaluations';
import {
  reconcileV5AuditLedgerFromEvaluations,
  syncV5AuditLedger,
} from '../backend/src/kory/skill-v5-audit';

const projectRoot = resolve(import.meta.dir, '..');
const audit = auditBundledSkillDefinitions();
if (!audit.valid) {
  throw new Error(`Cannot sync V5 audit ledger: ${audit.errors.join('; ')}`);
}

let ledger = syncV5AuditLedger(
  projectRoot,
  BUNDLED_SKILL_DEFINITIONS,
  V5_SKILL_PACKAGE_CATALOG.packages,
  {
    baseCount: audit.baseCount,
    professionalCount: audit.professionalCount,
  },
);

const activeRevisions = new Map(
  listSkills(projectRoot)
    .filter((skill) => skill.state === 'active' && skill.validation.valid)
    .map((skill) => [skill.name, skill]),
);
const promotionGates = new Map(
  V5_SKILL_PACKAGE_CATALOG.packages.flatMap((skillPackage) => {
    const revision = activeRevisions.get(skillPackage.sidecar.name);
    return revision
      ? [
          [
            skillPackage.sidecar.name,
            evaluateSkillPromotion(projectRoot, revision.name, revision.hash),
          ] as const,
        ]
      : [];
  }),
);
ledger = reconcileV5AuditLedgerFromEvaluations(projectRoot, promotionGates);

const ledgerPath = resolve(projectRoot, 'skills-v5', 'audit-ledger.json');
const formatResult = spawnSync('bunx', ['prettier', '--write', ledgerPath], {
  cwd: projectRoot,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
  shell: process.platform === 'win32',
});
if (formatResult.status !== 0) {
  throw new Error(
    formatResult.stderr.trim() || formatResult.stdout.trim() || 'Could not format V5 audit ledger',
  );
}

const counts = ledger.records.reduce<Record<string, number>>((accumulator, record) => {
  accumulator[record.v5Status] = (accumulator[record.v5Status] ?? 0) + 1;
  return accumulator;
}, {});

console.log(
  JSON.stringify(
    {
      path: 'skills-v5/audit-ledger.json',
      librarySize: ledger.librarySize,
      packageCount: V5_SKILL_PACKAGE_CATALOG.packages.length,
      statusCounts: counts,
    },
    null,
    2,
  ),
);
