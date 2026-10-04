import type { V5FullTaskFixture } from './skill-packages';

export interface BlindReviewArtifact {
  finalOutput: string;
  executionEvidence: string[];
  changes: Array<{
    path: string;
    change: string;
    beforeSha256: string | null;
    afterSha256: string | null;
    beforeText?: string;
    afterText?: string;
  }>;
}

export interface BlindPairExecutionEvidence {
  matchedPair: true;
  sameScenario: true;
  sameProviderModel: true;
  sameHarness: true;
  sameEvaluationContract: true;
  sameMaterializer: true;
  sameDeterministicScorer: true;
  randomizedArmIdentity: true;
  evidenceOwner: 'evaluation-harness';
}

export interface BlindJudgeRubricResult {
  artifactA: { evidence: string[] };
  artifactB: { evidence: string[] };
  rationale: string[];
}

export function blindJudgeQuoteIsStructural(tail: string): boolean {
  const normalized = tail.replace(/^(\s*)\\+(?=[,\]}:])/u, '$1').trimStart();
  if (!normalized) return true;
  const first = normalized[0]!;
  if (first === ':' || first === ']' || first === '}') return true;
  if (first !== ',') return false;
  const afterComma = normalized.slice(1).trimStart();
  if (!afterComma) return true;
  return /^(?:["\[{]|-?\d|true\b|false\b|null\b)/u.test(afterComma);
}

const ABSENCE_CRITICISM =
  /\b(?:lack(?:s|ing)?|missing|without|no explicit|does not (?:provide|include|establish|show|document)|fails? to (?:provide|include|establish|show|document))\b/iu;
const EVALUATOR_OWNED_META_REQUIREMENT =
  /\b(?:hierarch(?:y|ical)[^.\n]{0,70}(?:boundary|rationale|selection)|specialist[^.\n]{0,70}(?:selection|rationale)|skill[^.\n]{0,50}(?:selection|rationale)|paired[^.\n]{0,70}(?:skill|no[ -]?skill|evaluation|run)|skill[ -]?(?:vs|versus)[ -]?no[ -]?skill)\b/iu;
const EXPLICIT_NO_META_PENALTY =
  /\b(?:no penalty (?:is )?assigned|not penalized|is not penalized|does not penalize|do not penalize)\b/iu;

/** Reject blind adjudications that penalize evaluator-owned meta evidence. */
export function findBlindJudgeRubricViolation(result: BlindJudgeRubricResult): string | null {
  const statements = [
    ...result.artifactA.evidence,
    ...result.artifactB.evidence,
    ...result.rationale,
  ];
  const violation = statements.find(
    (statement) =>
      ABSENCE_CRITICISM.test(statement) &&
      EVALUATOR_OWNED_META_REQUIREMENT.test(statement) &&
      !EXPLICIT_NO_META_PENALTY.test(statement),
  );
  return violation ?? null;
}

export function buildBlindReviewJudgePrompt(input: {
  task: V5FullTaskFixture;
  artifactA: BlindReviewArtifact;
  artifactB: BlindReviewArtifact;
  pairEvidence: BlindPairExecutionEvidence;
}): string {
  return [
    'You are an independent blind semantic evaluator.',
    'Two anonymous agents attempted the same task. You are not told which agent received any extra guidance, and you must not infer or speculate about that hidden condition.',
    'Judge each artifact independently against the task contract. Do not reward matching wording, verbosity, or references to a skill. Focus on behavioral correctness, scope discipline, evidence quality, preservation of required facts, negative paths, recovery behavior, and whether completion claims are actually supported.',
    'The artifact bundle may include harness captured execution evidence and before and after file snapshots. Treat that as observed evidence, not as an agent claim.',
    'executionEvidence is supplied by the host after the agent attempt, including deterministic scorer observations. An agent can truthfully report that it could not run a check even when the host subsequently runs that check successfully. Those observations have different owners and times; that difference alone is not an integrity failure.',
    'Attribute a completion claim to its actual source. Penalize an agent for fabricated or overstated verification only when its finalOutput or authored file content makes that unsupported claim. Do not attribute a host scorer statement to the agent, require the agent to predict later host results, or treat an honest statement of limited access as contradicting later host verification.',
    'Host evidence is not infallible. If a scorer result conflicts with concrete artifact behavior, identify the disputed check and evidence as a possible verifier defect. Keep instrument uncertainty separate from an agent integrity finding; a score label alone does not prove the task succeeded.',
    'The PAIR EXECUTION EVIDENCE section is evaluator owned evidence. It certifies that Artifact A and Artifact B are the two randomized arms of one matched same model comparison for this exact scenario and evaluation contract.',
    'When REQUIRED EVIDENCE or REQUIRED ARTIFACTS asks for paired skill and no skill run artifacts, paired evaluation evidence, or an equivalent pair label, the anonymous A and B bundle plus PAIR EXECUTION EVIDENCE satisfies the existence and provenance of that pair. Do not require either agent output to claim, create, or narrate evaluator owned pair evidence.',
    'The REQUIRED ARTIFACTS entries below are evaluation evidence labels for the overall harness. They are not literal filenames the agent was instructed to create unless the task itself says so. Judge whether the bundle substantively supplies the required evidence; do not require those exact label strings to appear.',
    'Routing and hierarchy selection are evaluated independently by the harness. Do not require the agent to narrate which skill was selected or provide meta level specialist selection rationale when the artifact itself respects the requested scope and neighboring responsibility boundaries.',
    'Never lower passed, quality, verification, or integrity because an artifact omits hierarchy narration, specialist selection rationale, skill names, or evaluator owned paired A/B evidence. If a draft criticism relies on one of those omissions, remove that criticism and score only the concrete task behavior and evidence.',
    'If a REQUIRED EVIDENCE or REQUIRED ARTIFACTS label describes routing, hierarchy selection, specialist selection, or paired skill versus no skill provenance, treat that meta level requirement as evaluator owned. The harness evidence in this prompt is authoritative for those concerns.',
    'Treat genuinely missing task evidence as missing. Do not assume unshown commands or tests passed.',
    'Return JSON only, with this exact shape:',
    '{"artifactA":{"passed":true,"quality":0.0,"verification":0.0,"integrityFailure":false,"evidence":["..."]},"artifactB":{"passed":true,"quality":0.0,"verification":0.0,"integrityFailure":false,"evidence":["..."]},"preference":"A","rationale":["..."]}',
    '',
    'TASK',
    input.task.prompt,
    '',
    'FALSIFIABLE CHECKS',
    JSON.stringify(input.task.falsifiableChecks, null, 2),
    '',
    'REQUIRED EVIDENCE',
    JSON.stringify(input.task.requiredEvidence, null, 2),
    '',
    'REQUIRED ARTIFACTS',
    JSON.stringify(input.task.requiredArtifacts, null, 2),
    '',
    'PAIR EXECUTION EVIDENCE',
    JSON.stringify(input.pairEvidence, null, 2),
    '',
    'ARTIFACT A',
    JSON.stringify(input.artifactA, null, 2),
    '',
    'ARTIFACT B',
    JSON.stringify(input.artifactB, null, 2),
  ].join('\n');
}
