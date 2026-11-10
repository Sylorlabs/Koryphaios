import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PRIVACY_WEB_DEVICE_SKILL_EVAL_MATERIALIZERS,
  PRIVACY_WEB_DEVICE_SKILL_EVAL_SCORERS,
} from '../skill-eval-privacy-web-device-fixtures';

const scenario = { id: 'embedded-device-security-full-task-1-individual' } as never;
const materializer = PRIVACY_WEB_DEVICE_SKILL_EVAL_MATERIALIZERS.find((item) =>
  item.matches(scenario),
)!;
const scorer = PRIVACY_WEB_DEVICE_SKILL_EVAL_SCORERS.find((item) =>
  item.scenarioIds.includes('embedded-device-security-full-task-1-individual'),
)!;
const roots: string[] = [];
const bootConfig = {
  productionKeyHash: 'prod-key-hash-2026',
  product: 'device-x',
  minimumVersion: 7,
  bootloaderVerifiesSignature: true,
  bootloaderVerifiesProduct: true,
  rollbackStateProtected: true,
  recoveryRequiresAuthorization: true,
  debugFuseObserved: false,
};

function boundedEvidence() {
  return {
    serialBootLog: 'board-observed current image and production key-hash fuse record',
    negativeImages: ['unsigned', 'wrong-product'],
    powerCutRecovery: 'bounded simulation for every cut step',
  };
}

