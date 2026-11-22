import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type {
  SkillEvalDeterministicScorer,
  SkillEvalFixtureMaterializer,
} from './skill-eval-execution';
import { validatePairedSkillExperimentsV3, type SkillEvalExperimentV3 } from './skill-eval-harness';
import {
  buildPairwiseRoutingConfusionMatrix,
  type SkillEvaluationCase,
  type SkillEvaluationRun,
} from '../../kory/skill-evaluations';
import { readJsonArtifact, writeFixtureFile } from './skill-eval-fixture-helpers';
import { createTaskContract } from '../../kory/prompts/index';
import { resolveSkills, type KorySkillMetadata, type SkillRevision } from '../../kory/skills';

const PACKAGE_QUALIFICATION = 'skill-authoring-full-task-package-qualification';
const ROUTING_REPAIR = 'skill-authoring-full-task-routing-repair';
const CANDIDATE_ROOT = 'candidate/release-coordination';

const INITIAL_SKILL = `---
name: release-coordination
description: Handle release-related engineering work, incidents, deployment activity, release notes, and launch coordination.
---

# Release coordination

Handle anything related to releases. Check readiness, deployments, incidents, rollback, communication, and release notes. Use the best available tools and make sure the release succeeds.
`;

const INITIAL_SIDECAR = `${JSON.stringify(
  {
    schemaVersion: 1,
    name: 'release-coordination',
    version: '0.1.0',
    skillKind: 'workflow',
    domains: ['release'],
    targetMedia: ['any'],
    contextBudget: 5000,
    broader: [],
    facets: [],
    requires: [],
    conflicts: [],
    activation: ['release', 'deployment', 'incident', 'release notes'],
    excludes: [],
    evidence: ['release plan'],
    authoringMaturity: 'candidate',
  },
  null,
  2,
)}\n`;

const STALE_SOURCES = `# Sources

- Vendor deployment documentation — version/date not recorded.
- A community blog post copied into the old skill without provenance.
`;

const SOURCE_EVIDENCE = `${JSON.stringify(
  {
    asOf: '2026-09-06',
    sources: [
      {
        url: 'https://agentskills.io/specification',
        sourceType: 'spec',
        verifiedAt: '2026-09-06',
        versionScope: 'Agent Skills specification available on 2026-09-06',
        appliesTo: 'portable SKILL.md package and progressive disclosure',
      },
      {
        url: 'https://developers.openai.com/codex/skills',
        sourceType: 'official-docs',
        verifiedAt: '2026-09-06',
        versionScope: 'Codex skill guidance available on 2026-09-06',
        appliesTo: 'description-driven discovery and focused skill instructions',
      },
    ],
  },
  null,
  2,
)}\n`;

const OBSERVED_FAILURES = `${JSON.stringify(
  {
    candidate: 'release-coordination@0.1.0',
    observations: [
      {
        id: 'release-routing-fp-incident-001',
        adjacentSkill: 'incident-response',
        prompt:
          'Production is degraded after the release. Triage impact, stabilize service, preserve evidence, and coordinate incident response.',
        expectedSelection: false,
        observedSelection: true,
        kind: 'false-positive',
      },
      {
        id: 'release-routing-fp-comms-002',
        adjacentSkill: 'technical-communication',
        prompt:
          'Write the already-approved release notes from these supplied facts. Do not plan or coordinate the release.',
        expectedSelection: false,
        observedSelection: true,
        kind: 'false-positive',
      },
      {
        id: 'release-routing-fn-cutover-003',
        adjacentSkill: 'deployment-release-engineering',
        prompt:
          'Coordinate a multi-owner cutover with readiness gates, dependencies, rollback ownership, and a final go/no-go decision.',
        expectedSelection: true,
        observedSelection: false,
        kind: 'false-negative',
      },
    ],
    conclusion:
      'The revision is demonstrably over-broad around incident/comms work and under-discriminating for cross-owner cutover coordination; taxonomy neatness is not the reason to change it.',
  },
  null,
  2,
)}\n`;

