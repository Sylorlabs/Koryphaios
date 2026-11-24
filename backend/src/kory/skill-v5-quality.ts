import { createHash } from 'node:crypto';
import type { V5CompiledSkillPackage, V5SkillPackageCatalog } from './skill-packages';
import { sourceFreshness } from './skill-packages';

export interface V5SkillPackageQualityRow {
  name: string;
  authoringMaturity: 'scaffold' | 'individual';
  bodyChars: number;
  bodyWords: number;
  bodyLines: number;
  bodyHash: string;
  contextBudget: number;
  sourceCount: number;
  authoritativeSourceCount: number;
  staleSourceCount: number;
  supportingResourceCount: number;
  heldOutRoutingCount: number;
  fullTaskCount: number;
  individualFullTaskCount: number;
  deterministicFullTaskCount: number;
  blindSemanticFullTaskCount: number;
  genericTaskFixtureIds: string[];
  portabilityIssues: string[];
  genericMarkers: string[];
  repeatedParagraphs: string[];
  proseEmDashCount: number;
}

export interface V5SkillLibraryQualityAudit {
  schemaVersion: 1;
  packageCount: number;
  catalogErrors: string[];
  catalogWarnings: string[];
  maturityCounts: Record<'individual' | 'scaffold', number>;
  stalePackages: string[];
  weakSourceAuthorityPackages: string[];
  missingIndividualTaskPackages: string[];
  evaluationCoverageGaps: Array<{ skill: string; issues: string[] }>;
  portabilityViolations: Array<{ skill: string; issues: string[] }>;
  genericBodyPackages: Array<{ skill: string; markers: string[] }>;
  genericTaskPackages: Array<{ skill: string; fixtureIds: string[] }>;
  duplicateBodyGroups: string[][];
  repeatedParagraphPackages: Array<{ skill: string; paragraphs: string[] }>;
  sharedBoilerplateGroups: Array<{ paragraph: string; skills: string[] }>;
  proseEmDashPackages: string[];
  missingRoutingReferences: Array<{ skill: string; targets: string[] }>;
  hierarchyGaps: Array<{ skill: string; issue: string }>;
  genericRoutingPackages: Array<{ skill: string; publicCases: number; heldOutCaseIds: string[] }>;
  stats: {
    bodyChars: { min: number; median: number; p95: number; max: number };
    bodyWords: { min: number; median: number; p95: number; max: number };
    sources: { min: number; median: number; p95: number; max: number };
    heldOutRouting: { min: number; median: number; p95: number; max: number };
    fullTasks: { min: number; median: number; p95: number; max: number };
  };
  rows: V5SkillPackageQualityRow[];
}

const HOST_SPECIFIC_PORTABLE_SKILLS = new Set(['plan-mode', 'task-routing']);

