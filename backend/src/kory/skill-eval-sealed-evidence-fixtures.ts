import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import type {
  SkillEvalDeterministicScore,
  SkillEvalDeterministicScorer,
  SkillEvalFixtureMaterializer,
} from './skill-eval-execution';
import type { SkillEvalScenarioV3 } from './skill-eval-harness';
import { readFixtureText, readJsonArtifact, writeFixtureFile } from './skill-eval-fixture-helpers';

/**
 * Closed-packet professional judgment tasks that can be exercised without pretending a
 * browser, device, live service, external corpus, or runtime simulation exists.
 *
 * This is intentionally a scenario allowlist. New tasks stay fail-closed until someone
 * deliberately decides that a sealed evidence packet is faithful to the task contract.
 */
export const SEALED_EVIDENCE_SCENARIO_IDS = [
  'content-error-design-full-task-compiler-diagnostics',
  'content-error-design-full-task-offline-sync-language',
  'contract-analysis-full-task-1-individual',
  'contract-analysis-full-task-2-individual',
  'customer-success-full-task-1-individual',
  'customer-success-full-task-2-individual',
  'documents-communication-full-task-2-individual',
  'executive-communication-full-task-1-individual',
  'executive-communication-full-task-2-individual',
  'experimental-analysis-full-task-1-individual',
  'experimental-analysis-full-task-2-individual',
  'experimentation-ab-testing-full-task-1-individual',
  'experimentation-ab-testing-full-task-2-individual',
  'exploratory-data-analysis-full-task-1-individual',
  'exploratory-data-analysis-full-task-2-individual',
  'financial-modeling-full-task-1-individual',
  'financial-modeling-full-task-2-individual',
  'growth-engineering-full-task-1-individual',
  'growth-engineering-full-task-2-individual',
  'human-experience-full-task-cross-channel-recovery',
  'human-experience-full-task-operator-interruption-recovery',
  'information-architecture-full-task-developer-platform-docs',
  'information-architecture-full-task-role-aware-settings',
  'instructional-communication-full-task-2-individual',
  'interface-usability-testing-full-task-1',
  'interface-usability-testing-full-task-2',
  'market-strategy-full-task-1-individual',
  'market-strategy-full-task-2-individual',
  'marketing-strategy-full-task-1-individual',
  'marketing-strategy-full-task-2-individual',
  'operational-data-analysis-full-task-1-individual',
  'operational-data-analysis-full-task-2-individual',
  'planning-full-task-1-individual',
  'pricing-monetization-full-task-1-individual',
  'pricing-monetization-full-task-2-individual',
  'procurement-vendor-evaluation-full-task-1-individual',
  'procurement-vendor-evaluation-full-task-2-individual',
  'product-analytics-full-task-1-individual',
  'product-analytics-full-task-2-individual',
  'product-management-full-task-1-individual',
  'product-management-full-task-2-individual',
  'project-program-management-full-task-1-individual',
  'project-program-management-full-task-2-individual',
  'release-planning-full-task-1-individual',
  'release-planning-full-task-2-individual',
  'sales-engineering-full-task-1-individual',
  'sales-engineering-full-task-2-individual',
  'startup-operations-full-task-1-individual',
  'startup-operations-full-task-2-individual',
  'statistical-inference-full-task-1-individual',
  'statistical-inference-full-task-2-individual',
  'technical-communication-full-task-2-individual',
  'usability-evaluation-full-task-account-recovery',
  'user-research-full-task-decision-linked-discovery',
  'user-research-full-task-mixed-method-prevalence-boundary',
] as const;

const scenarioIds = new Set<string>(SEALED_EVIDENCE_SCENARIO_IDS);

type EvidenceStatus = 'provided' | 'evaluation-constraint';
type ClaimConfidence = 'observed' | 'inferred' | 'assumption' | 'unresolved';
type VerificationStatus = 'passed' | 'failed' | 'unavailable' | 'not-applicable';

interface SealedEvidenceRecord {
  id: string;
  status: EvidenceStatus;
  text: string;
}

interface SealedEvidencePacket {
  schemaVersion: 1;
  scenarioId: string;
  skill: string;
  startingState: string;
  evidenceBoundary: string;
  evidence: SealedEvidenceRecord[];
  falsifiableChecks: Array<{ id: string; assertion: string }>;
  requiredEvidence: string[];
  requiredArtifacts: string[];
}

