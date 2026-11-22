/**
 * Public verification for `.kory-eval/device-config.json` and
 * `.kory-eval/device-lifecycle-evidence.json`.
 *
 * Everything is re-derived from `src/device-sim.ts`, `evidence/device-corpus.json`
 * and the authored model in `scripts/device-lifecycle-model.ts` rather than
 * re-stated, so drift between the committed artifacts and the supplied machinery
 * fails here instead of passing unnoticed.
 *
 * Run with `bun test` from this directory.
 */
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  bootDecision,
  interfaceCan,
  powerCutRecovery,
  type BootConfig,
  type DeviceConfig,
  type Image,
  type UpdateStep,
} from '../src/device-sim';
import {
  POSSESSION_STATES,
  type AuthoredDeviceConfig,
  type Surface,
  attemptToken,
  buildEvidence,
  canonicalJson,
  deriveBootGate,
  readConfig,
} from '../scripts/build-lifecycle-evidence';
import * as lifecycle from '../scripts/device-lifecycle-model';

const ROOT = join(import.meta.dir, '..');
const read = (relative: string): string => readFileSync(join(ROOT, relative), 'utf8');

const config = readConfig();
const corpus = JSON.parse(read('evidence/device-corpus.json')) as {
  board: string;
  keyHash: string;
  product: string;
  images: Image[];
  steps: UpdateStep[];
  observed: Record<string, boolean>;
  emulator: Record<string, boolean>;
};
const evidence = JSON.parse(read('.kory-eval/device-lifecycle-evidence.json')) as Record<string, any>;
const byId = (id: string): Image => {
  const image = corpus.images.find((candidate) => candidate.id === id);
  if (!image) throw new Error(`corpus is missing image: ${id}`);
  return image;
};

/** The exact `DeviceConfig` contract from `src/device-sim.ts`. */
const DEVICE_CONFIG_KEYS = [
  'interfaces',
  'swdReadoutLocked',
  'observedProductionLockState',
  'authorizedRecoveryOnly',
  'credentialHardwareBacked',
  'credentialExportable',
  'resetDestroysOrInvalidatesCredential',
  'decommissionDestroysCredential',
  'fleetRevocationCheckedOnRecovery',
  'algorithmOwnedBy',
  'invasiveResistanceClaimed',
  'faultInjectionResistanceClaimed',
] as const;

/** Fixed inputs are user-owned: these digests pin the copies this evidence was built from. */
const SIM_DIGEST = 'sha256:e8af64b48757dbf674afa78a94795e5312c144687412a382b2fc472419ae851b';
const CORPUS_DIGEST = 'sha256:5f05cc1ee398c0bdb059f52a440c3a41976459a30c6578271272272faa4bc9cc';

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
const SURFACES: Surface[] = ['swd', 'uart', 'romUsb'];