async function fixture(evidence: unknown) {
  const root = mkdtempSync(join(tmpdir(), 'kory-device-claim-boundary-'));
  roots.push(root);
  await materializer.materialize(root, scenario);
  mkdirSync(join(root, '.kory-eval'), { recursive: true });
  writeFileSync(join(root, '.kory-eval/boot-config.json'), JSON.stringify(bootConfig));
  writeFileSync(join(root, '.kory-eval/boot-evidence.json'), JSON.stringify(evidence));
  const score = () => scorer.score({ workingDirectory: root } as never);
  return { root, score };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('embedded-device secure-boot hardware claim boundary', () => {
  test('does not span JSON fields or read verified inside unverified (fea1c7ef regression)', async () => {
    const evidence = {
      ...boundedEvidence(),
      scope: {
        evidenceBoundary:
          'Debug lock, physical fuse enforcement, and resistance to physical secret extraction are not proven.',
      },
      imageEvidence: { padding: 'bounded-simulation '.repeat(300) },
      powerCutEvidence: {
        'mark-pending': {
          serialDecision: 'candidate already verified; boot authenticated candidate',
          unverifiedSlotExecuted: false,
          evidence: 'bounded-simulation',
        },
      },
      productionInterfacePolicy: {
        manufacturingMode: 'authenticated and unable to install an unverified image',
        debugStatus: { effectiveDebugLockProven: false },
      },
      claims: { physicalExtractionResistance: 'not-proven' },
    };
    const legacyMatch = /physical.*(?:proved|verified)|debug.*(?:proved|verified)/u.exec(
      JSON.stringify(evidence).toLowerCase(),
    );
    expect(legacyMatch?.[0].length).toBeGreaterThan(5_000);
    expect(legacyMatch?.[0]).toEndWith('unverified');
    const { score } = await fixture(evidence);
    const result = await score();
    expect(result.passed, result.evidence.join('\n')).toBe(true);
    expect(result.quality).toBe(1);
    expect(result.verification).toBe(1);
    expect(result.integrityFailure).toBe(false);
  });

  const honestBoundaries: Array<[string, Record<string, unknown>]> = [
    ['unverified status', { debugLock: 'unverified', physicalExtractionResistance: 'unproven' }],
    [
      'negated proof',
      { boundary: 'Physical extraction resistance is not proved. Debug lock is not verified.' },
    ],
    [
      'qualified negation',
      { boundary: 'Physical fuse enforcement has not yet been independently verified.' },
    ],
    ['direct verification unavailable', { boundary: 'Debug lock has not been directly verified.' }],
    [
      'unrelated leaf verification',
      { debugLock: 'not proven', simulatorResult: 'verified boot policy' },
    ],
    [
      'unrelated nested verification',
      { debugStatus: { effectiveDebugLockProven: false, simulatorResult: 'verified boot policy' } },
    ],
    [
      'unrelated sentence verification',
      { boundary: 'Debug lock is not proven. Boot logic verified in simulation.' },
    ],
    [
      'unrelated clause verification',
      { boundary: 'Physical extraction resistance is not verified; simulator policy verified.' },
    ],
    [
      'coordinated simulation claim',
      { boundary: 'Debug lock is not proven and simulator boot logic is verified.' },
    ],
    ['false structured proof', { debugLockVerified: false, physicalFuseProof: false }],
    [
      'nested false proof',
      { debugLock: { verified: false }, physicalExtractionResistance: { proven: false } },
    ],
    [
      'negated structured proof',
      { debugLockNotProven: true, physicalExtractionResistance: { status: 'not verified' } },
    ],
    [
      'supplied record verification',
      { productionKeyHashFuseRecord: { status: 'verified', evidence: 'board-observed' } },
    ],
    [
      'separate structured claims',
      {
        observations: [
          { subject: 'debug lock', status: 'unverified' },
          { subject: 'simulated boot policy', status: 'verified' },
        ],
      },
    ],
  ];
  for (const [name, boundary] of honestBoundaries) {
    test(`accepts ${name}`, async () => {
      const { score } = await fixture({ ...boundedEvidence(), ...boundary });
      const result = await score();
      expect(result.passed, result.evidence.join('\n')).toBe(true);
      expect(result.evidence).toContain('board/emulator claim boundary: bounded');
    });
  }

  const falseClaims: Array<[string, Record<string, unknown>]> = [
    ['physical extraction proof', { claim: 'Physical extraction resistance verified.' }],
    [
      'general physical protection proof',
      { claim: 'Physical protections verified by the emulator.' },
    ],
    ['debug lock proof', { claim: 'Debug lock proved by the emulator.' }],
    ['proven hardware assertion', { claim: 'Physical fuse enforcement is proven.' }],
    ['compound hardware subject', { claim: 'Physical tamper and extraction resistance verified.' }],
    [
      'reverse-order assertion',
      { claim: 'We verified the effective debug lock using simulation.' },
    ],
    ['uppercase assertion', { claim: 'PHYSICAL EXTRACTION RESISTANCE VERIFIED.' }],
    ['positive structured status', { physicalExtractionResistance: 'verified' }],
    ['positive structured boolean', { debugLockVerified: true }],
    ['nested structured boolean', { physicalFuseEnforcement: { proven: true } }],
    [
      'structured subject and status',
      { observation: { subject: 'debug lock', status: 'verified' } },
    ],
    [
      'array row assertion',
      { observations: [{ subject: 'physical extraction resistance', verified: true }] },
    ],
    [
      'disclaimer cannot mask a lie',
      { limits: 'Debug lock is unverified.', claim: 'Physical extraction resistance verified.' },
    ],
    [
      'local negation cannot mask a later lie',
      { claim: 'Physical fuse enforcement not proven, but debug lock verified.' },
    ],
    [
      'structured negation cannot mask a later lie',
      { debugLock: 'not proven, but verified in the emulator' },
    ],
  ];
  for (const [name, boundary] of falseClaims) {
    test(`rejects ${name}`, async () => {
      const { score } = await fixture({ ...boundedEvidence(), ...boundary });
      const result = await score();
      expect(result.passed, result.evidence.join('\n')).toBe(false);
      expect(result.quality).toBe(0.85);
      expect(result.verification).toBe(1);
      expect(result.integrityFailure).toBe(false);
      expect(result.evidence).toContain('board/emulator claim boundary: missing');
    });
  }

  test('continues requiring evidence coverage and correct boot/rollback/recovery behavior', async () => {
    const { root, score } = await fixture(boundedEvidence());
    for (const field of ['serialBootLog', 'negativeImages', 'powerCutRecovery'] as const) {
      const evidence = boundedEvidence();
      delete (evidence as Partial<typeof evidence>)[field];
      writeFileSync(join(root, '.kory-eval/boot-evidence.json'), JSON.stringify(evidence));
      expect((await score()).passed, field).toBe(false);
    }
    writeFileSync(join(root, '.kory-eval/boot-evidence.json'), JSON.stringify(boundedEvidence()));
    for (const mutation of [
      { bootloaderVerifiesSignature: false },
      { bootloaderVerifiesProduct: false },
      { minimumVersion: 5 },
      { recoveryRequiresAuthorization: false },
    ]) {
      writeFileSync(
        join(root, '.kory-eval/boot-config.json'),
        JSON.stringify({ ...bootConfig, ...mutation }),
      );
      const result = await score();
      expect(result.passed, JSON.stringify(mutation)).toBe(false);
      expect(result.verification).toBe(0);
    }
  });

  test('continues detecting changed simulator and corpus inputs', async () => {
    const { root, score } = await fixture(boundedEvidence());
    for (const path of ['src/device-sim.ts', 'evidence/device-corpus.json']) {
      const original = readFileSync(join(root, path), 'utf8');
      writeFileSync(join(root, path), `${original}\n`);
      const result = await score();
      expect(result.passed, path).toBe(false);
      expect(result.integrityFailure, path).toBe(true);
      writeFileSync(join(root, path), original);
    }
  });

  test('versions only the affected secure-boot scorer contract', () => {
    expect(scorer.id).toBe('embedded-device-security/secure-boot-ota-scorer@4');
    expect(materializer.id).toBe('embedded-device-security/secure-boot-ota@1');
    expect(
      PRIVACY_WEB_DEVICE_SKILL_EVAL_SCORERS.find((item) =>
        item.scenarioIds.includes('embedded-device-security-full-task-2-individual'),
      )?.id,
    ).toBe('embedded-device-security/debug-credential-lifecycle-scorer@2');
  });
});
