import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  SkillEvalDeterministicScorer,
  SkillEvalFixtureMaterializer,
} from './skill-eval-execution';
import {
  hasRegressionText,
  packageJson,
  readJsonArtifact,
  runHiddenBunTest,
  writeFixtureFile,
} from './skill-eval-fixture-helpers';

const ENCRYPTED_DOCUMENT = 'applied-cryptography-full-task-1';
const RELEASE_SIGNATURE = 'applied-cryptography-full-task-2';
const AWS_CLOUD = 'cloud-security-full-task-1';
const GCP_CLOUD = 'cloud-security-full-task-2';

const AWS_CLOUD_SPEC_TYPES = `export interface AwsCloudSecuritySpec {
  humanIdentity: {
    federatedTemporary: boolean;
    longLivedKeysRetired: boolean;
    breakGlassProtectedAndAudited: boolean;
  };
  workload: { workloadSpecificIdentity: boolean; inheritsNodeRole: boolean };
  crossAccount: {
    trustsWholeSourceAccount: boolean;
    principalScoped: boolean;
    resourceScoped: boolean;
    conditions: string[];
    kmsExplicit: boolean;
  };
  guardrails: {
    publicAccessBlocked: boolean;
    preventiveOrganizationPolicy: boolean;
    prohibitedConfigurationTestDenied: boolean;
  };
  audit: {
    centralized: boolean;
    primaryCopyProtectedFromWorkloadAdmins: boolean;
    retentionProtected: boolean;
  };
  verification: { allowed: string[]; denied: string[] };
  liveProviderVerified: boolean;
  containerPrivilegeOwnedBy: string;
}
`;

const GCP_CLOUD_SPEC_TYPES = `export interface GcpCloudSecuritySpec {
  ci: {
    workloadIdentityFederation: boolean;
    longLivedServiceAccountKey: boolean;
    shortLivedCredentials: boolean;
    trustMapping: { issuer: string; audience: string; attributes: Record<string, string> };
  };
  identities: {
    ciAndRuntimeSeparate: boolean;
    ciProjectEditor: boolean;
    runtimeProjectEditor: boolean;
    resourceScoped: boolean;
  };
  publicAccess: { allUsersRemoved: boolean; anonymousReadDenied: boolean };
  guardrails: {
    blockServiceAccountKeyCreation: boolean;
    restrictUnmanagedPublicExposure: boolean;
    requiredAuditLogging: boolean;
  };
  audit: { centralized: boolean; destinationProtected: boolean; retentionAuthority: string };
  verification: { allowed: string[]; denied: string[] };
  liveProviderVerified: boolean;
}
`;

function artifactText(root: string, path: string): { artifact: unknown | null; text: string } {
  const artifact = readJsonArtifact<unknown>(root, path);
  return { artifact, text: JSON.stringify(artifact ?? '').toLowerCase() };
}

function hasBoolean(value: unknown, key: string, expected: boolean): boolean {
  if (Array.isArray(value)) return value.some((item) => hasBoolean(item, key, expected));
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (record[key] === expected) return true;
  return Object.values(record).some((item) => hasBoolean(item, key, expected));
}

const ENVELOPE_SPEC_TYPES = `export interface EnvelopeCryptoSpec {
  aead: {
    algorithm: string;
    standardConstruction: boolean;
    algorithmIdAuthenticated: boolean;
    keyIdAuthenticated: boolean;
    authenticationBeforePlaintextUse: boolean;
  };
  nonce: {
    uniquenessMode: 'random-192-plus' | 'external-atomic-counter' | 'fresh-key-single-use';
    scopePerKey: boolean;
    randomBits?: number;
    uniquenessArgument: string;
    unqualifiedRandomAssumption: boolean;
    covers: {
      concurrentWriters: boolean;
      processRestart: boolean;
      vmSnapshotClone: boolean;
      keyRotation: boolean;
    };
  };
  associatedData: string[];
  serialization: {
    canonicalOrUnambiguous: boolean;
    versioned: boolean;
    validatesLengthsBeforeCrypto: boolean;
    unknownAlgorithmFailsClosed: boolean;
    downgradeRejected: boolean;
  };
  negativeCases: string[];
  migration: {
    oldVersionRecognizedExplicitly: boolean;
    authenticateBeforeMigration: boolean;
    reencryptToExplicitNewVersion: boolean;
    fallbackToUnknownAlgorithm: boolean;
  };
  kmsGenerationWrappingRotationOwnedBy: string;
  evidenceBoundary: string;
}
`;