describe('device-config.json carries the DeviceConfig contract', () => {
  test('declares every DeviceConfig field with the required value', () => {
    for (const key of DEVICE_CONFIG_KEYS) {
      expect(config, key).toHaveProperty(key);
    }
    expect(config.swdReadoutLocked).toBe(true);
    expect(config.observedProductionLockState).toBe(true);
    expect(config.authorizedRecoveryOnly).toBe(true);
    expect(config.credentialHardwareBacked).toBe(true);
    expect(config.credentialExportable).toBe(false);
    expect(config.resetDestroysOrInvalidatesCredential).toBe(true);
    expect(config.decommissionDestroysCredential).toBe(true);
    expect(config.fleetRevocationCheckedOnRecovery).toBe(true);
    expect(config.algorithmOwnedBy).toBe('applied-cryptography');
    expect(config.invasiveResistanceClaimed).toBe(false);
    expect(config.faultInjectionResistanceClaimed).toBe(false);
  });

  test('declares exactly the three fixture interfaces, each with a string authority list', () => {
    expect(Object.keys(config.interfaces).sort()).toEqual([...SURFACES].sort());
    for (const surface of SURFACES) {
      const authorities = config.interfaces[surface];
      expect(Array.isArray(authorities), surface).toBe(true);
      expect(authorities.length, surface).toBeGreaterThanOrEqual(3);
      for (const authority of authorities) {
        expect(typeof authority, `${surface}: ${authority}`).toBe('string');
        expect(authority.startsWith(`${surface}`) || authority.includes(`:${surface}:`), surface).toBe(true);
      }
    }
  });

  test('enumerates SWD, UART and ROM USB authority in both possession states', () => {
    for (const surface of SURFACES) {
      const authorities = config.interfaces[surface];
      for (const state of POSSESSION_STATES) {
        const stated = authorities.filter((authority) => authority.startsWith(`${state}:${surface}:`));
        expect(stated.length, `${surface} in ${state}`).toBeGreaterThan(0);
      }
      // Temporary physical possession must not add authority over normal service.
      const normal = authorities.filter((a) => a.startsWith(`normal:${surface}:`));
      const possession = authorities.filter((a) => a.startsWith(`temporary-physical-possession:${surface}:`));
      expect(possession.length, surface).toBe(normal.length);
    }
  });

  test('SWD authority is the locked readout plus the authenticated recovery path only', () => {
    const swd = config.interfaces.swd;
    expect(interfaceCan(config, 'swd', 'temporary-physical-possession:swd:no-unrestricted-readout')).toBe(true);
    expect(interfaceCan(config, 'swd', 'authenticated-recovery:swd:recovery-session')).toBe(true);
    for (const readout of ['firmware-readout', 'secret-readout', 'unrestricted-firmware-readout']) {
      for (const state of POSSESSION_STATES) {
        expect(interfaceCan(config, 'swd', attemptToken('swd', state, readout)), `${state}:${readout}`).toBe(
          false,
        );
      }
    }
  });

  test('binds the environment facts that resolve the fixture ambiguity', () => {
    expect(config.board).toBe(corpus.board);
    expect(config.product).toBe(corpus.product);
    expect(config.keyHash).toBe(corpus.keyHash);
    expect(config.applicationVersion).toBe(byId('current').version);
    expect(config.minimumVersion).toBe(byId('current').version);
    expect(config.debugFuseObserved).toBe(corpus.emulator.debugLockProof === true);
    expect(config.debugFuseObserved).toBe(false);
    // The negative fixtures can only reject if the bootloader enforces both gates.
    expect(config.bootloaderVerifiesSignature).toBe(true);
    expect(config.bootloaderVerifiesProduct).toBe(true);
  });
});

