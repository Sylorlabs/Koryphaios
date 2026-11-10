import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  listSkillEvaluationRuns,
  recordSkillEvaluationRuns,
  type SkillEvaluationRun,
} from '../backend/src/kory/skill-evaluations';
import { newRoutingCampaignId, routingComparisonId } from './skill-v5-routing-identity';

test('new routing observations retain earlier negative results and revision history', () => {
  const root = mkdtempSync(join(tmpdir(), 'kory-routing-history-'));
  try {
    const first = newRoutingCampaignId();
    const second = newRoutingCampaignId();
    expect(second).not.toBe(first);
    const ids = [
      'v5-routing@1:task-routing:case-1',
      routingComparisonId('task-routing', 'case-1', 'revision-a', first),
      routingComparisonId('task-routing', 'case-1', 'revision-a', second),
      routingComparisonId('task-routing', 'case-1', 'revision-b', second),
    ];
    expect(new Set(ids).size).toBe(4);
    const runs: SkillEvaluationRun[] = ids.map((id, index) => ({
      id,
      skill: 'task-routing',
      revisionHash: index === 3 ? 'revision-b' : 'revision-a',
      caseId: 'case-1',
      provider: 'kory-resolver',
      model: 'deterministic-v5',
      harnessVersion: 'v5-routing-evidence@1',
      role: 'worker',
      evaluator: 'deterministic',
      passed: index > 1,
      quality: index > 1 ? 1 : 0,
      verification: 1,
      integrityFailure: false,
      evidence: ['Observed routing test result'],
      recordedAt: new Date().toISOString(),
    }));
    recordSkillEvaluationRuns(root, runs.slice(0, 2));
    recordSkillEvaluationRuns(root, runs.slice(2));
    expect(listSkillEvaluationRuns(root)).toHaveLength(4);
    expect(listSkillEvaluationRuns(root).filter((run) => !run.passed)).toHaveLength(2);
    expect(new Set(listSkillEvaluationRuns(root).map((run) => run.id))).toEqual(new Set(ids));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
