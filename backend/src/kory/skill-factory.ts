import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { buildSkillEvaluationCard, type SkillEvaluationCard } from './skill-evaluations';
import {
  createSkillDraft,
  enforceSkillLearningPolicy,
  listSkills,
  normalizeSkillTokens,
  SkillDraftConflictError,
  type CreateSkillDraftInput,
  type SkillLearningMode,
  type SkillRevision,
  type SkillSource,
} from './skills';
import {
  DEFAULT_SKILL_STEWARD_MODEL,
  ensureSkillSteward,
  getSkillSteward,
  type SkillStewardRecord,
} from './skill-stewards';
import { lintProse } from '../../../skills-v5/dash-free-writing/scripts/check-prose.mjs';

const FACTORY_SCHEMA_VERSION = 1 as const;
const FACTORY_LOCK_STALE_MS = 5 * 60_000;
const SKILL_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const DEFAULT_COVERAGE_THRESHOLD = 0.78;

const GAP_SIGNAL_SOURCES = ['session', 'benchmark', 'failure', 'manual', 'import'] as const;
const GAP_STATUSES = ['proposed', 'drafted', 'covered', 'dismissed'] as const;
const BENCHMARK_KINDS = [
  'positive-trigger',
  'negative-trigger',
  'ambiguous-routing',
  'adversarial-routing',
  'realistic-full-task',
  'skill-vs-no-skill',
  'regression',
] as const;

const COVERAGE_STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'for',
  'in',
  'of',
  'on',
  'or',
  'the',
  'to',
  'use',
  'using',
  'with',
  'work',
]);

export type SkillGapSignalSource = (typeof GAP_SIGNAL_SOURCES)[number];
export type SkillFactoryGapStatus = (typeof GAP_STATUSES)[number];
export type SkillFactoryBenchmarkKind = (typeof BENCHMARK_KINDS)[number];

export interface SkillGapSignal {
  id: string;
  capability: string;
  proposedSkillName?: string;
  requestExamples?: string[];
  domains?: string[];
  targetMedia?: string[];
  source: SkillGapSignalSource;
  observedAt: string;
  weight?: number;
  evidence?: string[];
}

export interface SkillCoverageMatch {
  signalId: string;
  capability: string;
  proposedSkillName: string;
  status: 'covered' | 'gap';
  score: number;
  matchedSkill?: string;
  reason: string;
}

export interface SkillFactoryNearestSkill {
  name: string;
  score: number;
}

export interface SkillFactoryBenchmarkRequirement {
  kind: SkillFactoryBenchmarkKind;
  minimumCases: number;
  description: string;
}

export const DEFAULT_SKILL_FACTORY_BENCHMARK_PLAN: readonly SkillFactoryBenchmarkRequirement[] = [
  {
    kind: 'positive-trigger',
    minimumCases: 3,
    description: 'Representative requests that must select the candidate skill.',
  },
  {
    kind: 'negative-trigger',
    minimumCases: 3,
    description: 'Near-neighbor requests that must not select the candidate skill.',
  },
  {
    kind: 'ambiguous-routing',
    minimumCases: 2,
    description: 'Requests where the candidate competes with adjacent skills.',
  },
  {
    kind: 'adversarial-routing',
    minimumCases: 2,
    description: 'Prompt wording designed to induce scope leakage or false activation.',
  },
  {
    kind: 'realistic-full-task',
    minimumCases: 2,
    description: 'End-to-end tasks with completion evidence and verification artifacts.',
  },
  {
    kind: 'skill-vs-no-skill',
    minimumCases: 2,
    description: 'Blind A/B evidence that the skill improves the result.',
  },
  {
    kind: 'regression',
    minimumCases: 1,
    description: 'A durable case for every material production failure.',
  },
];

export interface SkillFactoryGapRecord {
  id: string;
  capabilityKey: string;
  capability: string;
  proposedSkillName: string;
  status: SkillFactoryGapStatus;
  gapScore: number;
  coverageScore: number;
  demandWeight: number;
  occurrences: number;
  signalIds: string[];
  requestExamples: string[];
  domains: string[];
  targetMedia: string[];
  evidence: string[];
  nearestSkills: SkillFactoryNearestSkill[];
  benchmarkPlan: SkillFactoryBenchmarkRequirement[];
  firstSeenAt: string;
  lastSeenAt: string;
  updatedAt: string;
  draft?: {
    source: SkillSource;
    hash: string;
    createdAt: string;
  };
  stewardAgentId?: string;
  coveredBySkill?: string;
  dismissal?: {
    reason: string;
    dismissedAt: string;
  };
}

