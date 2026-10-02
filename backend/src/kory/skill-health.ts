import { buildSkillEvaluationCard, listSkillEvaluationRuns } from './skill-evaluations';
import { listSkills, type SkillRevision } from './skills';
import { listSkillStewards, type SkillStewardRecord } from './skill-stewards';
import { listSkillUsage } from './skill-usage';

export interface SkillHealthRecord {
  name: string;
  source: SkillRevision['source'];
  state: SkillRevision['state'];
  hash: string;
  version: string;
  steward: Pick<
    SkillStewardRecord,
    'agentId' | 'displayLabel' | 'provider' | 'model' | 'status' | 'lastCompletedAt' | 'lastOutcome'
  > | null;
  lastBenchmarkAt: string | null;
  routingPrecision: number | null;
  routingRecall: number | null;
  qualityDelta: number | null;
  openRegressions: number;
  usageCount: number;
  lastUsedAt: string | null;
  conflicts: string[];
  dependencies: string[];
  promotionState: 'unmeasured' | 'insufficient-evidence' | 'blocked' | 'ready';
}

export interface SkillHealthSnapshot {
  generatedAt: string;
  records: SkillHealthRecord[];
  summary: {
    revisions: number;
    active: number;
    stewarded: number;
    ready: number;
    blocked: number;
    openRegressions: number;
  };
}

export function buildSkillHealthSnapshot(projectRoot: string): SkillHealthSnapshot {
  const revisions = listSkills(projectRoot);
  const stewards = new Map(listSkillStewards(projectRoot).map((item) => [item.skill, item]));
  const usage = new Map(listSkillUsage(projectRoot).map((item) => [item.skill, item]));
  const runs = listSkillEvaluationRuns(projectRoot);
  const runsByRevision = new Map<string, typeof runs>();
  for (const run of runs) {
    const key = `${run.skill}:${run.revisionHash}`;
    runsByRevision.set(key, [...(runsByRevision.get(key) ?? []), run]);
  }

  const records = revisions.map((skill): SkillHealthRecord => {
    const revisionRuns = runsByRevision.get(`${skill.name}:${skill.hash}`) ?? [];
    const gate = revisionRuns.length ? buildSkillEvaluationCard(projectRoot, skill).gate : null;
    const lastBenchmarkAt = revisionRuns.length
      ? revisionRuns
          .map((run) => run.recordedAt)
          .sort((left, right) => Date.parse(right) - Date.parse(left))[0]
      : null;
    const steward = stewards.get(skill.name);
    const usageRecord = usage.get(skill.name);
    return {
      name: skill.name,
      source: skill.source,
      state: skill.state,
      hash: skill.hash,
      version: skill.metadata.version,
      steward: steward
        ? {
            agentId: steward.agentId,
            displayLabel: steward.displayLabel,
            provider: steward.provider,
            model: steward.model,
            status: steward.status,
            lastCompletedAt: steward.lastCompletedAt,
            lastOutcome: steward.lastOutcome,
          }
        : null,
      lastBenchmarkAt,
      routingPrecision: gate?.routingPrecision ?? null,
      routingRecall: gate?.routingRecall ?? null,
      qualityDelta: gate?.skillBaselineQualityDelta ?? gate?.baselineDelta ?? null,
      openRegressions: gate?.openRegressions ?? 0,
      usageCount: usageRecord?.count ?? 0,
      lastUsedAt: usageRecord?.lastUsedAt ?? null,
      conflicts: [...skill.metadata.conflicts],
      dependencies: [...new Set([...skill.metadata.broader, ...skill.metadata.requires])],
      promotionState: gate?.status ?? 'unmeasured',
    };
  });
  return {
    generatedAt: new Date().toISOString(),
    records,
    summary: {
      revisions: records.length,
      active: records.filter((record) => record.state === 'active').length,
      stewarded: records.filter((record) => record.steward?.status === 'active').length,
      ready: records.filter((record) => record.promotionState === 'ready').length,
      blocked: records.filter((record) => record.promotionState === 'blocked').length,
      openRegressions: records.reduce((sum, record) => sum + record.openRegressions, 0),
    },
  };
}