const ENVELOPE_CORPUS = `${JSON.stringify(
  {
    metadata: {
      tenantId: 'tenant-acme',
      documentId: 'doc-42',
      formatVersion: 1,
      contentType: 'application/json',
      creationSequence: 8842,
    },
    suppliedKey: {
      keyId: 'dek-7',
      note: 'random DEK supplied externally; generation/wrapping out of scope',
    },
    faultCases: [
      'nonce-reuse-under-same-key',
      'ciphertext-bit-flip',
      'tag-bit-flip',
      'tenant-id-substitution',
      'document-id-substitution',
      'truncation',
      'wrong-key-id',
      'wrong-format-version',
      'algorithm-downgrade',
    ],
    nonceThreats: ['concurrent-writers', 'process-restart', 'vm-snapshot-clone', 'key-rotation'],
  },
  null,
  2,
)}\n`;

const encryptedDocumentMaterializer: SkillEvalFixtureMaterializer = {
  id: 'applied-cryptography/encrypted-document-envelope@1',
  matches: (scenario) => scenario.id === ENCRYPTED_DOCUMENT,
  materialize: (destination) => {
    writeFixtureFile(destination, 'package.json', packageJson('kory-eval-crypto-envelope'));
    writeFixtureFile(destination, 'src/envelope-spec.ts', ENVELOPE_SPEC_TYPES);
    writeFixtureFile(destination, 'evidence/negative-corpus.json', ENVELOPE_CORPUS);
    writeFixtureFile(destination, 'tests/.gitkeep', '');
    writeFixtureFile(
      destination,
      'README.md',
      `# Versioned encrypted-document cryptography design

This fixture evaluates a cryptographic protocol design and negative-vector contract; do not invent a new cipher or KMS. Preserve the supplied type contract and negative corpus. Write \`.kory-eval/encrypted-document-crypto.json\` as \`EnvelopeCryptoSpec\`.

Choose a standard AEAD and authenticate before any plaintext is treated as content. Bind tenant ID, document ID, format version, content type, creation sequence, algorithm ID, and key ID into the authenticated meaning of the envelope. Serialization must be canonical or otherwise unambiguous/versioned, validate bounds/IDs before crypto work, and fail closed on unknown/downgrade algorithms.

Nonce uniqueness is per key. Give an explicit argument that covers concurrent writers, restart, VM snapshot/clone, and key rotation. An unqualified “random nonce” assertion is not enough: for the random strategy this fixture requires at least 192 random bits plus the stated collision/uniqueness argument; alternatively use a documented external atomic allocator or a fresh-key-single-use construction whose premise is explicit.

Include every supplied negative case and a migration rule that authenticates old data before re-encryption into an explicit new version. KMS generation/wrapping/rotation stays owned by \`secrets-key-management\`. Label all evidence synthetic/design-only.
`,
    );
  },
};