export interface SkillFactoryState {
  schemaVersion: typeof FACTORY_SCHEMA_VERSION;
  revision: number;
  updatedAt: string;
  gaps: SkillFactoryGapRecord[];
}

export interface SkillGapAnalysisReport {
  generatedAt: string;
  librarySkillCount: number;
  activeSkillCount: number;
  draftSkillCount: number;
  coverageThreshold: number;
  covered: SkillCoverageMatch[];
  gaps: SkillFactoryGapRecord[];
}

export type SkillFactoryDraftSpec = Omit<CreateSkillDraftInput, 'source' | 'name'>;

export interface SkillFactoryDraftResult {
  gap: SkillFactoryGapRecord;
  draft: SkillRevision;
  steward: SkillStewardRecord;
  evaluation: SkillEvaluationCard;
  promotionReady: boolean;
}

export interface SkillFactoryCandidate {
  gap: SkillFactoryGapRecord;
  draft: SkillRevision;
  steward?: SkillStewardRecord;
  evaluation: SkillEvaluationCard;
  promotionReady: boolean;
}

export class SkillFactoryStateConflictError extends Error {
  constructor() {
    super('Skill Factory state is being updated by another process; retry with fresh state');
    this.name = 'SkillFactoryStateConflictError';
  }
}

export function getSkillFactoryStatePath(projectRoot: string): string {
  return join(resolve(projectRoot), '.koryphaios', 'skills', 'factory-gaps.json');
}

export function loadSkillFactoryState(projectRoot: string): SkillFactoryState {
  return readFactoryState(getSkillFactoryStatePath(projectRoot));
}

export function listSkillFactoryGaps(projectRoot: string): SkillFactoryGapRecord[] {
  return loadSkillFactoryState(projectRoot).gaps;
}

export function getSkillFactoryGap(
  projectRoot: string,
  gapId: string,
): SkillFactoryGapRecord | undefined {
  return listSkillFactoryGaps(projectRoot).find((gap) => gap.id === gapId);
}

/**
 * Compare observed demand with active skill metadata. This produces evidence-
 * backed proposals only; it does not author or activate a skill.
 */
export function analyzeSkillGaps(
  projectRoot: string,
  signals: SkillGapSignal[],
  options: {
    now?: Date | string;
    coverageThreshold?: number;
    persist?: boolean;
  } = {},
): SkillGapAnalysisReport {
  if (!Array.isArray(signals) || signals.length === 0) {
    throw new Error('At least one skill gap signal is required');
  }
  const normalizedSignals = signals.map(normalizeSignal);
  const now = toIso(options.now);
  const threshold = options.coverageThreshold ?? DEFAULT_COVERAGE_THRESHOLD;
  if (!Number.isFinite(threshold) || threshold < 0.5 || threshold > 1) {
    throw new Error('Skill coverage threshold must be between 0.5 and 1');
  }
  const revisions = listSkills(projectRoot);
  const activeSkills = effectiveSkills(revisions, 'active');
  const matches = normalizedSignals.map((signal) =>
    findCoverageMatch(signal, activeSkills, threshold),
  );
  const covered = matches.filter((match) => match.status === 'covered');
  const generated = buildGapRecords(
    normalizedSignals.filter((signal) =>
      matches.some((match) => match.signalId === signal.id && match.status === 'gap'),
    ),
    matches,
    activeSkills,
    now,
  );
  let reportGaps = generated;
  if (options.persist !== false) {
    const next = updateFactoryState(projectRoot, now, (draft) => {
      mergeGapRecords(draft, generated, revisions, now);
      for (const match of covered) {
        const existing = draft.gaps.find(
          (gap) => gap.proposedSkillName === match.proposedSkillName,
        );
        if (existing && existing.status !== 'dismissed') {
          existing.status = 'covered';
          existing.coveredBySkill = match.matchedSkill;
          existing.updatedAt = now;
        }
      }
      reconcileRecordsAgainstSkills(draft.gaps, revisions, now);
    }).snapshot;
    const generatedIds = new Set(generated.map((gap) => gap.id));
    reportGaps = next.gaps.filter((gap) => generatedIds.has(gap.id));
  }
  return {
    generatedAt: now,
    librarySkillCount: new Set(revisions.map((revision) => revision.name)).size,
    activeSkillCount: new Set(
      revisions.filter((revision) => revision.state === 'active').map((revision) => revision.name),
    ).size,
    draftSkillCount: new Set(
      revisions.filter((revision) => revision.state === 'draft').map((revision) => revision.name),
    ).size,
    coverageThreshold: threshold,
    covered,
    gaps: reportGaps,
  };
}