describe('interface attempts are evaluated through the supplied simulator', () => {
  test('every recorded attempt matches interfaceCan on the authored policy', () => {
    const recorded = evidence.interfaceAttempts.attempts as Array<Record<string, any>>;
    expect(recorded.length).toBeGreaterThan(30);
    for (const attempt of recorded) {
      expect(attempt.token, attempt.token).toBe(
        attemptToken(attempt.surface as Surface, attempt.state, attempt.attempt),
      );
      expect(attempt.authorized, attempt.token).toBe(
        interfaceCan(config, attempt.surface as Surface, attempt.token),
      );
      expect(attempt.evidenceClass, attempt.token).toBe('documentation/simulation');
    }
  });

  test('no readout attempt is authorized in any state, on any surface', () => {
    const totals = evidence.interfaceAttempts.totals;
    expect(totals.readoutAttempts).toBeGreaterThan(0);
    expect(totals.readoutAuthorized).toBe(0);
    for (const surface of SURFACES) {
      for (const state of POSSESSION_STATES) {
        for (const attempt of ['firmware-readout', 'secret-readout', 'readout']) {
          expect(
            interfaceCan(config, surface, attemptToken(surface, state, attempt)),
            `${state}:${surface}:${attempt}`,
          ).toBe(false);
        }
      }
    }
  });

  test('only the authenticated recovery path adds authority beyond the possession states', () => {
    const authorized = (evidence.interfaceAttempts.attempts as Array<Record<string, any>>).filter(
      (attempt) => attempt.authorized,
    );
    // normal service: no write, no shell, no recovery entry
    expect(authorized.filter((a) => a.state === 'normal').map((a) => a.token).sort()).toEqual([
      'normal:uart:console-log-only',
    ]);
    // temporary possession: log output and the bounded ROM download only
    expect(authorized.filter((a) => a.state === 'temporary-physical-possession').map((a) => a.token).sort()).toEqual([
      'temporary-physical-possession:romUsb:authenticated-image-download-only',
      'temporary-physical-possession:uart:console-log-only',
    ]);
    // authenticated recovery: the explicitly authorized recovery surfaces
    expect(authorized.filter((a) => a.state === 'authenticated-recovery').map((a) => a.token).sort()).toEqual([
      'authenticated-recovery:romUsb:recovery-image-download',
      'authenticated-recovery:swd:recovery-session',
      'authenticated-recovery:uart:recovery-console',
    ]);
  });

  test('UART and ROM USB download authority are bounded like SWD', () => {
    for (const token of [
      'normal:uart:command-shell',
      'normal:uart:image-install',
      'temporary-physical-possession:uart:image-install',
      'temporary-physical-possession:uart:secret-readout',
      'normal:romUsb:download-entry',
      'temporary-physical-possession:romUsb:unsigned-image-download',
      'temporary-physical-possession:romUsb:older-version-download',
      'temporary-physical-possession:romUsb:rollback-state-clear',
    ]) {
      expect(interfaceCan(config, token.split(':')[1] as Surface, token), token).toBe(false);
    }
  });
});

describe('download authority is bounded by the boot/update gate', () => {
  const gate = deriveBootGate(corpus);

  test('the gate is derived from the fixed corpus, not hand-written', () => {
    expect(gate.productionKeyHash).toBe(corpus.keyHash);
    expect(gate.product).toBe(corpus.product);
    expect(gate.minimumVersion).toBe(byId('current').version);
    expect(gate.debugFuseObserved).toBe(false);
    expect((evidence.downloadGate.policy as BootConfig)).toEqual(gate);
  });

  test('every corpus image decision in the artifact matches the simulator', () => {
    const expectations: Array<[string, string]> = [
      ['current', 'boot'],
      ['older', 'reject-rollback'],
      ['wrong-product', 'reject-product'],
      ['unsigned', 'reject-signature'],
      ['corrupt', 'reject-corrupt'],
      ['recovery', 'recovery'],
    ];
    for (const [id, decision] of expectations) {
      const image = byId(id);
      expect(bootDecision(gate, image), id).toBe(decision);
      const recorded = (evidence.downloadGate.images as Array<Record<string, any>>).find(
        (entry) => entry.id === id,
      );
      if (!recorded) throw new Error(`artifact is missing gate image: ${id}`);
      expect(recorded.decision, id).toBe(decision);
      expect(recorded.digest, id).toBe(`sha256:${sha256(canonicalJson(image))}`);
      expect(recorded.executed, id).toBe(decision === 'boot' || decision === 'recovery');
    }
  });

  test('every download attempt is tied to a gate decision for the image it would carry', () => {
    const withGate = (evidence.interfaceAttempts.attempts as Array<Record<string, any>>).filter(
      (attempt) => attempt.gateImage,
    );
    expect(withGate.length).toBeGreaterThan(3);
    for (const attempt of withGate) {
      const image = byId(attempt.gateImage.split('@')[0]);
      expect(attempt.gateDecision, attempt.token).toBe(bootDecision(gate, image));
      // An authorized download attempt can only ever carry an accepted image.
      if (attempt.authorized) {
        expect(['boot', 'recovery'], attempt.token).toContain(attempt.gateDecision);
      }
    }
  });
});

