import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GRPC_PROTOBUF_SKILL_EVAL_MATERIALIZERS,
  GRPC_PROTOBUF_SKILL_EVAL_SCORERS,
} from '../skill-eval-grpc-protobuf-fixtures';
import { buildSkillEvalSuiteV3 } from '../skill-eval-harness';
import { loadV5SkillPackages } from '../skill-packages';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test('field-evolution scorer recognizes a semantically valid post-window proto under a descriptive filename', async () => {
  const skillPackage = loadV5SkillPackages().packages.find(
    (item) => item.sidecar.name === 'grpc-protobuf',
  )!;
  const scenario = buildSkillEvalSuiteV3(skillPackage).scenarios.find(
    (item) => item.id === 'grpc-protobuf-full-task-1-individual',
  )!;
  const root = mkdtempSync(join(tmpdir(), 'kory-grpc-eval-'));
  roots.push(root);
  const materializer = GRPC_PROTOBUF_SKILL_EVAL_MATERIALIZERS.find((entry) =>
    entry.matches(scenario),
  )!;
  const scorer = GRPC_PROTOBUF_SKILL_EVAL_SCORERS.find((entry) =>
    entry.scenarioIds.includes(scenario.id),
  )!;
  await materializer.materialize(root, scenario);
  mkdirSync(join(root, 'proto'), { recursive: true });
  writeFileSync(
    join(root, 'proto/job_post_migration.proto'),
    `syntax = "proto3";
package kory.jobs.v1.postmigration;
message StartJobRequest {
  reserved 2;
  reserved "urgent";
  string name = 1;
  Priority priority = 3;
}
enum Priority {
  PRIORITY_UNSPECIFIED = 0;
  PRIORITY_NORMAL = 1;
  PRIORITY_HIGH = 2;
}
`,
  );

  const score = await scorer.score({
    scenario,
    experiment: {} as never,
    workingDirectory: root,
    observation: { output: '', evidence: [], artifacts: [], durationMs: 0 },
  });

  expect(scorer.id).toEndWith('@2');
  expect(score.evidence).toContain('post-window reservation schema: pass');
});
