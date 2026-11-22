/**
 * Deterministic builder for `.kory-eval/device-lifecycle-evidence.json`.
 *
 * Nothing here re-states a security claim by hand: every interface authority is
 * evaluated through the supplied `interfaceCan`, every download bound through
 * the supplied `bootDecision` / `powerCutRecovery`, and every credential
 * lifecycle result through the authored model in
 * `scripts/device-lifecycle-model.ts`, against the fixed
 * `evidence/device-corpus.json` and the authored `.kory-eval/device-config.json`
 * policy.
 *
 * The file is non-clock, non-random and non-secret, so re-running it on an
 * unchanged tree reproduces a byte-identical artifact, which
 * `tests/device-lifecycle.test.ts` asserts.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  bootDecision,
  interfaceCan,
  powerCutRecovery,
  type BootConfig,
  type DeviceConfig,
  type Image,
  type UpdateStep,
} from '../src/device-sim';
import { runScenarios, type Scenario } from './device-lifecycle-model';

export const ROOT = join(import.meta.dir, '..');
export const CONFIG_PATH = join(ROOT, '.kory-eval/device-config.json');
export const EVIDENCE_PATH = join(ROOT, '.kory-eval/device-lifecycle-evidence.json');
export const CORPUS_PATH = join(ROOT, 'evidence/device-corpus.json');
export const SIM_PATH = join(ROOT, 'src/device-sim.ts');

export interface Corpus {
  board: string;
  keyHash: string;
  product: string;
  images: Image[];
  steps: UpdateStep[];
  observed: Record<string, boolean>;
  emulator: Record<string, boolean>;
}

/**
 * The `DeviceConfig` contract from `src/device-sim.ts`, plus the environment
 * facts this analysis binds so the fixture's version/runtime ambiguity is
 * resolved in the artifact rather than left implicit.
 */
export interface AuthoredDeviceConfig extends DeviceConfig {
  board: string;
  product: string;
  keyHash: string;
  applicationVersion: number;
  minimumVersion: number;
  debugFuseObserved: boolean;
  bootloaderVerifiesSignature: boolean;
  bootloaderVerifiesProduct: boolean;
}

export function readCorpus(): Corpus {
  return JSON.parse(readFileSync(CORPUS_PATH, 'utf8')) as Corpus;
}

