import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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

test.each([
  'job_post_migration.proto',
  'job_post_migration.proto.example',
  'post-window/job.proto',
])(
  'field-evolution scorer recognizes a valid post-window proto artifact named %s',
  async (filename) => {
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
    const postWindowPath = join(root, `proto/${filename}`);
    mkdirSync(dirname(postWindowPath), { recursive: true });
    writeFileSync(
      postWindowPath,
      `syntax = "proto3";
package kory.jobs.v1;
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

    expect(scorer.id).toEndWith('@6');
    expect(score.evidence).toContain('post-window message identity: pass');
    expect(score.evidence).toContain('post-window reservation schema: pass');
  },
);

test('field-evolution scorer evaluates each migration candidate independently', async () => {
  const skillPackage = loadV5SkillPackages().packages.find(
    (item) => item.sidecar.name === 'grpc-protobuf',
  )!;
  const scenario = buildSkillEvalSuiteV3(skillPackage).scenarios.find(
    (item) => item.id === 'grpc-protobuf-full-task-1-individual',
  )!;
  const root = mkdtempSync(join(tmpdir(), 'kory-grpc-eval-'));
  roots.push(root);
  await GRPC_PROTOBUF_SKILL_EVAL_MATERIALIZERS.find((entry) =>
    entry.matches(scenario),
  )!.materialize(root, scenario);

  // An obsolete draft is encountered first and describes a different API.
  // It must neither qualify the migration nor hide a separate valid artifact.
  writeFileSync(
    join(root, 'proto/a-obsolete.proto'),
    `syntax = "proto3";
package kory.jobs.v2;
message StartJobRequest {
  reserved 2;
  reserved "urgent";
  string name = 1;
  Priority priority = 3;
}
`,
  );
  writeFileSync(
    join(root, 'proto/z-migrated.proto'),
    `syntax = "proto3";
package kory.jobs.v1;
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

  const scorer = GRPC_PROTOBUF_SKILL_EVAL_SCORERS.find((entry) =>
    entry.scenarioIds.includes(scenario.id),
  )!;
  const result = await scorer.score({
    scenario,
    experiment: {} as never,
    workingDirectory: root,
    observation: { output: '', evidence: [], artifacts: [], durationMs: 0 },
  });
  expect(result.evidence).toContain('post-window message identity: pass');
  expect(result.evidence).toContain('post-window reservation schema: pass');
});

test('field-evolution scorer requires executable assertions, not codec calls alone', async () => {
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
  writeFileSync(
    join(root, 'tests/wire.test.ts'),
    `import { decodeNew, decodeOld, encodeNew, encodeOld } from '../src/wire';

// Old/new compatibility and unknown future priority behavior are exercised through the codec.
decodeNew(encodeOld({ name: 'legacy', urgent: true }));
decodeOld(encodeNew({ name: 'new', priority: 'HIGH', priorityNumeric: 2, unknownFields: [] }));
`,
  );

  const score = await scorer.score({
    scenario,
    experiment: {} as never,
    workingDirectory: root,
    observation: { output: '', evidence: [], artifacts: [], durationMs: 0 },
  });

   expect(score.evidence).toContain('representative compatibility tests with executable assertions: missing');
  expect(score.passed).toBe(false);
});

test('stream scorer rejects lifecycle keywords without executable observations', async () => {
  const skillPackage = loadV5SkillPackages().packages.find(
    (item) => item.sidecar.name === 'grpc-protobuf',
  )!;
  const scenario = buildSkillEvalSuiteV3(skillPackage).scenarios.find(
    (item) => item.id === 'grpc-protobuf-full-task-2-individual',
  )!;
  const root = mkdtempSync(join(tmpdir(), 'kory-grpc-stream-eval-'));
  roots.push(root);
  const materializer = GRPC_PROTOBUF_SKILL_EVAL_MATERIALIZERS.find((entry) =>
    entry.matches(scenario),
  )!;
  const scorer = GRPC_PROTOBUF_SKILL_EVAL_SCORERS.find((entry) =>
    entry.scenarioIds.includes(scenario.id),
  )!;
  await materializer.materialize(root, scenario);
  writeFileSync(
    join(root, 'tests/stream.test.ts'),
    `// slow reader backpressure cancellation deadline downstream unavailable internal half-close resource cleanup
test('lifecycle words only', () => {});
`,
  );

  const score = await scorer.score({
    scenario,
    experiment: {} as never,
    workingDirectory: root,
    observation: { output: '', evidence: [], artifacts: [], durationMs: 0 },
  });

  expect(score.passed).toBe(false);
  expect(score.evidence).toContain(
    'representative stream regression coverage with executable assertions: missing',
  );
});

test.each([
  ['package identity', 'kory.jobs.v2', 'StartJobRequest'],
  ['message identity', 'kory.jobs.v1', 'StartJobRequestV2'],
] as const)(
  'field-evolution scorer rejects a post-window schema that changes %s',
  async (_label, packageName, messageName) => {
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
package ${packageName};
message ${messageName} {
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

    expect(scorer.id).toEndWith('@6');
    expect(score.evidence).toContain('post-window message identity: fail');
    expect(score.evidence).toContain('post-window reservation schema: fail');
    expect(score.passed).toBe(false);
  },
);