/**
 * Materialize a reviewed gap as a validated draft and assign its persistent
 * logical steward. Activation remains entirely outside the factory.
 */
export function createSkillFactoryDraft(
  projectRoot: string,
  input: {
    gapId: string;
    learningMode: SkillLearningMode;
    source?: SkillSource;
    draft: SkillFactoryDraftSpec;
    stewardModel?: string;
    now?: Date | string;
  },
): SkillFactoryDraftResult {
  const now = toIso(input.now);
  const gap = getSkillFactoryGap(projectRoot, input.gapId);
  if (!gap) throw new Error(`Skill Factory gap ${input.gapId} not found`);
  if (gap.status === 'dismissed') throw new Error(`Skill Factory gap ${input.gapId} is dismissed`);
  if (gap.status === 'covered')
    throw new Error(`Skill Factory gap ${input.gapId} is already covered`);
  enforceSkillLearningPolicy(input.learningMode, 'agent', 'save-draft');
  const source = input.source ?? 'project';
  let draft = listSkills(projectRoot).find(
    (revision) =>
      revision.name === gap.proposedSkillName &&
      revision.source === source &&
      revision.state === 'draft',
  );
  if (!draft) {
    try {
      draft = createSkillDraft(projectRoot, {
        ...input.draft,
        source,
        name: gap.proposedSkillName,
      });
    } catch (error: unknown) {
      if (!(error instanceof SkillDraftConflictError)) throw error;
      draft = listSkills(projectRoot).find(
        (revision) =>
          revision.name === gap.proposedSkillName &&
          revision.source === source &&
          revision.state === 'draft',
      );
      if (!draft) throw error;
    }
  }
  const proseFindings = lintProse(draft.sourceContent, {
    literals: [
      draft.name,
      ...draft.metadata.broader,
      ...draft.metadata.facets,
      ...draft.metadata.requires,
      ...draft.metadata.conflicts,
    ],
  }).findings;
  if (proseFindings.length > 0) {
    const first = proseFindings[0]!;
    throw new Error(
      `Skill Factory authored prose must avoid dash punctuation; first finding is ${first.codePoint} at line ${first.line}, column ${first.column}`,
    );
  }
  const steward = ensureSkillSteward(projectRoot, draft.name, {
    model: input.stewardModel ?? DEFAULT_SKILL_STEWARD_MODEL,
    now,
  });
  const updated = updateFactoryState(projectRoot, now, (state) => {
    const current = state.gaps.find((item) => item.id === gap.id);
    if (!current) throw new Error(`Skill Factory gap ${gap.id} disappeared during drafting`);
    current.status = 'drafted';
    current.draft = { source: draft!.source, hash: draft!.hash, createdAt: now };
    current.stewardAgentId = steward.agentId;
    current.coveredBySkill = undefined;
    current.dismissal = undefined;
    current.updatedAt = now;
  }).snapshot.gaps.find((item) => item.id === gap.id)!;
  const baseline = listSkills(projectRoot).find(
    (revision) => revision.name === draft!.name && revision.state === 'active',
  );
  const evaluation = buildSkillEvaluationCard(projectRoot, draft, baseline?.hash);
  return {
    gap: updated,
    draft,
    steward,
    evaluation,
    promotionReady: evaluation.gate.status === 'ready',
  };
}

export function buildSkillFactoryCandidate(
  projectRoot: string,
  gapId: string,
): SkillFactoryCandidate {
  const gap = getSkillFactoryGap(projectRoot, gapId);
  if (!gap) throw new Error(`Skill Factory gap ${gapId} not found`);
  const revisions = listSkills(projectRoot).filter(
    (revision) => revision.name === gap.proposedSkillName,
  );
  const draft = revisions.find((revision) => revision.state === 'draft');
  if (!draft) throw new Error(`Skill Factory gap ${gapId} has no draft revision`);
  const baseline = revisions.find((revision) => revision.state === 'active');
  const evaluation = buildSkillEvaluationCard(projectRoot, draft, baseline?.hash);
  return {
    gap,
    draft,
    steward: getSkillSteward(projectRoot, draft.name),
    evaluation,
    promotionReady: evaluation.gate.status === 'ready',
  };
}

