import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CRYPTO_CLOUD_SECURITY_SKILL_EVAL_MATERIALIZERS,
  CRYPTO_CLOUD_SECURITY_SKILL_EVAL_SCORERS,
} from '../skill-eval-crypto-cloud-security-fixtures';
import { buildSkillEvalSuiteV3 } from '../skill-eval-harness';
import { loadV5SkillPackages } from '../skill-packages';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scenario(skill: string, scenarioId: string) {
  const skillPackage = loadV5SkillPackages().packages.find((item) => item.sidecar.name === skill)!;
  return buildSkillEvalSuiteV3(skillPackage).scenarios.find((item) => item.id === scenarioId)!;
}

test('encrypted-document scorer accepts descriptive AAD entries and bounded ownership detail', async () => {
  const item = scenario('applied-cryptography', 'applied-cryptography-full-task-1');
  const root = mkdtempSync(join(tmpdir(), 'kory-crypto-eval-'));
  roots.push(root);
  const materializer = CRYPTO_CLOUD_SECURITY_SKILL_EVAL_MATERIALIZERS.find((entry) =>
    entry.matches(item),
  )!;
  const scorer = CRYPTO_CLOUD_SECURITY_SKILL_EVAL_SCORERS.find((entry) =>
    entry.scenarioIds.includes(item.id),
  )!;
  await materializer.materialize(root, item);
  mkdirSync(join(root, '.kory-eval'), { recursive: true });
  writeFileSync(
    join(root, '.kory-eval/encrypted-document-crypto.json'),
    JSON.stringify({
      aead: {
        algorithm: 'AES-256-GCM',
        standardConstruction: true,
        algorithmIdAuthenticated: true,
        keyIdAuthenticated: true,
        authenticationBeforePlaintextUse: true,
      },
      nonce: {
        uniquenessMode: 'external-atomic-counter',
        scopePerKey: true,
        uniquenessArgument:
          'A durable allocator outside cloned VM state serializes allocation per key across writers, restart, snapshots, and rotation.',
        unqualifiedRandomAssumption: false,
        covers: {
          concurrentWriters: true,
          processRestart: true,
          vmSnapshotClone: true,
          keyRotation: true,
        },
      },
      associatedData: [
        'tenantId: length-prefixed UTF-8',
        'documentId: length-prefixed UTF-8',
        'formatVersion: unsigned integer',
        'contentType: normalized ASCII',
        'creationSequence: unsigned integer',
        'algorithmId: registered integer',
        'keyId: length-prefixed UTF-8',
      ],
      serialization: {
        canonicalOrUnambiguous: true,
        versioned: true,
        validatesLengthsBeforeCrypto: true,
        unknownAlgorithmFailsClosed: true,
        downgradeRejected: true,
      },
      negativeCases: [
        'nonce-reuse',
        'ciphertext-bit-flip',
        'tag-bit-flip',
        'tenant-substitution',
        'document-substitution',
        'truncation',
        'wrong-key',
        'wrong-format',
        'downgrade',
      ],
      migration: {
        oldVersionRecognizedExplicitly: true,
        authenticateBeforeMigration: true,
        reencryptToExplicitNewVersion: true,
        fallbackToUnknownAlgorithm: false,
      },
      kmsGenerationWrappingRotationOwnedBy:
        'secrets-key-management; application consumes only the supplied DEK',
      evidenceBoundary: 'synthetic design evidence',
    }),
  );
  const score = await scorer.score({
    scenario: item,
    experiment: {} as never,
    workingDirectory: root,
    observation: { output: '', evidence: [], artifacts: [], durationMs: 0 },
  });
  expect(score.passed).toBe(true);
});