const encryptedDocumentScorer: SkillEvalDeterministicScorer = {
  id: 'applied-cryptography/encrypted-document-envelope-scorer@2',
  scenarioIds: [ENCRYPTED_DOCUMENT],
  score: ({ workingDirectory }) => {
    const hidden = runHiddenBunTest(
      workingDirectory,
      `import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { EnvelopeCryptoSpec } from '../src/envelope-spec';

const spec = JSON.parse(readFileSync('.kory-eval/encrypted-document-crypto.json','utf8')) as EnvelopeCryptoSpec;
const requiredAad = ['tenantId','documentId','formatVersion','contentType','creationSequence','algorithmId','keyId'];
const requiredNegatives = ['nonce-reuse','ciphertext','tag','tenant','document','trunc','wrong-key','wrong-format','downgrade'];

test('hidden: AEAD, authenticated domain binding, and fail-closed parsing are explicit', () => {
  expect(spec.aead.standardConstruction).toBe(true);
  expect(spec.aead.algorithm.toLowerCase()).toMatch(/gcm|poly1305/);
  expect(spec.aead.algorithmIdAuthenticated).toBe(true);
  expect(spec.aead.keyIdAuthenticated).toBe(true);
  expect(spec.aead.authenticationBeforePlaintextUse).toBe(true);
  for (const field of requiredAad) {
    expect(spec.associatedData.some((entry) =>
      entry === field || entry.startsWith(field + ':') || entry.startsWith(field + ' ')
    )).toBe(true);
  }
  expect(spec.serialization.canonicalOrUnambiguous).toBe(true);
  expect(spec.serialization.versioned).toBe(true);
  expect(spec.serialization.validatesLengthsBeforeCrypto).toBe(true);
  expect(spec.serialization.unknownAlgorithmFailsClosed).toBe(true);
  expect(spec.serialization.downgradeRejected).toBe(true);
});

test('hidden: nonce uniqueness argument covers restart/concurrency/clone/key rotation', () => {
  expect(spec.nonce.scopePerKey).toBe(true);
  expect(spec.nonce.unqualifiedRandomAssumption).toBe(false);
  expect(spec.nonce.uniquenessArgument.length).toBeGreaterThan(30);
  for (const key of ['concurrentWriters','processRestart','vmSnapshotClone','keyRotation'] as const) expect(spec.nonce.covers[key]).toBe(true);
  if (spec.nonce.uniquenessMode === 'random-192-plus') expect(spec.nonce.randomBits ?? 0).toBeGreaterThanOrEqual(192);
  else expect(['external-atomic-counter','fresh-key-single-use']).toContain(spec.nonce.uniquenessMode);
});

test('hidden: negative corpus, migration, and KMS boundary fail closed', () => {
  const joined = spec.negativeCases.join(' ').toLowerCase();
  for (const token of requiredNegatives) expect(joined).toContain(token);
  expect(spec.migration.oldVersionRecognizedExplicitly).toBe(true);
  expect(spec.migration.authenticateBeforeMigration).toBe(true);
  expect(spec.migration.reencryptToExplicitNewVersion).toBe(true);
  expect(spec.migration.fallbackToUnknownAlgorithm).toBe(false);
  expect(spec.kmsGenerationWrappingRotationOwnedBy.toLowerCase()).toMatch(/^secrets-key-management(?:\\b|[;,:])/);
  expect(spec.evidenceBoundary.toLowerCase()).toMatch(/synthetic|design/);
});
`,
    );
    const typesPreserved =
      readFileSync(join(workingDirectory, 'src/envelope-spec.ts'), 'utf8') === ENVELOPE_SPEC_TYPES;
    const corpusPreserved =
      readFileSync(join(workingDirectory, 'evidence/negative-corpus.json'), 'utf8') ===
      ENVELOPE_CORPUS;
    const report = artifactText(workingDirectory, '.kory-eval/encrypted-document-crypto.json');
    const bounded =
      Boolean(report.artifact) &&
      /secrets-key-management/u.test(report.text) &&
      /synthetic|design/u.test(report.text) &&
      hasBoolean(report.artifact, 'unqualifiedRandomAssumption', false);
    const passed = hidden.passed && typesPreserved && corpusPreserved && bounded;
    return {
      passed,
      quality: passed ? 1 : hidden.passed && corpusPreserved ? 0.8 : hidden.passed ? 0.6 : 0,
      verification: hidden.passed ? 1 : 0,
      integrityFailure: !typesPreserved || !corpusPreserved,
      evidence: [
        `AEAD/nonce/AAD/migration design vectors: ${hidden.passed ? 'pass' : 'fail'}`,
        `negative corpus + type contract preserved: ${typesPreserved && corpusPreserved ? 'yes' : 'no'}`,
        `KMS/evidence boundary: ${bounded ? 'bounded' : 'missing'}`,
        hidden.evidence,
      ],
    };
  },
};