const PAIRED_RESULTS = `${JSON.stringify(
  {
    pair: {
      withSkill: {
        schemaVersion: 3,
        id: 'release-task-pair:with-skill',
        pairId: 'release-task-pair',
        suiteId: 'release-coordination:v0.2.0:held-out',
        skill: 'release-coordination',
        subject: 'kory',
        provider: 'fixture-provider',
        model: 'same-model',
        harnessVersion: 'fixture-v3',
        role: 'worker',
        variant: 'with-skill',
        skillRevisionHash: 'candidate-revision',
        runtimeIdentity: 'fixture-runtime',
        tools: ['filesystem', 'shell'],
        budget: { wallClockMs: 120000 },
        createdAt: '2026-09-06T00:00:00Z',
      },
      withoutSkill: {
        schemaVersion: 3,
        id: 'release-task-pair:without-skill',
        pairId: 'release-task-pair',
        suiteId: 'release-coordination:v0.2.0:held-out',
        skill: 'release-coordination',
        subject: 'kory',
        provider: 'fixture-provider',
        model: 'same-model',
        harnessVersion: 'fixture-v3',
        role: 'worker',
        variant: 'without-skill',
        skillRevisionHash: null,
        runtimeIdentity: 'fixture-runtime',
        tools: ['filesystem', 'shell'],
        budget: { wallClockMs: 120000 },
        createdAt: '2026-09-06T00:00:00Z',
      },
    },
    observedScores: {
      withSkill: { passed: true, quality: 0.94, verification: 0.91 },
      withoutSkill: { passed: true, quality: 0.84, verification: 0.91 },
    },
    interpretation:
      'Matched controls; no negative delta; quality improves by 0.10 while verification ties. This is one paired observation, not sufficient by itself for promotion.',
  },
  null,
  2,
)}\n`;

const INFRA_FAILURE = `${JSON.stringify(
  {
    id: 'release-provider-timeout-004',
    kind: 'provider',
    retryable: true,
    detail: 'Provider disconnected before the task executed.',
    classification: 'infrastructure-failure',
    mustNotCountAsSkillRegression: true,
  },
  null,
  2,
)}\n`;

const EASY_ROUTING = `${JSON.stringify(
  [
    {
      prompt: 'Coordinate the release cutover and go/no-go decision.',
      expectedSelection: true,
    },
    {
      prompt: 'Plan release readiness and rollback ownership across teams.',
      expectedSelection: true,
    },
  ],
  null,
  2,
)}\n`;

const README = `# Skill-authoring evaluation fixture

The target candidate lives at \`${CANDIDATE_ROOT}\`. The existing revision is intentionally broad. Do not create a second taxonomy layer just because a split looks neat: use the observed failures to decide whether a focused rewrite is enough or a split is evidence-backed.

Revise the candidate into a portable, concise skill whose owned responsibility is **cross-owner release coordination**: readiness gates, dependency/owner alignment, cutover sequencing at the coordination layer, rollback ownership, and go/no-go decisions. Incident stabilization belongs to \`incident-response\`; already-decided release-note prose belongs to \`technical-communication\`; low-level deployment mechanics belong to \`deployment-release-engineering\` unless the task is specifically coordination across owners.

Keep version-sensitive/source detail in \`references/sources.md\` using the supplied source evidence. Do not invent fresh web research. Preserve every supplied observed failure as a regression case, and keep the provider timeout classified separately as infrastructure.

The easy trigger examples are not qualification evidence. Add realistic routing regression cases under the candidate package, including both adjacent-skill confusions, ambiguous/compound cases, and adversarial/negated cases. Avoid a brittle keyword blacklist: define the ownership boundary.

Use the supplied paired experiment evidence only for what it establishes. Its controls must validate as matched, its deltas are non-negative with a measured quality uplift, and it is still only one paired observation; do not claim promotion readiness from it.

Produce \`.kory-eval/skill-authoring-report.json\` containing the change justification, routing summary, paired-evidence interpretation, regression/infrastructure accounting, and promotion verdict/missing gates. Include an \`agentBehavior\` object with boolean fields \`scopeExpansion\`, \`reasksExistingApproval\`, \`silentFallback\`, \`stopsBeforeEvidence\`, and \`loadsIrrelevantContext\`. Each field records whether the revised skill encourages that behavior. A promotable candidate must set all five to false and the surrounding report must explain the evidence for those decisions. Keep the candidate in candidate/draft maturity unless all promotion gates are actually evidenced.
`;