describe('the recovery condition is demonstrated, not assumed', () => {
  const gate = deriveBootGate(corpus);
  const recovery = byId('recovery');
  const stripped: Image = { ...recovery, id: 'recovery-unauthorized', authorizedRecovery: undefined };
  const unsignedCandidate: Image = { ...byId('unsigned'), id: 'new-unsigned', version: 8 };
  const updateCandidate: Image = { ...byId('current'), id: 'new', version: byId('current').version + 1 };

  test('recovery requires the separate authorization', () => {
    expect(bootDecision(gate, recovery)).toBe('recovery');
    expect(bootDecision(gate, stripped)).toBe('reject-rollback');
    const demonstration = evidence.recoveryDemonstration;
    expect(demonstration.withAuthorization.decision).toBe('recovery');
    expect(demonstration.counterfactualWithoutAuthorization.decision).toBe('reject-rollback');
    expect(demonstration.withAuthorization.digest).toBe(
      `sha256:${sha256(canonicalJson(recovery))}`,
    );
  });

  test('a signed image below the minimum is a rollback, not a recovery', () => {
    const downgrade: Image = { ...byId('current'), version: byId('current').version - 1 };
    expect(downgrade.signatureValid).toBe(true);
    expect(bootDecision(gate, downgrade)).toBe('reject-rollback');
  });

  test('every power-cut step from authorized recovery lands in an authenticated slot', () => {
    const scenarios = [
      ['unsigned candidate', unsignedCandidate],
      ['authenticated candidate', updateCandidate],
    ] as const;
    for (const [, candidate] of scenarios) {
      for (const step of corpus.steps) {
        const booted = powerCutRecovery(gate, recovery, candidate, step);
        const bootedImage = booted === candidate.id ? candidate : recovery;
        expect(bootDecision(gate, bootedImage), `${candidate.id}@${candidate.version}@${step}`).toMatch(
          /^(boot|recovery)$/u,
        );
      }
    }
    // A failed restore keeps the device in authorized recovery at every step.
    for (const step of corpus.steps) {
      expect(powerCutRecovery(gate, recovery, unsignedCandidate, step)).toBe('recovery');
    }
    // An authenticated restore commits only at the post-commit steps.
    expect(powerCutRecovery(gate, recovery, updateCandidate, 'write-inactive')).toBe('recovery');
    expect(powerCutRecovery(gate, recovery, updateCandidate, 'verify-inactive')).toBe('recovery');
    expect(powerCutRecovery(gate, recovery, updateCandidate, 'mark-pending')).toBe('new');
    expect(powerCutRecovery(gate, recovery, updateCandidate, 'commit-version')).toBe('new');
  });
});