const MANIFEST_SOURCE = `export interface ReleaseManifest {
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

export function canonicalManifestBytes(manifest: ReleaseManifest): Uint8Array {
  // BUG: insertion-order JSON is ambiguous across independent implementations.
  return new TextEncoder().encode(RELEASE_DOMAIN + String.fromCharCode(0) + JSON.stringify(manifest));
}
`;

const MANIFEST_VECTORS = `${JSON.stringify(
  {
    implementationA: {
      product: 'Koryphaios',
      channel: 'stable',
      version: '5.2.0',
      artifactDigest: 'sha256:abc123',
      minimumCompatibleVersion: '5.0.0',
      expiration: '2026-12-31T23:59:59Z',
      signingKeyId: 'release-ed25519-2026',
      algorithmId: 'Ed25519',
    },
    implementationBInsertionOrder: [
      'algorithmId',
      'signingKeyId',
      'expiration',
      'minimumCompatibleVersion',
      'artifactDigest',
      'version',
      'channel',
      'product',
    ],
    mutations: [
      'wrong-domain',
      'wrong-key-id',
      'unknown-algorithm',
      'malformed-signature',
      'artifact-digest-modified',
      'expired',
      'rollback-version',
      'minimum-version-violation',
      'algorithm-downgrade',
    ],
  },
  null,
  2,
)}\n`;

const releaseSignatureMaterializer: SkillEvalFixtureMaterializer = {
  id: 'applied-cryptography/offline-release-signature@1',
  matches: (scenario) => scenario.id === RELEASE_SIGNATURE,
  materialize: (destination) => {
    writeFixtureFile(destination, 'package.json', packageJson('kory-eval-release-signature'));
    writeFixtureFile(destination, 'src/manifest-format.ts', MANIFEST_SOURCE);
    writeFixtureFile(destination, 'evidence/release-vectors.json', MANIFEST_VECTORS);
    writeFixtureFile(
      destination,
      'tests/manifest-format.test.ts',
      `import { expect, test } from 'bun:test';
import { RELEASE_DOMAIN, canonicalManifestBytes } from '../src/manifest-format';

test('signed representation is domain-prefixed', () => {
  const manifest = { product:'Koryphaios',channel:'stable',version:'5.2.0',artifactDigest:'sha256:abc123',minimumCompatibleVersion:'5.0.0',expiration:'2026-12-31T23:59:59Z',signingKeyId:'release-ed25519-2026',algorithmId:'Ed25519' };
  expect(new TextDecoder().decode(canonicalManifestBytes(manifest)).startsWith(RELEASE_DOMAIN + String.fromCharCode(0))).toBe(true);
});
`,
    );
    writeFixtureFile(
      destination,
      'README.md',
      `# Offline release-manifest signature format

Repair only the canonical-byte formatter needed for cross-implementation determinism; do not implement signature primitives. The signed bytes must start with the fixed \`RELEASE_DOMAIN\` plus a NUL separator and then an unambiguous deterministic representation of every manifest field. Equivalent manifests with different object insertion order must produce identical bytes.

Write \`.kory-eval/release-signature.json\` with: approved standard signature algorithm/key form; the exact canonicalization rule; authenticated domain/product/channel/version/artifact/min-version/expiration/key/algorithm fields; verification order that fails closed on unknown algorithm/key and verifies authenticity before trusting release semantics; rollback, expiry, artifact-digest, malformed-signature, wrong-domain/key/version, and downgrade negatives; deterministic algorithm-agility rules; and \`secrets-key-management\` ownership for HSM custody/rotation ceremony. Label evidence synthetic/local and do not claim live signing-key verification.

Add a regression proving the supplied semantic manifest produces the same canonical bytes under reverse insertion order.
`,
    );
  },
};