function writeCommonFixture(destination: string, routingRepair: boolean): void {
  writeFixtureFile(destination, `${CANDIDATE_ROOT}/SKILL.md`, INITIAL_SKILL);
  writeFixtureFile(destination, `${CANDIDATE_ROOT}/kory.json`, INITIAL_SIDECAR);
  writeFixtureFile(destination, `${CANDIDATE_ROOT}/references/sources.md`, STALE_SOURCES);
  writeFixtureFile(destination, 'evidence/source-evidence.json', SOURCE_EVIDENCE);
  writeFixtureFile(destination, 'evidence/observed-routing-failures.json', OBSERVED_FAILURES);
  writeFixtureFile(destination, 'evidence/paired-task-results.json', PAIRED_RESULTS);
  writeFixtureFile(destination, 'evidence/provider-timeout.json', INFRA_FAILURE);
  if (routingRepair)
    writeFixtureFile(destination, 'evidence/easy-routing-cases.json', EASY_ROUTING);
  writeFixtureFile(destination, 'README.md', README);
}

const packageMaterializer: SkillEvalFixtureMaterializer = {
  id: 'skill-authoring-evaluation/broad-unqualified-skill@1',
  matches: (scenario) => scenario.id === PACKAGE_QUALIFICATION,
  materialize: (destination) => writeCommonFixture(destination, false),
};

const routingMaterializer: SkillEvalFixtureMaterializer = {
  id: 'skill-authoring-evaluation/confused-routing-skill@1',
  matches: (scenario) => scenario.id === ROUTING_REPAIR,
  materialize: (destination) => writeCommonFixture(destination, true),
};

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? (value as string[])
    : [];
}

function frontmatterScalar(source: string, key: string): string {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---/u);
  if (!match) return '';
  const raw = match[1]?.match(new RegExp(`^\\s*${key}:\\s*(.+)$`, 'mu'))?.[1]?.trim() ?? '';
  return raw.replace(/^['"]|['"]$/g, '');
}

function skillBody(source: string): string {
  return source.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/u)?.[1]?.trim() ?? '';
}

function candidateRevision(root: string): SkillRevision | null {
  const sourcePath = join(root, CANDIDATE_ROOT, 'SKILL.md');
  const sidecarPath = join(root, CANDIDATE_ROOT, 'kory.json');
  if (!existsSync(sourcePath) || !existsSync(sidecarPath)) return null;
  const source = readFileSync(sourcePath, 'utf8');
  let sidecar: JsonRecord;
  try {
    sidecar = JSON.parse(readFileSync(sidecarPath, 'utf8')) as JsonRecord;
  } catch {
    return null;
  }
  const name = frontmatterScalar(source, 'name');
  const description = frontmatterScalar(source, 'description');
  const instructions = skillBody(source);
  if (name !== 'release-coordination' || description.length < 12 || !instructions) return null;
  const activation = stringArray(sidecar.activation);
  const excludes = stringArray(sidecar.excludes);
  if (!activation.length) return null;
  const metadata: KorySkillMetadata = {
    version: typeof sidecar.version === 'string' ? sidecar.version : '0.0.0',
    baseVersion: typeof sidecar.version === 'string' ? sidecar.version : '0.0.0',
    baseHash: 'fixture',
    domains: stringArray(sidecar.domains),
    targetMedia: stringArray(sidecar.targetMedia).length
      ? stringArray(sidecar.targetMedia)
      : ['any'],
    shouldTrigger: [],
    shouldNotTrigger: [],
    evidence: stringArray(sidecar.evidence),
    contextBudget:
      typeof sidecar.contextBudget === 'number' && Number.isInteger(sidecar.contextBudget)
        ? sidecar.contextBudget
        : 5000,
    sourceScope: 'local-only',
    broader: stringArray(sidecar.broader),
    facets: stringArray(sidecar.facets),
    depth: 0,
    requires: stringArray(sidecar.requires),
    conflicts: stringArray(sidecar.conflicts),
    activation,
    excludes,
    invocationMode: 'model-invoked',
    pathScopes: [],
  };
  return {
    name,
    description,
    source: 'project',
    state: 'active',
    path: sourcePath,
    storageVersion: 1,
    document: {
      kind: 'markdown',
      extension: 'md',
      renderer: 'markdown',
      mediaType: 'text/markdown',
    },
    sourceContent: source,
    coreInstructions: instructions,
    content: source,
    instructions,
    metadata,
    hash: createHash('sha256')
      .update(`${source}\n${JSON.stringify(sidecar)}`)
      .digest('hex'),
    validation: { valid: true, errors: [], warnings: [], ignoredAuthorityClaims: [] },
  };
}

