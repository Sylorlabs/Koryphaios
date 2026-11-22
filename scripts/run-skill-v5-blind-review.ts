import { createHash } from 'node:crypto';
import { completePairForScenario, selectBlindReviewQueue } from '../backend/src/eval/skills/skill-eval-blind-review';
import { selectEligibleSkillEvaluationEvidence } from '../backend/src/eval/skills/skill-eval-eligibility';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  anonymousArtifact,
  MAX_BLIND_IMPORT_BYTES,
  readBoundedBlindFile,
  SNAPSHOT_HASH_EXPLANATION,
  verifyPreparedArtifactHashes,
  verifyPreparedCurrentBinding,
  verifyPreparedPromptBinding,
  writeProtectedBlindFile,
} from './blind-review-import-validation';
import {
  requireNativeStageOptIn,
  retainNativeBlindReviewEvidence,
  verifyNativeBlindReviewImport,
  type NativeStageEvidence,
} from './blind-review-native-import';
import { canonicalizePath } from '../backend/src/runtime/platform';
import { homedir } from 'node:os';
import { strictJson } from './reviewer-json';
import {
  BUILTIN_SKILL_EVAL_MATERIALIZERS,
  BUILTIN_SKILL_EVAL_SCORERS,
} from '../backend/src/eval/skills/skill-eval-fixtures';
import {
  CURRENT_SKILL_EVAL_CONTRACT_VERSION,
  listSkillEvaluationRuns,
  recordSkillEvaluationRuns,
  type SkillEvaluationRun,
} from '../backend/src/kory/skill-evaluations';
import {
  blindJudgeQuoteIsStructural,
  buildBlindReviewJudgePrompt,
  findBlindJudgeArtifactMismatch,
  findBlindJudgeRubricViolation,
  type BlindPairExecutionEvidence,
} from '../backend/src/eval/skills/skill-eval-blind-review';
import { loadV5SkillPackages, type V5FullTaskFixture } from '../backend/src/kory/skill-packages';
import { skillEvaluationV5ContractHash } from '../backend/src/eval/skills/skill-eval-contract-hash';
import type { SkillEvalScenarioV3 } from '../backend/src/eval/skills/skill-eval-harness';
import { listSkills } from '../backend/src/kory/skills';
import {
  getSkillSteward,
  isEligibleBlindReviewerProvenance,
} from '../backend/src/kory/skill-stewards';

const projectRoot = resolve(import.meta.dir, '..');
const evaluationContractVersion = CURRENT_SKILL_EVAL_CONTRACT_VERSION;
const BLIND_HARNESS_VERSION = 'v5-blind-semantic@8';
const BLIND_EVALUATOR_ID = 'independent-blind-semantic-v7';
/**
 * Record who actually graded, under its own name.
 *
 * No provider is the reviewer of record. Eligibility is independence from the
 * skill author plus a blind assignment, not membership of a preferred vendor, so
 * the label states the provider that produced the judgement and the skill it
 * graded. Nothing is rewritten to another channel's name.
 */
function blindReviewerDisplayLabel(
  skill: string,
  reviewer: { provider: string; model: string },
): string {
  return `${reviewer.provider} reviewer — ${skill}`;
}
const packages = loadV5SkillPackages(resolve(projectRoot, 'skills-v5')).packages;
const currentByName = new Map(
  listSkills(projectRoot)
    .filter((skill) => skill.state === 'active' && skill.validation.valid)
    .map((skill) => [skill.name, skill]),
);
const requested = process.argv
  .filter((argument) => argument.startsWith('--skill='))
  .map((argument) => argument.slice('--skill='.length).trim())
  .filter(Boolean);
const dryRun = process.argv.includes('--dry-run');
const prepareOnly = process.argv.includes('--prepare-only');
const ingestPath = process.argv
  .find((argument) => argument.startsWith('--ingest='))
  ?.slice('--ingest='.length)
  .trim();
const validateOnlyPath = process.argv
  .find((argument) => argument.startsWith('--validate-only='))
  ?.slice('--validate-only='.length)
  .trim();
const summaryOnly = process.argv.includes('--summary');
const retryFailed = process.argv.includes('--retry-failed');
const allowNativeStage = process.argv.includes('--allow-native-stage');
const concurrency = Number(
  process.argv
    .find((argument) => argument.startsWith('--concurrency='))
    ?.slice('--concurrency='.length) ||
    process.env.KORY_SKILL_BLIND_CONCURRENCY?.trim() ||
    '4',
);
const maxPerSkillArgument = process.argv
  .find((argument) => argument.startsWith('--max-per-skill='))
  ?.slice('--max-per-skill='.length);