const releaseSignatureScorer: SkillEvalDeterministicScorer = {
  id: 'applied-cryptography/offline-release-signature-scorer@4',
  scenarioIds: [RELEASE_SIGNATURE],
  score: ({ workingDirectory }) => {
    const hidden = runHiddenBunTest(
      workingDirectory,
      `import { expect, test } from 'bun:test';
import { RELEASE_DOMAIN, canonicalManifestBytes, type ReleaseManifest } from '../src/manifest-format';

const a: ReleaseManifest = { product:'Koryphaios',channel:'stable',version:'5.2.0',artifactDigest:'sha256:abc123',minimumCompatibleVersion:'5.0.0',expiration:'2026-12-31T23:59:59Z',signingKeyId:'release-ed25519-2026',algorithmId:'Ed25519' };
const b = { algorithmId:'Ed25519',signingKeyId:'release-ed25519-2026',expiration:'2026-12-31T23:59:59Z',minimumCompatibleVersion:'5.0.0',artifactDigest:'sha256:abc123',version:'5.2.0',channel:'stable',product:'Koryphaios' } as ReleaseManifest;

test('hidden: canonical signed bytes are insertion-order independent and domain separated', () => {
  const left = canonicalManifestBytes(a); const right = canonicalManifestBytes(b);
  expect([...left]).toEqual([...right]);
  const text = new TextDecoder().decode(left);
  expect(text.startsWith(RELEASE_DOMAIN + String.fromCharCode(0))).toBe(true);
  for (const value of ['Koryphaios','stable','5.2.0','sha256:abc123','5.0.0','2026-12-31T23:59:59Z','release-ed25519-2026','Ed25519']) expect(text).toContain(value);
});
`,
    );
    const regression = hasRegressionText(workingDirectory, [
      /insertion|order|canonical/iu,
      /domain/iu,
    ]);
    const vectorsPath = join(workingDirectory, 'evidence/release-vectors.json');
    const vectorsPreserved =
      existsSync(vectorsPath) && readFileSync(vectorsPath, 'utf8') === MANIFEST_VECTORS;
    const report = artifactText(workingDirectory, '.kory-eval/release-signature.json');
    const bounded =
      Boolean(report.artifact) &&
      /ed25519|ecdsa|rsa-pss/iu.test(report.text) &&
      /domain/u.test(report.text) &&
      /rollback/u.test(report.text) &&
      /expir/u.test(report.text) &&
      /downgrade/u.test(report.text) &&
      /unknown.*algorithm|algorithm.*unknown/u.test(report.text) &&
      /secrets[-_ ]?key[-_ ]?management/iu.test(report.text) &&
      /synthetic|local/u.test(report.text) &&
      !/live.*(?:verified|proved)/u.test(report.text);
    const passed = hidden.passed && regression && vectorsPreserved && bounded;
    return {
      passed,
      quality: passed ? 1 : hidden.passed && regression ? 0.8 : hidden.passed ? 0.6 : 0,
      verification: hidden.passed ? 1 : 0,
      integrityFailure: !vectorsPreserved,
      evidence: [
        `cross-implementation canonical bytes: ${hidden.passed ? 'pass' : 'fail'}`,
        `canonicalization regression coverage: ${regression ? 'present' : 'missing'}`,
        `signature/release semantics + scope boundary: ${bounded ? 'bounded' : 'missing'}`,
        hidden.evidence,
      ],
    };
  },
};

const AWS_STATE = `${JSON.stringify(
  {
    organization: {
      accounts: ['prod', 'non-prod'],
      cloudTrail: 'account-local-only',
      scpGuardrails: [],
    },
    humanIdentity: {
      iamUsersWithLongLivedKeys: ['alice', 'bob'],
      federation: false,
      breakGlass: 'undefined',
    },
    eks: {
      workload: 'analytics-api',
      currentIdentity: 'node-role',
      nodeRoleActions: ['s3:*', 'kms:*', 'sts:AssumeRole'],
    },
    crossAccount: {
      role: 'analytics-reader',
      trust: { principal: 'entire-source-account' },
      s3: {
        bucket: 'prod-analytics',
        actions: ['s3:GetObject'],
        resources: ['arn:aws:s3:::prod-analytics/*'],
      },
      kms: { grants: 'undocumented' },
    },
    publicAccess: { s3BlockPublicAccess: false },
  },
  null,
  2,
)}\n`;