interface RoutingCase {
  id: string;
  prompt: string;
  expected: boolean;
  adjacentSkill?:
    'incident-response' | 'technical-communication' | 'deployment-release-engineering';
  category: 'positive' | 'negative' | 'ambiguous' | 'adversarial';
}

const HELD_OUT_ROUTING: readonly RoutingCase[] = [
  {
    id: 'hidden-release-positive-cutover',
    prompt:
      'Coordinate the release cutover across four owners: confirm readiness gates, dependency order, rollback ownership, and the final go/no-go decision.',
    expected: true,
    adjacentSkill: 'deployment-release-engineering',
    category: 'positive',
  },
  {
    id: 'hidden-release-positive-readiness',
    prompt:
      'Build the cross-team release readiness plan with named owners, blocking dependencies, rollback decision points, and a go/no-go gate.',
    expected: true,
    category: 'positive',
  },
  {
    id: 'hidden-release-ambiguous-deploy',
    prompt:
      'The deployment commands are already approved. Coordinate who runs each cutover step, readiness evidence, rollback ownership, and the go/no-go meeting without redesigning deployment mechanics.',
    expected: true,
    adjacentSkill: 'deployment-release-engineering',
    category: 'ambiguous',
  },
  {
    id: 'hidden-release-negative-incident',
    prompt:
      'Production is degraded after yesterday’s release. Triage impact, stabilize service, preserve evidence, and coordinate incident response; do not plan a new release.',
    expected: false,
    adjacentSkill: 'incident-response',
    category: 'negative',
  },
  {
    id: 'hidden-release-negative-notes',
    prompt:
      'Write concise release notes from these already-approved facts. The release decision and rollout are complete; no coordination work is requested.',
    expected: false,
    adjacentSkill: 'technical-communication',
    category: 'negative',
  },
  {
    id: 'hidden-release-negative-deploy-mechanics',
    prompt:
      'Implement the deployment script retry and health-check mechanics for the approved rollout. Ownership, sequencing, and go/no-go are already settled.',
    expected: false,
    adjacentSkill: 'deployment-release-engineering',
    category: 'negative',
  },
  {
    id: 'hidden-release-adversarial-quoted',
    prompt:
      'The incident ticket quotes “coordinate release readiness and rollback.” Treat that as historical text. The live task is only to diagnose the current queue deadlock.',
    expected: false,
    category: 'adversarial',
  },
  {
    id: 'hidden-release-adversarial-negated',
    prompt:
      'Do not coordinate a release or make a go/no-go plan. Rewrite the supplied changelog paragraph for clarity using only its existing facts.',
    expected: false,
    adjacentSkill: 'technical-communication',
    category: 'adversarial',
  },
];