test('release-signature scorer accepts the standard Ed25519 spelling in a bounded report', async () => {
  const item = scenario('applied-cryptography', 'applied-cryptography-full-task-2');
  const root = mkdtempSync(join(tmpdir(), 'kory-release-signature-eval-'));
  roots.push(root);
  const materializer = CRYPTO_CLOUD_SECURITY_SKILL_EVAL_MATERIALIZERS.find((entry) =>
    entry.matches(item),
  )!;
  const scorer = CRYPTO_CLOUD_SECURITY_SKILL_EVAL_SCORERS.find((entry) =>
    entry.scenarioIds.includes(item.id),
  )!;
  await materializer.materialize(root, item);
  writeFileSync(
    join(root, 'src/manifest-format.ts'),
    `export interface ReleaseManifest {
  product: string;
  channel: string;
  version: string;
  artifactDigest: string;
  minimumCompatibleVersion: string;
  expiration: string;
  signingKeyId: string;
  algorithmId: string;
}
export const RELEASE_DOMAIN = 'koryphaios:offline-release-manifest:v1';
const fields = ['product','channel','version','artifactDigest','minimumCompatibleVersion','expiration','signingKeyId','algorithmId'] as const;
export function canonicalManifestBytes(manifest: ReleaseManifest): Uint8Array {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [encoder.encode(RELEASE_DOMAIN), Uint8Array.of(0)];
  for (const field of fields) {
    const value = encoder.encode(manifest[field]);
    const length = new Uint8Array(4);
    new DataView(length.buffer).setUint32(0, value.length, false);
    chunks.push(length, value);
  }
  const output = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; }
  return output;
}
`,
  );
  writeFileSync(
    join(root, 'tests/manifest-format.test.ts'),
    `import { expect, test } from 'bun:test';
import { canonicalManifestBytes } from '../src/manifest-format';
test('canonical insertion order preserves the release domain', () => {
  const a = { product:'Koryphaios',channel:'stable',version:'5.2.0',artifactDigest:'sha256:abc123',minimumCompatibleVersion:'5.0.0',expiration:'2026-12-31T23:59:59Z',signingKeyId:'release-ed25519-2026',algorithmId:'Ed25519' };
  const b = { algorithmId:'Ed25519',signingKeyId:'release-ed25519-2026',expiration:'2026-12-31T23:59:59Z',minimumCompatibleVersion:'5.0.0',artifactDigest:'sha256:abc123',version:'5.2.0',channel:'stable',product:'Koryphaios' };
  expect([...canonicalManifestBytes(a)]).toEqual([...canonicalManifestBytes(b)]);
});
`,
  );
  mkdirSync(join(root, '.kory-eval'), { recursive: true });
  writeFileSync(
    join(root, '.kory-eval/release-signature.json'),
    JSON.stringify({
      algorithm: 'Ed25519',
      domain: 'fixed release-manifest domain',
      rollback: 'reject',
      expiration: 'reject expired releases',
      downgrade: 'reject algorithm downgrade',
      unknownAlgorithm: 'unknown algorithm values fail closed',
      secretsKeyManagement: 'HSM custody and rotation own private-key lifecycle',
      evidence: 'synthetic local evidence',
      liveSigningKeyVerification: false,
    }),
  );
  const score = await scorer.score({
    scenario: item,
    experiment: {} as never,
    workingDirectory: root,
    observation: { output: '', evidence: [], artifacts: [], durationMs: 0 },
  });
  expect(scorer.id).toEndWith('@4');
  expect(score.passed).toBe(true);
});

test('cloud-security materializers declare the JSON shape their scorers require', async () => {
  for (const scenarioId of ['cloud-security-full-task-1', 'cloud-security-full-task-2']) {
    const item = scenario('cloud-security', scenarioId);
    const root = mkdtempSync(join(tmpdir(), 'kory-cloud-security-eval-'));
    roots.push(root);
    const materializer = CRYPTO_CLOUD_SECURITY_SKILL_EVAL_MATERIALIZERS.find((entry) =>
      entry.matches(item),
    )!;
    await materializer.materialize(root, item);
    const spec = readFileSync(join(root, 'src/cloud-security-spec.ts'), 'utf8');
    const readme = readFileSync(join(root, 'README.md'), 'utf8');
    expect(spec).toContain(
      scenarioId.endsWith('-1') ? 'AwsCloudSecuritySpec' : 'GcpCloudSecuritySpec',
    );
    expect(readme).toContain('src/cloud-security-spec.ts');
  }
});