const maxPerSkill = maxPerSkillArgument ? Number(maxPerSkillArgument) : Number.POSITIVE_INFINITY;
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) {
  throw new Error(`Invalid blind-review concurrency ${String(concurrency)}; expected 1-8`);
}
if (ingestPath && validateOnlyPath) {
  throw new Error('Choose --ingest or --validate-only, not both');
}
if (!dryRun && !prepareOnly && !ingestPath && !validateOnlyPath && !summaryOnly) {
  throw new Error(
    'Direct V5 blind judging is disabled. Use --prepare-only, delegate the anonymous assignment to an actual chatgpt-web/... reviewer, then use --validate-only=<result.json> or --ingest=<result.json>.',
  );
}
if (
  maxPerSkill !== Number.POSITIVE_INFINITY &&
  (!Number.isInteger(maxPerSkill) || maxPerSkill < 1)
) {
  throw new Error(`Invalid --max-per-skill value ${String(maxPerSkillArgument)}`);
}
const selectedPackages = requested.length
  ? requested.map((name) => {
      const skillPackage = packages.find((item) => item.sidecar.name === name);
      if (!skillPackage) throw new Error(`Unknown V5 skill package ${name}`);
      return skillPackage;
    })
  : packages;

const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

function currentEvaluationContract(
  skill: string,
  task: V5FullTaskFixture,
): {
  evaluationContractVersion: number;
  evaluationContractHash: string;
  materializerIds: string[];
  scorerIds: string[];
} | null {
  const skillPackage = packages.find((item) => item.sidecar.name === skill);
  if (!skillPackage) return null;
  // Match the same full-task scenario shape used by the execution campaign;
  // passing only a task silently breaks materializers that inspect skill/scope.
  const scenario: SkillEvalScenarioV3 = {
    ...task,
    skill,
    category: 'full-task',
    expectedSelection: true,
    expectedSkills: [],
    forbiddenSkills: [],
    heldOut: true,
    adjacentSkills: [],
    tags: ['held-out', 'full-task'],
  };
  const materializerIds = BUILTIN_SKILL_EVAL_MATERIALIZERS.filter((item) => item.matches(scenario))
    .map((item) => item.id)
    .sort();
  const scorerIds = BUILTIN_SKILL_EVAL_SCORERS.filter((item) => item.scenarioIds.includes(task.id))
    .map((item) => item.id)
    .sort();
  if (!materializerIds.length || !scorerIds.length) return null;
  return {
    evaluationContractVersion,
    materializerIds,
    scorerIds,
    evaluationContractHash: skillEvaluationV5ContractHash({
      contractVersion: evaluationContractVersion,
      skill,
      packageVersion: skillPackage.sidecar.version,
      scenario: task,
      materializerIds,
      scorerIds,
    }),
  };
}

function matchesCurrentSourceContract(
  run: SkillEvaluationRun,
  current: NonNullable<ReturnType<typeof currentEvaluationContract>>,
): boolean {
  return (
    run.evaluationContractVersion === current.evaluationContractVersion &&
    run.evaluationContractHash === current.evaluationContractHash &&
    typeof run.materializerId === 'string' &&
    current.materializerIds.includes(run.materializerId) &&
    typeof run.deterministicScorerId === 'string' &&
    current.scorerIds.includes(run.deterministicScorerId)
  );
}

interface JudgeArtifactScore {
  passed: boolean;
  quality: number;
  verification: number;
  integrityFailure: boolean;
  evidence: string[];
}

interface JudgeResult {
  artifactA: JudgeArtifactScore;
  artifactB: JudgeArtifactScore;
  preference: 'A' | 'B' | 'tie';
  rationale: string[];
}