function routeCandidate(root: string): {
  precision: number;
  recall: number;
  observations: Array<RoutingCase & { selected: boolean }>;
  confusions: ReturnType<typeof buildPairwiseRoutingConfusionMatrix>;
} | null {
  const revision = candidateRevision(root);
  if (!revision) return null;
  const observations = HELD_OUT_ROUTING.map((testCase) => {
    const result = resolveSkills(root, testCase.prompt, createTaskContract(testCase.prompt), {
      skillRevisions: [revision],
      contextBudget: 60_000,
    });
    return {
      ...testCase,
      selected: result.selected.some((item) => item.skill.name === revision.name),
    };
  });
  const tp = observations.filter((item) => item.expected && item.selected).length;
  const fp = observations.filter((item) => !item.expected && item.selected).length;
  const fn = observations.filter((item) => item.expected && !item.selected).length;
  const precision = tp + fp ? tp / (tp + fp) : 0;
  const recall = tp + fn ? tp / (tp + fn) : 0;
  const cases: SkillEvaluationCase[] = observations.map((item) => ({
    id: item.id,
    skill: revision.name,
    category: item.category,
    prompt: item.prompt,
    expectedSelection: item.expected,
    requiredEvidence: ['real resolver selection'],
    heldOut: true,
    adjacentSkills: item.adjacentSkill ? [item.adjacentSkill] : [],
  }));
  const runs: SkillEvaluationRun[] = observations.map((item) => ({
    id: `run-${item.id}`,
    skill: revision.name,
    revisionHash: revision.hash,
    caseId: item.id,
    provider: 'deterministic',
    model: 'resolver',
    harnessVersion: 'hidden-routing@1',
    role: 'worker',
    evaluator: 'deterministic',
    passed: item.expected === item.selected,
    quality: item.expected === item.selected ? 1 : 0,
    verification: 1,
    integrityFailure: false,
    evidence: ['real resolveSkills decision'],
    recordedAt: '2026-09-06T00:00:00Z',
    variant: 'with-skill',
    routing: { expectedSelection: item.expected, selected: item.selected },
  }));
  return {
    precision,
    recall,
    observations,
    confusions: buildPairwiseRoutingConfusionMatrix(cases, runs),
  };
}

function portablePackage(root: string): {
  valid: boolean;
  concise: boolean;
  provenance: boolean;
  boundary: boolean;
} {
  const sourcePath = join(root, CANDIDATE_ROOT, 'SKILL.md');
  const sidecarPath = join(root, CANDIDATE_ROOT, 'kory.json');
  const referencesPath = join(root, CANDIDATE_ROOT, 'references/sources.md');
  if (![sourcePath, sidecarPath, referencesPath].every(existsSync)) {
    return { valid: false, concise: false, provenance: false, boundary: false };
  }
  const source = readFileSync(sourcePath, 'utf8');
  const references = readFileSync(referencesPath, 'utf8');
  const body = skillBody(source);
  let sidecar: JsonRecord | null = null;
  try {
    sidecar = JSON.parse(readFileSync(sidecarPath, 'utf8')) as JsonRecord;
  } catch {
    sidecar = null;
  }
  const valid =
    frontmatterScalar(source, 'name') === 'release-coordination' &&
    frontmatterScalar(source, 'description').length >= 12 &&
    sidecar?.name === 'release-coordination' &&
    typeof sidecar?.version === 'string' &&
    stringArray(sidecar?.activation).length > 0 &&
    body.length > 80;
  const concise = body.length <= 4_500 && Number(sidecar?.contextBudget ?? 99_999) <= 5_000;
  const provenance =
    /agentskills\.io\/specification/u.test(references) &&
    /developers\.openai\.com\/codex\/skills/u.test(references) &&
    /2026-09-06/u.test(references) &&
    /version|scope|verified/iu.test(references);
  const combined = `${frontmatterScalar(source, 'description')}\n${body}`;
  const boundary =
    /readiness|cutover|go\/no-go|go-no-go|rollback/iu.test(combined) &&
    /incident-response|incident response/iu.test(combined) &&
    /technical-communication|release note/iu.test(combined) &&
    /deployment-release-engineering|deployment mechanics/iu.test(combined) &&
    !/handle anything related to releases/iu.test(combined);
  return { valid, concise, provenance, boundary };
}