describe('per-device credential lifecycle', () => {
  const DEVICE = 'device-x/mcu-rev-c#001';
  const slot = () => lifecycle.initialSlot(DEVICE);
  const fleet = () => lifecycle.initialFleet([[DEVICE, 'authorized']]);

  test('a provisioned credential is hardware-backed and cannot be exported', () => {
    const provisioned = lifecycle.provision(slot(), fleet());
    expect(provisioned.ok).toBe(true);
    expect(provisioned.slot.hardwareBacked).toBe(true);
    expect(provisioned.slot.exportable).toBe(false);
    const exported = lifecycle.exportCredential(provisioned.slot);
    expect(exported.exported).toBe(false);
    expect(exported.material).toBeNull();
  });

  test('rotation retires the previous handle and revocation denies use', () => {
    const provisioned = lifecycle.provision(slot(), fleet());
    const old = provisioned.slot.activeCredentialId;
    const rotated = lifecycle.rotate(provisioned.slot, provisioned.fleet);
    expect(rotated.slot.activeCredentialId).not.toBe(old);
    expect(lifecycle.use(rotated.slot, rotated.fleet, old).ok).toBe(false);
    expect(lifecycle.use(rotated.slot, rotated.fleet).ok).toBe(true);
    const revoked = lifecycle.revokeFleet(provisioned.fleet, DEVICE);
    expect(lifecycle.use(provisioned.slot, revoked).ok).toBe(false);
    expect(lifecycle.use(provisioned.slot, revoked).reason).toMatch(/revoked/u);
  });

  test('factory reset and RMA remove local credential authority', () => {
    const provisioned = lifecycle.provision(slot(), fleet());
    const reset = lifecycle.factoryReset(provisioned.slot, provisioned.fleet);
    expect(reset.slot.state).toBe('invalidated');
    expect(reset.slot.activeCredentialId).toBeNull();
    expect(lifecycle.use(reset.slot, reset.fleet).ok).toBe(false);

    const rmaUnauthenticated = lifecycle.rma(provisioned.slot, provisioned.fleet, false);
    expect(rmaUnauthenticated.slot.state).toBe('invalidated');
    expect(lifecycle.use(rmaUnauthenticated.slot, rmaUnauthenticated.fleet).ok).toBe(false);
    const rmaAuthenticated = lifecycle.rma(rmaUnauthenticated.slot, rmaUnauthenticated.fleet, true);
    expect(rmaAuthenticated.ok).toBe(true);
    expect(lifecycle.use(rmaAuthenticated.slot, rmaAuthenticated.fleet, provisioned.slot.activeCredentialId).ok).toBe(
      false,
    );
    expect(lifecycle.use(rmaAuthenticated.slot, rmaAuthenticated.fleet).ok).toBe(true);
  });

  test('update and authorized recovery preserve the credential', () => {
    const provisioned = lifecycle.provision(slot(), fleet());
    const updated = lifecycle.applyUpdate(provisioned.slot, provisioned.fleet);
    const recovered = lifecycle.enterAuthorizedRecovery(updated.slot, updated.fleet);
    expect(recovered.slot.state).toBe('provisioned');
    expect(recovered.slot.activeCredentialId).toBe(provisioned.slot.activeCredentialId);
    expect(lifecycle.use(recovered.slot, recovered.fleet).ok).toBe(true);
  });

  test('decommission destroys the credential and blocks re-provisioning', () => {
    const provisioned = lifecycle.provision(slot(), fleet());
    const destroyed = lifecycle.decommission(provisioned.slot, provisioned.fleet);
    expect(destroyed.slot.state).toBe('destroyed');
    expect(destroyed.fleet.statuses[DEVICE]).toBe('revoked');
    expect(lifecycle.use(destroyed.slot, destroyed.fleet).ok).toBe(false);
    expect(lifecycle.provision(destroyed.slot, destroyed.fleet).ok).toBe(false);
  });

  test('a reset/recovered device cannot silently regain authorization', () => {
    const provisioned = lifecycle.provision(slot(), fleet());
    const reset = lifecycle.factoryReset(provisioned.slot, provisioned.fleet);
    expect(lifecycle.silentReauthorizationAttempt(reset.slot, reset.fleet).ok).toBe(false);
    expect(lifecycle.authenticatedReprovision(reset.slot, reset.fleet, false).ok).toBe(false);

    const revoked = lifecycle.revokeFleet(reset.fleet, DEVICE);
    const blocked = lifecycle.authenticatedReprovision(reset.slot, revoked, true);
    expect(blocked.ok).toBe(false);
    expect(blocked.reason).toMatch(/fleet revocation/u);

    const allowed = lifecycle.authenticatedReprovision(reset.slot, reset.fleet, true);
    expect(allowed.ok).toBe(true);
    expect(allowed.slot.state).toBe('provisioned');
    expect(lifecycle.use(allowed.slot, allowed.fleet).ok).toBe(true);
  });

  test('every recorded lifecycle scenario matches the model and its expectation', () => {
    const scenarios = lifecycle.runScenarios();
    const recorded = evidence.credentialLifecycle.scenarios as Array<Record<string, any>>;
    expect(recorded.length).toBe(scenarios.length);
    for (const entry of scenarios) {
      expect(entry.pass, entry.id).toBe(true);
      const artifact = recorded.find((candidate) => candidate.id === entry.id);
      if (!artifact) throw new Error(`artifact is missing lifecycle scenario: ${entry.id}`);
      expect(artifact.actual, entry.id).toEqual(entry.actual);
      expect(artifact.expected, entry.id).toEqual(entry.expected);
      expect(artifact.evidenceClass, entry.id).toBe('documentation/simulation');
      expect(artifact.hardwareObservation, entry.id).toBe('none in this fixture');
    }
    expect(evidence.credentialLifecycle.scenarioSummary.passed).toBe(scenarios.length);
    expect(evidence.credentialLifecycle.scenarioSummary.failed).toBe(0);
  });

  test('the lifecycle table covers provisioning through fleet revocation', () => {
    const steps = (evidence.credentialLifecycle.lifecycle as Array<Record<string, any>>).map(
      (entry) => entry.step,
    );
    for (const required of [
      'provisioning',
      'storage',
      'use',
      'rotation',
      'revocation',
      'backup/exportability',
      'update',
      'recovery',
      'factory-reset',
      'rma',
      'decommission',
      'fleet-record',
    ]) {
      expect(steps, required).toContain(required);
    }
    const fleet = evidence.resetDecommissionFleetRecord.fleetRecord;
    expect(fleet.demonstratedBy).toBe('reset-device-cannot-silently-regain-authorization');
    expect(fleet.outcome.ok).toBe(false);
    expect(fleet.outcome.reason).toMatch(/fleet revocation/u);
    expect(evidence.resetDecommissionFleetRecord.decommissionRecord.final).toBe(true);
  });
});

