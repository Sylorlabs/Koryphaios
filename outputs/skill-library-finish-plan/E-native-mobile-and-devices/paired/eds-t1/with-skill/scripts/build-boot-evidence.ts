/**
 * Deterministic builder for `.kory-eval/boot-evidence.json`.
 *
 * Nothing here may hard-code a boot decision: every decision, digest, serial
 * line and power-cut transition is re-derived from the supplied
 * `src/device-sim.ts` state machine plus the fixed `evidence/device-corpus.json`
 * corpus and the authored `.kory-eval/boot-config.json` policy.
 *
 * Deliberately non-clock, non-random and non-secret: re-running this file on an
 * unchanged tree reproduces a byte-identical artifact, which is what
 * `tests/boot-evidence.test.ts` asserts.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  bootDecision,
  powerCutRecovery,
  type BootConfig,
  type Image,
  type UpdateStep,
} from '../src/device-sim';

export const ROOT = join(import.meta.dir, '..');
export const CONFIG_PATH = join(ROOT, '.kory-eval/boot-config.json');
export const EVIDENCE_PATH = join(ROOT, '.kory-eval/boot-evidence.json');
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

export function readCorpus(): Corpus {
  return JSON.parse(readFileSync(CORPUS_PATH, 'utf8')) as Corpus;
}

export function readConfig(): BootConfig {
  return JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as BootConfig;
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

export function isDerived(image: Image, corpus: Corpus): boolean {
  return !corpus.images.some((entry) => entry.id === image.id && entry.version === image.version);
}

/** The boot chain in evaluation order, mirroring `bootDecision`. */
export function checkOutcomes(
  config: BootConfig,
  image: Image,
): Array<{ check: string; result: string; note: string }> {
  return [
    {
      check: 'integrity',
      result: image.corrupt ? 'fail' : 'pass',
      note: image.corrupt ? 'slot content is corrupt' : 'slot content intact',
    },
    {
      check: 'signature',
      result: !image.signed || !image.signatureValid ? 'fail' : 'pass',
      note: `bootloaderVerifiesSignature=${String(
        config.bootloaderVerifiesSignature,
      )} (signed=${String(image.signed)}, signatureValid=${String(image.signatureValid)})`,
    },
    {
      check: 'product-binding',
      result: image.product !== config.product ? 'fail' : 'pass',
      note: `bootloaderVerifiesProduct=${String(
        config.bootloaderVerifiesProduct,
      )} (image product=${image.product}, policy product=${config.product})`,
    },
    {
      check: 'rollback-version',
      result:
        image.version < config.minimumVersion
          ? image.authorizedRecovery
            ? 'below-minimum-authorized'
            : 'fail'
          : 'pass',
      note: `minimumVersion=${config.minimumVersion}, image version=${image.version}, rollbackStateProtected=${String(
        config.rollbackStateProtected,
      )}`,
    },
    {
      check: 'recovery-authorization',
      result: image.authorizedRecovery ? 'present' : 'absent',
      note: image.authorizedRecovery
        ? 'separate recovery authorization is carried by the image and required by policy'
        : 'image carries no separate recovery authorization',
    },
  ];
}

/** Serial decision evidence: one line per evaluated check, in evaluation order. */
export function serialDecision(config: BootConfig, corpus: Corpus, image: Image): string[] {
  const decision = bootDecision(config, image);
  const lines: string[] = [
    `[bootrom] key-hash record bound to ${config.productionKeyHash} (corpus keyHash=${corpus.keyHash})`,
    `[bootloader] image ${imageKey(image)} product=${image.product}`,
  ];
  const checks = checkOutcomes(config, image);
  // `bootDecision` short-circuits on integrity, then signature, then product,
  // then rollback; the serial trace shows the same short-circuit and never
  // repeats a check the state machine already evaluated.
  const stop = image.corrupt
    ? 1
    : !image.signed || !image.signatureValid
      ? 2
      : image.product !== config.product
        ? 3
        : 5;
  for (const [index, check] of checks.entries()) {
    if (index >= stop) break;
    lines.push(`[check] ${check.check}: ${check.result} (${check.note})`);
  }
  lines.push(
    decision === 'boot' || decision === 'recovery'
      ? `[boot] decision=${decision}; executing ${imageKey(image)}`
      : `[boot] decision=${decision}; no slot executed`,
  );
  return lines;
}

