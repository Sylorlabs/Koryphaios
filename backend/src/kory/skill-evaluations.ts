import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { SkillRevision } from './skills';

/** Evidence ledger for skills. It stores observed results; it never calls a model or invents a score. */
export interface SkillEvaluationCase {
  id: string;
  skill: string;
  prompt: string;
  expectedSelection: boolean;
  requiredEvidence: string[];
}

export interface SkillEvaluationRun {
  id: string;
  skill: string;
  revisionHash: string;
  caseId: string;
  provider: string;
  model: string;
  harnessVersion: string;
  role: 'worker' | 'critic';
  medium?: string;
  evaluator: 'deterministic' | 'human-blind-review' | 'human-review';
  passed: boolean;
  quality: number;
  verification: number;
  integrityFailure: boolean;
  evidence: string[];
  notes?: string;
  recordedAt: string;
}

export interface SkillPromotionGate {
  status: 'unmeasured' | 'insufficient-evidence' | 'blocked' | 'ready';
  candidateRuns: number;
  distinctHarnesses: number;
  distinctProviders: number;
  distinctModels: number;
  humanBlindReviews: number;
  passRate: number | null;
  quality: number | null;
  verification: number | null;
  baselineDelta: number | null;
  reasons: string[];
}

export interface SkillEvaluationCard {
  skill: string;
  revisionHash: string;
  cases: SkillEvaluationCase[];
  gate: SkillPromotionGate;
  runs: SkillEvaluationRun[];
}

const ledgerPath = (projectRoot: string) =>
  join(resolve(projectRoot), '.koryphaios', 'skills', 'evaluations.json');

const validRun = (value: unknown): value is SkillEvaluationRun => {
  const run = value as SkillEvaluationRun;
  return Boolean(
    run &&
    typeof run.id === 'string' &&
    typeof run.skill === 'string' &&
    typeof run.revisionHash === 'string' &&
    typeof run.caseId === 'string' &&
    typeof run.provider === 'string' &&
    typeof run.model === 'string' &&
    typeof run.harnessVersion === 'string' &&
    (run.role === 'worker' || run.role === 'critic') &&
    ['deterministic', 'human-blind-review', 'human-review'].includes(run.evaluator) &&
    typeof run.passed === 'boolean' &&
    typeof run.integrityFailure === 'boolean' &&
    typeof run.quality === 'number' &&
    run.quality >= 0 &&
    run.quality <= 1 &&
    typeof run.verification === 'number' &&
    run.verification >= 0 &&
    run.verification <= 1 &&
    Array.isArray(run.evidence) &&
    run.evidence.every((item) => typeof item === 'string') &&
    typeof run.recordedAt === 'string',
  );
};

export function listSkillEvaluationRuns(projectRoot: string, skill?: string): SkillEvaluationRun[] {
  try {
    const data = JSON.parse(readFileSync(ledgerPath(projectRoot), 'utf8'));
    const runs = Array.isArray(data) ? data.filter(validRun) : [];
    return skill ? runs.filter((run) => run.skill === skill) : runs;
  } catch {
    return [];
  }
}

export function recordSkillEvaluationRun(
  projectRoot: string,
  run: SkillEvaluationRun,
): SkillEvaluationRun {
  if (!validRun(run)) throw new Error('Invalid skill evaluation run');
  if (!run.evidence.length && run.evaluator !== 'deterministic') {
    throw new Error('Human evaluation requires at least one evidence artifact');
  }
  const existing = listSkillEvaluationRuns(projectRoot);
  const next = [...existing.filter((item) => item.id !== run.id), run];
  const path = ledgerPath(projectRoot);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
  return run;
}

export function buildSkillEvaluationCases(skill: SkillRevision): SkillEvaluationCase[] {
  const positive = skill.metadata.shouldTrigger.map((prompt, index) => ({
    id: `${skill.name}:trigger:${index + 1}`,
    skill: skill.name,
    prompt,
    expectedSelection: true,
    requiredEvidence: skill.metadata.evidence,
  }));
  const negative = skill.metadata.shouldNotTrigger.map((prompt, index) => ({
    id: `${skill.name}:non-trigger:${index + 1}`,
    skill: skill.name,
    prompt,
    expectedSelection: false,
    requiredEvidence: ['Proof that the skill was not selected', 'No scope leakage'],
  }));
  return [...positive, ...negative];
}

