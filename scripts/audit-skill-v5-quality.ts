import { resolve } from 'node:path';
import { loadV5SkillPackages } from '../backend/src/kory/skill-packages';
import { auditV5SkillLibraryQuality } from '../backend/src/kory/skill-v5-quality';

const projectRoot = resolve(import.meta.dir, '..');
const skillsRoot = resolve(projectRoot, 'skills-v5');
const auditDate = process.env.KORY_V5_AUDIT_DATE
  ? new Date(`${process.env.KORY_V5_AUDIT_DATE}T00:00:00.000Z`)
  : new Date();

const report = auditV5SkillLibraryQuality(loadV5SkillPackages(skillsRoot), auditDate);
const summaryOnly = process.argv.includes('--summary');
const shortestBodies = [...report.rows]
  .sort((left, right) => left.bodyWords - right.bodyWords)
  .slice(0, 20)
  .map(({ name, bodyWords, sourceCount, supportingResourceCount }) => ({
    name,
    bodyWords,
    sourceCount,
    supportingResourceCount,
  }));
const lowestSourceCounts = [...report.rows]
  .sort((left, right) => left.sourceCount - right.sourceCount || left.bodyWords - right.bodyWords)
  .slice(0, 30)
  .map(({ name, sourceCount, bodyWords }) => ({ name, sourceCount, bodyWords }));
console.log(
  JSON.stringify(
    summaryOnly
      ? {
          ...report,
          rows: undefined,
          shortestBodies,
          lowestSourceCounts,
        }
      : report,
    null,
    2,
  ),
);

if (
  report.catalogErrors.length ||
  report.maturityCounts.scaffold ||
  report.stalePackages.length ||
  report.weakSourceAuthorityPackages.length ||
  report.missingIndividualTaskPackages.length ||
  report.evaluationCoverageGaps.length ||
  report.portabilityViolations.length ||
  report.genericBodyPackages.length ||
  report.genericTaskPackages.length ||
  report.genericRoutingPackages.length ||
  report.duplicateBodyGroups.length ||
  report.repeatedParagraphPackages.length ||
  report.sharedBoilerplateGroups.length ||
  report.proseEmDashPackages.length ||
  report.missingRoutingReferences.length ||
  report.hierarchyGaps.length
) {
  process.exitCode = 1;
}