export function dismissSkillFactoryGap(
  projectRoot: string,
  gapId: string,
  reason: string,
  now?: Date | string,
): SkillFactoryGapRecord {
  const timestamp = toIso(now);
  const dismissalReason = cleanString(reason, 'dismissal reason', 1_000);
  const result = updateFactoryState(projectRoot, timestamp, (state) => {
    const gap = state.gaps.find((item) => item.id === gapId);
    if (!gap) throw new Error(`Skill Factory gap ${gapId} not found`);
    gap.status = 'dismissed';
    gap.dismissal = { reason: dismissalReason, dismissedAt: timestamp };
    gap.updatedAt = timestamp;
  });
  return result.snapshot.gaps.find((gap) => gap.id === gapId)!;
}

export function reopenSkillFactoryGap(
  projectRoot: string,
  gapId: string,
  now?: Date | string,
): SkillFactoryGapRecord {
  const timestamp = toIso(now);
  const revisions = listSkills(projectRoot);
  const result = updateFactoryState(projectRoot, timestamp, (state) => {
    const gap = state.gaps.find((item) => item.id === gapId);
    if (!gap) throw new Error(`Skill Factory gap ${gapId} not found`);
    gap.dismissal = undefined;
    gap.status = 'proposed';
    gap.updatedAt = timestamp;
    reconcileRecordAgainstSkills(gap, revisions, timestamp);
  });
  return result.snapshot.gaps.find((gap) => gap.id === gapId)!;
}

export function reconcileSkillFactoryGaps(
  projectRoot: string,
  now?: Date | string,
): SkillFactoryState {
  const timestamp = toIso(now);
  const revisions = listSkills(projectRoot);
  const snapshot = updateFactoryState(projectRoot, timestamp, (state) => {
    reconcileRecordsAgainstSkills(state.gaps, revisions, timestamp);
  }).snapshot;
  for (const gap of snapshot.gaps.filter((item) => item.status === 'drafted')) {
    ensureSkillSteward(projectRoot, gap.proposedSkillName, { now: timestamp });
  }
  return snapshot;
}

function normalizeSignal(signal: SkillGapSignal): SkillGapSignal & { proposedSkillName: string } {
  if (!signal || typeof signal !== 'object') throw new Error('Invalid skill gap signal');
  const id = cleanString(signal.id, 'signal id', 200);
  const capability = cleanString(signal.capability, 'capability', 240);
  if (!GAP_SIGNAL_SOURCES.includes(signal.source))
    throw new Error('Invalid skill gap signal source');
  const observedAt = toIso(signal.observedAt);
  const weight = signal.weight ?? 1;
  if (!Number.isFinite(weight) || weight <= 0 || weight > 100) {
    throw new Error('Skill gap signal weight must be greater than 0 and at most 100');
  }
  const proposedSkillName = signal.proposedSkillName
    ? cleanSkillName(signal.proposedSkillName)
    : capabilityToSkillName(capability);
  return {
    id,
    capability,
    proposedSkillName,
    source: signal.source,
    observedAt,
    weight,
    requestExamples: cleanList(signal.requestExamples ?? [], 12, 500, 'request example'),
    domains: cleanList(signal.domains ?? [], 12, 80, 'domain').map((value) => value.toLowerCase()),
    targetMedia: cleanList(signal.targetMedia ?? [], 8, 64, 'target medium').map((value) =>
      value.toLowerCase(),
    ),
    evidence: cleanList(signal.evidence ?? [], 20, 1_000, 'evidence'),
  };
}

function findCoverageMatch(
  signal: SkillGapSignal & { proposedSkillName: string },
  activeSkills: SkillRevision[],
  threshold: number,
): SkillCoverageMatch {
  const scored = activeSkills
    .map((skill) => ({ skill, score: coverageScore(signal, skill) }))
    .sort(
      (left, right) => right.score - left.score || left.skill.name.localeCompare(right.skill.name),
    );
  const best = scored[0];
  const covered = Boolean(best && best.score >= threshold);
  return {
    signalId: signal.id,
    capability: signal.capability,
    proposedSkillName: signal.proposedSkillName,
    status: covered ? 'covered' : 'gap',
    score: best?.score ?? 0,
    matchedSkill: covered ? best!.skill.name : undefined,
    reason: covered
      ? `Active skill ${best!.skill.name} meets the ${threshold.toFixed(2)} coverage threshold`
      : `No active skill meets the ${threshold.toFixed(2)} coverage threshold`,
  };
}