interface EvidenceMapArtifact {
  name: string;
  status: 'produced' | 'external-evaluator' | 'unavailable';
  note?: string;
}

interface EvidenceMap {
  claims?: Array<{
    claim?: string;
    evidenceIds?: string[];
    confidence?: ClaimConfidence;
  }>;
  verification?: Array<{
    checkId?: string;
    status?: VerificationStatus;
    evidence?: string;
  }>;
  artifacts?: EvidenceMapArtifact[];
  limitations?: string[];
}

const RESULT_STARTER = '# Result\n\nTODO: complete the task from the sealed evidence packet.\n';
const VERIFICATION_STARTER =
  '# Verification\n\nTODO: record success, negative-path, recovery, and unavailable checks.\n';
const MAP_STARTER = `${JSON.stringify(
  { claims: [], verification: [], artifacts: [], limitations: [] } satisfies EvidenceMap,
  null,
  2,
)}\n`;

function isEvaluationConstraint(text: string): boolean {
  return /\b(?:paired same-model|parent\/child\/neighbor|hierarchy boundary fixture|routing decoy|domain-specific tempting anti-pattern|representative negative|identical starting snapshot)\b/iu.test(
    text,
  );
}

function packetFor(scenario: SkillEvalScenarioV3): SealedEvidencePacket {
  if (!scenarioIds.has(scenario.id))
    throw new Error(`Unapproved sealed-evidence scenario ${scenario.id}`);
  if (scenario.environment.kind !== 'synthetic') {
    throw new Error(`Sealed-evidence scenario ${scenario.id} must remain synthetic`);
  }
  const evidence = scenario.environment.requirements.map((text, index) => ({
    id: `E${String(index + 1).padStart(2, '0')}`,
    status: isEvaluationConstraint(text) ? 'evaluation-constraint' : 'provided',
    text,
  })) satisfies SealedEvidenceRecord[];
  return {
    schemaVersion: 1,
    scenarioId: scenario.id,
    skill: scenario.skill,
    startingState: scenario.environment.startingState,
    evidenceBoundary:
      'This is an authored synthetic closed packet. Treat only the records below as supplied facts. Do not invent missing values, source text, observations, measurements, approvals, or external verification. Mark unsupported work unavailable or unresolved.',
    evidence,
    falsifiableChecks: scenario.falsifiableChecks.map(({ id, assertion }) => ({ id, assertion })),
    requiredEvidence: [...scenario.requiredEvidence],
    requiredArtifacts: [...scenario.requiredArtifacts],
  };
}

function readRegularText(root: string, path: string): string | null {
  try {
    const stat = lstatSync(join(root, path));
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    return readFixtureText(root, path);
  } catch {
    return null;
  }
}

function packetText(packet: SealedEvidencePacket): string {
  return `${JSON.stringify(packet, null, 2)}\n`;
}

function readmeFor(packet: SealedEvidencePacket): string {
  return `# Sealed evidence evaluation\n\nComplete the task in the evaluator prompt using only the authored evidence in \`evidence-packet.json\`. This fixture intentionally provides no network, browser, device, live service, hidden corpus, or external account. A statement that requires evidence not present in the packet must be labeled inferred, assumption, unresolved, or unavailable rather than invented.\n\nThe packet and this README are evaluator-owned fixed inputs. Do not modify them.\n\nCreate all three candidate-owned outputs:\n\n1. \`result.md\` — the substantive decision, analysis, plan, communication, or recommendation requested by the task.\n2. \`verification.md\` — concrete verification notes, including negative/recovery paths and explicit unavailable checks.\n3. \`evidence-map.json\` — structured traceability with this shape:\n\n\`\`\`json\n{\n  "claims": [\n    { "claim": "material claim", "evidenceIds": ["E01"], "confidence": "observed" }\n  ],\n  "verification": [\n    { "checkId": "a falsifiable check id from the packet", "status": "passed", "evidence": "what supports the status" }\n  ],\n  "artifacts": [\n    { "name": "required artifact name from the packet", "status": "produced", "note": "where/how it is represented" }\n  ],\n  "limitations": ["important unresolved or unavailable evidence"]\n}\n\`\`\`\n\nAllowed claim confidence values: \`observed\`, \`inferred\`, \`assumption\`, \`unresolved\`. Allowed verification status values: \`passed\`, \`failed\`, \`unavailable\`, \`not-applicable\`.\n\nEvery provided evidence record must be traceable from at least one material claim. Every falsifiable check must have a verification row. Required artifacts created by the candidate use \`produced\`; paired-run or evaluator-owned comparison artifacts use \`external-evaluator\`. If a requested artifact cannot honestly be created from the packet, use \`unavailable\` and explain why.\n\nDeterministic scoring checks packet integrity, traceability, artifact presence, explicit uncertainty, and verification coverage only. It does not certify domain correctness. Semantic quality remains a separate blind evaluation.\n\nScenario: ${packet.scenarioId}\nSkill: ${packet.skill}\nStarting state: ${packet.startingState}\n`;
}