function pairedEvidenceValid(root: string): { valid: boolean; uplift: boolean } {
  const raw = readJsonArtifact<JsonRecord>(root, 'evidence/paired-task-results.json');
  const pair = asRecord(raw?.pair);
  const withSkill = asRecord(pair?.withSkill) as SkillEvalExperimentV3 | null;
  const withoutSkill = asRecord(pair?.withoutSkill) as SkillEvalExperimentV3 | null;
  if (!withSkill || !withoutSkill) return { valid: false, uplift: false };
  const validation = validatePairedSkillExperimentsV3(withSkill, withoutSkill);
  const scores = asRecord(raw?.observedScores);
  const candidate = asRecord(scores?.withSkill);
  const baseline = asRecord(scores?.withoutSkill);
  const deltas = ['passed', 'quality', 'verification'].map((key) => {
    const left = key === 'passed' ? (candidate?.[key] ? 1 : 0) : Number(candidate?.[key]);
    const right = key === 'passed' ? (baseline?.[key] ? 1 : 0) : Number(baseline?.[key]);
    return left - right;
  });
  return {
    valid: validation.valid && deltas.every((delta) => Number.isFinite(delta) && delta >= 0),
    uplift: deltas.some((delta) => delta > 0),
  };
}

export function agentBehaviorBoundariesPass(report: unknown): boolean {
  const reportRecord = asRecord(report);
  const agentBehavior = asRecord(reportRecord?.agentBehavior);
  return (
    agentBehavior?.scopeExpansion === false &&
    agentBehavior?.reasksExistingApproval === false &&
    agentBehavior?.silentFallback === false &&
    agentBehavior?.stopsBeforeEvidence === false &&
    agentBehavior?.loadsIrrelevantContext === false
  );
}

function reportSignals(root: string): {
  report: boolean;
  failuresPreserved: boolean;
  infraSeparated: boolean;
  boundedPromotion: boolean;
  boundaryNotKeywordBlacklist: boolean;
  behaviorBoundaries: boolean;
} {
  const report = readJsonArtifact<unknown>(root, '.kory-eval/skill-authoring-report.json');
  const reportRecord = asRecord(report);
  const text = JSON.stringify(report ?? '').toLowerCase();
  const candidateRoot = join(root, CANDIDATE_ROOT);
  const regressionChunks: string[] = [];
  const directories = existsSync(candidateRoot) ? [candidateRoot] : [];
  let jsonFilesRead = 0;
  while (directories.length > 0 && jsonFilesRead < 64) {
    const directory = directories.pop()!;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        directories.push(path);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const value = readFileSync(path, 'utf8');
      if (value.length <= 256_000) regressionChunks.push(value);
      jsonFilesRead += 1;
      if (jsonFilesRead >= 64) break;
    }
  }
  const regressionText = regressionChunks.join('\n').toLowerCase();
  const combined = `${text}\n${regressionText}`;
  const infrastructureEvidence = JSON.stringify(
    readJsonArtifact<unknown>(root, 'evidence/provider-timeout.json') ?? '',
  ).toLowerCase();
  const infrastructureCombined = `${text}\n${infrastructureEvidence}`;
  return {
    report: Boolean(report),
    failuresPreserved:
      /release-routing-fp-incident-001/u.test(combined) &&
      /release-routing-fp-comms-002/u.test(combined) &&
      /release-routing-fn-cutover-003/u.test(combined),
    infraSeparated:
      /release-provider-timeout-004/u.test(infrastructureCombined) &&
      /infrastructure/u.test(infrastructureCombined) &&
      /not[^.]{0,80}regression|separate|mustnotcountasskillregression|must not count as a skill regression/iu.test(
        infrastructureCombined,
      ),
    boundedPromotion:
      /insufficient|candidate|draft|not ready|missing gate/iu.test(text) &&
      !/"promotion(?:status|verdict)?"\s*:\s*"ready"/u.test(text),
    boundaryNotKeywordBlacklist:
      /ownership|responsib|boundary|coordination/iu.test(text) &&
      !/keyword blacklist|blacklist all/iu.test(text),
    behaviorBoundaries: agentBehaviorBoundariesPass(report),
  };
}