function coverageScore(
  signal: SkillGapSignal & { proposedSkillName: string },
  skill: SkillRevision,
): number {
  if (signal.proposedSkillName === skill.name) return 1;
  const signalTokens = significantTokens([
    signal.capability,
    ...(signal.requestExamples ?? []),
    ...(signal.domains ?? []),
    ...(signal.targetMedia ?? []),
  ]);
  const nameTokens = significantTokens([skill.name]);
  const skillTokens = significantTokens([
    skill.name,
    skill.description,
    ...skill.metadata.domains,
    ...skill.metadata.targetMedia,
    ...skill.metadata.activation,
    ...skill.metadata.shouldTrigger,
  ]);
  const broadOverlap = overlap(signalTokens, skillTokens);
  const nameOverlap = overlap(signalTokens, nameTokens);
  const signalDomains = new Set((signal.domains ?? []).map((value) => value.toLowerCase()));
  const domainOverlap = signalDomains.size
    ? [...signalDomains].filter((domain) => skill.metadata.domains.includes(domain)).length /
      signalDomains.size
    : 0;
  const phrases = [...skill.metadata.activation, ...skill.metadata.shouldTrigger];
  const phraseOverlap = phrases.reduce(
    (best, phrase) => Math.max(best, jaccard(signalTokens, significantTokens([phrase]))),
    0,
  );
  const score =
    broadOverlap * 0.4 + nameOverlap * 0.25 + domainOverlap * 0.15 + phraseOverlap * 0.2;
  return roundScore(score);
}

function buildGapRecords(
  signals: Array<SkillGapSignal & { proposedSkillName: string }>,
  matches: SkillCoverageMatch[],
  activeSkills: SkillRevision[],
  now: string,
): SkillFactoryGapRecord[] {
  const groups = new Map<string, Array<SkillGapSignal & { proposedSkillName: string }>>();
  for (const signal of signals) {
    const values = groups.get(signal.proposedSkillName) ?? [];
    values.push(signal);
    groups.set(signal.proposedSkillName, values);
  }
  const records: SkillFactoryGapRecord[] = [];
  for (const [proposedSkillName, grouped] of groups) {
    const coverageScoreValue = Math.max(
      ...grouped.map((signal) => matches.find((match) => match.signalId === signal.id)?.score ?? 0),
    );
    const demandWeight = grouped.reduce((sum, signal) => sum + (signal.weight ?? 1), 0);
    const nearest = activeSkills
      .map((skill) => ({
        name: skill.name,
        score: Math.max(...grouped.map((signal) => coverageScore(signal, skill))),
      }))
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name))
      .slice(0, 3);
    const firstSeenAt = grouped
      .map((signal) => signal.observedAt)
      .sort((left, right) => Date.parse(left) - Date.parse(right))[0];
    const lastSeenAt = grouped
      .map((signal) => signal.observedAt)
      .sort((left, right) => Date.parse(right) - Date.parse(left))[0];
    records.push({
      id: `gap-${createHash('sha256').update(proposedSkillName).digest('hex').slice(0, 16)}`,
      capabilityKey: proposedSkillName,
      capability: grouped[0].capability,
      proposedSkillName,
      status: 'proposed',
      gapScore: roundScore((1 - coverageScoreValue) * Math.min(1, demandWeight / 3)),
      coverageScore: coverageScoreValue,
      demandWeight,
      occurrences: new Set(grouped.map((signal) => signal.id)).size,
      signalIds: uniqueBounded(
        grouped.map((signal) => signal.id),
        100,
      ),
      requestExamples: uniqueBounded(
        grouped.flatMap((signal) => [signal.capability, ...(signal.requestExamples ?? [])]),
        20,
      ),
      domains: uniqueBounded(
        grouped.flatMap((signal) => signal.domains ?? []),
        20,
      ),
      targetMedia: uniqueBounded(
        grouped.flatMap((signal) => signal.targetMedia ?? []),
        12,
      ),
      evidence: uniqueBounded(
        grouped.flatMap((signal) => signal.evidence ?? []),
        40,
      ),
      nearestSkills: nearest,
      benchmarkPlan: DEFAULT_SKILL_FACTORY_BENCHMARK_PLAN.map((item) => ({ ...item })),
      firstSeenAt,
      lastSeenAt,
      updatedAt: now,
    });
  }
  return records.sort(
    (left, right) =>
      right.gapScore - left.gapScore ||
      left.proposedSkillName.localeCompare(right.proposedSkillName),
  );
}