function parseJudgeResult(output: string): JudgeResult {
  const fenced = output.match(/```(?:json)?\s*([\s\S]*?)```/iu)?.[1];
  const first = output.indexOf('{');
  const last = output.lastIndexOf('}');
  const candidate = fenced ?? (first >= 0 && last > first ? output.slice(first, last + 1) : output);
  const normalizedCandidate = (() => {
    try {
      JSON.parse(candidate.trim());
      return candidate.trim();
    } catch {
      // Repair an observed Web serialization error at the boundary between
      // an evidence array and the next top-level artifact key. Do this before
      // scanning quotes so the stray quote cannot consume the next object.
      const structuralCandidate = candidate.replace(
        /\\\],"\}(?=,"(?:artifactB|preference)"\s*:)/gu,
        '\\]}',
      );
      let inString = false;
      let escaped = false;
      let normalized = '';
      for (let index = 0; index < structuralCandidate.length; index += 1) {
        const char = structuralCandidate[index]!;
        const nextChar = structuralCandidate[index + 1];
        if (inString) {
          if (
            !escaped &&
            char === '\\' &&
            (nextChar === '[' ||
              nextChar === ']' ||
              nextChar === '_' ||
              nextChar === '`' ||
              nextChar === '*')
          ) {
            continue;
          }
          normalized += char;
          if (escaped) {
            escaped = false;
          } else if (char === '\\') {
            escaped = true;
          } else if (char === '"') {
            // Some Web reviewers quote a label inside an evidence sentence
            // without escaping it. Treat a quote as the string terminator
            // only when the following text is structurally a JSON boundary;
            // prose punctuation such as `"value", which ...` stays inside
            // the evidence string.
            const tail = structuralCandidate.slice(index + 1);
            if (blindJudgeQuoteIsStructural(tail)) {
              inString = false;
            } else {
              normalized = normalized.slice(0, -1) + '\\"';
            }
          }
          continue;
        }
        if (char === '"') {
          inString = true;
          normalized += char;
          continue;
        }
        if (char === '\\') {
          let runEnd = index;
          while (structuralCandidate[runEnd] === '\\') runEnd += 1;
          const following = structuralCandidate[runEnd];
          if (
            following === '[' ||
            following === ']' ||
            following === '_' ||
            following === '`' ||
            following === '*'
          ) {
            index = runEnd - 1;
            continue;
          }
        }
        normalized += char;
      }
      // A few otherwise structured responses omit the object delimiter
      // between an artifact score and the next top-level field.
      return (
        normalized
          // Some Web outputs add `,"}` after an evidence array. Repair only
          // this structural punctuation before the next known top-level key;
          // leave the scores, preference, and evidence text untouched.
          .replace(/\],"\}(?=,"(?:artifactB|preference)"\s*:)/gu, ']}')
          .replace(/\],(?="(?:artifactB|preference)"\s*:)/gu, ']},')
          .trim()
      );
    }
  })();
  const parsed = JSON.parse(normalizedCandidate) as Partial<JudgeResult>;
  const validScore = (value: unknown): value is JudgeArtifactScore => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const score = value as JudgeArtifactScore;
    return (
      typeof score.passed === 'boolean' &&
      typeof score.quality === 'number' &&
      score.quality >= 0 &&
      score.quality <= 1 &&
      typeof score.verification === 'number' &&
      score.verification >= 0 &&
      score.verification <= 1 &&
      typeof score.integrityFailure === 'boolean' &&
      Array.isArray(score.evidence) &&
      score.evidence.every((item) => typeof item === 'string')
    );
  };
  if (
    !validScore(parsed.artifactA) ||
    !validScore(parsed.artifactB) ||
    !['A', 'B', 'tie'].includes(parsed.preference ?? '') ||
    !Array.isArray(parsed.rationale) ||
    !parsed.rationale.every((item) => typeof item === 'string')
  ) {
    throw new Error('Blind judge returned an invalid adjudication schema');
  }
  const result = parsed as JudgeResult;
  const rubricViolation = findBlindJudgeRubricViolation(result);
  if (rubricViolation) {
    throw new Error(
      `Blind judge violated the evaluator-owned routing/hierarchy/pairing boundary: ${rubricViolation}`,
    );
  }
  return result;
}

const blindRoot = join(projectRoot, '.koryphaios', 'skills', 'blind-reviews');
const allRuns = listSkillEvaluationRuns(projectRoot);
const evidenceEligibility = selectEligibleSkillEvaluationEvidence(allRuns);
const requestedSkillNames = new Set(
  selectedPackages.map((skillPackage) => skillPackage.sidecar.name),
);
const relevantRunIds = new Set(
  allRuns
    .filter(
      (run) =>
        currentByName.get(run.skill)?.hash === run.revisionHash &&
        requestedSkillNames.has(run.skill),
    )
    .map((run) => run.id),
);
const excludedEvidence = evidenceEligibility.excludedEvidence.filter((item) =>
  relevantRunIds.has(item.runId),
);
const eligible: Array<{
  skill: string;
  task: V5FullTaskFixture;
  pair: { withSkill: SkillEvaluationRun; withoutSkill: SkillEvaluationRun };
}> = [];

for (const skillPackage of selectedPackages) {
  const revision = currentByName.get(skillPackage.sidecar.name);
  if (!revision) continue;
  const runs = evidenceEligibility.runs.filter(
    (run) => run.skill === skillPackage.sidecar.name && run.revisionHash === revision.hash,
  );
  for (const task of skillPackage.evaluation.tasks) {
    const current = currentEvaluationContract(skillPackage.sidecar.name, task);
    if (!current) continue;
    const pair = completePairForScenario(
      runs.filter((run) => matchesCurrentSourceContract(run, current)),
      task.id,
      current.evaluationContractHash,
    );
    if (pair) eligible.push({ skill: skillPackage.sidecar.name, task, pair });
  }
}

const currentBlindReviews = evidenceEligibility.runs.filter((run) => {
  if (
    run.evaluator !== 'blind-review' ||
    run.harnessVersion !== BLIND_HARNESS_VERSION ||
    run.protocolVersion !== 3 ||
    !run.comparisonId ||
    currentByName.get(run.skill)?.hash !== run.revisionHash
  ) {
    return false;
  }
  const skillPackage = packages.find((item) => item.sidecar.name === run.skill);
  const task = skillPackage?.evaluation.tasks.find((item) => item.id === run.scenarioId);
  const current = task ? currentEvaluationContract(run.skill, task) : null;
  if (!current || !matchesCurrentSourceContract(run, current)) {
    return false;
  }
  return isEligibleBlindReviewerProvenance(
    run.skill,
    run.evaluatorProvenance,
    getSkillSteward(projectRoot, run.skill),
  );
});
const blockingBlindReviews = retryFailed
  ? currentBlindReviews.filter((run) => run.passed)
  : currentBlindReviews;