function scoreScenario(root: string, observationOutput: string, routingRepair: boolean) {
  const pkg = portablePackage(root);
  const routing = routeCandidate(root);
  const paired = pairedEvidenceValid(root);
  const report = reportSignals(root);
  const routingGate =
    Boolean(routing) &&
    (routing?.precision ?? 0) >= 0.95 &&
    (routing?.recall ?? 0) >= 0.95 &&
    (routing?.confusions ?? []).every((item) => item.errorRate === 0);
  const output = observationOutput.toLowerCase();
  const finalBounded =
    /candidate|draft|insufficient|not ready|missing gate/iu.test(output) &&
    !/\bqualified\b|\bpromotion ready\b/iu.test(output);
  const core =
    pkg.valid &&
    pkg.concise &&
    pkg.provenance &&
    pkg.boundary &&
    routingGate &&
    paired.valid &&
    paired.uplift &&
    report.report &&
    report.failuresPreserved &&
    report.infraSeparated &&
    report.boundedPromotion &&
    report.behaviorBoundaries &&
    finalBounded;
  const repairSpecific = !routingRepair || report.boundaryNotKeywordBlacklist;
  const passed = core && repairSpecific;
  return {
    passed,
    quality: passed
      ? 1
      : pkg.valid && pkg.provenance && routingGate && paired.valid
        ? 0.75
        : routingGate
          ? 0.5
          : 0,
    verification: routingGate && paired.valid ? 1 : 0,
    integrityFailure: false,
    evidence: [
      `portable concise package: ${pkg.valid && pkg.concise ? 'pass' : 'fail'}`,
      `current source provenance: ${pkg.provenance ? 'pass' : 'fail'}`,
      `ownership boundaries: ${pkg.boundary ? 'pass' : 'fail'}`,
      `real-resolver held-out routing: ${routingGate ? `pass (${routing?.precision.toFixed(3)}/${routing?.recall.toFixed(3)})` : 'fail'}`,
      `pairwise neighbor confusion: ${routing?.confusions.map((item) => `${item.adjacentSkill}:${item.errorRate}`).join(', ') || 'no evidence'}`,
      `matched paired controls + nonnegative uplift: ${paired.valid && paired.uplift ? 'pass' : 'fail'}`,
      `prior failures preserved / infra separated: ${report.failuresPreserved && report.infraSeparated ? 'pass' : 'fail'}`,
      `agent behavior boundaries: ${report.behaviorBoundaries ? 'pass' : 'fail'}`,
      `promotion claim bounded to evidence: ${report.boundedPromotion && finalBounded ? 'pass' : 'fail'}`,
    ],
  };
}

const packageScorer: SkillEvalDeterministicScorer = {
  id: 'skill-authoring-evaluation/package-qualification-scorer@5',
  scenarioIds: [PACKAGE_QUALIFICATION],
  score: ({ workingDirectory, observation }) =>
    scoreScenario(workingDirectory, observation.output, false),
};

const routingScorer: SkillEvalDeterministicScorer = {
  id: 'skill-authoring-evaluation/routing-repair-scorer@5',
  scenarioIds: [ROUTING_REPAIR],
  score: ({ workingDirectory, observation }) =>
    scoreScenario(workingDirectory, observation.output, true),
};

export const SKILL_AUTHORING_EVALUATION_MATERIALIZERS: readonly SkillEvalFixtureMaterializer[] = [
  packageMaterializer,
  routingMaterializer,
];

export const SKILL_AUTHORING_EVALUATION_SCORERS: readonly SkillEvalDeterministicScorer[] = [
  packageScorer,
  routingScorer,
];