function mergeGapRecords(
  state: SkillFactoryState,
  incoming: SkillFactoryGapRecord[],
  revisions: SkillRevision[],
  now: string,
): void {
  const byId = new Map(state.gaps.map((gap) => [gap.id, gap]));
  for (const candidate of incoming) {
    const current = byId.get(candidate.id);
    if (!current) {
      state.gaps.push(candidate);
      byId.set(candidate.id, candidate);
      continue;
    }
    current.capability = candidate.capability;
    current.gapScore = Math.max(current.gapScore, candidate.gapScore);
    current.coverageScore = candidate.coverageScore;
    current.demandWeight = Math.max(current.demandWeight, candidate.demandWeight);
    current.signalIds = uniqueBounded([...current.signalIds, ...candidate.signalIds], 100);
    current.occurrences = current.signalIds.length;
    current.requestExamples = uniqueBounded(
      [...current.requestExamples, ...candidate.requestExamples],
      20,
    );
    current.domains = uniqueBounded([...current.domains, ...candidate.domains], 20);
    current.targetMedia = uniqueBounded([...current.targetMedia, ...candidate.targetMedia], 12);
    current.evidence = uniqueBounded([...current.evidence, ...candidate.evidence], 40);
    current.nearestSkills = candidate.nearestSkills;
    current.lastSeenAt =
      Date.parse(candidate.lastSeenAt) > Date.parse(current.lastSeenAt)
        ? candidate.lastSeenAt
        : current.lastSeenAt;
    current.updatedAt = now;
    if (current.status === 'covered' && !current.coveredBySkill) current.status = 'proposed';
    reconcileRecordAgainstSkills(current, revisions, now);
  }
  state.gaps.sort(
    (left, right) =>
      right.gapScore - left.gapScore ||
      left.proposedSkillName.localeCompare(right.proposedSkillName),
  );
}

function reconcileRecordsAgainstSkills(
  gaps: SkillFactoryGapRecord[],
  revisions: SkillRevision[],
  now: string,
): void {
  for (const gap of gaps) reconcileRecordAgainstSkills(gap, revisions, now);
}

function reconcileRecordAgainstSkills(
  gap: SkillFactoryGapRecord,
  revisions: SkillRevision[],
  now: string,
): void {
  if (gap.status === 'dismissed') return;
  const matching = revisions.filter((revision) => revision.name === gap.proposedSkillName);
  const active = matching.find((revision) => revision.state === 'active');
  if (active) {
    gap.status = 'covered';
    gap.coveredBySkill = active.name;
    gap.updatedAt = now;
    return;
  }
  const draft = matching.find((revision) => revision.state === 'draft');
  if (draft) {
    gap.status = 'drafted';
    gap.draft = gap.draft ?? { source: draft.source, hash: draft.hash, createdAt: now };
    gap.coveredBySkill = undefined;
    gap.updatedAt = now;
    return;
  }
  if (gap.status === 'drafted' || gap.status === 'covered') {
    gap.status = 'proposed';
    gap.draft = undefined;
    gap.coveredBySkill = undefined;
    gap.updatedAt = now;
  }
}

function effectiveSkills(
  revisions: SkillRevision[],
  state: SkillRevision['state'],
): SkillRevision[] {
  const byName = new Map<string, SkillRevision>();
  for (const revision of revisions.filter(
    (item) =>
      item.state === state && item.validation.valid && item.compatibility?.status !== 'unavailable',
  )) {
    const current = byName.get(revision.name);
    if (!current || (current.source === 'personal' && revision.source === 'project')) {
      byName.set(revision.name, revision);
    }
  }
  return [...byName.values()];
}

function capabilityToSkillName(capability: string): string {
  const tokens = normalizeSkillTokens(capability)
    .map((token) => token.replace(/[^a-z0-9]+/g, '-'))
    .filter(Boolean);
  const candidate = tokens.join('-').replace(/-+/g, '-').slice(0, 64).replace(/-+$/, '');
  return cleanSkillName(candidate);
}

function cleanSkillName(value: string): string {
  const name = value.trim().toLowerCase();
  if (!SKILL_NAME_PATTERN.test(name)) throw new Error(`Invalid proposed skill name: ${value}`);
  return name;
}