function fixedFiles(scenario: SkillEvalScenarioV3): Record<string, string> {
  const packet = packetFor(scenario);
  return {
    'README.md': readmeFor(packet),
    'evidence-packet.json': packetText(packet),
  };
}

function isExternalArtifact(name: string): boolean {
  return /\b(?:paired|comparison|experiment|evaluation)\b/iu.test(name);
}

function requiresUncertainty(packet: SealedEvidencePacket): boolean {
  return packet.evidence.some(
    ({ status, text }) =>
      status === 'provided' &&
      /\b(?:uncertain|unknown|incomplete|missing|partial|pending|unavailable|unresolved|conflict|ambiguity|mismatch|loss)\b/iu.test(
        text,
      ),
  );
}

export function scoreSealedEvidenceFixture(
  scenario: SkillEvalScenarioV3,
  root: string,
): SkillEvalDeterministicScore {
  const packet = packetFor(scenario);
  const fixed = fixedFiles(scenario);
  const checks: Array<{ name: string; passed: boolean }> = [];
  const check = (name: string, passed: boolean) => checks.push({ name, passed });

  for (const [path, expected] of Object.entries(fixed)) {
    check(`${path} integrity`, readRegularText(root, path) === expected);
  }

  const result = readRegularText(root, 'result.md');
  const verificationText = readRegularText(root, 'verification.md');
  const mapText = readRegularText(root, 'evidence-map.json');
  const map = readJsonArtifact<EvidenceMap>(root, 'evidence-map.json');
  check(
    'substantive result artifact',
    result !== null && result !== RESULT_STARTER && result.trim().length >= 200,
  );
  check(
    'substantive verification artifact',
    verificationText !== null &&
      verificationText !== VERIFICATION_STARTER &&
      verificationText.trim().length >= 100,
  );
  check('structured evidence map', mapText !== null && mapText !== MAP_STARTER && map !== null);

  const claims = Array.isArray(map?.claims) ? map.claims : [];
  const providedIds = new Set(
    packet.evidence.filter(({ status }) => status === 'provided').map(({ id }) => id),
  );
  const knownIds = new Set(packet.evidence.map(({ id }) => id));
  const validConfidence = new Set<ClaimConfidence>([
    'observed',
    'inferred',
    'assumption',
    'unresolved',
  ]);
  const claimRowsValid =
    claims.length > 0 &&
    claims.every((claim) => {
      const ids = Array.isArray(claim.evidenceIds) ? claim.evidenceIds : [];
      const confidence = claim.confidence;
      const evidenceValid = ids.every((id) => typeof id === 'string' && knownIds.has(id));
      const unsupportedButLabeled =
        ids.length === 0 &&
        (confidence === 'inferred' || confidence === 'assumption' || confidence === 'unresolved');
      return (
        typeof claim.claim === 'string' &&
        claim.claim.trim().length >= 12 &&
        confidence !== undefined &&
        validConfidence.has(confidence) &&
        evidenceValid &&
        (ids.length > 0 || unsupportedButLabeled)
      );
    });
  check('claim schema and evidence references', claimRowsValid);

  const citedIds = new Set(
    claims.flatMap((claim) => (Array.isArray(claim.evidenceIds) ? claim.evidenceIds : [])),
  );
  check(
    'provided evidence traceability',
    providedIds.size > 0 && [...providedIds].every((id) => citedIds.has(id)),
  );

  const verification = Array.isArray(map?.verification) ? map.verification : [];
  const validVerificationStatus = new Set<VerificationStatus>([
    'passed',
    'failed',
    'unavailable',
    'not-applicable',
  ]);
  const verificationByCheck = new Map(
    verification
      .filter(
        (row) =>
          typeof row.checkId === 'string' &&
          typeof row.status === 'string' &&
          validVerificationStatus.has(row.status as VerificationStatus) &&
          typeof row.evidence === 'string' &&
          row.evidence.trim().length >= 8,
      )
      .map((row) => [row.checkId!, row]),
  );
  check(
    'falsifiable check coverage',
    packet.falsifiableChecks.length > 0 &&
      packet.falsifiableChecks.every(({ id }) => verificationByCheck.has(id)),
  );

  const artifactRows = Array.isArray(map?.artifacts) ? map.artifacts : [];
  const artifactsByName = new Map(
    artifactRows
      .filter(
        (row) =>
          row &&
          typeof row.name === 'string' &&
          (row.status === 'produced' ||
            row.status === 'external-evaluator' ||
            row.status === 'unavailable'),
      )
      .map((row) => [row.name, row]),
  );
  check(
    'required artifact accounting',
    packet.requiredArtifacts.every((name) => {
      const row = artifactsByName.get(name);
      if (!row) return false;
      if (isExternalArtifact(name)) return row.status === 'external-evaluator';
      if (row.status === 'produced') return true;
      return (
        row.status === 'unavailable' && typeof row.note === 'string' && row.note.trim().length >= 12
      );
    }),
  );

  const limitations = Array.isArray(map?.limitations)
    ? map.limitations.filter(
        (item): item is string => typeof item === 'string' && item.trim().length >= 8,
      )
    : [];
  const uncertaintyPreserved =
    !requiresUncertainty(packet) ||
    limitations.length > 0 ||
    claims.some(
      ({ confidence }) =>
        confidence === 'inferred' || confidence === 'assumption' || confidence === 'unresolved',
    ) ||
    verification.some(({ status }) => status === 'unavailable' || status === 'failed');
  check('uncertainty and unavailable evidence preserved', uncertaintyPreserved);

  const immutableInputsPassed = checks
    .filter(({ name }) => name.endsWith('integrity'))
    .every(({ passed }) => passed);
  const passed = checks.every(({ passed }) => passed);
  return {
    passed,
    quality: checks.filter(({ passed }) => passed).length / checks.length,
    verification: passed ? 1 : 0,
    integrityFailure: !immutableInputsPassed,
    evidence: [
      ...checks.map(({ name, passed: itemPassed }) => `${name}: ${itemPassed ? 'pass' : 'fail'}`),
      'Closed-packet deterministic scoring covers integrity, traceability, structure, and uncertainty only; domain correctness still requires blind semantic review.',
    ],
  };
}

export const SEALED_EVIDENCE_SKILL_EVAL_MATERIALIZERS: readonly SkillEvalFixtureMaterializer[] = [
  {
    id: 'sealed-evidence/professional-judgment@1',
    matches: (scenario) =>
      scenarioIds.has(scenario.id) && scenario.environment.kind === 'synthetic',
    materialize: (root, scenario) => {
      for (const [path, content] of Object.entries(fixedFiles(scenario))) {
        writeFixtureFile(root, path, content);
      }
      writeFixtureFile(root, 'result.md', RESULT_STARTER);
      writeFixtureFile(root, 'verification.md', VERIFICATION_STARTER);
      writeFixtureFile(root, 'evidence-map.json', MAP_STARTER);
    },
  },
];

export const SEALED_EVIDENCE_SKILL_EVAL_SCORERS: readonly SkillEvalDeterministicScorer[] = [
  {
    id: 'sealed-evidence/professional-judgment-scorer@1',
    scenarioIds: [...SEALED_EVIDENCE_SCENARIO_IDS],
    score: ({ scenario, workingDirectory }) =>
      scoreSealedEvidenceFixture(scenario, workingDirectory),
  },
];