const awsCloudMaterializer: SkillEvalFixtureMaterializer = {
  id: 'cloud-security/aws-org-policy-review@2',
  matches: (scenario) => scenario.id === AWS_CLOUD,
  materialize: (destination) => {
    writeFixtureFile(destination, 'package.json', packageJson('kory-eval-cloud-security-aws'));
    writeFixtureFile(destination, 'evidence/aws-state.json', AWS_STATE);
    writeFixtureFile(destination, 'src/cloud-security-spec.ts', AWS_CLOUD_SPEC_TYPES);
    writeFixtureFile(destination, 'tests/.gitkeep', '');
    writeFixtureFile(
      destination,
      'README.md',
      `# Synthetic AWS cloud-security policy review

Preserve \`evidence/aws-state.json\` and \`src/cloud-security-spec.ts\`; the state is synthetic provider-policy evidence, not a live AWS account. Write \`.kory-eval/cloud-security-aws.json\` using the exported \`AwsCloudSecuritySpec\` shape so the remediated effective policy and representative allow/deny analysis are explicit.

Required design: federated short-lived human access; separately protected/audited emergency path; EKS workload-specific temporary identity instead of node-role inheritance; principal/action/resource/condition-scoped cross-account trust; coordinated S3 and KMS permissions; preventive organization/account guardrails including public-access posture; centralized protected audit logs whose primary copy cannot be silently erased by workload/account admins.

Include representative intended allows and cross-account/public/escalation denials based on synthetic IAM/resource-policy analysis or safe-test-call simulation. Set \`liveProviderVerified: false\` and label the evidence synthetic. Keep pod/container privilege assigned to \`infrastructure-security\`.
`,
    );
  },
};

const awsCloudScorer: SkillEvalDeterministicScorer = {
  id: 'cloud-security/aws-org-policy-review-scorer@2',
  scenarioIds: [AWS_CLOUD],
  score: ({ workingDirectory }) => {
    const hidden = runHiddenBunTest(
      workingDirectory,
      `import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
const spec = JSON.parse(readFileSync('.kory-eval/cloud-security-aws.json','utf8')) as any;

test('hidden: human/workload/cross-account identities are temporary and scoped', () => {
  expect(spec.humanIdentity.federatedTemporary).toBe(true);
  expect(spec.humanIdentity.longLivedKeysRetired).toBe(true);
  expect(spec.humanIdentity.breakGlassProtectedAndAudited).toBe(true);
  expect(spec.workload.workloadSpecificIdentity).toBe(true);
  expect(spec.workload.inheritsNodeRole).toBe(false);
  expect(spec.crossAccount.trustsWholeSourceAccount).toBe(false);
  expect(spec.crossAccount.principalScoped).toBe(true);
  expect(spec.crossAccount.resourceScoped).toBe(true);
  expect(spec.crossAccount.conditions?.length ?? 0).toBeGreaterThan(0);
  expect(spec.crossAccount.kmsExplicit).toBe(true);
});

test('hidden: guardrail/audit/effective-access design includes both allows and denials', () => {
  expect(spec.guardrails.publicAccessBlocked).toBe(true);
  expect(spec.guardrails.preventiveOrganizationPolicy).toBe(true);
  expect(spec.guardrails.prohibitedConfigurationTestDenied).toBe(true);
  expect(spec.audit.centralized).toBe(true);
  expect(spec.audit.primaryCopyProtectedFromWorkloadAdmins).toBe(true);
  expect(spec.audit.retentionProtected).toBe(true);
  expect(spec.verification.allowed?.length ?? 0).toBeGreaterThan(0);
  expect(spec.verification.denied?.length ?? 0).toBeGreaterThanOrEqual(3);
  expect(spec.liveProviderVerified).toBe(false);
  expect(spec.containerPrivilegeOwnedBy).toBe('infrastructure-security');
});
`,
    );
    const statePreserved =
      readFileSync(join(workingDirectory, 'evidence/aws-state.json'), 'utf8') === AWS_STATE;
    const specPreserved =
      readFileSync(join(workingDirectory, 'src/cloud-security-spec.ts'), 'utf8') ===
      AWS_CLOUD_SPEC_TYPES;
    const report = artifactText(workingDirectory, '.kory-eval/cloud-security-aws.json');
    const bounded =
      Boolean(report.artifact) &&
      /synthetic/u.test(report.text) &&
      /iam|policy/u.test(report.text) &&
      /s3/u.test(report.text) &&
      /kms/u.test(report.text) &&
      /cloudtrail|audit/u.test(report.text) &&
      hasBoolean(report.artifact, 'liveProviderVerified', false);
    const passed = hidden.passed && statePreserved && specPreserved && bounded;
    return {
      passed,
      quality: passed
        ? 1
        : hidden.passed && statePreserved && specPreserved
          ? 0.8
          : hidden.passed
            ? 0.6
            : 0,
      verification: hidden.passed ? 1 : 0,
      integrityFailure: !statePreserved || !specPreserved,
      evidence: [
        `AWS effective-policy design checks: ${hidden.passed ? 'pass' : 'fail'}`,
        `synthetic provider state/spec preserved: ${statePreserved && specPreserved ? 'yes' : 'no'}`,
        `provider-evidence boundary: ${bounded ? 'bounded' : 'missing'}`,
        hidden.evidence,
      ],
    };
  },
};