const reviewedPairKeys = new Set(
  blockingBlindReviews.map(
    (run) => `${run.skill}\0${run.scenarioId ?? run.caseId}\0${run.comparisonId}`,
  ),
);
const pending = eligible.filter(
  (item) =>
    !reviewedPairKeys.has(
      `${item.skill}\0${item.task.id}\0${item.pair.withSkill.comparisonId ?? ''}`,
    ),
);
// A replaced pair is a new observation and needs its own adjudication; a pair that
// was already judged at its current identity is never re-reviewed. The per-skill
// cap bounds what this invocation stages, not the skill's lifetime review count,
// which used to freeze any skill holding two passing reviews on one case and leave
// a different case with no adjudication at all.
// A blind review exists to adjudicate whether a reviewer's prose judgement tracks the
// deterministic signal. On a pair where both arms scored identically there is nothing to
// adjudicate, and the reviewer correctly returns a tie, which reads as weak evidence when
// it is only weak staging. Stage the most discriminating pair for each skill first, with
// the newest pair as the tie breaker. No acceptance rule changes: the same reviewer, the
// same envelope, the same gate.
function pairDiscrimination(item: (typeof pending)[number]): number {
  const withSkill = item.pair.withSkill;
  const withoutSkill = item.pair.withoutSkill;
  const passGap = Math.abs(Number(Boolean(withSkill.passed)) - Number(Boolean(withoutSkill.passed)));
  const qualityGap = Math.abs((withSkill.quality ?? 0) - (withoutSkill.quality ?? 0));
  const verificationGap = Math.abs((withSkill.verification ?? 0) - (withoutSkill.verification ?? 0));
  return passGap * 2 + qualityGap + verificationGap;
}
const pendingByDiscrimination = [...pending].sort((left, right) => {
  const delta = pairDiscrimination(right) - pairDiscrimination(left);
  if (delta !== 0) return delta;
  const leftAt = [left.pair.withSkill.recordedAt, left.pair.withoutSkill.recordedAt].sort().at(-1)!;
  const rightAt = [right.pair.withSkill.recordedAt, right.pair.withoutSkill.recordedAt].sort().at(-1)!;
  return rightAt.localeCompare(leftAt);
});
const queue = selectBlindReviewQueue(
  pendingByDiscrimination.map((item) => ({
    skill: item.skill,
    scenarioId: item.task.id,
    comparisonId: item.pair.withSkill.comparisonId!,
    pairRecordedAt: [item.pair.withSkill.recordedAt, item.pair.withoutSkill.recordedAt].sort().at(-1)!,
  })),
  currentBlindReviews.map((run) => ({
    skill: run.skill,
    scenarioId: run.scenarioId ?? run.caseId,
    comparisonId: run.comparisonId,
    recordedAt: run.recordedAt,
  })),
  maxPerSkill,
).map((selected) => pending.find((item) =>
  item.skill === selected.skill && item.task.id === selected.scenarioId &&
  item.pair.withSkill.comparisonId === selected.comparisonId)!);

const persisted: SkillEvaluationRun[] = [];
const failures: Array<{ skill: string; scenarioId: string; detail: string }> = [];

interface PreparedAssignmentRecord {
  schemaVersion: 3;
  assignmentId: string;
  skill: string;
  scenarioId: string;
  pairId: string;
  revisionHash: string;
  suiteId?: string;
  evaluationContractHash?: string;
  evaluationContractVersion?: number;
  materializerId?: string;
  deterministicScorerId?: string;
  withIsA: boolean;
  promptSha256: string;
  artifactASha256: string;
  artifactBSha256: string;
  promptPath: string;
  preparedAt: string;
}

interface BlindReviewImportEnvelope {
  schemaVersion: 1;
  nativeStageEvidence?: NativeStageEvidence;
  reviewer: {
    agentId: string;
    provider: string;
    model: string;
  };
  reviews: Array<{
    assignmentId: string;
    output: string | JudgeResult;
  }>;
}

const pendingRoot = join(blindRoot, 'pending');

function assignmentIdFor(item: (typeof eligible)[number]): string {
  return `blind-v5-${sha256(
    `${item.skill}\0${item.task.id}\0${item.pair.withSkill.comparisonId ?? ''}`,
  ).slice(0, 20)}`;
}

