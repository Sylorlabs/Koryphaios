import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from 'bun:test';
import type { SkillEvalScenarioV3 } from '../../eval/skills/skill-eval-harness';
import {
  PHP_JSON_SCENARIO,
  PHP_WORKER_SCENARIO,
  V5_LANGUAGE_HOST_SKILL_EVAL_MATERIALIZERS,
  V5_LANGUAGE_HOST_SKILL_EVAL_SCORERS,
  phpHostReadiness,
} from '../../eval/skills/skill-eval-v5-language-host-fixtures';

// Replay saved, hash-checked PHP candidate files from the two genuine paired runs.
// This exercises the local scorer only; it does not execute an agent, write to the
// qualification ledger or create replacement evidence when artifacts are absent.
const EVIDENCE_ROOT = resolve(import.meta.dir, '../../../../.koryphaios/skills/eval-artifacts');
const CASES = [
  {
    scenarioId: PHP_WORKER_SCENARIO,
    artifact: 'php-engineering-full-task-1-individual_1d18c3c8-af5d-4ede-b0fc-15c6e093a7a4',
    variant: 'with-skill',
    expectedPass: true,
    failureEvidence: '',
  },
  {
    scenarioId: PHP_WORKER_SCENARIO,
    artifact: 'php-engineering-full-task-1-individual_1d18c3c8-af5d-4ede-b0fc-15c6e093a7a4',
    variant: 'without-skill',
    expectedPass: false,
    failureEvidence: 'Request-owned state declared static',
  },
  {
    scenarioId: PHP_JSON_SCENARIO,
    artifact: 'php-engineering-full-task-2-individual_fd28ceb3-99b9-4f16-8085-bb00ccaf3b56',
    variant: 'with-skill',
    expectedPass: false,
    failureEvidence: 'NULL_QUANTITY',
  },
  {
    scenarioId: PHP_JSON_SCENARIO,
    artifact: 'php-engineering-full-task-2-individual_fd28ceb3-99b9-4f16-8085-bb00ccaf3b56',
    variant: 'without-skill',
    expectedPass: false,
    failureEvidence: 'NULL_QUANTITY',
  },
] as const;

const phpAvailable = phpHostReadiness().length === 0;

test('PHP JSON materializer publishes exact input distinctions and error contract', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kory-php-contract-'));
  try {
    const materializer = V5_LANGUAGE_HOST_SKILL_EVAL_MATERIALIZERS.find((entry) =>
      entry.id.startsWith('php-engineering/actual-php-strict-json@'),
    );
    expect(materializer).toBeDefined();
    await materializer!.materialize(root, { id: PHP_JSON_SCENARIO } as SkillEvalScenarioV3);
    const readme = readFileSync(join(root, 'README.md'), 'utf8');
    for (const detail of [
      'MISSING_QUANTITY',
      'NULL_QUANTITY',
      'INVALID_TYPE',
      'OUT_OF_RANGE',
      'INVALID_JSON',
      'quoted numeric string',
      'JSON_BIGINT_AS_STRING',
    ]) {
      expect(readme).toContain(detail);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const entry of CASES) {
  const archived = join(EVIDENCE_ROOT, entry.artifact, entry.variant);
  const evidenceExists = existsSync(join(archived, 'run-manifest.json'));
  const runTest = phpAvailable && evidenceExists ? test : test.skip;
  runTest(`PHP recorded ${entry.scenarioId} ${entry.variant}: scorer respects actual candidate evidence`, async () => {
    const manifest = JSON.parse(readFileSync(join(archived, 'run-manifest.json'), 'utf8')) as {
      pairId: string;
      variant: string;
      scenario: SkillEvalScenarioV3;
      changes: Array<{ path: string; afterSha256: string }>;
    };
    expect(manifest.pairId).toStartWith(`${entry.scenarioId}:`);
    expect(manifest.variant).toBe(entry.variant);
    expect(manifest.scenario.id).toBe(entry.scenarioId);

    const root = mkdtempSync(join(tmpdir(), 'kory-php-recorded-'));
    try {
      const materializer = V5_LANGUAGE_HOST_SKILL_EVAL_MATERIALIZERS.find((item) =>
        item.matches(manifest.scenario),
      );
      const scorer = V5_LANGUAGE_HOST_SKILL_EVAL_SCORERS.find((item) =>
        item.scenarioIds.includes(entry.scenarioId),
      );
      expect(materializer).toBeDefined();
      expect(scorer).toBeDefined();
      await materializer!.materialize(root, manifest.scenario);

      for (const change of manifest.changes) {
        const source = join(archived, 'files', change.path);
        const recordedBytes = readFileSync(source);
        expect(createHash('sha256').update('file\0').update(recordedBytes).digest('hex')).toBe(change.afterSha256);
        copyFileSync(source, join(root, change.path));
      }

      const scored = await scorer!.score({ workingDirectory: root } as Parameters<typeof scorer.score>[0]);
      expect(scored.integrityFailure).toBe(false);
      expect(scored.passed).toBe(entry.expectedPass);
      const evidence = scored.evidence.join('\n');
      expect(evidence).toContain('Composer validation: pass');
      expect(evidence).toContain('candidate regression coverage: present; execution: pass');
      if (entry.failureEvidence) expect(evidence).toContain(entry.failureEvidence);
      else expect(evidence).toContain('PHP 8.5.11 runtime checks: pass');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