const GCP_STATE = `${JSON.stringify(
  {
    organization: { orgPolicies: [], centralizedAudit: false },
    ci: {
      location: 'external',
      credential: 'downloaded-service-account-key',
      identity: 'ci-deployer',
    },
    cloudRun: { service: 'api', runtimeServiceAccountRole: 'roles/editor' },
    storage: { bucket: 'reports-prod', publicPrincipal: 'allUsers', publicReadable: true },
    bigQuery: { dataset: 'analytics', projectWideBindings: true },
    audit: { destinations: ['project-local'], retentionOwner: 'project-admins' },
  },
  null,
  2,
)}\n`;

const gcpCloudMaterializer: SkillEvalFixtureMaterializer = {
  id: 'cloud-security/gcp-wif-policy-review@2',
  matches: (scenario) => scenario.id === GCP_CLOUD,
  materialize: (destination) => {
    writeFixtureFile(destination, 'package.json', packageJson('kory-eval-cloud-security-gcp'));
    writeFixtureFile(destination, 'evidence/gcp-state.json', GCP_STATE);
    writeFixtureFile(destination, 'src/cloud-security-spec.ts', GCP_CLOUD_SPEC_TYPES);
    writeFixtureFile(destination, 'tests/.gitkeep', '');
    writeFixtureFile(
      destination,
      'README.md',
      `# Synthetic GCP cloud-security policy review

Preserve the supplied state and \`src/cloud-security-spec.ts\`; no live GCP account is connected. Write \`.kory-eval/cloud-security-gcp.json\` using the exported \`GcpCloudSecuritySpec\` shape with a remediated policy model and synthetic allow/deny analysis.

External CI must use Workload Identity Federation with explicit issuer/audience/attribute trust mapping and short-lived credentials; downloaded long-lived service-account keys are removed. CI deploy and Cloud Run runtime identities are separate and resource-scoped; neither may retain project-wide Editor/basic-role power. Remove unintended \`allUsers\` exposure and prove a representative anonymous denial. Constrain Storage and BigQuery access.

Define organization/project guardrails for service-account key creation, unmanaged public exposure, and required logging where supported, with named exception handling. Export relevant IAM/admin/resource audit evidence to a protected centralized destination and identify who can alter retention/destination. Include intended allows and representative denials. Set \`liveProviderVerified: false\`, label evidence synthetic, and keep application tenant authorization/container internals out of this skill.
`,
    );
  },
};

