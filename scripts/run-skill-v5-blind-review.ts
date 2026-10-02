import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import {
  BUILTIN_SKILL_EVAL_MATERIALIZERS,
  BUILTIN_SKILL_EVAL_SCORERS,
} from '../backend/src/kory/skill-eval-fixtures';
import {
  CURRENT_SKILL_EVAL_CONTRACT_VERSION,
  listSkillEvaluationRuns,
  recordSkillEvaluationRuns,
  type SkillEvaluationRun,
} from '../backend/src/kory/skill-evaluations';
import {
  buildBlindReviewJudgePrompt,
  findBlindJudgeRubricViolation,
  type BlindPairExecutionEvidence,
  type BlindReviewArtifact,
} from '../backend/src/kory/skill-eval-blind-review';
import { loadV5SkillPackages, type V5FullTaskFixture } from '../backend/src/kory/skill-packages';
import { listSkills } from '../backend/src/kory/skills';
import {
  buildSkillStewardDisplayLabel,
  getSkillSteward,
  isChatGptWebSkillStewardIdentity,
} from '../backend/src/kory/skill-stewards';

const projectRoot = resolve(import.meta.dir, '..');
const evaluationContractVersion = CURRENT_SKILL_EVAL_CONTRACT_VERSION;
const BLIND_HARNESS_VERSION = 'v5-blind-semantic@6';
const BLIND_EVALUATOR_ID = 'chatgpt-web-blind-semantic-v6';
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
const summaryOnly = process.argv.includes('--summary');
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
if (!dryRun && !prepareOnly && !ingestPath && !summaryOnly) {
  throw new Error(
    'Direct V5 blind judging is disabled. Use --prepare-only, delegate the anonymous assignment to an actual chatgpt-web/... reviewer, then use --ingest=<result.json>.',
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

function currentEvaluationContractHash(skill: string, task: V5FullTaskFixture): string | null {
  const skillPackage = packages.find((item) => item.sidecar.name === skill);
  if (!skillPackage) return null;
  const materializerIds = BUILTIN_SKILL_EVAL_MATERIALIZERS.filter((item) => item.matches(task))
    .map((item) => item.id)
    .sort();
  const scorerIds = BUILTIN_SKILL_EVAL_SCORERS.filter((item) => item.scenarioIds.includes(task.id))
    .map((item) => item.id)
    .sort();
  if (!materializerIds.length || !scorerIds.length) return null;
  return sha256(
    JSON.stringify({
      contractVersion: evaluationContractVersion,
      skill,
      packageVersion: skillPackage.sidecar.version,
      scenario: task,
      materializerIds,
      scorerIds,
    }),
  ).slice(0, 16);
}

function completePairForScenario(
  runs: readonly SkillEvaluationRun[],
  scenarioId: string,
  contractHash: string,
): { withSkill: SkillEvaluationRun; withoutSkill: SkillEvaluationRun } | null {
  const eligible = runs.filter(
    (run) =>
      run.protocolVersion === 3 &&
      run.evaluator === 'deterministic' &&
      run.caseCategory === 'full-task' &&
      run.scenarioId === scenarioId &&
      run.evaluationContractHash === contractHash &&
      !run.infrastructureFailure &&
      Boolean(run.comparisonId),
  );
  const byPair = new Map<string, SkillEvaluationRun[]>();
  for (const run of eligible) {
    byPair.set(run.comparisonId!, [...(byPair.get(run.comparisonId!) ?? []), run]);
  }
  const pairs = [...byPair.entries()]
    .flatMap(([comparisonId, pairRuns]) => {
      const withSkill = pairRuns.find((run) => run.variant === 'with-skill');
      const withoutSkill = pairRuns.find((run) => run.variant === 'without-skill');
      if (!withSkill || !withoutSkill) return [];
      if (
        withSkill.provider !== withoutSkill.provider ||
        withSkill.model !== withoutSkill.model ||
        withSkill.harnessVersion !== withoutSkill.harnessVersion ||
        withSkill.evaluationContractVersion !== withoutSkill.evaluationContractVersion ||
        withSkill.evaluationContractHash !== withoutSkill.evaluationContractHash ||
        withSkill.materializerId !== withoutSkill.materializerId ||
        withSkill.deterministicScorerId !== withoutSkill.deterministicScorerId
      ) {
        return [];
      }
      return [{ comparisonId, withSkill, withoutSkill }];
    })
    .sort((left, right) => {
      const leftTime = [left.withSkill.recordedAt, left.withoutSkill.recordedAt].sort().at(-1)!;
      const rightTime = [right.withSkill.recordedAt, right.withoutSkill.recordedAt].sort().at(-1)!;
      return (
        rightTime.localeCompare(leftTime) || right.comparisonId.localeCompare(left.comparisonId)
      );
    });
  return pairs[0] ?? null;
}

function readBoundedText(path: string, maxChars: number): string | undefined {
  if (!existsSync(path)) return undefined;
  const buffer = readFileSync(path);
  if (buffer.includes(0)) return undefined;
  return buffer.toString('utf8').slice(0, maxChars);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function scrubBlindText(value: string, skill: string): string {
  return value
    .replace(/\bwithout-skill\b/giu, 'workspace')
    .replace(/\bwith-skill\b/giu, 'workspace')
    .replace(new RegExp(escapeRegExp(skill), 'giu'), 'target-guidance');
}

function anonymousArtifact(run: SkillEvaluationRun, skill: string): BlindReviewArtifact {
  const manifestArtifact = run.artifacts?.find(
    (artifact) => artifact.kind === 'report' && basename(artifact.location) === 'run-manifest.json',
  );
  const outputArtifact = run.artifacts?.find(
    (artifact) => artifact.kind === 'report' && basename(artifact.location) === 'final-output.txt',
  );
  if (!manifestArtifact || !outputArtifact) {
    throw new Error(`Run ${run.id} lacks durable manifest/output artifacts`);
  }
  const manifest = JSON.parse(readFileSync(manifestArtifact.location, 'utf8')) as {
    changes?: Array<{
      path?: unknown;
      change?: unknown;
      beforeSha256?: unknown;
      afterSha256?: unknown;
    }>;
    evidence?: unknown;
    score?: { evidence?: unknown };
  };
  let remaining = 80_000;
  const artifactRoot = dirname(manifestArtifact.location);
  const changes = (manifest.changes ?? []).flatMap((change) => {
    if (typeof change.path !== 'string' || typeof change.change !== 'string') return [];
    const beforePath = join(artifactRoot, 'before-files', change.path);
    const afterPath = join(artifactRoot, 'files', change.path);
    const beforeText =
      remaining > 0 ? readBoundedText(beforePath, Math.min(20_000, remaining)) : undefined;
    if (beforeText) remaining -= beforeText.length;
    const afterText =
      remaining > 0 ? readBoundedText(afterPath, Math.min(20_000, remaining)) : undefined;
    if (afterText) remaining -= afterText.length;
    return [
      {
        path: change.path,
        change: change.change,
        beforeSha256: typeof change.beforeSha256 === 'string' ? change.beforeSha256 : null,
        afterSha256: typeof change.afterSha256 === 'string' ? change.afterSha256 : null,
        ...(beforeText ? { beforeText: scrubBlindText(beforeText, skill) } : {}),
        ...(afterText ? { afterText: scrubBlindText(afterText, skill) } : {}),
      },
    ];
  });
  const manifestEvidence = Array.isArray(manifest.evidence)
    ? manifest.evidence.filter((item): item is string => typeof item === 'string')
    : [];
  const scoreEvidence = Array.isArray(manifest.score?.evidence)
    ? manifest.score.evidence.filter((item): item is string => typeof item === 'string')
    : [];
  let evidenceRemaining = 45_000;
  const executionEvidence = [...manifestEvidence, ...scoreEvidence].flatMap((item) => {
    if (evidenceRemaining <= 0) return [];
    const bounded = item.slice(0, evidenceRemaining);
    evidenceRemaining -= bounded.length;
    return [scrubBlindText(bounded, skill)];
  });
  return {
    finalOutput: scrubBlindText(
      readFileSync(outputArtifact.location, 'utf8').slice(0, 30_000),
      skill,
    ),
    executionEvidence,
    changes,
  };
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
            (nextChar === '[' || nextChar === ']' || nextChar === '_')
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
            // only when the following token can legally begin the next JSON
            // member/value; otherwise preserve it as literal string content.
            const tail = structuralCandidate.slice(index + 1);
            const escapedStructural = tail.match(/^\s*\\*([,\]}:])/u)?.[1];
            const following = escapedStructural ?? tail.match(/\S/u)?.[0];
            if (!following || ',]}:'.includes(following)) {
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
          if (following === '[' || following === ']' || following === '_') {
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
const eligible: Array<{
  skill: string;
  task: V5FullTaskFixture;
  pair: { withSkill: SkillEvaluationRun; withoutSkill: SkillEvaluationRun };
}> = [];

for (const skillPackage of selectedPackages) {
  const revision = currentByName.get(skillPackage.sidecar.name);
  if (!revision) continue;
  const runs = listSkillEvaluationRuns(projectRoot, skillPackage.sidecar.name).filter(
    (run) => run.revisionHash === revision.hash,
  );
  for (const task of skillPackage.evaluation.tasks) {
    const contractHash = currentEvaluationContractHash(skillPackage.sidecar.name, task);
    if (!contractHash) continue;
    const pair = completePairForScenario(runs, task.id, contractHash);
    if (pair) eligible.push({ skill: skillPackage.sidecar.name, task, pair });
  }
}

const currentBlindReviews = listSkillEvaluationRuns(projectRoot).filter((run) => {
  if (
    run.evaluator !== 'blind-review' ||
    run.harnessVersion !== BLIND_HARNESS_VERSION ||
    run.protocolVersion !== 3 ||
    !run.comparisonId ||
    currentByName.get(run.skill)?.hash !== run.revisionHash
  ) {
    return false;
  }
  const provenance = run.evaluatorProvenance;
  const steward = getSkillSteward(projectRoot, run.skill);
  return Boolean(
    provenance?.agentId &&
    provenance.provider &&
    provenance.model &&
    provenance.displayLabel === buildSkillStewardDisplayLabel(run.skill) &&
    isChatGptWebSkillStewardIdentity(provenance.provider, provenance.model) &&
    steward &&
    provenance.agentId !== steward.agentId,
  );
});
const reviewedPairKeys = new Set(
  currentBlindReviews.map(
    (run) => `${run.skill}\0${run.scenarioId ?? run.caseId}\0${run.comparisonId}`,
  ),
);
const pending = eligible.filter(
  (item) =>
    !reviewedPairKeys.has(
      `${item.skill}\0${item.task.id}\0${item.pair.withSkill.comparisonId ?? ''}`,
    ),
);
const currentReviewCountBySkill = new Map<string, number>();
for (const run of currentBlindReviews) {
  currentReviewCountBySkill.set(run.skill, (currentReviewCountBySkill.get(run.skill) ?? 0) + 1);
}
const queue = pending.filter((item, index, items) => {
  if (maxPerSkill === Number.POSITIVE_INFINITY) return true;
  const priorForSkill = items
    .slice(0, index)
    .filter((candidate) => candidate.skill === item.skill).length;
  return (currentReviewCountBySkill.get(item.skill) ?? 0) + priorForSkill < maxPerSkill;
});

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
  const withIsA = Number.parseInt(sha256(`${assignmentId}\0arm-order`).slice(0, 2), 16) % 2 === 0;
  const artifactA = withIsA ? withArtifact : withoutArtifact;
  const artifactB = withIsA ? withoutArtifact : withArtifact;
  const prompt = buildBlindReviewJudgePrompt({
    task: item.task,
    artifactA,
    artifactB,
    pairEvidence: pairExecutionEvidence(item.pair.withSkill, item.pair.withoutSkill),
  });
  const promptPath = join(pendingRoot, `${assignmentId}.prompt.txt`);
  const privatePath = join(pendingRoot, `${assignmentId}.private.json`);
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
  writeFileSync(promptPath, prompt, { mode: 0o600 });
  writeFileSync(privatePath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  return record;
}

function readPreparedAssignment(assignmentId: string): PreparedAssignmentRecord {
  const path = join(pendingRoot, `${assignmentId}.private.json`);
  if (!existsSync(path)) throw new Error(`Unknown prepared blind assignment ${assignmentId}`);
  const record = JSON.parse(readFileSync(path, 'utf8')) as PreparedAssignmentRecord;
  if (record.schemaVersion !== 3 || record.assignmentId !== assignmentId) {
    throw new Error(`Invalid prepared blind assignment ${assignmentId}`);
  }
  if (!existsSync(record.promptPath))
    throw new Error(`Blind assignment prompt is missing: ${record.promptPath}`);
  if (sha256(readFileSync(record.promptPath)) !== record.promptSha256) {
    throw new Error(`Blind assignment prompt hash mismatch for ${assignmentId}`);
  }
  return record;
}

function ingestBlindReviews(path: string): void {
  const envelope = JSON.parse(readFileSync(resolve(path), 'utf8')) as BlindReviewImportEnvelope;
  if (
    envelope.schemaVersion !== 1 ||
    !envelope.reviewer?.agentId ||
    !envelope.reviewer.provider ||
    !envelope.reviewer.model ||
    !Array.isArray(envelope.reviews)
  ) {
    throw new Error('Invalid blind-review import envelope');
  }
  if (!isChatGptWebSkillStewardIdentity(envelope.reviewer.provider, envelope.reviewer.model)) {
    throw new Error('Blind-review import must come from an actual chatgpt-web/... reviewer');
  }
  for (const review of envelope.reviews) {
    if (
      !review?.assignmentId ||
      (typeof review.output !== 'string' && typeof review.output !== 'object')
    ) {
      throw new Error('Blind-review import contains an invalid review entry');
    }
    const prepared = readPreparedAssignment(review.assignmentId);
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
    const steward = getSkillSteward(projectRoot, prepared.skill);
    if (!steward) throw new Error(`Skill ${prepared.skill} has no registered steward identity`);
    if (envelope.reviewer.agentId === steward.agentId) {
      throw new Error(`Skill ${prepared.skill} cannot blind-grade its own work`);
    }
    const rawOutput =
      typeof review.output === 'string' ? review.output : JSON.stringify(review.output);
    const result = parseJudgeResult(rawOutput);
    const withScore = prepared.withIsA ? result.artifactA : result.artifactB;
    const assignmentPath = join(blindRoot, `${review.assignmentId}.json`);
    const recordedAt = new Date().toISOString();
    const assignmentRecord = {
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
        displayLabel: buildSkillStewardDisplayLabel(prepared.skill),
      },
      harnessVersion: BLIND_HARNESS_VERSION,
      promptSha256: prepared.promptSha256,
      artifactASha256: prepared.artifactASha256,
      artifactBSha256: prepared.artifactBSha256,
      outputSha256: sha256(rawOutput),
      result,
      recordedAt,
    };
    writeFileSync(assignmentPath, `${JSON.stringify(assignmentRecord, null, 2)}\n`, {
      mode: 0o600,
    });
    const assignmentSha = sha256(readFileSync(assignmentPath));
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
      notes: 'Independent randomized A/B semantic adjudication by an actual ChatGPT Web reviewer.',
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
        displayLabel: buildSkillStewardDisplayLabel(prepared.skill),
        assignmentId: review.assignmentId,
        blindTo: ['skill-variant', 'expected-outcome'],
        evidence: [
          `assignment:${assignmentPath}#sha256=${assignmentSha}`,
          `prompt-sha256:${prepared.promptSha256}`,
          `artifact-a-sha256:${prepared.artifactASha256}`,
          `artifact-b-sha256:${prepared.artifactBSha256}`,
          `judge-output-sha256:${sha256(rawOutput)}`,
          `reviewer-agent:${envelope.reviewer.agentId}`,
        ],
      },
      suiteId: prepared.suiteId,
      scenarioId: prepared.scenarioId,
      experimentId: review.assignmentId,
      evaluationContractHash: prepared.evaluationContractHash,
      evaluationContractVersion: prepared.evaluationContractVersion,
      materializerId: prepared.materializerId,
      deterministicScorerId: prepared.deterministicScorerId,
      artifacts: [{ kind: 'report', location: assignmentPath, sha256: assignmentSha }],
    });
  }
  if (persisted.length) recordSkillEvaluationRuns(projectRoot, persisted);
}

const preparedAssignments: PreparedAssignmentRecord[] = [];
if (prepareOnly) {
  mkdirSync(pendingRoot, { recursive: true, mode: 0o700 });
  for (const item of queue) preparedAssignments.push(prepareAssignment(item));
}
if (ingestPath) {
  mkdirSync(blindRoot, { recursive: true, mode: 0o700 });
  ingestBlindReviews(ingestPath);
}

console.log(
  JSON.stringify(
    {
      schemaVersion: 1,
      dryRun,
      mode: dryRun ? 'dry-run' : prepareOnly ? 'prepare' : ingestPath ? 'ingest' : 'disabled',
      concurrency,
      maxPerSkill: Number.isFinite(maxPerSkill) ? maxPerSkill : null,
      skillsRequested: selectedPackages.length,
      eligiblePairs: eligible.length,
      skippedExistingReviews: eligible.length - pending.length,
      queuedPairs: queue.length,
      preparedAssignments: preparedAssignments.map((item) => ({
        assignmentId: item.assignmentId,
        skill: item.skill,
        scenarioId: item.scenarioId,
        pairId: item.pairId,
        promptPath: item.promptPath,
        promptSha256: item.promptSha256,
      })),
      persistedReviews: persisted.length,
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