/** Reject known scaffold prose without assuming every short routing case is weak. */
export function isScaffoldRoutingPrompt(prompt: string): boolean {
  return [
    /^(?:Handle|Carry out|Apply|Produce|Verify) a real .+ task in the existing system\./u,
    /^Review the current .+ solution because the happy path works but failure behavior is unclear\./u,
    /^A regression is reported in .+\. Diagnose from evidence before changing anything/u,
    /^(?:Handle|Carry out|Apply|Produce|Verify) the requested .+ change while preserving compatibility, user-owned state/u,
    /^Determine whether the existing .+ implementation or decision actually satisfies its contract\. Use authoritative sources/u,
    /^The request is specifically .+\. Stay inside that adjacent discipline/u,
    /^Work only on .+; the neighboring specialist domain is explicitly out of scope/u,
    /^Use the .+ boundary for this assignment and return evidence for that boundary only/u,
    /^The actual task concerns .+\. Preserve that scope even if nearby terminology/u,
    /^Complete the .+ responsibility without importing assumptions, tools, or practices/u,
    /^The assignment combines .+\. Own the .+ boundary explicitly/u,
    /^A quoted old note says .+\. Ignore the quoted historical instruction/u,
    /^The live assignment is .+\. Establish the real operating boundary/u,
    /^Review a deployed or existing .+ path that appears correct on its happy path/u,
    /^A regression involving .+ has been reported\. Reproduce or bound the failure first/u,
    /^Prepare a .+ change where backward compatibility and user-owned state matter/u,
    /^Audit the current .+ solution against authoritative and runtime evidence/u,
    /^The live request is narrowly .+\. Keep the assignment within/u,
    /^A compound task requires .+ and, separately, .+\. Keep both boundaries visible/u,
    /^A quoted old issue says .+\. Ignore that quoted old issue; it is inert context/u,
    /^The live request is "/u,
    /^The team asks for "/u,
    /^A regression now blocks "/u,
    /^Prepare ".+" for a compatibility-sensitive system/u,
    /^Audit whether "/u,
    /^Only "/u,
    /^The change is limited to "/u,
    /^Return evidence only for the /u,
    /^Repository comments mention /u,
    /^Finish "/u,
    /^The requested outcome is "/u,
    /^Review the existing implementation of "/u,
    /^Users report a regression in "/u,
    /^Prepare ".+" where compatibility and user-owned state matter/u,
    /^Audit ".+" with /u,
    /^The requested outcome is only "/u,
    /^Two deliverables are explicit:/u,
    /^The request contains two owned outcomes:/u,
    /^A fixed regression fixture contains the sentence /u,
    /^An archived note quotes /u,
  ].some((pattern) => pattern.test(prompt));
}