function pairExecutionEvidence(
  withSkill: SkillEvaluationRun,
  withoutSkill: SkillEvaluationRun,
): BlindPairExecutionEvidence {
  if (
    withSkill.scenarioId !== withoutSkill.scenarioId ||
    withSkill.provider !== withoutSkill.provider ||
    withSkill.model !== withoutSkill.model ||
    withSkill.harnessVersion !== withoutSkill.harnessVersion ||
    withSkill.evaluationContractVersion !== withoutSkill.evaluationContractVersion ||
    withSkill.evaluationContractHash !== withoutSkill.evaluationContractHash ||
    withSkill.materializerId !== withoutSkill.materializerId ||
    withSkill.deterministicScorerId !== withoutSkill.deterministicScorerId
  ) {
    throw new Error('Blind review pair does not satisfy the matched execution contract');
  }
  return {
    matchedPair: true,
    sameScenario: true,
    sameProviderModel: true,
    sameHarness: true,
    sameEvaluationContract: true,
    sameMaterializer: true,
    sameDeterministicScorer: true,
    randomizedArmIdentity: true,
    evidenceOwner: 'evaluation-harness',
  };
}

function prepareAssignment(item: (typeof eligible)[number]): PreparedAssignmentRecord {
  const pairId = item.pair.withSkill.comparisonId!;
  const assignmentId = assignmentIdFor(item);
  const withArtifact = anonymousArtifact(item.pair.withSkill, item.skill);
  const withoutArtifact = anonymousArtifact(item.pair.withoutSkill, item.skill);
  if (
    JSON.stringify(withArtifact.publicContract) !== JSON.stringify(withoutArtifact.publicContract)
  ) {
    throw new Error(`Blind review pair ${pairId} has mismatched public contract snapshots`);
  }
  const withIsA = Number.parseInt(sha256(`${assignmentId}\0arm-order`).slice(0, 2), 16) % 2 === 0;
  const artifactA = withIsA ? withArtifact : withoutArtifact;
  const artifactB = withIsA ? withoutArtifact : withArtifact;
  const promptPath = join(pendingRoot, `${assignmentId}.prompt.txt`);
  const privatePath = join(pendingRoot, `${assignmentId}.private.json`);
  // Existing seals are historical bytes: never overwrite them to add guidance.
  if (existsSync(privatePath) || existsSync(promptPath)) {
    const existing = readPreparedAssignment(assignmentId);
    verifyPreparedCurrentBinding(existing, item.pair.withSkill);
    if (existing.withIsA !== withIsA)
      throw new Error(
        'Prepared blind assignment arm mapping differs from its sealed randomized order',
      );
    verifyPreparedArtifactHashes(existing, artifactA, artifactB);
    return existing;
  }
  const prompt = `${SNAPSHOT_HASH_EXPLANATION}\n\n${buildBlindReviewJudgePrompt({
    task: item.task,
    artifactA,
    artifactB,
    pairEvidence: pairExecutionEvidence(item.pair.withSkill, item.pair.withoutSkill),
  })}`;
  const record: PreparedAssignmentRecord = {
    schemaVersion: 3,
    assignmentId,
    skill: item.skill,
    scenarioId: item.task.id,
    pairId,
    revisionHash: item.pair.withSkill.revisionHash,
    suiteId: item.pair.withSkill.suiteId,
    evaluationContractHash: item.pair.withSkill.evaluationContractHash,
    evaluationContractVersion: item.pair.withSkill.evaluationContractVersion,
    materializerId: item.pair.withSkill.materializerId,
    deterministicScorerId: item.pair.withSkill.deterministicScorerId,
    withIsA,
    promptSha256: sha256(prompt),
    artifactASha256: sha256(JSON.stringify(artifactA)),
    artifactBSha256: sha256(JSON.stringify(artifactB)),
    promptPath,
    preparedAt: new Date().toISOString(),
  };
  writeProtectedBlindFile(promptPath, Buffer.from(prompt));
  writeProtectedBlindFile(privatePath, Buffer.from(`${JSON.stringify(record, null, 2)}\n`));
  return record;
}

function readPreparedAssignment(assignmentId: string): PreparedAssignmentRecord {
  if (typeof assignmentId !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/u.test(assignmentId)) {
    throw new Error('Invalid prepared blind assignment id');
  }
  const path = join(pendingRoot, `${assignmentId}.private.json`);
  if (!existsSync(path)) throw new Error(`Unknown prepared blind assignment ${assignmentId}`);
  const record = strictJson(
    readBoundedBlindFile(path, MAX_BLIND_IMPORT_BYTES, true).toString('utf8'),
  ) as PreparedAssignmentRecord;
  if (
    !record ||
    record.schemaVersion !== 3 ||
    record.assignmentId !== assignmentId ||
    typeof record.withIsA !== 'boolean' ||
    ['skill', 'scenarioId', 'pairId', 'revisionHash'].some(
      (key) =>
        typeof record[key as keyof PreparedAssignmentRecord] !== 'string' ||
        !record[key as keyof PreparedAssignmentRecord],
    ) ||
    ['promptSha256', 'artifactASha256', 'artifactBSha256'].some(
      (key) => !/^[a-f0-9]{64}$/u.test(String(record[key as keyof PreparedAssignmentRecord])),
    ) ||
    record.promptPath !== join(pendingRoot, `${assignmentId}.prompt.txt`)
  ) {
    throw new Error(`Invalid prepared blind assignment ${assignmentId}`);
  }
  if (!existsSync(record.promptPath))
    throw new Error(`Blind assignment prompt is missing for ${assignmentId}`);
  if (
    sha256(readBoundedBlindFile(record.promptPath, MAX_BLIND_IMPORT_BYTES, true)) !==
    record.promptSha256
  ) {
    throw new Error(`Blind assignment prompt hash mismatch for ${assignmentId}`);
  }
  return record;
}

