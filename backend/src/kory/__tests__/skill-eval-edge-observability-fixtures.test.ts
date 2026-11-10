import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EDGE_OBSERVABILITY_SKILL_EVAL_MATERIALIZERS,
  EDGE_OBSERVABILITY_SKILL_EVAL_SCORERS,
} from '../skill-eval-edge-observability-fixtures';
import { buildSkillEvalSuiteV3 } from '../skill-eval-harness';
import { loadV5SkillPackages } from '../skill-packages';

test('observability sampling fixture declares its simulator and replay corpus as fixed inputs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kory-observability-fixture-'));
  try {
    const scenario = { id: 'observability-sre-full-task-2' } as never;
    const materializer = EDGE_OBSERVABILITY_SKILL_EVAL_MATERIALIZERS.find((item) =>
      item.matches(scenario),
    );
    expect(materializer?.id).toBe('observability-sre/tail-sampling-cardinality@2');
    await materializer!.materialize(root, scenario);
    const readme = readFileSync(join(root, 'README.md'), 'utf8');
    expect(readme).toContain('src/observability-sim.ts');
    expect(readme).toContain('evidence/replay.json');
    expect(readme).toContain('fixed evaluator-owned inputs');
    expect(readme).toContain('Do not edit, replace, or regenerate them');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('edge privacy scorer executes compression, stale-if-error, rollback, and rollout gates', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kory-edge-cdn-fixture-'));
  try {
    const skillPackage = loadV5SkillPackages().packages.find(
      (item) => item.sidecar.name === 'edge-cdn',
    )!;
    const scenario = buildSkillEvalSuiteV3(skillPackage).scenarios.find(
      (item) => item.id === 'edge-cdn-full-task-1-individual',
    )!;
    const materializer = EDGE_OBSERVABILITY_SKILL_EVAL_MATERIALIZERS.find((item) =>
      item.matches(scenario),
    )!;
    const scorer = EDGE_OBSERVABILITY_SKILL_EVAL_SCORERS.find((item) =>
      item.scenarioIds.includes(scenario.id),
    )!;
    expect(materializer.id).toBe('edge-cdn/account-cache-privacy@2');
    expect(scorer.id).toBe('edge-cdn/account-cache-privacy-scorer@3');
    await materializer.materialize(root, scenario);
    mkdirSync(join(root, '.kory-eval'), { recursive: true });

    const policy = {
      revision: 'rev-safe-43',
      accountMode: 'bypass',
      cacheSetCookie: false,
      keyDimensions: ['path', 'query', 'rewrite', 'encoding'],
      purgeDimensions: ['host', 'path', 'query', 'rewrite', 'encoding'],
      ttlSeconds: 60,
      staleWhileRevalidateSeconds: 30,
      staleIfErrorSeconds: 120,
      rollbackRevision: 'rev-safe-43',
      unrelatedAssetCacheable: true,
    };
    writeFileSync(
      join(root, '.kory-eval/edge-privacy-policy.json'),
      `${JSON.stringify(policy, null, 2)}\n`,
    );
    writeFileSync(
      join(root, '.kory-eval/edge-privacy-evidence.json'),
      `${JSON.stringify(
        {
          evidenceType: 'synthetic',
          environment: {
            observedPops: ['POP-A', 'POP-B'],
            deployedRevision: 'rev-safe-43',
            deploymentTimestamp: '2026-10-04T00:00:00Z',
          },
          verification: {
            summary:
              'cold warm alice bob logout purge cache-status Age HIT MISS rollback propagation observed synthetic encoding br gzip identity stale-if-error',
          },
        },
        null,
        2,
      )}\n`,
    );

    const valid = await scorer.score({
      scenario,
      experiment: {} as never,
      workingDirectory: root,
      observation: { output: '', evidence: [], artifacts: [], durationMs: 0 },
    });
    expect(valid.passed).toBe(true);

    writeFileSync(
      join(root, '.kory-eval/edge-privacy-evidence.json'),
      `${JSON.stringify(
        {
          evidenceType: 'synthetic',
          environment: {
            observedPops: ['POP-A'],
            deployedRevision: 'rev-safe-43',
            deploymentTimestamp: '2026-10-04T00:00:00Z',
          },
          verification: {
            summary:
              'cold warm alice bob logout purge cache-status Age HIT MISS rollback propagation observed synthetic encoding br gzip identity stale-if-error',
          },
        },
        null,
        2,
      )}\n`,
    );
    const singlePop = await scorer.score({
      scenario,
      experiment: {} as never,
      workingDirectory: root,
      observation: { output: '', evidence: [], artifacts: [], durationMs: 0 },
    });
    expect(singlePop.passed).toBe(false);

    writeFileSync(
      join(root, '.kory-eval/edge-privacy-evidence.json'),
      `${JSON.stringify(
        {
          evidenceType: 'synthetic',
          environment: {
            observedPops: ['POP-A', 'POP-B'],
            deployedRevision: 'rev-safe-43',
            deploymentTimestamp: '2026-10-04T00:00:00Z',
          },
          verification: {
            summary:
              'cold warm alice bob logout purge cache-status Age HIT MISS rollback propagation observed synthetic encoding br gzip identity stale-if-error',
          },
        },
        null,
        2,
      )}\n`,
    );

    writeFileSync(
      join(root, '.kory-eval/edge-privacy-policy.json'),
      `${JSON.stringify({ ...policy, rollbackRevision: 'rev-bad-42' }, null, 2)}\n`,
    );
    const contaminatedRollback = await scorer.score({
      scenario,
      experiment: {} as never,
      workingDirectory: root,
      observation: { output: '', evidence: [], artifacts: [], durationMs: 0 },
    });
    expect(contaminatedRollback.passed).toBe(false);

    writeFileSync(
      join(root, '.kory-eval/edge-privacy-policy.json'),
      `${JSON.stringify(
        {
          ...policy,
          keyDimensions: ['path', 'query', 'rewrite'],
          purgeDimensions: ['host', 'path', 'query', 'rewrite'],
        },
        null,
        2,
      )}\n`,
    );
    const collapsedCompression = await scorer.score({
      scenario,
      experiment: {} as never,
      workingDirectory: root,
      observation: { output: '', evidence: [], artifacts: [], durationMs: 0 },
    });
    expect(collapsedCompression.passed).toBe(false);

    writeFileSync(
      join(root, '.kory-eval/edge-privacy-policy.json'),
      `${JSON.stringify({ ...policy, staleIfErrorSeconds: 0 }, null, 2)}\n`,
    );
    const missingStaleIfError = await scorer.score({
      scenario,
      experiment: {} as never,
      workingDirectory: root,
      observation: { output: '', evidence: [], artifacts: [], durationMs: 0 },
    });
    expect(missingStaleIfError.passed).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