function authenticityOf(config: BootConfig, image: Image): string {
  const decision = bootDecision(config, image);
  if (decision === 'boot') return 'authenticated-application';
  if (decision === 'recovery') return 'authorized-recovery';
  return `not-authenticated(${decision})`;
}

function imageEntry(
  config: BootConfig,
  corpus: Corpus,
  image: Image,
  evidenceClass: string,
  notes: string[],
): Record<string, unknown> {
  const decision = bootDecision(config, image);
  return {
    id: image.id,
    version: image.version,
    digest: imageDigest(image),
    product: image.product,
    source: isDerived(image, corpus) ? 'derived' : 'corpus',
    decision,
    executed: decision === 'boot' || decision === 'recovery',
    executedBeforeReject: false,
    checks: checkOutcomes(config, image),
    serialDecision: serialDecision(config, corpus, image),
    serialDecisionSummary:
      decision === 'boot' || decision === 'recovery'
        ? `serial: ${imageKey(image)} accepted (${decision})`
        : `serial: ${imageKey(image)} rejected before execution (${decision})`,
    evidenceClass,
    notes,
  };
}

function powerCutEntry(
  config: BootConfig,
  active: Image,
  candidate: Image,
  step: UpdateStep,
): Record<string, unknown> {
  const candidateDecision = bootDecision(config, candidate);
  const bootedId = powerCutRecovery(config, active, candidate, step);
  const booted = bootedId === candidate.id ? candidate : active;
  const authenticity = authenticityOf(config, booted);
  const executedUnverified = authenticity.startsWith('not-authenticated');
  return {
    step,
    activeSlot: imageKey(active),
    candidateSlot: imageKey(candidate),
    candidateDecision,
    bootedImage: booted.id,
    bootedImageVersion: booted.version,
    bootedImageKey: imageKey(booted),
    bootedSlotAuthenticity: authenticity,
    unverifiedSlotExecuted: executedUnverified,
    serialDecision: [
      `[boot] power-cut at ${step}: candidate ${imageKey(candidate)} decision=${candidateDecision}`,
      `[boot] selecting ${imageKey(booted)} (${authenticity}); unverified slot executed=${String(
        executedUnverified,
      )}`,
    ],
    serialDecisionSummary: `serial: power-cut at ${step} selected ${imageKey(booted)}`,
    evidenceClass: 'emulator-only',
    note:
      step === 'write-inactive' || step === 'verify-inactive'
        ? 'pre-commit step: the inactive slot is not selected, so a partial write is never run'
        : candidateDecision === 'boot'
          ? 'post-commit step: the candidate is selected only because it passed the same signature, product and version gate'
          : 'candidate failed the gate, so the previously authenticated slot keeps running',
  };
}