const gcpCloudScorer: SkillEvalDeterministicScorer = {
  id: 'cloud-security/gcp-wif-policy-review-scorer@2',
  scenarioIds: [GCP_CLOUD],
  score: ({ workingDirectory }) => {
    const hidden = runHiddenBunTest(
      workingDirectory,
      `import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
const spec = JSON.parse(readFileSync('.kory-eval/cloud-security-gcp.json','utf8')) as any;

test('hidden: external CI uses bounded WIF and separate least-privileged runtime identity', () => {
  expect(spec.ci.workloadIdentityFederation).toBe(true);
  expect(spec.ci.longLivedServiceAccountKey).toBe(false);
  expect(spec.ci.shortLivedCredentials).toBe(true);
  expect(spec.ci.trustMapping?.issuer).toBeTruthy();
  expect(spec.ci.trustMapping?.audience).toBeTruthy();
  expect(spec.ci.trustMapping?.attributes).toBeTruthy();
  expect(spec.identities.ciAndRuntimeSeparate).toBe(true);
  expect(spec.identities.ciProjectEditor).toBe(false);
  expect(spec.identities.runtimeProjectEditor).toBe(false);
  expect(spec.identities.resourceScoped).toBe(true);
});

test('hidden: public exposure, org policy, audit, and denied paths are explicit', () => {
  expect(spec.publicAccess.allUsersRemoved).toBe(true);
  expect(spec.publicAccess.anonymousReadDenied).toBe(true);
  expect(spec.guardrails.blockServiceAccountKeyCreation).toBe(true);
  expect(spec.guardrails.restrictUnmanagedPublicExposure).toBe(true);
  expect(spec.guardrails.requiredAuditLogging).toBe(true);
  expect(spec.audit.centralized).toBe(true);
  expect(spec.audit.destinationProtected).toBe(true);
  expect(spec.audit.retentionAuthority).toBeTruthy();
  expect(spec.verification.allowed?.length ?? 0).toBeGreaterThan(0);
  expect(spec.verification.denied?.length ?? 0).toBeGreaterThanOrEqual(2);
  expect(spec.liveProviderVerified).toBe(false);
});
`,
    );
    const statePreserved =
      readFileSync(join(workingDirectory, 'evidence/gcp-state.json'), 'utf8') === GCP_STATE;
    const specPreserved =
      readFileSync(join(workingDirectory, 'src/cloud-security-spec.ts'), 'utf8') ===
      GCP_CLOUD_SPEC_TYPES;
    const report = artifactText(workingDirectory, '.kory-eval/cloud-security-gcp.json');
    const bounded =
      Boolean(report.artifact) &&
      /workload identity federation|wif/u.test(report.text) &&
      /synthetic/u.test(report.text) &&
      /storage/u.test(report.text) &&
      /bigquery/u.test(report.text) &&
      /audit/u.test(report.text) &&
      hasBoolean(report.artifact, 'liveProviderVerified', false);
    const passed = hidden.passed && statePreserved && specPreserved && bounded;
    return {
      passed,
      quality: passed
        ? 1
        : hidden.passed && statePreserved && specPreserved
          ? 0.8
          : hidden.passed
            ? 0.6
            : 0,
      verification: hidden.passed ? 1 : 0,
      integrityFailure: !statePreserved || !specPreserved,
      evidence: [
        `GCP WIF/least-privilege/public/audit checks: ${hidden.passed ? 'pass' : 'fail'}`,
        `synthetic provider state/spec preserved: ${statePreserved && specPreserved ? 'yes' : 'no'}`,
        `provider-evidence boundary: ${bounded ? 'bounded' : 'missing'}`,
        hidden.evidence,
      ],
    };
  },
};

export const CRYPTO_CLOUD_SECURITY_SKILL_EVAL_MATERIALIZERS: readonly SkillEvalFixtureMaterializer[] =
  [
    encryptedDocumentMaterializer,
    releaseSignatureMaterializer,
    awsCloudMaterializer,
    gcpCloudMaterializer,
  ];

export const CRYPTO_CLOUD_SECURITY_SKILL_EVAL_SCORERS: readonly SkillEvalDeterministicScorer[] = [
  encryptedDocumentScorer,
  releaseSignatureScorer,
  awsCloudScorer,
  gcpCloudScorer,
];