const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;

export function evaluateSkillPromotion(
  projectRoot: string,
  skill: string,
  revisionHash: string,
  baselineHash?: string,
): SkillPromotionGate {
  const allRuns = listSkillEvaluationRuns(projectRoot, skill);
  const runs = allRuns.filter((run) => run.revisionHash === revisionHash);
  if (!runs.length) {
    return {
      status: 'unmeasured',
      candidateRuns: 0,
      distinctHarnesses: 0,
      distinctProviders: 0,
      distinctModels: 0,
      humanBlindReviews: 0,
      passRate: null,
      quality: null,
      verification: null,
      baselineDelta: null,
      reasons: ['No observed evaluation runs have been recorded.'],
    };
  }
  const passRate = runs.filter((run) => run.passed).length / runs.length;
  const quality = mean(runs.map((run) => run.quality));
  const verification = mean(runs.map((run) => run.verification));
  const humanBlindReviews = runs.filter((run) => run.evaluator === 'human-blind-review').length;
  const distinctHarnesses = new Set(
    runs.map((run) => `${run.provider}:${run.model}:${run.harnessVersion}`),
  ).size;
  const distinctProviders = new Set(runs.map((run) => run.provider)).size;
  const distinctModels = new Set(runs.map((run) => `${run.provider}:${run.model}`)).size;
  const baseline = baselineHash ? allRuns.filter((run) => run.revisionHash === baselineHash) : [];
  const baselineScore = baseline.length
    ? mean(
        baseline.map((run) => (run.passed ? 0.5 : 0) + run.quality * 0.3 + run.verification * 0.2),
      )
    : null;
  const candidateScore = mean(
    runs.map((run) => (run.passed ? 0.5 : 0) + run.quality * 0.3 + run.verification * 0.2),
  );
  const baselineDelta = baselineScore === null ? null : candidateScore - baselineScore;
  const reasons: string[] = [];
  if (runs.some((run) => run.integrityFailure))
    reasons.push('At least one run recorded an integrity failure.');
  if (runs.length < 3) reasons.push('At least three observed runs are required.');
  if (distinctProviders < 2)
    reasons.push('At least two provider families are required for cross-model evidence.');
  if (distinctModels < 2)
    reasons.push('At least two distinct provider/model combinations are required.');
  if (!humanBlindReviews) reasons.push('At least one blinded human review is required.');
  if (passRate < 0.8) reasons.push('Observed pass rate is below 80%.');
  if (verification < 0.8) reasons.push('Observed verification score is below 80%.');
  if (baselineDelta !== null && baselineDelta < 0)
    reasons.push('Candidate regressed against its recorded baseline.');
  const blocked =
    runs.some((run) => run.integrityFailure) || (baselineDelta !== null && baselineDelta < 0);
  const ready = !reasons.length;
  return {
    status: ready ? 'ready' : blocked ? 'blocked' : 'insufficient-evidence',
    candidateRuns: runs.length,
    distinctHarnesses,
    distinctProviders,
    distinctModels,
    humanBlindReviews,
    passRate,
    quality,
    verification,
    baselineDelta,
    reasons,
  };
}

export function buildSkillEvaluationCard(
  projectRoot: string,
  skill: SkillRevision,
  baselineHash?: string,
): SkillEvaluationCard {
  const runs = listSkillEvaluationRuns(projectRoot, skill.name).filter(
    (run) => run.revisionHash === skill.hash,
  );
  return {
    skill: skill.name,
    revisionHash: skill.hash,
    cases: buildSkillEvaluationCases(skill),
    gate: evaluateSkillPromotion(projectRoot, skill.name, skill.hash, baselineHash),
    runs,
  };
}