export function buildEvidence(config: BootConfig, corpus: Corpus): Record<string, unknown> {
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

  // Derived fixtures: never written into the corpus, only used to probe a
  // boundary the supplied images alone cannot express.
  const candidateUpdate: Image = { ...current, id: 'new', version: current.version + 1 };
  const unsignedCandidate: Image = { ...unsigned, id: 'new-unsigned', version: 8 };
  const recoveryNoAuthorization: Image = {
    ...recovery,
    id: 'recovery-unauthorized',
    authorizedRecovery: undefined,
  };

  const images: Record<string, unknown> = {
    [imageKey(current)]: imageEntry(config, corpus, current, 'board-observed', [
      'corpus observed.serialBootLog=true: the board serial log records this image executing',
      'the per-check results below are the state machine explanation of that observation, not separate hardware measurements',
    ]),
    [imageKey(older)]: imageEntry(config, corpus, older, 'emulator-only', [
      'negative fixture supplied by the corpus; the board was not flashed with it in this fixture',
    ]),
    [imageKey(wrongProduct)]: imageEntry(config, corpus, wrongProduct, 'emulator-only', [
      'negative fixture supplied by the corpus; the board was not flashed with it in this fixture',
    ]),
    [imageKey(unsigned)]: imageEntry(config, corpus, unsigned, 'emulator-only', [
      'negative fixture supplied by the corpus; the board was not flashed with it in this fixture',
    ]),
    [imageKey(corrupt)]: imageEntry(config, corpus, corrupt, 'emulator-only', [
      'invalid-state fixture supplied by the corpus; the board was not flashed with it in this fixture',
    ]),
    [imageKey(recovery)]: imageEntry(config, corpus, recovery, 'emulator-only', [
      'recovery fixture supplied by the corpus; entering recovery on the board was not performed in this fixture',
    ]),
    [imageKey(candidateUpdate)]: imageEntry(config, corpus, candidateUpdate, 'emulator-only', [
      'derived from current@7 with version 8: the authenticated update candidate used by the power-cut matrix',
    ]),
    [imageKey(recoveryNoAuthorization)]: imageEntry(config, corpus, recoveryNoAuthorization, 'emulator-only', [
      'derived counterfactual: identical to the supplied recovery image except that the separate recovery authorization is removed',
      'this fixture shows recovery is authorized separately and is not a signature-only rollback bypass',
    ]),
  };

  const scenario = (
    title: string,
    active: Image,
    candidate: Image,
    notes: string[],
  ): Record<string, unknown> => {
    const steps: Record<string, unknown> = {};
    const booted: string[] = [];
    let unverified = false;
    for (const step of corpus.steps) {
      const entry = powerCutEntry(config, active, candidate, step);
      steps[step] = entry;
      booted.push(entry.bootedImageKey as string);
      unverified = unverified || (entry.unverifiedSlotExecuted as boolean);
    }
    return {
      title,
      activeSlot: imageKey(active),
      activeSlotAuthenticity: authenticityOf(config, active),
      candidateSlot: imageKey(candidate),
      candidateDigest: imageDigest(candidate),
      candidateDecision: bootDecision(config, candidate),
      steps,
      recoveredImages: [...new Set(booted)],
      recoversToAuthenticatedSlotOnly: !unverified,
      unverifiedSlotExecutedAtAnyStep: unverified,
      notes,
      evidenceClass: 'emulator-only',
    };
  };

  const powerCuts: Record<string, unknown> = {
    [imageKey(candidateUpdate)]: scenario(
      'authenticated update from the board-observed current image',
      current,
      candidateUpdate,
      [
        'the candidate passes the signature, product and version gates before any step selects it',
        'every pre-commit cut leaves the board-observed current image running',
      ],
    ),
    [imageKey(older)]: scenario(
      'signed downgrade of the product image',
      current,
      older,
      [
        'the older image is correctly signed, so only protected rollback state can reject it',
        'recovery stays on the authenticated current image at every step',
      ],
    ),
    [imageKey(wrongProduct)]: scenario(
      'correctly signed image bound to another product',
      current,
      wrongProduct,
      ['product binding is enforced before version state is consulted'],
    ),
    [imageKey(unsigned)]: scenario(
      'unsigned candidate of the right product and version',
      current,
      unsigned,
      ['signature enforcement happens before product and version checks'],
    ),
    [imageKey(corrupt)]: scenario(
      'corrupt candidate of the right product and version',
      current,
      corrupt,
      ['integrity is checked first, exactly as the state machine orders it'],
    ),
    [imageKey(recovery)]: scenario(
      'recovery image offered as an ordinary update candidate',
      current,
      recovery,
      [
        'an authorized recovery image is never selected as an update candidate: it is a boot destination, not an installable image',
        'interrupting this path leaves the authenticated current image running',
      ],
    ),
    'restore-from-authorized-recovery': scenario(
      'authorized recovery restoring a production image',
      recovery,
      candidateUpdate,
      [
        'starting from authorized recovery, an authenticated production image is installed and committed',
        'pre-commit cuts keep the board in authorized recovery, which is itself an authenticated state',
      ],
    ),
    [imageKey(unsignedCandidate)]: scenario(
      'unsigned candidate installed while the active slot is authorized recovery',
      recovery,
      unsignedCandidate,
      [
        'the active slot is authorized recovery, so a failed update falls back to an authorized state rather than to an unverified slot',
      ],
    ),
    [imageKey(recoveryNoAuthorization)]: scenario(
      'recovery image with the separate authorization removed (counterfactual)',
      current,
      recoveryNoAuthorization,
      [
        'with the authorization removed the same signed image is rejected as a rollback: signature alone does not open the recovery path',
        'this is the property that makes recovery a separate authorization rather than a rollback bypass',
      ],
    ),
  };

  const trustChain = [
    {
      stage: 'immutable-boot-rom',
      mutability: 'immutable',
      trustAnchor: `key-hash fuse record ${config.productionKeyHash} (corpus keyHash=${corpus.keyHash})`,
      anchorEvidenceClass: 'board-observed (corpus observed.keyHashFuseRecord=true)',
      authenticates: 'mutable first-stage bootloader',
      failureBehavior: 'reject before executing any mutable stage',
      notes: [
        'the fixture contract states this design property; the simulator models the bootloader image decision, not the ROM-to-bootloader handoff',
      ],
    },
    {
      stage: 'first-stage-bootloader',
      mutability: 'mutable, authenticated by the immutable Boot ROM',
      enforces: [
        `bootloaderVerifiesSignature=${String(config.bootloaderVerifiesSignature)}`,
        `bootloaderVerifiesProduct=${String(config.bootloaderVerifiesProduct)}`,
      ],
      failureBehavior: 'reject-signature / reject-product / reject-corrupt before execution',
      notes: ['integrity is evaluated before signature, and signature before product, in the state machine'],
    },
    {
      stage: 'protected-rollback-state',
      mutability: 'protected from ordinary firmware writes',
      enforces: [
        `minimumVersion=${config.minimumVersion}`,
        `rollbackStateProtected=${String(config.rollbackStateProtected)}`,
      ],
      failureBehavior: 'reject-rollback for any version below the minimum that is not separately authorized',
    },
    {
      stage: 'authorized-recovery',
      mutability: 'separately authorized destination, never an ordinary installable image',
      enforces: [`recoveryRequiresAuthorization=${String(config.recoveryRequiresAuthorization)}`],
      failureBehavior: 'an image below the minimum without the separate authorization is rejected as a rollback',
    },
    {
      stage: 'application',
      mutability: 'mutable',
      currentImage: imageKey(current),
      note: 'the board-observed current image is the only image this fixture records as executing on hardware',
    },
  ];

  const interfacePolicy = {
    note: 'production interface policy for this device class. The fixture supplies no board observation for any of these surfaces, so nothing here is treated as measured.',
    evidenceClass: 'emulator-only',
    surfaces: [
      {
        name: 'swd',
        boardObservation: 'none in this fixture',
        productionPolicy:
          'disabled or authenticated in production, with an explicit capability limit and an authorized recovery path',
      },
      {
        name: 'uart-console',
        boardObservation: 'none in this fixture',
        productionPolicy:
          'the console is not privileged in production and cannot install an image or bypass verification',
      },
      {
        name: 'rom-usb-download-mode',
        boardObservation: 'none in this fixture',
        productionPolicy: 'download mode accepts only authenticated images and cannot lower version state',
      },
      {
        name: 'test-pads-and-manufacturing-mode',
        boardObservation: 'none in this fixture',
        productionPolicy:
          'manufacturing access is authenticated and cannot install an unverified image or clear rollback state',
      },
      {
        name: 'fleet-update-channel',
        boardObservation: 'none in this fixture',
        productionPolicy:
          'the remote channel authenticates the artifact, and the device still enforces product binding and version state locally',
      },
    ],
  };

  const claims = {
    supportedByThisFixture: [
      `the board-observed current image (${imageKey(current)}) boots, recorded on the serial boot log`,
      `the production key-hash fuse record is read on the board and matches the configured productionKeyHash (${config.productionKeyHash})`,
      'unsigned, corrupt and wrong-product fixtures are rejected before execution in the state machine',
      'the signed older image is rejected as a rollback at every power-cut step',
      'every supplied power-cut transition recovers to an authenticated current, candidate or authorized-recovery slot',
      'recovery requires the separate authorization: removing it turns the same signed recovery image into a rollback rejection',
    ],
    notEstablished: [
      'debug lock and effective debug privilege: the corpus records emulator.debugLockProof=false and boot-config debugFuseObserved=false',
      'physical fuse enforcement and resistance to physical secret extraction: the corpus records emulator.physicalFuseProof=false',
      'invasive or fault-injection resistance: not modeled by the simulator',
      'production lock register semantics: the register value is read on the board, but what it enforces is outside this fixture',
    ],
    claimBoundary:
      'This artifact shows the boot, rollback, recovery and power-cut state machine. Fuse state, debug lock, physical secret extraction resistance and power-fail behaviour on real silicon are outside what a simulator can show.',
  };

  const limits = [
    'The simulator models decisions and slot selection, not flash wear, bit-rot or a partially erased slot: the pre-commit recovery rule is the configured fail-safe, not a measurement.',
    'Only the supplied key-hash fuse record is board-observed; the corpus marks physicalFuseProof and debugLockProof as unavailable in the emulator.',
    'Digests are content digests of the corpus image records, not measurements of flash contents on hardware.',
    'The recovery-authorization counterfactual and the update candidates are derived fixtures: they are labelled as such and are not present in evidence/device-corpus.json.',
    'No fleet, credential or communication behaviour is asserted here: those surfaces have no observation in this fixture.',
  ];

  return {
    schema: 'kory-eval/boot-evidence@1',
    board: {
      board: corpus.board,
      product: corpus.product,
      configuredProduct: config.product,
      configuredProductionKeyHash: config.productionKeyHash,
      corpusKeyHash: corpus.keyHash,
      boardObserved: Object.entries(corpus.observed)
        .filter(([, value]) => value)
        .map(([key]) => key),
      emulatorUnavailable: Object.entries(corpus.emulator)
        .filter(([, value]) => value === false)
        .map(([key]) => key),
      note: 'the corpus observation set is the only board-side evidence in this fixture',
    },
    trustChain,
    policy: {
      ...config,
      rationale: [
        `productionKeyHash matches the corpus key-hash fuse record (${corpus.keyHash})`,
        `product matches the corpus product (${corpus.product})`,
        'minimumVersion 7 is the version of the board-observed current image, so no signed image older than the deployed one is accepted',
        'bootloaderVerifiesSignature and bootloaderVerifiesProduct stay enabled: the negative fixtures must reject before execution',
        'rollbackStateProtected is enabled so version state cannot be lowered by an ordinary firmware write',
        'recoveryRequiresAuthorization keeps the recovery path behind a separate authorization',
        'debugFuseObserved is false because the corpus records no debug-lock proof and the emulator cannot supply one',
      ],
    },
    images,
    powerCuts,
    recoveryAuthorization: {
      boardObserved: false,
      demonstration: [
        `supplied recovery image (${imageKey(recovery)}) with its separate authorization: decision=${bootDecision(
          config,
          recovery,
        )}`,
        `derived counterfactual (${imageKey(recoveryNoAuthorization)}) with the authorization removed: decision=${bootDecision(
          config,
          recoveryNoAuthorization,
        )}`,
      ],
      conclusion:
        'Recovery is a separately authorized destination. The same signed, non-corrupt, correctly bound image enters recovery only when the authorization is present; without it the protected rollback state rejects it, so a valid signature alone does not open the recovery path.',
      evidenceClass: 'emulator-only',
    },
    interfacePolicy,
    claims,
    limits,
    reproduction: {
      commands: ['bun run scripts/build-boot-evidence.ts', 'bun test'],
      deterministic: true,
      analysisDocument: '.kory-eval/threat-model.md',
      inputs: {
        'src/device-sim.ts': fileDigest(SIM_PATH),
        'evidence/device-corpus.json': fileDigest(CORPUS_PATH),
        '.kory-eval/boot-config.json': fileDigest(CONFIG_PATH),
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
  const cutCount = Object.keys(evidence.powerCuts).length * corpus.steps.length;
  console.log(
    `wrote ${EVIDENCE_PATH}\nimages: ${Object.keys(evidence.images).length}; power-cut transitions: ${cutCount}`,
  );
}

if (import.meta.main) main();