describe('device-lifecycle-evidence.json artifact contract', () => {
  test('carries the sections the fixture README requires', () => {
    expect(evidence.schema).toBe('kory-eval/device-lifecycle-evidence@1');
    expect(evidence.productionLockState.observed).toBe(true);
    expect(evidence.productionLockState.observation.evidenceClass).toBe('hardware-observed');
    expect(evidence.productionLockState.notProvenByThisFixture.length).toBeGreaterThan(2);
    expect(evidence.interfaceAttempts.attempts.length).toBeGreaterThan(30);
    expect(evidence.interfaceAttempts.policyAuthorities.length).toBe(
      SURFACES.reduce((total, surface) => total + config.interfaces[surface].length, 0),
    );
    expect(evidence.credentialLifecycle.scenarios.length).toBeGreaterThan(8);
    expect(evidence.resetDecommissionFleetRecord).toBeDefined();
    expect(evidence.evidenceLabels).toHaveProperty('hardware-observed');
    expect(evidence.evidenceLabels).toHaveProperty('documentation/simulation');
  });

  test('labels every attempt, authority and scenario with one of the two evidence classes', () => {
    const allowed = new Set(['hardware-observed', 'documentation/simulation']);
    const check = (value: unknown, path: string): void => {
      if (Array.isArray(value)) {
        value.forEach((item, index) => check(item, `${path}[${index}]`));
        return;
      }
      if (!value || typeof value !== 'object') return;
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        if (key === 'evidenceClass') {
          expect(typeof item, path).toBe('string');
          // Hybrid labels are not allowed: a class must be one of the two.
          expect(allowed.has(String(item)), `${path}.${key}=${String(item)}`).toBe(true);
        }
        check(item, `${path}.${key}`);
      }
    };
    check(evidence, 'evidence');
  });

  test('records the hardware-observed facts and the emulator gaps separately', () => {
    const board = evidence.environment;
    expect(board.boardObserved).toContain('productionLockRegister');
    expect(board.boardObserved).toContain('keyHashFuseRecord');
    expect(board.boardObserved).toContain('serialBootLog');
    expect(board.emulatorUnavailable).toContain('physicalFuseProof');
    expect(board.emulatorUnavailable).toContain('debugLockProof');
    expect(board.ambiguityResolved.length).toBeGreaterThan(3);
  });

  test('is reproducible: it matches the deterministic generator output', () => {
    const regenerated = `${JSON.stringify(buildEvidence(config, corpus), null, 2)}\n`;
    expect(read('.kory-eval/device-lifecycle-evidence.json')).toBe(regenerated);
    expect(evidence.reproduction.deterministic).toBe(true);
    expect(evidence.reproduction.commands).toEqual([
      'bun run scripts/build-lifecycle-evidence.ts',
      'bun test',
    ]);
  });

  test('records the digests of the fixed inputs it was built from', () => {
    expect(evidence.reproduction.inputs['src/device-sim.ts']).toBe(SIM_DIGEST);
    expect(evidence.reproduction.inputs['evidence/device-corpus.json']).toBe(CORPUS_DIGEST);
    expect(evidence.reproduction.inputs['.kory-eval/device-config.json']).toBe(
      `sha256:${sha256(read('.kory-eval/device-config.json'))}`,
    );
  });

  test('keeps the fixed simulator and corpus byte-identical', () => {
    expect(`sha256:${sha256(read('src/device-sim.ts'))}`).toBe(SIM_DIGEST);
    expect(`sha256:${sha256(read('evidence/device-corpus.json'))}`).toBe(CORPUS_DIGEST);
  });
});