let validatedReviews = 0;
function ingestBlindReviews(path: string, writeEvaluation: boolean): void {
  const envelopeBytes = readBoundedBlindFile(resolve(path), MAX_BLIND_IMPORT_BYTES);
  const envelope = strictJson(envelopeBytes.toString('utf8')) as BlindReviewImportEnvelope;
  if (
    !envelope ||
    envelope.schemaVersion !== 1 ||
    typeof envelope.reviewer?.agentId !== 'string' ||
    !envelope.reviewer.agentId.trim() ||
    typeof envelope.reviewer.provider !== 'string' ||
    !envelope.reviewer.provider.trim() ||
    typeof envelope.reviewer.model !== 'string' ||
    !envelope.reviewer.model.trim() ||
    !Array.isArray(envelope.reviews)
  ) {
    throw new Error('Invalid blind-review import envelope');
  }
  const nativeStage = requireNativeStageOptIn(envelope, allowNativeStage);
  if (
    nativeStage &&
    !readBoundedBlindFile(resolve(path), MAX_BLIND_IMPORT_BYTES, true).equals(envelopeBytes)
  ) {
    throw new Error('Native import envelope changed during validation');
  }
  // Provider/model are provenance metadata. The integrity boundary is the
  // sealed assignment, completed event evidence, and reviewer identity being
  // distinct from the registered skill steward. Any reviewer adapter may
  // produce a valid envelope; no vendor or model family is privileged here.
  for (const review of envelope.reviews) {
    if (
      typeof review?.assignmentId !== 'string' ||
      !review.assignmentId ||
      (nativeStage && typeof review.output !== 'string') ||
      (typeof review.output !== 'string' &&
        (!review.output || typeof review.output !== 'object' || Array.isArray(review.output)))
    ) {
      throw new Error('Blind-review import contains an invalid review entry');
    }
    const prepared = readPreparedAssignment(review.assignmentId);
    const excludedPairRunIds = new Set(
      allRuns
        .filter(
          (run) =>
            run.skill === prepared.skill &&
            run.revisionHash === prepared.revisionHash &&
            (run.scenarioId ?? run.caseId) === prepared.scenarioId &&
            run.comparisonId === prepared.pairId,
        )
        .map((run) => run.id),
    );
    const exclusion = evidenceEligibility.excludedEvidence.find((item) =>
      excludedPairRunIds.has(item.runId),
    );
    if (exclusion)
      throw new Error(`Blind assignment ${review.assignmentId} is excluded: ${exclusion.reason}`);
    const item = eligible.find(
      (candidate) =>
        candidate.skill === prepared.skill &&
        candidate.task.id === prepared.scenarioId &&
        candidate.pair.withSkill.comparisonId === prepared.pairId,
    );
    if (!item) {
      throw new Error(
        `Blind assignment ${review.assignmentId} is stale; its exact current revision/contract pair is no longer eligible`,
      );
    }
    verifyPreparedCurrentBinding(prepared, item.pair.withSkill);
    pairExecutionEvidence(item.pair.withSkill, item.pair.withoutSkill);
    const steward = getSkillSteward(projectRoot, prepared.skill);
    if (!steward) throw new Error(`Skill ${prepared.skill} has no registered steward identity`);
    if (envelope.reviewer.agentId === steward.agentId) {
      throw new Error(`Skill ${prepared.skill} cannot blind-grade its own work`);
    }
    const rawOutput =
      typeof review.output === 'string' ? review.output : JSON.stringify(review.output);
    const result = parseJudgeResult(rawOutput);
    const withArtifact = anonymousArtifact(item.pair.withSkill, prepared.skill);
    const withoutArtifact = anonymousArtifact(item.pair.withoutSkill, prepared.skill);
    verifyPreparedArtifactHashes(
      prepared,
      prepared.withIsA ? withArtifact : withoutArtifact,
      prepared.withIsA ? withoutArtifact : withArtifact,
    );
    if (
      JSON.stringify(withArtifact.publicContract) !== JSON.stringify(withoutArtifact.publicContract)
    ) {
      throw new Error('Current blind pair has mismatched public contract snapshots');
    }
    const currentPrompt = readBoundedBlindFile(prepared.promptPath, MAX_BLIND_IMPORT_BYTES, true);
    if (sha256(currentPrompt) !== prepared.promptSha256)
      throw new Error('Blind assignment prompt changed during validation');
    verifyPreparedPromptBinding(
      currentPrompt.toString('utf8'),
      buildBlindReviewJudgePrompt({
        task: item.task,
        artifactA: prepared.withIsA ? withArtifact : withoutArtifact,
        artifactB: prepared.withIsA ? withoutArtifact : withArtifact,
        pairEvidence: pairExecutionEvidence(item.pair.withSkill, item.pair.withoutSkill),
      }),
    );
    const sourceMismatch = findBlindJudgeArtifactMismatch(
      result,
      prepared.withIsA ? withArtifact : withoutArtifact,
      prepared.withIsA ? withoutArtifact : withArtifact,
    );
    if (sourceMismatch)
      throw new Error(`Blind judge contradicted source evidence: ${sourceMismatch}`);
    const nativeEvidence = nativeStage
      ? verifyNativeBlindReviewImport({
          stage: envelope.nativeStageEvidence,
          reviewer: envelope.reviewer,
          output: rawOutput,
          promptSha256: prepared.promptSha256,
          requiredProtectedRoots: [
            projectRoot,
            homedir(),
            pendingRoot,
            ...[
              'HOME',
              'USERPROFILE',
              'CLAUDE_CONFIG_DIR',
              'KORYPHAIOS_DATA_DIR',
              'KORYPHAIOS_SKILLS_HOME',
            ].flatMap((key) =>
              process.env[key]?.trim() ? [canonicalizePath(process.env[key]!.trim())] : [],
            ),
          ].map((root) => canonicalizePath(root)),
        })
      : undefined;
    if (!writeEvaluation) {
      validatedReviews += 1;
      continue;
    }
    const withScore = prepared.withIsA ? result.artifactA : result.artifactB;
    const recordedAt = new Date().toISOString();
    const preparedBytes = readBoundedBlindFile(
      join(pendingRoot, `${review.assignmentId}.private.json`),
      MAX_BLIND_IMPORT_BYTES,
      true,
    );
    if (JSON.stringify(JSON.parse(preparedBytes.toString('utf8'))) !== JSON.stringify(prepared)) {
      throw new Error('Prepared blind assignment changed during validation');
    }
    const retainedNativeArtifacts = nativeEvidence
      ? retainNativeBlindReviewEvidence(blindRoot, nativeEvidence, envelopeBytes, preparedBytes)
      : [];
    // Native assignments live with their seven immutable evidence copies. A
    // re-import cannot overwrite an earlier assignment or follow its symlink.
    const assignmentPath = join(
      nativeEvidence ? dirname(retainedNativeArtifacts[0]!.location) : blindRoot,
      `${review.assignmentId}.json`,
    );
    const assignmentRecord = {
      ...(nativeEvidence
        ? { nativeEvidence: { ...nativeEvidence.provenance, artifacts: retainedNativeArtifacts } }
        : {}),
      schemaVersion: 3,
      assignmentId: review.assignmentId,
      skill: prepared.skill,
      scenarioId: prepared.scenarioId,
      pairId: prepared.pairId,
      revisionHash: prepared.revisionHash,
      evaluationContractHash: prepared.evaluationContractHash,
      blindTo: ['skill-variant', 'expected-outcome'],
      randomizedMapping: {
        A: prepared.withIsA ? 'with-skill' : 'without-skill',
        B: prepared.withIsA ? 'without-skill' : 'with-skill',
      },
      reviewer: {
        agentId: envelope.reviewer.agentId,
        provider: envelope.reviewer.provider,
        model: envelope.reviewer.model,
        displayLabel: blindReviewerDisplayLabel(prepared.skill, envelope.reviewer),
      },
      harnessVersion: BLIND_HARNESS_VERSION,
      promptSha256: prepared.promptSha256,
      artifactASha256: prepared.artifactASha256,
      artifactBSha256: prepared.artifactBSha256,
      outputSha256: sha256(rawOutput),
      result,
      recordedAt,
    };
    const assignmentSha = writeProtectedBlindFile(
      assignmentPath,
      Buffer.from(`${JSON.stringify(assignmentRecord, null, 2)}\n`),
    );
    persisted.push({
      id: `${review.assignmentId}:with-skill`,
      skill: prepared.skill,
      revisionHash: prepared.revisionHash,
      caseId: prepared.scenarioId,
      provider: envelope.reviewer.provider,
      model: envelope.reviewer.model,
      harnessVersion: BLIND_HARNESS_VERSION,
      role: 'critic',
      evaluator: 'blind-review',
      passed: withScore.passed,
      quality: withScore.quality,
      verification: withScore.verification,
      integrityFailure: withScore.integrityFailure,
      evidence: [
        ...withScore.evidence,
        `blind preference: ${result.preference}`,
        ...result.rationale,
      ],
      notes: nativeEvidence
        ? 'Randomized A/B semantic adjudication with retained host-observed native empty-tool stream and canonical macOS private-root profile; unsigned, no upstream identity or universal OS read-allowlist attestation.'
        : 'Independent randomized A/B semantic adjudication by a provider-neutral reviewer.',
      recordedAt,
      protocolVersion: 3,
      variant: 'with-skill',
      caseCategory: 'full-task',
      comparisonId: prepared.pairId,
      routing: item.pair.withSkill.routing ?? { expectedSelection: true, selected: true },
      evaluatorProvenance: {
        evaluatorId: BLIND_EVALUATOR_ID,
        kind: 'model',
        provider: envelope.reviewer.provider,
        model: envelope.reviewer.model,
        agentId: envelope.reviewer.agentId,
        displayLabel: blindReviewerDisplayLabel(prepared.skill, envelope.reviewer),
        assignmentId: review.assignmentId,
        blindTo: ['skill-variant', 'expected-outcome'],
        evidence: [
          `assignment:${assignmentPath}#sha256=${assignmentSha}`,
          `prompt-sha256:${prepared.promptSha256}`,
          `artifact-a-sha256:${prepared.artifactASha256}`,
          `artifact-b-sha256:${prepared.artifactBSha256}`,
          `judge-output-sha256:${sha256(rawOutput)}`,
          `reviewer-agent:${envelope.reviewer.agentId}`,
          ...retainedNativeArtifacts.map(
            (artifact) => `native-evidence:${artifact.location}#sha256=${artifact.sha256}`,
          ),
          ...(nativeEvidence
            ? [
                `native-boundary:${nativeEvidence.provenance.qualification};unsigned;upstream-identity-unverified;universal-read-allowlist-false`,
              ]
            : []),
        ],
      },
      suiteId: prepared.suiteId,
      scenarioId: prepared.scenarioId,
      experimentId: review.assignmentId,
      evaluationContractHash: prepared.evaluationContractHash,
      evaluationContractVersion: prepared.evaluationContractVersion,
      materializerId: prepared.materializerId,
      deterministicScorerId: prepared.deterministicScorerId,
      artifacts: [
        { kind: 'report', location: assignmentPath, sha256: assignmentSha },
        ...retainedNativeArtifacts,
      ],
    });
  }
  if (writeEvaluation && persisted.length) recordSkillEvaluationRuns(projectRoot, persisted);
}