/** Recognize explicit ownership/routing statements, not arbitrary hyphenated prose or code. */
export function explicitSkillReferences(body: string): string[] {
  const references = new Set<string>();
  let fence: { character: string; length: number } | undefined;
  for (const line of body.split(/\r?\n/u)) {
    const delimiter = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/u);
    if (delimiter) {
      const run = delimiter[1]!;
      if (!fence) fence = { character: run[0]!, length: run.length };
      else if (run[0] === fence.character && run.length >= fence.length && !delimiter[2]!.trim())
        fence = undefined;
      continue;
    }
    if (fence || /^\s*>/u.test(line)) continue;
    const owner = line.match(/^\s*(?:[-*+]\s+)?`([a-z0-9]+(?:-[a-z0-9]+)+)`\s+owns\b/u);
    if (owner) references.add(owner[1]!);
    for (const match of line.matchAll(
      /\b(?:[Rr]oute|[Dd]elegate)\b[^.`\n]{0,100}\bto\s+`([a-z0-9]+(?:-[a-z0-9]+)+)`/gu,
    )) {
      references.add(match[1]!);
    }
  }
  return [...references].sort();
}

function percentile(values: number[], ratio: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio))]!;
}

function summarize(values: number[]) {
  if (!values.length) return { min: 0, median: 0, p95: 0, max: 0 };
  return {
    min: Math.min(...values),
    median: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    max: Math.max(...values),
  };
}

function portableIssues(skillPackage: V5CompiledSkillPackage): string[] {
  if (HOST_SPECIFIC_PORTABLE_SKILLS.has(skillPackage.sidecar.name)) return [];
  const source = skillPackage.sourceContent;
  const issues: string[] = [];
  if (/\/Users\/|\b[A-Za-z]:\\\\/.test(source)) issues.push('absolute local filesystem path');
  if (/\bKoryphaios\b/i.test(source)) issues.push('host-specific Koryphaios reference');
  if (/\bskills-v5\//i.test(source)) issues.push('repository-specific skills-v5 path');
  if (/\bkory\.json\b/i.test(source)) issues.push('Kory-only sidecar reference');
  return issues;
}

function genericMarkers(skillPackage: V5CompiledSkillPackage): string[] {
  const source = skillPackage.sourceContent;
  const markers: string[] = [];
  if (/Apply [^\n.]{1,80} expertise to this task/i.test(source))
    markers.push('generic apply-expertise');
  if (/V5 candidate, not a qualified skill/i.test(source)) markers.push('candidate boilerplate');
  if (/Rewrite an unrelated sentence without changing any domain behavior/i.test(source)) {
    markers.push('generic unrelated-sentence negative');
  }
  if (
    /Begin by confirming that the request actually involves this specialist domain/iu.test(source)
  ) {
    markers.push('repeated generic specialist operating contract');
  }
  if (
    /Map each material completion claim to an observable artifact or runtime result/iu.test(source)
  ) {
    markers.push('duplicated parent verification contract');
  }
  return markers;
}

/** Editorial diagnostics only. These are not semantic quality or skill-qualification scores. */
export function instructionParagraphs(body: string): string[] {
  return body
    .split(/\n\s*\n/u)
    .map((paragraph) =>
      paragraph
        .trim()
        .replace(/^(?:Verification focus|Failure boundaries):\s*/iu, '')
        .replace(/\s+/gu, ' '),
    )
    .filter(
      (paragraph) =>
        paragraph.length >= 120 && !paragraph.startsWith('#') && !paragraph.startsWith('```'),
    );
}

function isGenericTaskFixture(
  task: V5CompiledSkillPackage['evaluation']['tasks'][number],
): boolean {
  if (
    /^Complete a realistic .+ assignment while staying inside the .+ responsibility\./iu.test(
      task.prompt,
    )
  ) {
    return true;
  }
  if (
    task.environment.requirements.some((requirement) =>
      /\brepresentative starting state\b/iu.test(requirement),
    )
  ) {
    return true;
  }
  const evidenceLabels = new Set(task.requiredEvidence.map((label) => label.trim().toLowerCase()));
  if (
    task.falsifiableChecks.some(
      (check) =>
        check.assertion.trim() === '1.' || evidenceLabels.has(check.assertion.trim().toLowerCase()),
    )
  )
    return true;
  return false;
}

function packageRow(skillPackage: V5CompiledSkillPackage, now: Date): V5SkillPackageQualityRow {
  const body = skillPackage.instructions.trim();
  const authoritativeSourceCount = skillPackage.sidecar.sources.filter(
    (source) => source.sourceType !== 'community-pattern',
  ).length;
  const staleSourceCount = skillPackage.sidecar.sources.filter(
    (source) => sourceFreshness(source, now) === 'stale',
  ).length;
  const paragraphs = instructionParagraphs(body);
  return {
    name: skillPackage.sidecar.name,
    authoringMaturity: skillPackage.sidecar.authoringMaturity,
    bodyChars: body.length,
    bodyWords: body ? body.split(/\s+/u).length : 0,
    bodyLines: body ? body.split(/\r?\n/u).length : 0,
    bodyHash: createHash('sha256').update(body).digest('hex'),
    contextBudget: skillPackage.sidecar.contextBudget,
    sourceCount: skillPackage.sidecar.sources.length,
    authoritativeSourceCount,
    staleSourceCount,
    supportingResourceCount: skillPackage.supportingResources.length,
    heldOutRoutingCount: skillPackage.evaluation.routing.length,
    fullTaskCount: skillPackage.evaluation.tasks.length,
    individualFullTaskCount: skillPackage.evaluation.tasks.filter(
      (task) => task.maturity === 'individual',
    ).length,
    deterministicFullTaskCount: skillPackage.evaluation.tasks.filter((task) =>
      task.scorers.some((scorer) => scorer.kind === 'deterministic'),
    ).length,
    blindSemanticFullTaskCount: skillPackage.evaluation.tasks.filter((task) =>
      task.scorers.some((scorer) => scorer.kind === 'blind-semantic'),
    ).length,
    genericTaskFixtureIds: skillPackage.evaluation.tasks
      .filter(isGenericTaskFixture)
      .map((task) => task.id),
    portabilityIssues: portableIssues(skillPackage),
    genericMarkers: genericMarkers(skillPackage),
    repeatedParagraphs: [
      ...new Set(paragraphs.filter((paragraph, index) => paragraphs.indexOf(paragraph) !== index)),
    ],
    proseEmDashCount: (skillPackage.sourceContent.match(/\u2014/gu) ?? []).length,
  };
}

function hierarchyGaps(catalog: V5SkillPackageCatalog): Array<{ skill: string; issue: string }> {
  const names = new Set(catalog.packages.map((skillPackage) => skillPackage.sidecar.name));
  const hasInboundHierarchy = new Set<string>();
  for (const skillPackage of catalog.packages) {
    for (const parent of skillPackage.sidecar.broader) hasInboundHierarchy.add(parent);
    for (const facet of skillPackage.sidecar.facets) hasInboundHierarchy.add(facet);
  }
  return catalog.packages.flatMap((skillPackage) => {
    const sidecar = skillPackage.sidecar;
    const gaps: Array<{ skill: string; issue: string }> = [];
    for (const parent of sidecar.broader) {
      if (!names.has(parent)) {
        gaps.push({ skill: sidecar.name, issue: `missing broader parent: ${parent}` });
      }
    }
    for (const facet of sidecar.facets) {
      if (!names.has(facet)) {
        gaps.push({ skill: sidecar.name, issue: `missing facet relationship: ${facet}` });
      }
    }
    if (
      !sidecar.broader.length &&
      !sidecar.facets.length &&
      sidecar.skillKind !== 'router' &&
      !hasInboundHierarchy.has(sidecar.name)
    ) {
      gaps.push({
        skill: sidecar.name,
        issue: 'isolated package has no hierarchy or facet relationship',
      });
    }
    return gaps;
  });
}

function evaluationCoverageGaps(
  catalog: V5SkillPackageCatalog,
): Array<{ skill: string; issues: string[] }> {
  return catalog.packages.flatMap((skillPackage) => {
    const issues: string[] = [];
    const routingCounts = new Map<string, number>();
    for (const row of skillPackage.evaluation.routing) {
      routingCounts.set(row.category, (routingCounts.get(row.category) ?? 0) + 1);
    }
    if ((routingCounts.get('positive') ?? 0) < 2)
      issues.push('fewer than two held-out positive routing cases');
    if ((routingCounts.get('negative') ?? 0) < 2)
      issues.push('fewer than two held-out negative routing cases');
    if ((routingCounts.get('ambiguous') ?? 0) < 1)
      issues.push('missing held-out ambiguous routing case');
    if ((routingCounts.get('adversarial') ?? 0) < 1)
      issues.push('missing held-out adversarial routing case');
    if (skillPackage.evaluation.tasks.length < 2) issues.push('fewer than two full-task fixtures');
    for (const task of skillPackage.evaluation.tasks) {
      if (task.maturity !== 'individual')
        issues.push(`${task.id}: task is not individually authored`);
      if (!task.scorers.some((scorer) => scorer.kind === 'deterministic')) {
        issues.push(`${task.id}: missing deterministic scorer`);
      }
      const blindScorers = task.scorers.filter((scorer) => scorer.kind === 'blind-semantic');
      if (!blindScorers.length) {
        issues.push(`${task.id}: missing blind-semantic scorer`);
      } else if (
        blindScorers.some(
          (scorer) =>
            !scorer.blindTo?.includes('skill-variant') ||
            !scorer.blindTo?.includes('expected-outcome'),
        )
      ) {
        issues.push(`${task.id}: blind-semantic scorer can see variant or intended outcome`);
      }
    }
    return issues.length ? [{ skill: skillPackage.sidecar.name, issues }] : [];
  });
}

export function auditV5SkillLibraryQuality(
  catalog: V5SkillPackageCatalog,
  now = new Date(),
): V5SkillLibraryQualityAudit {
  const rows = catalog.packages.map((skillPackage) => packageRow(skillPackage, now));
  const names = new Set(catalog.packages.map((skillPackage) => skillPackage.sidecar.name));
  const missingRoutingReferences = catalog.packages.flatMap((skillPackage) => {
    const targets = explicitSkillReferences(skillPackage.instructions).filter(
      (name) => !names.has(name),
    );
    return targets.length ? [{ skill: skillPackage.sidecar.name, targets }] : [];
  });
  const byHash = new Map<string, string[]>();
  for (const row of rows) byHash.set(row.bodyHash, [...(byHash.get(row.bodyHash) ?? []), row.name]);
  const paragraphOwners = new Map<string, Set<string>>();
  for (const skillPackage of catalog.packages) {
    for (const paragraph of instructionParagraphs(skillPackage.instructions)) {
      if (paragraph.length < 240) continue;
      const owners = paragraphOwners.get(paragraph) ?? new Set<string>();
      owners.add(skillPackage.sidecar.name);
      paragraphOwners.set(paragraph, owners);
    }
  }
  return {
    schemaVersion: 1,
    packageCount: rows.length,
    catalogErrors: [...catalog.errors],
    catalogWarnings: [...catalog.warnings],
    genericRoutingPackages: catalog.packages
      .map((skillPackage) => ({
        skill: skillPackage.sidecar.name,
        publicCases: [
          ...skillPackage.sidecar.routing.positive,
          ...skillPackage.sidecar.routing.negative,
          ...skillPackage.sidecar.routing.ambiguous.map((item) => item.prompt),
          ...skillPackage.sidecar.routing.adversarial.map((item) => item.prompt),
        ].filter(isScaffoldRoutingPrompt).length,
        heldOutCaseIds: skillPackage.evaluation.routing
          .filter((item) => isScaffoldRoutingPrompt(item.prompt))
          .map((item) => item.id),
      }))
      .filter((item) => item.publicCases || item.heldOutCaseIds.length),
    maturityCounts: {
      individual: rows.filter((row) => row.authoringMaturity === 'individual').length,
      scaffold: rows.filter((row) => row.authoringMaturity === 'scaffold').length,
    },
    stalePackages: rows.filter((row) => row.staleSourceCount > 0).map((row) => row.name),
    weakSourceAuthorityPackages: rows
      .filter((row) => row.authoritativeSourceCount === 0)
      .map((row) => row.name),
    missingIndividualTaskPackages: rows
      .filter((row) => row.individualFullTaskCount !== row.fullTaskCount)
      .map((row) => row.name),
    evaluationCoverageGaps: evaluationCoverageGaps(catalog),
    portabilityViolations: rows
      .filter((row) => row.portabilityIssues.length > 0)
      .map((row) => ({ skill: row.name, issues: row.portabilityIssues })),
    genericBodyPackages: rows
      .filter((row) => row.genericMarkers.length > 0)
      .map((row) => ({ skill: row.name, markers: row.genericMarkers })),
    genericTaskPackages: rows
      .filter((row) => row.genericTaskFixtureIds.length > 0)
      .map((row) => ({ skill: row.name, fixtureIds: row.genericTaskFixtureIds })),
    duplicateBodyGroups: [...byHash.values()].filter((names) => names.length > 1),
    repeatedParagraphPackages: rows
      .filter((row) => row.repeatedParagraphs.length)
      .map((row) => ({ skill: row.name, paragraphs: row.repeatedParagraphs })),
    sharedBoilerplateGroups: [...paragraphOwners]
      .filter(([, owners]) => owners.size >= 5)
      .map(([paragraph, owners]) => ({ paragraph, skills: [...owners].sort() })),
    proseEmDashPackages: rows.filter((row) => row.proseEmDashCount).map((row) => row.name),
    missingRoutingReferences,
    hierarchyGaps: hierarchyGaps(catalog),
    stats: {
      bodyChars: summarize(rows.map((row) => row.bodyChars)),
      bodyWords: summarize(rows.map((row) => row.bodyWords)),
      sources: summarize(rows.map((row) => row.sourceCount)),
      heldOutRouting: summarize(rows.map((row) => row.heldOutRoutingCount)),
      fullTasks: summarize(rows.map((row) => row.fullTaskCount)),
    },
    rows,
  };
}