function significantTokens(values: string[]): Set<string> {
  return new Set(
    values
      .flatMap(normalizeSkillTokens)
      .filter((token) => token.length > 1 && !COVERAGE_STOP_WORDS.has(token)),
  );
}

function overlap(needle: Set<string>, haystack: Set<string>): number {
  if (!needle.size) return 0;
  return [...needle].filter((token) => haystack.has(token)).length / needle.size;
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (!left.size || !right.size) return 0;
  const intersection = [...left].filter((token) => right.has(token)).length;
  const union = new Set([...left, ...right]).size;
  return intersection / union;
}

function roundScore(value: number): number {
  return Math.round(Math.max(0, Math.min(1, value)) * 1_000) / 1_000;
}

function uniqueBounded(values: string[], limit: number): string[] {
  return [...new Set(values)].slice(0, limit);
}

function updateFactoryState<T>(
  projectRoot: string,
  now: string,
  operation: (draft: SkillFactoryState) => T,
): { snapshot: SkillFactoryState; value: T } {
  const path = getSkillFactoryStatePath(projectRoot);
  return withFactoryLock(path, () => {
    const existed = existsSync(path);
    const current = readFactoryState(path);
    const draft = cloneFactoryState(current);
    const value = operation(draft);
    draft.gaps.sort(
      (left, right) =>
        right.gapScore - left.gapScore ||
        left.proposedSkillName.localeCompare(right.proposedSkillName),
    );
    const changed = !existed || JSON.stringify(current.gaps) !== JSON.stringify(draft.gaps);
    if (!changed) return { snapshot: current, value };
    const next: SkillFactoryState = {
      ...draft,
      schemaVersion: FACTORY_SCHEMA_VERSION,
      revision: current.revision + 1,
      updatedAt: now,
    };
    writeFactoryState(path, next);
    return { snapshot: next, value };
  });
}

function emptyFactoryState(): SkillFactoryState {
  return {
    schemaVersion: FACTORY_SCHEMA_VERSION,
    revision: 0,
    updatedAt: new Date(0).toISOString(),
    gaps: [],
  };
}

function cloneFactoryState(state: SkillFactoryState): SkillFactoryState {
  return {
    ...state,
    gaps: state.gaps.map((gap) => ({
      ...gap,
      signalIds: [...gap.signalIds],
      requestExamples: [...gap.requestExamples],
      domains: [...gap.domains],
      targetMedia: [...gap.targetMedia],
      evidence: [...gap.evidence],
      nearestSkills: gap.nearestSkills.map((item) => ({ ...item })),
      benchmarkPlan: gap.benchmarkPlan.map((item) => ({ ...item })),
      draft: gap.draft ? { ...gap.draft } : undefined,
      dismissal: gap.dismissal ? { ...gap.dismissal } : undefined,
    })),
  };
}

function readFactoryState(path: string): SkillFactoryState {
  let source: string;
  try {
    source = readFileSync(path, 'utf8');
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return emptyFactoryState();
    throw new Error(
      `Could not read Skill Factory state at ${path}; the existing file was preserved`,
      { cause: error },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error: unknown) {
    throw new Error(`Invalid Skill Factory JSON at ${path}; the existing file was preserved`, {
      cause: error,
    });
  }
  if (!isValidFactoryState(parsed)) {
    throw new Error(`Invalid Skill Factory state at ${path}; the existing file was preserved`);
  }
  return parsed;
}

function writeFactoryState(path: string, state: SkillFactoryState): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    writeFileSync(descriptor, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, path);
  } catch (error: unknown) {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
    throw error;
  }
}

function withFactoryLock<T>(path: string, operation: () => T): T {
  const lockPath = `${path}.lock`;
  mkdirSync(dirname(path), { recursive: true });
  try {
    const stat = lstatSync(lockPath);
    if (
      stat.isFile() &&
      !stat.isSymbolicLink() &&
      Date.now() - stat.mtimeMs > FACTORY_LOCK_STALE_MS
    ) {
      unlinkSync(lockPath);
    }
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') throw error;
  }
  let descriptor: number | undefined;
  try {
    descriptor = openSync(lockPath, 'wx', 0o600);
    writeFileSync(descriptor, `${process.pid}\n`, 'utf8');
    fsyncSync(descriptor);
    return operation();
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'EEXIST') {
      throw new SkillFactoryStateConflictError();
    }
    throw error;
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Preserve the operation result or error.
      }
      try {
        unlinkSync(lockPath);
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') throw error;
      }
    }
  }
}