const preparedAssignments: PreparedAssignmentRecord[] = [];
const unavailableAssignments: Array<{ assignmentId: string; reason: string }> = [];
if (prepareOnly) {
  mkdirSync(pendingRoot, { recursive: true, mode: 0o700 });
  const preparedBySkill = new Map<string, number>();
  for (const item of pending) {
    const preparedForSkill = preparedBySkill.get(item.skill) ?? 0;
    if (preparedForSkill >= maxPerSkill) continue;
    // One unreadable historical artifact must not consume a capped slot and starve the rest of
    // the skill: the pair is reported by id and reason as unavailable, and the next reviewable
    // current pair takes the slot instead.
    try {
      preparedAssignments.push(prepareAssignment(item));
      preparedBySkill.set(item.skill, preparedForSkill + 1);
    } catch (error) {
      unavailableAssignments.push({
        assignmentId: assignmentIdFor(item),
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
if (ingestPath) {
  mkdirSync(blindRoot, { recursive: true, mode: 0o700 });
  ingestBlindReviews(ingestPath, true);
}
if (validateOnlyPath) {
  ingestBlindReviews(validateOnlyPath, false);
}

console.log(
  JSON.stringify(
    {
      schemaVersion: 1,
      dryRun,
      mode: dryRun
        ? 'dry-run'
        : prepareOnly
          ? 'prepare'
          : ingestPath
            ? 'ingest'
            : validateOnlyPath
              ? 'validate'
              : 'disabled',
      concurrency,
      maxPerSkill: Number.isFinite(maxPerSkill) ? maxPerSkill : null,
      retryFailed,
      skillsRequested: selectedPackages.length,
      eligiblePairs: eligible.length,
      excludedEvidence,
      skippedExistingReviews: eligible.length - pending.length,
      queuedPairs: queue.length,
      unavailableAssignments,
      preparedAssignments: preparedAssignments.map((item) => ({
        assignmentId: item.assignmentId,
        skill: item.skill,
        scenarioId: item.scenarioId,
        pairId: item.pairId,
        promptPath: item.promptPath,
        promptSha256: item.promptSha256,
      })),
      persistedReviews: persisted.length,
      validatedReviews,
      failedReviews: failures.length,
      ...(summaryOnly
        ? {
            eligibleBySkill: Object.fromEntries(
              [...new Set(queue.map((item) => item.skill))]
                .sort()
                .map((skill) => [skill, queue.filter((item) => item.skill === skill).length]),
            ),
            failures: failures.slice(0, 20),
          }
        : {
            eligible: queue.map((item) => ({
              skill: item.skill,
              scenarioId: item.task.id,
              pairId: item.pair.withSkill.comparisonId,
            })),
            failures,
          }),
    },
    null,
    2,
  ),
);

if (failures.length) process.exitCode = 1;