export function readConfig(): AuthoredDeviceConfig {
  return JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as AuthoredDeviceConfig;
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Stable, key-sorted serialization so a digest never depends on field order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(',')}}`;
}

/** Content digest of an image record: the only image identity this fixture has. */
export function imageDigest(image: Image): string {
  return `sha256:${sha256(canonicalJson(image))}`;
}

export function imageKey(image: Image): string {
  return `${image.id}@${image.version}`;
}

export function fileDigest(path: string): string {
  return `sha256:${sha256(readFileSync(path))}`;
}

/* ------------------------------------------------------------------ *
 * Interface authority
 * ------------------------------------------------------------------ */

export type PossessionState = 'normal' | 'temporary-physical-possession' | 'authenticated-recovery';
export type Surface = 'swd' | 'uart' | 'romUsb';

export const POSSESSION_STATES: PossessionState[] = [
  'normal',
  'temporary-physical-possession',
  'authenticated-recovery',
];

export const STATE_DEFINITIONS: Record<PossessionState, string> = {
  normal:
    'device in service; the attacker holds remote and local protocol access only, and no bench access to headers, test pads or the boot strap',
  'temporary-physical-possession':
    'attacker holds the device on a bench: case open, SWD header and test pads reachable, UART console reachable, boot strap for ROM download reachable',
  'authenticated-recovery':
    'the explicitly authenticated recovery path has been entered; it is a separately authorized state, not an ordinary run state and not a rollback bypass',
};

export const TOKEN_GRAMMAR =
  'Each entry of DeviceConfig.interfaces[<surface>] is a complete statement of that surface\u2019s authority in one possession state, written as <state>:<surface>:<authority>. A bound authority (…:no-unrestricted-readout, …:console-log-only, …:authenticated-image-download-only) states what the surface may not do beyond the named limit; a capability authority (…:recovery-session, …:recovery-console, …:recovery-image-download) states the only action that remains. interfaceCan(config, surface, token) answers whether that authority statement is part of production policy for the surface.';

/** Human meaning of every authority the authored policy enumerates. */
const AUTHORITY_MEANINGS: Record<string, string> = {
  'normal:swd:no-unrestricted-readout':
    'in normal service SWD holds no unrestricted firmware or secret readout authority; no general debug session is enumerated',
  'temporary-physical-possession:swd:no-unrestricted-readout':
    'with the board on a bench SWD still holds no unrestricted firmware or secret readout authority: temporary physical possession does not escalate SWD authority',
  'authenticated-recovery:swd:recovery-session':
    'the explicitly authenticated recovery session is the only SWD authority that remains; it drives the recovery path and carries no readout authority',
  'normal:uart:console-log-only':
    'in normal service the UART console emits log output only: no command shell, no image install, no secret readout',
  'temporary-physical-possession:uart:console-log-only':
    'with the console reachable on a bench it still emits log output only: possession does not escalate console authority',
  'authenticated-recovery:uart:recovery-console':
    'the authenticated recovery console is the only UART authority that remains',
  'normal:romUsb:no-download-authority':
    'in normal service the ROM download path holds no authority: the mode is not reachable without the boot strap and no image write path is open',
  'temporary-physical-possession:romUsb:authenticated-image-download-only':
    'with the boot strap reachable, ROM download accepts only images that pass the same integrity, product and rollback gate the bootloader applies (see downloadGate); it cannot lower rollback state and is not a flash readout path',
  'authenticated-recovery:romUsb:recovery-image-download':
    'ROM download inside the authenticated recovery path accepts only the authorized recovery image',
};

/** Attempts an attacker or an operator would actually make, in evaluation order. */
const ATTEMPTS: Array<{
  surface: Surface;
  state: PossessionState;
  attempt: string;
  meaning: string;
  /** Corpus image whose gate decision bounds this attempt, when applicable. */
  gateImageId?: string;
}> = [
  { surface: 'swd', state: 'normal', attempt: 'debug-session-attach', meaning: 'open a debug session on a device in service' },
  { surface: 'swd', state: 'normal', attempt: 'firmware-readout', meaning: 'read the application image out of flash unrestricted' },
  { surface: 'swd', state: 'normal', attempt: 'secret-readout', meaning: 'read the per-device credential slot or key material' },
  { surface: 'swd', state: 'normal', attempt: 'image-write', meaning: 'write an arbitrary image into the application slot' },
  { surface: 'swd', state: 'normal', attempt: 'rollback-state-clear', meaning: 'clear the anti-rollback version state' },
  { surface: 'swd', state: 'temporary-physical-possession', attempt: 'debug-session-attach', meaning: 'open a debug session with the board open on a bench' },
  { surface: 'swd', state: 'temporary-physical-possession', attempt: 'firmware-readout', meaning: 'read the application image out of flash with the board open' },
  { surface: 'swd', state: 'temporary-physical-possession', attempt: 'secret-readout', meaning: 'read the per-device credential slot or key material with the board open' },
  { surface: 'swd', state: 'temporary-physical-possession', attempt: 'image-write', meaning: 'write an arbitrary image into the application slot with the board open' },
  { surface: 'swd', state: 'temporary-physical-possession', attempt: 'rollback-state-clear', meaning: 'clear the anti-rollback version state with the board open' },
  { surface: 'swd', state: 'authenticated-recovery', attempt: 'recovery-session', meaning: 'drive the explicitly authenticated recovery session' },
  { surface: 'swd', state: 'authenticated-recovery', attempt: 'firmware-readout', meaning: 'read flash from inside the authenticated recovery session' },
  { surface: 'swd', state: 'authenticated-recovery', attempt: 'secret-readout', meaning: 'read the credential slot from inside the authenticated recovery session' },

  { surface: 'uart', state: 'normal', attempt: 'console-log-only', meaning: 'read the console log' },
  { surface: 'uart', state: 'normal', attempt: 'command-shell', meaning: 'open a privileged command shell on the console' },
  { surface: 'uart', state: 'normal', attempt: 'image-install', meaning: 'install an image over the console' },
  { surface: 'uart', state: 'normal', attempt: 'secret-readout', meaning: 'read secrets over the console' },
  { surface: 'uart', state: 'normal', attempt: 'rollback-state-clear', meaning: 'clear the anti-rollback version state over the console' },
  { surface: 'uart', state: 'temporary-physical-possession', attempt: 'console-log-only', meaning: 'read the console log with the board open' },
  { surface: 'uart', state: 'temporary-physical-possession', attempt: 'command-shell', meaning: 'open a privileged command shell with the board open' },
  { surface: 'uart', state: 'temporary-physical-possession', attempt: 'image-install', meaning: 'install an image over the console with the board open' },
  { surface: 'uart', state: 'temporary-physical-possession', attempt: 'secret-readout', meaning: 'read secrets over the console with the board open' },
  { surface: 'uart', state: 'temporary-physical-possession', attempt: 'rollback-state-clear', meaning: 'clear the anti-rollback version state over the console with the board open' },
  { surface: 'uart', state: 'authenticated-recovery', attempt: 'recovery-console', meaning: 'use the authenticated recovery console' },
  { surface: 'uart', state: 'authenticated-recovery', attempt: 'image-install-unauthorized', meaning: 'install an image the recovery path has not authorized' },
  { surface: 'uart', state: 'authenticated-recovery', attempt: 'secret-readout', meaning: 'read secrets from the recovery console' },

  { surface: 'romUsb', state: 'normal', attempt: 'download-entry', meaning: 'enter ROM USB download mode on a device in service' },
  { surface: 'romUsb', state: 'normal', attempt: 'firmware-readout', meaning: 'read flash out over ROM USB' },
  { surface: 'romUsb', state: 'temporary-physical-possession', attempt: 'authenticated-image-download-only', meaning: 'download an image through ROM USB with the boot strap reachable', gateImageId: 'current' },
  { surface: 'romUsb', state: 'temporary-physical-possession', attempt: 'unsigned-image-download', meaning: 'download the unsigned corpus image through ROM USB', gateImageId: 'unsigned' },
  { surface: 'romUsb', state: 'temporary-physical-possession', attempt: 'wrong-product-image-download', meaning: 'download the wrong-product corpus image through ROM USB', gateImageId: 'wrong-product' },
  { surface: 'romUsb', state: 'temporary-physical-possession', attempt: 'older-version-download', meaning: 'download the signed older corpus image (a downgrade) through ROM USB', gateImageId: 'older' },
  { surface: 'romUsb', state: 'temporary-physical-possession', attempt: 'corrupt-image-download', meaning: 'download the corrupt corpus image through ROM USB', gateImageId: 'corrupt' },
  { surface: 'romUsb', state: 'temporary-physical-possession', attempt: 'firmware-readout', meaning: 'read flash out over ROM USB' },
  { surface: 'romUsb', state: 'temporary-physical-possession', attempt: 'rollback-state-clear', meaning: 'lower the anti-rollback state through the download path' },
  { surface: 'romUsb', state: 'authenticated-recovery', attempt: 'recovery-image-download', meaning: 'download the authorized recovery image', gateImageId: 'recovery' },
  { surface: 'romUsb', state: 'authenticated-recovery', attempt: 'unsigned-image-download', meaning: 'download an unsigned image through the recovery path', gateImageId: 'unsigned' },
  { surface: 'romUsb', state: 'authenticated-recovery', attempt: 'firmware-readout', meaning: 'read flash out through the recovery path' },
];

export function attemptToken(surface: Surface, state: PossessionState, attempt: string): string {
  return `${state}:${surface}:${attempt}`;
}

/**
 * Boot/update gate that bounds every write path, including ROM download.
 * Derived from the fixed corpus, never hand-written in the artifact.
 */
export function deriveBootGate(corpus: Corpus): BootConfig {
  const current = corpus.images.find((image) => image.id === 'current');
  if (!current) throw new Error('corpus is missing the current image');
  return {
    productionKeyHash: corpus.keyHash,
    product: corpus.product,
    // The anti-rollback floor is the version the board actually runs: the
    // corpus's board-observed current image resolves the version ambiguity.
    minimumVersion: current.version,
    bootloaderVerifiesSignature: true,
    bootloaderVerifiesProduct: true,
    rollbackStateProtected: true,
    recoveryRequiresAuthorization: true,
    // The corpus records no debug-lock proof, so no debug fuse is claimed.
    debugFuseObserved: corpus.emulator.debugLockProof === true,
  };
}

export function buildEvidence(config: AuthoredDeviceConfig, corpus: Corpus): Record<string, unknown> {
  const byId = new Map(corpus.images.map((image) => [image.id, image]));
  const require = (id: string): Image => {
    const image = byId.get(id);
    if (!image) throw new Error(`corpus is missing required image: ${id}`);
    return image;
  };
  const current = require('current');
  const older = require('older');
  const wrongProduct = require('wrong-product');
  const unsigned = require('unsigned');
  const corrupt = require('corrupt');
  const recovery = require('recovery');

  const gate = deriveBootGate(corpus);

  /* ---------------- production lock state ---------------- */

  const productionLockState = {
    register: 'production lock register',
    observed: config.observedProductionLockState === true && corpus.observed.productionLockRegister === true,
    observation: {
      fact: 'the production lock register is read on the representative board',
      source: `corpus.observed.productionLockRegister=${String(corpus.observed.productionLockRegister)}`,
      evidenceClass: 'hardware-observed',
    },
    semanticsPerFixtureContract: [
      'SWD holds no unrestricted firmware or secret readout authority',
      'the only SWD authority that remains is the explicitly authenticated recovery path',
      'UART and ROM USB download authority are bounded the same way',
    ],
    semanticsEvidenceClass: 'documentation/simulation',
    configFlags: {
      swdReadoutLocked: config.swdReadoutLocked,
      observedProductionLockState: config.observedProductionLockState,
      authorizedRecoveryOnly: config.authorizedRecoveryOnly,
    },
    notProvenByThisFixture: [
      `debug lock effectiveness: corpus.emulator.debugLockProof=${String(corpus.emulator.debugLockProof)}`,
      `physical fuse enforcement: corpus.emulator.physicalFuseProof=${String(corpus.emulator.physicalFuseProof)}`,
      'resistance to invasive secret extraction and to fault injection: not modeled by the supplied simulator',
    ],
  };

  /* ---------------- interface authorities and attempts ---------------- */

  const policyAuthorities = (Object.keys(config.interfaces) as Surface[]).flatMap((surface) =>
    config.interfaces[surface].map((token) => ({
      surface,
      token,
      state: token.split(':')[0] as PossessionState,
      authority: token.slice(`${token.split(':')[0]}`.length + `${surface}`.length + 2),
      meaning: AUTHORITY_MEANINGS[token] ?? 'not described',
      enumeratedByPolicy: interfaceCan(config, surface, token),
      evidenceClass: 'documentation/simulation',
    })),
  );

  const attempts = ATTEMPTS.map((entry) => {
    const token = attemptToken(entry.surface, entry.state, entry.attempt);
    const authorized = interfaceCan(config, entry.surface, token);
    const gateImage = entry.gateImageId ? require(entry.gateImageId) : undefined;
    return {
      surface: entry.surface,
      state: entry.state,
      attempt: entry.attempt,
      token,
      meaning: entry.meaning,
      authorized,
      outcome: authorized ? 'permitted within the enumerated bound' : 'denied by production policy',
      basis: authorized
        ? `interfaceCan(device-config, ${entry.surface}, "${token}") is true: this authority is enumerated in production policy`
        : `interfaceCan(device-config, ${entry.surface}, "${token}") is false: production policy enumerates no such authority for this surface in this state`,
      gateImage: gateImage ? imageKey(gateImage) : undefined,
      gateDecision: gateImage ? bootDecision(gate, gateImage) : undefined,
      gateNote: gateImage
        ? `any image offered on this path must still pass the boot/update gate: ${imageKey(gateImage)} -> ${bootDecision(gate, gateImage)}`
        : undefined,
      evidenceClass: 'documentation/simulation',
    };
  });

  const authorizedCount = attempts.filter((entry) => entry.authorized).length;

  /* ---------------- download / boot gate ---------------- */

  const gateImages = corpus.images.map((image) => ({
    id: image.id,
    version: image.version,
    digest: imageDigest(image),
    product: image.product,
    signed: image.signed,
    signatureValid: image.signatureValid,
    corrupt: image.corrupt,
    authorizedRecovery: image.authorizedRecovery === true,
    decision: bootDecision(gate, image),
    executed: bootDecision(gate, image) === 'boot' || bootDecision(gate, image) === 'recovery',
    evidenceClass: 'documentation/simulation',
    boardObservation:
      image.id === 'current'
        ? `corpus.observed.serialBootLog=${String(corpus.observed.serialBootLog)}: the board serial log records this image executing (hardware-observed)`
        : 'none in this fixture',
    note:
      image.id === 'current'
        ? 'the board-observed fact is that this image executes; the decision above is state-machine logic, not a separate hardware measurement'
        : 'negative or recovery fixture supplied by the corpus; the board was not flashed with it in this fixture',
  }));

  const recoveryWithoutAuthorization: Image = {
    ...recovery,
    id: 'recovery-unauthorized',
    authorizedRecovery: undefined,
  };
  const unsignedCandidate: Image = { ...unsigned, id: 'new-unsigned', version: 8 };
  const updateCandidate: Image = { ...current, id: 'new', version: current.version + 1 };

  const powerCutFromRecovery = (candidate: Image) =>
    corpus.steps.map((step) => {
      const bootedId = powerCutRecovery(gate, recovery, candidate, step);
      const booted = bootedId === candidate.id ? candidate : recovery;
      return {
        step,
        activeSlot: imageKey(recovery),
        candidateSlot: imageKey(candidate),
        candidateDecision: bootDecision(gate, candidate),
        bootedImage: booted.id,
        bootedImageKey: imageKey(booted),
        authenticatedState: bootDecision(gate, booted) === 'boot' || bootDecision(gate, booted) === 'recovery',
        evidenceClass: 'documentation/simulation',
      };
    });

  const downloadGate = {
    policy: gate,
    derivation: [
      `product ${gate.product} and production key hash ${gate.productionKeyHash} are the corpus values, so the gate is bound to this product and this board's key-hash fuse record`,
      `minimumVersion ${gate.minimumVersion} is the version of the board-observed current image (${imageKey(current)}), so no image older than the deployed one is accepted`,
      'bootloaderVerifiesSignature and bootloaderVerifiesProduct are enabled so the unsigned and wrong-product fixtures reject before execution',
      'rollbackStateProtected is enabled so version state cannot be lowered by an ordinary firmware write',
      `recoveryRequiresAuthorization is enabled, and debugFuseObserved is ${String(gate.debugFuseObserved)} because the corpus records emulator.debugLockProof=${String(corpus.emulator.debugLockProof)}`,
    ],
    purpose:
      'Every interface write path, including ROM USB download and the authenticated recovery path, is bounded by this gate. Interface authority is therefore never broader than the boot policy: "download permitted" can only ever mean "download permitted for an image this gate accepts".',
    images: gateImages,
    evidenceClass: 'documentation/simulation',
  };

  const recoveryDemonstration = {
    claimUnderTest:
      'recovery is a separately authorized destination, not a signature-only rollback bypass, and a failed recovery never lands in an unverified slot',
    withAuthorization: {
      image: imageKey(recovery),
      digest: imageDigest(recovery),
      decision: bootDecision(gate, recovery),
      note: 'the supplied recovery image carries its separate authorization and is below the minimum version, so it is accepted only through the recovery destination',
    },
    counterfactualWithoutAuthorization: {
      image: imageKey(recoveryWithoutAuthorization),
      digest: imageDigest(recoveryWithoutAuthorization),
      decision: bootDecision(gate, recoveryWithoutAuthorization),
      note: 'derived counterfactual: the same signed, non-corrupt, correctly bound image with the separate authorization removed is rejected as a rollback, which is what makes recovery an authorization rather than a bypass',
    },
    powerCutFromAuthorizedRecovery: {
      withAuthenticatedCandidate: {
        candidate: imageKey(updateCandidate),
        steps: powerCutFromRecovery(updateCandidate),
        note: 'an authenticated production image is installed and committed from authorized recovery; a pre-commit cut keeps the device in authorized recovery',
      },
      withUnsignedCandidate: {
        candidate: imageKey(unsignedCandidate),
        steps: powerCutFromRecovery(unsignedCandidate),
        note: 'a failed restore from authorized recovery leaves the device in an authenticated state rather than on an unverified slot',
      },
    },
    conclusion:
      'The recovery condition is demonstrated, not assumed: the same signed image enters recovery only with its separate authorization, is rejected as a rollback without it, and no power-cut step from authorized recovery selects an unverified slot.',
    evidenceClass: 'documentation/simulation',
  };

  /* ---------------- credential lifecycle ---------------- */

  const scenarios: Scenario[] = runScenarios();

  const credentialLifecycle = {
    slot: {
      requirement: 'the per-device credential is provisioned into a hardware-backed slot and is non-exportable',
      hardwareBacked: config.credentialHardwareBacked,
      exportable: config.credentialExportable,
      protectedThrough: ['update', 'authorized-recovery', 'rma'],
      rotateRevoke: 'explicit rotate and revoke semantics; a retired handle keeps being rejected',
      evidenceClass: 'documentation/simulation',
      hardwareObservation: 'none in this fixture: the corpus records no credential, key-slot or fleet observation',
    },
    lifecycle: [
      { step: 'provisioning', requirement: 'identity and key material written under an authenticated provisioning path into the hardware-backed slot', configFlag: 'credentialHardwareBacked=true', demonstratedBy: 'provision-and-use' },
      { step: 'generation/import', requirement: 'the credential is generated on device or imported only into the hardware-backed slot; algorithm and protocol construction are not this task\u2019s to design', configFlag: `algorithmOwnedBy=${config.algorithmOwnedBy}`, demonstratedBy: 'provision-and-use (slot placement only)' },
      { step: 'storage', requirement: 'hardware-backed isolation with no export path', configFlag: 'credentialHardwareBacked=true, credentialExportable=false', demonstratedBy: 'export-attempt-blocked' },
      { step: 'use', requirement: 'authorization requires a live slot, the current handle and an authorized fleet record', configFlag: 'fleetRevocationCheckedOnRecovery=true', demonstratedBy: 'provision-and-use, fleet-revocation-denies-use' },
      { step: 'rotation', requirement: 'rotation retires the previous handle and only the new handle authorizes use', configFlag: 'explicit rotate semantics required by the contract', demonstratedBy: 'rotate-invalidates-previous-handle' },
      { step: 'revocation', requirement: 'fleet revocation denies use without requiring contact with the device', configFlag: 'fleetRevocationCheckedOnRecovery=true', demonstratedBy: 'fleet-revocation-denies-use' },
      { step: 'backup/exportability', requirement: 'no exportable copy of the private material exists', configFlag: 'credentialExportable=false', demonstratedBy: 'export-attempt-blocked' },
      { step: 'update', requirement: 'credential authority is protected through update', configFlag: 'protected through update per the contract', demonstratedBy: 'update-and-authorized-recovery-preserve-credential' },
      { step: 'recovery', requirement: 'credential authority is protected through recovery, and recovery itself is separately authorized', configFlag: 'authorizedRecoveryOnly=true', demonstratedBy: 'update-and-authorized-recovery-preserve-credential + recoveryDemonstration' },
      { step: 'factory-reset', requirement: 'factory reset destroys or invalidates local credential authority, not just user data', configFlag: 'resetDestroysOrInvalidatesCredential=true', demonstratedBy: 'factory-reset-invalidates-credential' },
      { step: 'rma', requirement: 'RMA invalidates the previous credential and re-provisions only through an authenticated path', configFlag: 'protected through RMA per the contract', demonstratedBy: 'rma-invalidates-previous-credential' },
      { step: 'decommission', requirement: 'decommission destroys the credential and is final', configFlag: 'decommissionDestroysCredential=true', demonstratedBy: 'decommission-destroys-credential' },
      { step: 'fleet-record', requirement: 'fleet revocation prevents a reset or recovered device from silently regaining authorization', configFlag: 'fleetRevocationCheckedOnRecovery=true', demonstratedBy: 'reset-device-cannot-silently-regain-authorization' },
    ],
    scenarios,
    scenarioSummary: {
      total: scenarios.length,
      passed: scenarios.filter((entry) => entry.pass).length,
      failed: scenarios.filter((entry) => !entry.pass).length,
      note: 'every scenario is an authored-model result, labelled documentation/simulation; no scenario is a hardware measurement',
    },
    evidenceClass: 'documentation/simulation',
  };

  /* ---------------- reset / decommission + fleet record ---------------- */

  const resetScenario = scenarios.find((entry) => entry.id === 'factory-reset-invalidates-credential');
  const silentScenario = scenarios.find(
    (entry) => entry.id === 'reset-device-cannot-silently-regain-authorization',
  );
  const decommissionScenario = scenarios.find((entry) => entry.id === 'decommission-destroys-credential');
  const rmaScenario = scenarios.find((entry) => entry.id === 'rma-invalidates-previous-credential');
  const preserveScenario = scenarios.find(
    (entry) => entry.id === 'update-and-authorized-recovery-preserve-credential',
  );

  const resetDecommissionFleetRecord = {
    factoryResetRecord: {
      deviceId: resetScenario?.deviceId,
      event: 'factory-reset',
      credentialStateAfter: resetScenario?.steps.at(-1)?.slotState,
      localCredentialAuthorityAfter: 'none: the reset device holds no usable credential',
      fleetEntryAfter: 'unchanged unless the operator also revokes it; a reset alone does not re-authorize the device',
      useAfterReset: resetScenario?.actual,
      silentReauthorization: silentScenario?.steps.find((entry) => entry.action === 'silent-reauthorization-attempt'),
      evidenceClass: 'documentation/simulation',
    },
    rmaRecord: {
      deviceId: rmaScenario?.deviceId,
      event: 'rma',
      unauthenticatedOutcome: rmaScenario?.steps.find((entry) => entry.action === 'rma-unauthenticated'),
      authenticatedOutcome: rmaScenario?.steps.find((entry) => entry.action === 'rma-authenticated'),
      previousHandleAfterRma: 'rejected (see rma-invalidates-previous-credential)',
      evidenceClass: 'documentation/simulation',
    },
    decommissionRecord: {
      deviceId: decommissionScenario?.deviceId,
      event: 'decommission',
      credentialStateAfter: 'destroyed',
      fleetEntryAfter: 'revoked',
      useAfterDecommission: decommissionScenario?.steps.find((entry) => entry.action === 'use'),
      reprovisionAfterDecommission: decommissionScenario?.steps.find((entry) => entry.action === 're-provision'),
      final: true,
      evidenceClass: 'documentation/simulation',
    },
    fleetRecord: {
      deviceId: silentScenario?.deviceId,
      events: [
        'authorized at provisioning',
        'revoked by the operator (fleet-side action, no device contact required)',
        'reauthorization after reset refused while revoked',
      ],
      statuses: { authorized: 'device may use its credential', revoked: 'every use and re-provisioning path is refused' },
      gates: [
        'the request must be authenticated',
        'the fleet record for the device must still authorize it',
        'local state alone never authorizes a reset or recovered device',
      ],
      demonstratedBy: silentScenario?.id,
      outcome: silentScenario?.actual,
      evidenceClass: 'documentation/simulation',
    },
    updateAndRecoveryRecord: {
      requirement: 'credential authority survives update and authorized recovery',
      outcome: preserveScenario?.actual,
      note: 'selecting an updated slot or entering authorized recovery does not touch the credential slot; only reset, RMA and decommission remove credential authority',
      evidenceClass: 'documentation/simulation',
    },
  };

  /* ---------------- claims, limits, scope ---------------- */

  const claims = {
    supportedByThisArtifact: [
      `the production lock register is observed on the representative board (corpus.observed.productionLockRegister=true), and the fixture contract states its semantics: swdReadoutLocked=${String(config.swdReadoutLocked)}, authorizedRecoveryOnly=${String(config.authorizedRecoveryOnly)}`,
      'SWD holds no unrestricted firmware or secret readout authority in normal service or under temporary physical possession, and its only remaining authority is the explicitly authenticated recovery session',
      'UART is bounded to console log output and ROM USB download to authenticated images in both states, so temporary physical possession does not escalate interface authority',
      `ROM download authority is bounded by the same gate the bootloader applies: ${imageKey(older)} -> ${bootDecision(gate, older)}, ${imageKey(unsigned)} -> ${bootDecision(gate, unsigned)}, ${imageKey(wrongProduct)} -> ${bootDecision(gate, wrongProduct)}, ${imageKey(corrupt)} -> ${bootDecision(gate, corrupt)}`,
      'recovery is separately authorized: removing the authorization turns the same signed recovery image into a rollback rejection, and every power-cut step from authorized recovery lands in an authenticated slot',
      'the credential lifecycle contract is exercised end to end by the authored model: provision, use, rotate, revoke, reset, RMA, decommission, and the reset/recovered device cannot regain authorization silently while its fleet entry is revoked',
    ],
    notEstablished: [
      `debug lock effectiveness: corpus.emulator.debugLockProof=${String(corpus.emulator.debugLockProof)}, and the production lock register is a different register whose semantics come from the fixture contract`,
      `physical fuse enforcement: corpus.emulator.physicalFuseProof=${String(corpus.emulator.physicalFuseProof)}`,
      `resistance to invasive extraction and fault injection: invasiveResistanceClaimed=${String(config.invasiveResistanceClaimed)}, faultInjectionResistanceClaimed=${String(config.faultInjectionResistanceClaimed)}; neither was exercised`,
      'credential hardware behaviour: no credential, key-slot or fleet observation exists in the corpus, so every credential result is documentation/simulation',
      'communications and peripheral behaviour (BLE/Wi-Fi provisioning, NFC, removable media, DMA-capable peripherals, hidden service protocols, manufacturing commands): no observation exists in this fixture',
    ],
    claimBoundary:
      'This artifact shows interface-authority policy, the boot/update gate that bounds every write path, and the credential lifecycle state machine. It does not show debug lock, fuse enforcement, physical secret-extraction resistance, fault-injection resistance or real flash behaviour; those need representative hardware.',
  };

  const limits = [
    'The supplied simulator models boot, update and recovery decisions. It has no credential, fleet, RMA or decommission state, so the credential lifecycle is an authored model (scripts/device-lifecycle-model.ts) and every one of its results is documentation/simulation.',
    'The corpus records no credential, key-slot or fleet observation, so nothing in the credential lifecycle is hardware-observed.',
    `The corpus records emulator.physicalFuseProof=false and emulator.debugLockProof=false, so invasive-extraction and fault-injection resistance stay unclaimed and the effective debug lock is not proven here.`,
    'Image digests are content digests of the corpus image records, not measurements of flash contents on hardware.',
    'The recovery counterfactual, the update candidates and the unsigned candidate are derived fixtures: they are labelled as such and are not present in evidence/device-corpus.json.',
    'Interface authority is evaluated as policy membership through interfaceCan; the fixture supplies no board observation of an interface attempt, so no attempt result is hardware-observed.',
    'Communications, peripherals and safety consequences are recorded as requirements in .kory-eval/threat-model.md; this fixture supplies no observation for any of them.',
  ];

  const scopeBoundary = {
    ownedHere: [
      'device trust anchors: the board-observed key-hash fuse record and the boot/update gate',
      'privileged interface authority and its bounds in normal, temporary-physical-possession and authenticated-recovery states',
      'the per-device credential lifecycle contract and its fleet-side revocation gate',
    ],
    ownedElsewhere: [
      `algorithm and protocol construction: algorithmOwnedBy=${config.algorithmOwnedBy}, and no algorithm is designed here`,
      'embedded-firmware: RTOS tasks, drivers, peripheral implementation and timing',
      'supply-chain-security: build provenance, dependency/release integrity, artifact-signing pipeline',
      'infrastructure-security / cloud-security: the fleet backend and control plane that owns the fleet record',
      'threat-modeling-practice: the broader threat model this analysis converts into device controls',
      'application security of a host, mobile or web tier: a separate discipline that this task did not request, so no application-layer control is claimed or graded here',
    ],
  };

  return {
    schema: 'kory-eval/device-lifecycle-evidence@1',
    summary:
      'Production interface authority for device-x on board mcu-rev-c under normal and temporary-physical-possession states, the boot/update gate that bounds every write path, the demonstrated recovery condition, and the per-device credential lifecycle through reset, RMA, decommission and fleet revocation.',
    environment: {
      board: corpus.board,
      product: corpus.product,
      configuredProduct: config.product,
      configuredKeyHash: config.keyHash,
      productionKeyHash: corpus.keyHash,
      keyHashFuseRecordObserved: corpus.observed.keyHashFuseRecord === true,
      applicationVersion: current.version,
      minimumVersion: gate.minimumVersion,
      currentImage: imageKey(current),
      currentImageDigest: imageDigest(current),
      boardObserved: Object.entries(corpus.observed)
        .filter(([, value]) => value)
        .map(([key]) => key),
      emulatorUnavailable: Object.entries(corpus.emulator)
        .filter(([, value]) => value === false)
        .map(([key]) => key),
      ambiguityResolved: [
        `board/revision ${corpus.board}: the representative board the production lock register and key-hash fuse record are observed on`,
        `product ${corpus.product}: the product the boot/update gate and every interface write path is bound to`,
        `production key hash ${corpus.keyHash}: matches the board-observed key-hash fuse record`,
        `application version ${current.version}: the board-observed deployed image, which sets the anti-rollback floor so the signed ${imageKey(older)} image is a downgrade and not an update`,
        `debug fuse: not observed \u2014 corpus.emulator.debugLockProof=${String(corpus.emulator.debugLockProof)}, so device-config.json ships debugFuseObserved=false`,
      ],
      note: 'environment facts are read from the fixed corpus and the authored policy; nothing here is inferred from the emulator',
    },
    evidenceLabels: {
      'hardware-observed': 'read on the representative board and recorded in the fixture corpus observation set (observed.serialBootLog, observed.keyHashFuseRecord, observed.productionLockRegister)',
      'documentation/simulation':
        'stated by the fixture contract, derived from src/device-sim.ts, or produced by the authored credential lifecycle model; no hardware measurement exists for it',
      usage:
        'each attempt, authority, gate decision and credential scenario carries one of these two labels, and any claim that would need silicon is listed under claims.notEstablished instead',
    },
    productionLockState,
    interfaceAttempts: {
      states: STATE_DEFINITIONS,
      tokenGrammar: TOKEN_GRAMMAR,
      policyAuthorities,
      attempts,
      totals: {
        attempts: attempts.length,
        authorized: authorizedCount,
        denied: attempts.length - authorizedCount,
        readoutAttempts: attempts.filter((entry) => entry.attempt.includes('readout')).length,
        readoutAuthorized: attempts.filter((entry) => entry.attempt.includes('readout') && entry.authorized)
          .length,
        writePathAttemptsAuthorized: attempts.filter(
          (entry) =>
            (entry.attempt.includes('image-install') ||
              entry.attempt.includes('image-write') ||
              entry.attempt.includes('rollback-state-clear') ||
              entry.attempt.includes('image-download')) &&
            entry.authorized,
        ).length,
        writePathNote:
          'the only authorized write-path attempts are the two bounded download authorities; each is limited by downloadGate, and every rollback-state-clear and unauthorized image-install attempt is denied',
      },
      evidenceClass: 'documentation/simulation',
    },
    downloadGate,
    recoveryDemonstration,
    credentialLifecycle,
    resetDecommissionFleetRecord,
    scopeBoundary,
    claims,
    limits,
    reproduction: {
      commands: ['bun run scripts/build-lifecycle-evidence.ts', 'bun test'],
      deterministic: true,
      analysisDocument: '.kory-eval/threat-model.md',
      inputs: {
        'src/device-sim.ts': fileDigest(SIM_PATH),
        'evidence/device-corpus.json': fileDigest(CORPUS_PATH),
        '.kory-eval/device-config.json': fileDigest(CONFIG_PATH),
      },
    },
  };
}

function main(): void {
  const config = readConfig();
  const corpus = readCorpus();
  const evidence = buildEvidence(config, corpus);
  mkdirSync(dirname(EVIDENCE_PATH), { recursive: true });
  writeFileSync(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`);
  const attempts = evidence.interfaceAttempts as { attempts: unknown[]; totals: Record<string, number> };
  const scenarios = evidence.credentialLifecycle as { scenarioSummary: Record<string, number> };
  console.log(
    `wrote ${EVIDENCE_PATH}\ninterface attempts: ${attempts.attempts.length} ` +
      `(authorized ${attempts.totals.authorized}, denied ${attempts.totals.denied}); ` +
      `credential scenarios: ${scenarios.scenarioSummary.passed}/${scenarios.scenarioSummary.total} matched expectations`,
  );
}

if (import.meta.main) main();