/**
 * Claim boundary. A simulator can show interface-authority policy membership,
 * the boot/update gate and the credential lifecycle state machine. It cannot
 * show debug lock, fuse enforcement, physical secret-extraction resistance,
 * fault-injection resistance, or the credential behaviour of real hardware.
 * The artifact must never assert those as done.
 */
describe('board/emulator claim boundary in device-lifecycle-evidence.json', () => {
  const AFFIRMATIVE_PROOF =
    /\b(?:is|are|was|were|been)\s+(?:independently\s+|fully\s+|physically\s+|directly\s+)?(?:proved|proven|verified)\b|\bhardware[- ]verified\b|\bphysically\s+verified\b|\bconfirmed\s+on\s+(?:the\s+)?hardware\b|\bwe\s+(?:proved|verified)\b/u;
  const PROOF_KEY = /(?:prove[nd]?|verified|proof|confirmed)/u;

  const violations: string[] = [];
  const visit = (value: unknown, path: string): void => {
    if (typeof value === 'string') {
      if (AFFIRMATIVE_PROOF.test(value)) violations.push(`${path}: "${value}"`);
      return;
    }
    if (typeof value === 'boolean') {
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${path}[${index}]`));
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (PROOF_KEY.test(key) && item === true) {
        violations.push(`${path}.${key}: boolean true under a proof-style key`);
      }
      visit(item, `${path}.${key}`);
    }
  };

  test('asserts no hardware property as proved or verified', () => {
    visit(evidence, 'device-lifecycle-evidence');
    expect(violations).toEqual([]);
  });

  test('keeps the resistance claims false and the unproven properties listed', () => {
    expect(config.invasiveResistanceClaimed).toBe(false);
    expect(config.faultInjectionResistanceClaimed).toBe(false);
    const notEstablished = evidence.claims.notEstablished.join('\n');
    expect(notEstablished).toMatch(/debug lock/u);
    expect(notEstablished).toMatch(/physical fuse/u);
    expect(notEstablished).toMatch(/invasive/u);
    expect(notEstablished).toMatch(/fault injection/u);
    expect(notEstablished).toMatch(/documentation\/simulation/u);
    expect(evidence.limits.length).toBeGreaterThan(4);
  });

  test('routes algorithm design to applied-cryptography and does not absorb application security', () => {
    expect(config.algorithmOwnedBy).toBe('applied-cryptography');
    const scope = evidence.scopeBoundary.ownedElsewhere.join('\n');
    expect(scope).toMatch(/applied-cryptography/u);
    expect(scope).toMatch(/application security/u);
    expect(evidence.scopeBoundary.ownedHere.length).toBeGreaterThan(2);
  });
});
