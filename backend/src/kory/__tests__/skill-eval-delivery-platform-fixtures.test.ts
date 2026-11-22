import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DELIVERY_PLATFORM_SKILL_EVAL_MATERIALIZERS,
  DELIVERY_PLATFORM_SKILL_EVAL_SCORERS,
} from '../../eval/skills/skill-eval-delivery-platform-fixtures';
import { writeFixtureFile } from '../../eval/skills/skill-eval-fixture-helpers';
import { buildSkillEvalSuiteV3 } from '../../eval/skills/skill-eval-harness';
import { loadV5SkillPackages } from '../skill-packages';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'kory-delivery-platform-'));
  roots.push(root);
  return root;
}

function containerMultiarchScenario() {
  const skillPackage = loadV5SkillPackages().packages.find(
    (candidate) => candidate.sidecar.name === 'container-engineering',
  );
  if (!skillPackage) throw new Error('container-engineering package not found');
  const scenario = buildSkillEvalSuiteV3(skillPackage).scenarios.find(
    (candidate) => candidate.id === 'container-engineering-full-task-2-individual',
  );
  if (!scenario) throw new Error('container multiarch scenario not found');
  return scenario;
}

describe('container multiarch OCI scorer', () => {
  test('accepts standard x64/aarch64 dependency aliases for amd64/arm64 children', async () => {
    const scenario = containerMultiarchScenario();
    const root = workspace();
    const materializer = DELIVERY_PLATFORM_SKILL_EVAL_MATERIALIZERS.find(
      (candidate) => candidate.id === 'container-engineering/multiarch-oci-index@1',
    );
    const scorer = DELIVERY_PLATFORM_SKILL_EVAL_SCORERS.find(
      (candidate) => candidate.id === 'container-engineering/multiarch-oci-index-scorer@2',
    );
    expect(materializer).toBeDefined();
    expect(scorer).toBeDefined();
    await materializer!.materialize(root, scenario);

    writeFixtureFile(
      root,
      '.kory-eval/oci-index.json',
      `${JSON.stringify(
        {
          mediaType: 'application/vnd.oci.image.index.v1+json',
          manifests: [
            {
              platform: { os: 'linux', architecture: 'amd64' },
              digest: `sha256:${'a'.repeat(64)}`,
              nativeDependency: 'native-addon-linux-x64-glibc@2.4.1',
              libc: 'glibc',
              entrypoint: ['/usr/local/bin/app'],
              user: '10001:10001',
              writablePaths: ['/tmp', '/var/lib/app'],
              smoke: 'pass',
              execution: 'emulated',
            },
            {
              platform: { os: 'linux', architecture: 'arm64' },
              digest: `sha256:${'b'.repeat(64)}`,
              nativeDependency: 'native-addon-linux-aarch64-glibc@2.4.1',
              libc: 'glibc',
              entrypoint: ['/usr/local/bin/app'],
              user: '10001:10001',
              writablePaths: ['/tmp', '/var/lib/app'],
              smoke: 'pass',
              execution: 'emulated',
            },
          ],
        },
        null,
        2,
      )}\n`,
    );
    writeFixtureFile(
      root,
      '.kory-eval/multiarch-evidence.json',
      `${JSON.stringify(
        {
          platforms: ['linux/amd64', 'linux/arm64'],
          digestInspection: true,
          smoke: 'pass',
          execution: 'emulated',
        },
        null,
        2,
      )}\n`,
    );

    const score = await scorer!.score({
      scenario,
      experiment: {} as never,
      workingDirectory: root,
      observation: {} as never,
    });
    expect(score.passed).toBe(true);
    expect(score.integrityFailure).toBe(false);
  });
});