function isValidFactoryState(value: unknown): value is SkillFactoryState {
  const state = value as SkillFactoryState;
  if (
    !state ||
    state.schemaVersion !== FACTORY_SCHEMA_VERSION ||
    !Number.isInteger(state.revision) ||
    state.revision < 0 ||
    !isIsoDate(state.updatedAt) ||
    !Array.isArray(state.gaps) ||
    !state.gaps.every(isValidGapRecord)
  ) {
    return false;
  }
  const ids = state.gaps.map((gap) => gap.id);
  const names = state.gaps.map((gap) => gap.proposedSkillName);
  return new Set(ids).size === ids.length && new Set(names).size === names.length;
}

function isValidGapRecord(value: unknown): value is SkillFactoryGapRecord {
  const gap = value as SkillFactoryGapRecord;
  return Boolean(
    gap &&
    validStoredString(gap.id, 200) &&
    validStoredString(gap.capabilityKey, 200) &&
    validStoredString(gap.capability, 240) &&
    SKILL_NAME_PATTERN.test(gap.proposedSkillName) &&
    GAP_STATUSES.includes(gap.status) &&
    validScore(gap.gapScore) &&
    validScore(gap.coverageScore) &&
    Number.isFinite(gap.demandWeight) &&
    gap.demandWeight > 0 &&
    Number.isInteger(gap.occurrences) &&
    gap.occurrences > 0 &&
    validStringArray(gap.signalIds, 100, 200) &&
    validStringArray(gap.requestExamples, 20, 500) &&
    validStringArray(gap.domains, 20, 80) &&
    validStringArray(gap.targetMedia, 12, 64) &&
    validStringArray(gap.evidence, 40, 1_000) &&
    Array.isArray(gap.nearestSkills) &&
    gap.nearestSkills.length <= 3 &&
    gap.nearestSkills.every(
      (item) => item && SKILL_NAME_PATTERN.test(item.name) && validScore(item.score),
    ) &&
    Array.isArray(gap.benchmarkPlan) &&
    gap.benchmarkPlan.length === DEFAULT_SKILL_FACTORY_BENCHMARK_PLAN.length &&
    gap.benchmarkPlan.every(isValidBenchmarkRequirement) &&
    isIsoDate(gap.firstSeenAt) &&
    isIsoDate(gap.lastSeenAt) &&
    isIsoDate(gap.updatedAt) &&
    (gap.draft === undefined ||
      ((gap.draft.source === 'personal' || gap.draft.source === 'project') &&
        SHA256_PATTERN.test(gap.draft.hash) &&
        isIsoDate(gap.draft.createdAt))) &&
    (gap.stewardAgentId === undefined || validStoredString(gap.stewardAgentId, 200)) &&
    (gap.coveredBySkill === undefined || SKILL_NAME_PATTERN.test(gap.coveredBySkill)) &&
    (gap.dismissal === undefined ||
      (validStoredString(gap.dismissal.reason, 1_000) && isIsoDate(gap.dismissal.dismissedAt))),
  );
}

function isValidBenchmarkRequirement(value: unknown): value is SkillFactoryBenchmarkRequirement {
  const requirement = value as SkillFactoryBenchmarkRequirement;
  return Boolean(
    requirement &&
    BENCHMARK_KINDS.includes(requirement.kind) &&
    Number.isInteger(requirement.minimumCases) &&
    requirement.minimumCases > 0 &&
    requirement.minimumCases <= 20 &&
    validStoredString(requirement.description, 500),
  );
}

function validScore(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function validStringArray(value: unknown, maxItems: number, maxLength: number): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= maxItems &&
    value.every((item) => validStoredString(item, maxLength))
  );
}

function validStoredString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength;
}

function cleanString(value: string, label: string, maxLength: number): string {
  const cleaned = value.trim();
  if (!cleaned || cleaned.length > maxLength || /[\r\n]/.test(cleaned)) {
    throw new Error(`${label} must be a single-line value of at most ${maxLength} characters`);
  }
  return cleaned;
}

function cleanList(values: string[], maxItems: number, maxLength: number, label: string): string[] {
  if (!Array.isArray(values)) throw new Error(`${label} values must be an array`);
  return uniqueBounded(
    values.map((value) => cleanString(value, label, maxLength)),
    maxItems,
  );
}

function toIso(value?: Date | string): string {
  const date = value instanceof Date ? value : value === undefined ? new Date() : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid timestamp');
  return date.toISOString();
}

function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}
