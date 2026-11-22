/**
 * Deterministic evidence generator for the MCU secure-boot / OTA fixture.
 *
 * Everything here is derived from two supplied, user-owned inputs:
 *   - evidence/device-corpus.json   (fixed board corpus, never modified)
 *   - .kory-eval/boot-config.json   (policy artifact written for this task)
 * and every decision is produced by calling the supplied simulator in
 * src/device-sim.ts (never modified, never re-implemented).
 *
 * Claim boundary enforced by this module:
 *   - "board-observed"  = a fact the corpus itself records as observed
 *                          (keyHashFuseRecord, productionLockRegister,
 *                          serialBootLog).
 *   - "emulator-only"   = every decision / transition outcome produced by the
 *                          simulator, and the image digests computed here.
 *   - Nothing in the generated evidence claims debug-lock, fuse state beyond
 *     the supplied key-hash record, physical/invasive extraction resistance,
 *     fault-injection resistance or power-fail behaviour on real hardware.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  bootDecision,
  powerCutRecovery,
  type BootConfig,
  type Image,
  type UpdateStep,
} from '../src/device-sim.ts';

export type Basis = 'board-observed' | 'emulator-only';
export type Decision = ReturnType<typeof bootDecision>;

/** Repository root: scripts/ -> one level up. Robust to the caller's cwd. */
export const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export interface SerialLine {
  seq: number;
  line: string;
  basis: Basis;
}

export interface Corpus {
  board: string;
  keyHash: string;
  product: string;
  images: Image[];
  steps: UpdateStep[];
  observed: Record<string, boolean>;
  emulator: Record<string, boolean>;
}

/** Fixed key order for corpus image objects, so digests are reproducible. */
const IMAGE_KEY_ORDER = [
  'id',
  'version',
  'product',
  'signed',
  'signatureValid',
  'corrupt',
  'authorizedRecovery',
] as const;

const REJECT_DECISIONS: Decision[] = [
  'reject-signature',
  'reject-product',
  'reject-rollback',
  'reject-corrupt',
];

export function loadCorpus(path = join(REPO_ROOT, 'evidence/device-corpus.json')): Corpus {
  return JSON.parse(readFileSync(path, 'utf8')) as Corpus;
}

export function loadBootConfig(path = join(REPO_ROOT, '.kory-eval/boot-config.json')): BootConfig {
  return JSON.parse(readFileSync(path, 'utf8')) as BootConfig;
}

export function fileSha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/**
 * The corpus ships no *valid* newer image: every version-8 fixture is a
 * negative case (unsigned / corrupt / wrong product). To exercise the
 * "candidate" branch of the update state machine (mark-pending,
 * boot-pending, commit-version) the intended OTA image is derived locally.
 * It is NOT part of evidence/device-corpus.json and is labelled as a derived
 * emulator fixture wherever it appears.
 */
export function derivedCandidate(corpus: Corpus): Image {
  return {
    id: 'candidate',
    version: 8,
    product: corpus.product,
    signed: true,
    signatureValid: true,
    corrupt: false,
  };
}

export function canonicalImage(image: Image): string {
  const ordered: Record<string, unknown> = {};
  for (const key of IMAGE_KEY_ORDER) {
    const value = (image as Record<string, unknown>)[key];
    if (value !== undefined) ordered[key] = value;
  }
  return JSON.stringify(ordered);
}

export function imageDigest(image: Image): string {
  return createHash('sha256').update(canonicalImage(image)).digest('hex');
}

/** Evidence key: image digest AND version, per the README. */
export function imageKey(image: Image): string {
  return `${image.id}@v${image.version}:${imageDigest(image).slice(0, 12)}`;
}

function withSeq(lines: Array<Omit<SerialLine, 'seq'>>): SerialLine[] {
  return lines.map((line, index) => ({ seq: index + 1, ...line }));
}

function fuseLines(cfg: BootConfig, corpus: Corpus): Array<Omit<SerialLine, 'seq'>> {
  const lines: Array<Omit<SerialLine, 'seq'>> = [
    {
      basis: 'board-observed',
      line:
        `rom: immutable boot rom trusts production key-hash fuse record '${cfg.productionKeyHash}' ` +
        `(corpus keyHash '${corpus.keyHash}', corpus observed.keyHashFuseRecord=true)`,
    },
  ];
  if (corpus.observed.productionLockRegister) {
    lines.push({
      basis: 'board-observed',
      line:
        'rom: production lock register read (corpus observed.productionLockRegister=true); ' +
        'this record does NOT prove the debug fuse',
    });
  }
  if (corpus.observed.serialBootLog) {
    lines.push({
      basis: 'board-observed',
      line:
        'rom: board emits a serial boot log (corpus observed.serialBootLog=true); ' +
        'the lines below are emulator reconstructions of that decision evidence',
    });
  }
  return lines;
}

/** Ordered serial decision evidence, stopping at the check that decides. */
export function bootSerial(
  cfg: BootConfig,
  corpus: Corpus,
  image: Image,
  decision: Decision,
): SerialLine[] {
  const authorizedRecovery = image.authorizedRecovery ?? false;
  const lines: Array<Omit<SerialLine, 'seq'>> = [
    ...fuseLines(cfg, corpus),
    {
      basis: 'emulator-only',
      line: `boot: candidate image ${image.id} v${image.version} product=${image.product}`,
    },
  ];

  if (decision === 'reject-corrupt') {
    lines.push({
      basis: 'emulator-only',
      line: 'integrity: corrupt=true -> stop before any signature or execution step',
    });
  } else {
    lines.push({ basis: 'emulator-only', line: 'integrity: corrupt=false' });
    if (decision === 'reject-signature') {
      lines.push({
        basis: 'emulator-only',
        line:
          `signature: bootloaderVerifiesSignature=true signed=${image.signed} ` +
          `signatureValid=${image.signatureValid} -> reject before execution`,
      });
    } else {
      lines.push({
        basis: 'emulator-only',
        line: `signature: signed=${image.signed} signatureValid=${image.signatureValid}`,
      });
      if (decision === 'reject-product') {
        lines.push({
          basis: 'emulator-only',
          line: `product: ${image.product} != ${cfg.product} -> reject before execution`,
        });
      } else {
        lines.push({ basis: 'emulator-only', line: `product: ${image.product} == ${cfg.product}` });
        if (decision === 'reject-rollback') {
          lines.push({
            basis: 'emulator-only',
            line:
              `rollback: v${image.version} < minimumVersion ${cfg.minimumVersion} and ` +
              `authorizedRecovery=false -> reject (protected rollback state, ` +
              `rollbackStateProtected=${cfg.rollbackStateProtected})`,
          });
        } else {
          lines.push({
            basis: 'emulator-only',
            line:
              `rollback: v${image.version} vs minimumVersion ${cfg.minimumVersion}, ` +
              `authorizedRecovery=${authorizedRecovery}`,
          });
          if (decision === 'recovery') {
            lines.push({
              basis: 'emulator-only',
              line:
                `recovery: recovery image ${image.id} v${image.version} is separately ` +
                `authorized (recoveryRequiresAuthorization=${cfg.recoveryRequiresAuthorization}); ` +
                'entering authorized recovery, not a normal boot',
            });
          } else {
            lines.push({
              basis: 'emulator-only',
              line: `execute: handing control to image ${image.id} v${image.version}`,
            });
          }
        }
      }
    }
  }
  lines.push({ basis: 'emulator-only', line: `decision: ${decision}` });
  return withSeq(lines);
}

/** Ordered serial evidence for a power cut at one update step. */
export function powerCutSerial(
  cfg: BootConfig,
  corpus: Corpus,
  candidate: Image,
  step: UpdateStep,
  candidateDecision: Decision,
  resultImage: Image,
  resultDecision: Decision,
): SerialLine[] {
  const lines: Array<Omit<SerialLine, 'seq'>> = [
    ...fuseLines(cfg, corpus),
    {
      basis: 'emulator-only',
      line:
        `update: power cut at step '${step}' with pending candidate ` +
        `${candidate.id} v${candidate.version} (product=${candidate.product})`,
    },
    {
      basis: 'emulator-only',
      line: `boot: bootDecision(candidate) = ${candidateDecision}`,
    },
    {
      basis: 'emulator-only',
      line:
        `resume: image '${resultImage.id}' v${resultImage.version}, ` +
        `bootDecision = ${resultDecision}`,
    },
  ];
  if (REJECT_DECISIONS.includes(resultDecision)) {
    lines.push({
      basis: 'emulator-only',
      line: 'safe: resumed slot does NOT pass boot policy (unexpected for this matrix)',
    });
  } else {
    lines.push({
      basis: 'emulator-only',
      line: 'safe: resumed slot passes boot policy; no unverified slot was executed',
    });
  }
  return withSeq(lines);
}

export interface ImageIndexEntry {
  imageId: string;
  version: number;
  product: string;
  digest: string;
  digestAlgorithm: 'sha256';
  digestBasis: Basis;
  source: 'corpus' | 'derived-emulator-fixture';
}

export interface BootDecisionEntry {
  image: ImageIndexEntry;
  imageKey: string;
  decision: Decision;
  basis: Basis;
  boardObservedInputs: string[];
  emulatorOnlySteps: string[];
  notClaimed: string[];
  serial: SerialLine[];
}

export interface PowerCutEntry {
  step: UpdateStep;
  candidate: string;
  candidateDecision: Decision;
  resultImage: string;
  resultSlot: string;
  resultDecision: Decision;
  executedUnverifiedSlot: boolean;
  basis: Basis;
  serial: SerialLine[];
}

export interface Invariant {
  id: string;
  statement: string;
  holds: boolean;
  basis: Basis;
  detail: string;
}

export interface Evidence {
  schema: string;
  board: string;
  generator: {
    script: string;
    runtime: string;
    simulatorPath: string;
    simulatorSha256: string;
    corpusPath: string;
    corpusSha256: string;
    configPath: string;
    configSha256: string;
  };
  config: BootConfig;
  claimBoundary: {
    boardObserved: Array<{ fact: string; corpusField: string }>;
    emulatorOnly: string[];
    notClaimed: string[];
  };
  imageIndex: Record<string, ImageIndexEntry>;
  bootDecisions: Record<string, BootDecisionEntry>;
  powerCutRecovery: Record<string, Record<string, PowerCutEntry>>;
  negativeControls: Record<string, unknown>;
  invariants: Invariant[];
}

const NOT_CLAIMED = [
  'debug fuse / debug-lock state (corpus emulator.debugLockProof=false)',
  'physical or invasive secret-extraction resistance (corpus emulator.physicalFuseProof=false)',
  'fault-injection resistance',
  'power-fail behaviour on real hardware',
  'hardware-root enforcement beyond the supplied key-hash fuse record',
];

const EMULATOR_ONLY = [
  'boot decisions (signature / product / rollback / corrupt)',
  'recovery authorization decision',
  'power-cut recovery transitions at every update step',
  'image digests computed over fixture metadata',
  'serial decision text (reconstruction of what the board would log)',
];

function boardObservedInputs(corpus: Corpus): string[] {
  const inputs: string[] = [];
  if (corpus.observed.keyHashFuseRecord) inputs.push(`keyHashFuseRecord=${corpus.keyHash}`);
  if (corpus.observed.productionLockRegister) inputs.push('productionLockRegister');
  if (corpus.observed.serialBootLog) inputs.push('serialBootLog');
  return inputs;
}

function indexEntry(image: Image, source: ImageIndexEntry['source']): ImageIndexEntry {
  return {
    imageId: image.id,
    version: image.version,
    product: image.product,
    digest: imageDigest(image),
    digestAlgorithm: 'sha256',
    digestBasis: 'emulator-only',
    source,
  };
}

/**
 * Builds the complete evidence document. Pure function of (config, corpus):
 * no clocks, no randomness, so re-running it must reproduce the file byte for
 * byte (asserted by tests/artifacts.test.ts).
 */
export function buildEvidence(cfg: BootConfig, corpus: Corpus): Evidence {
  const corpusImages = corpus.images.map((image) => ({ image, source: 'corpus' as const }));
  const candidate = derivedCandidate(corpus);
  const allImages: Array<{ image: Image; source: ImageIndexEntry['source'] }> = [
    ...corpusImages,
    { image: candidate, source: 'derived-emulator-fixture' },
  ];
  const current = corpus.images.find((image) => image.id === 'current');
  if (!current) throw new Error('corpus has no "current" image');
  const byId = new Map(allImages.map((entry) => [entry.image.id, entry.image]));

  const imageIndex: Record<string, ImageIndexEntry> = {};
  for (const { image, source } of allImages) imageIndex[imageKey(image)] = indexEntry(image, source);

  const bootDecisions: Record<string, BootDecisionEntry> = {};
  for (const { image } of allImages) {
    const decision = bootDecision(cfg, image);
    bootDecisions[imageKey(image)] = {
      image: indexEntry(image, imageIndex[imageKey(image)].source),
      imageKey: imageKey(image),
      decision,
      basis: 'emulator-only',
      boardObservedInputs: boardObservedInputs(corpus),
      emulatorOnlySteps: EMULATOR_ONLY,
      notClaimed: NOT_CLAIMED,
      serial: bootSerial(cfg, corpus, image, decision),
    };
  }

  const powerCutRecoveryEvidence: Record<string, Record<string, PowerCutEntry>> = {};
  for (const { image: cand } of allImages) {
    const candidateDecision = bootDecision(cfg, cand);
    const perStep: Record<string, PowerCutEntry> = {};
    for (const step of corpus.steps) {
      const resultId = powerCutRecovery(cfg, current, cand, step);
      const resultImage = byId.get(resultId);
      if (!resultImage) throw new Error(`simulator returned unknown image id '${resultId}'`);
      const resultDecision = bootDecision(cfg, resultImage);
      perStep[step] = {
        step,
        candidate: imageKey(cand),
        candidateDecision,
        resultImage: imageKey(resultImage),
        resultSlot: resultId,
        resultDecision,
        executedUnverifiedSlot: REJECT_DECISIONS.includes(resultDecision),
        basis: 'emulator-only',
        serial: powerCutSerial(cfg, corpus, cand, step, candidateDecision, resultImage, resultDecision),
      };
    }
    powerCutRecoveryEvidence[imageKey(cand)] = perStep;
  }

  // Negative control: the same matrix with recovery authorization disabled.
  // This is the "signature-only rollback bypass" the shipped config prevents;
  // it is recorded as a contrast, never as device policy.
  const bypassConfig: BootConfig = { ...cfg, recoveryRequiresAuthorization: false };
  const recoveryImage = corpus.images.find((image) => image.authorizedRecovery === true);
  const bypass: Record<string, unknown> = {
    description:
      'Contrast run with recoveryRequiresAuthorization=false. Shows why the shipped ' +
      'config keeps the flag true: a signed older recovery image would then boot, and a ' +
      'power cut at commit-version would resume it as an ordinary image.',
    config: bypassConfig,
    basis: 'emulator-only',
    isDevicePolicy: false,
  };
  if (recoveryImage) {
    bypass['bootDecision(recovery image)'] = bootDecision(bypassConfig, recoveryImage);
    bypass['powerCutRecovery(recovery, commit-version)'] = powerCutRecovery(
      bypassConfig,
      current,
      recoveryImage,
      'commit-version',
    );
    bypass['shippedConfigBootDecision(recovery image)'] = bootDecision(cfg, recoveryImage);
    bypass['shippedConfigPowerCutRecovery(recovery, commit-version)'] = powerCutRecovery(
      cfg,
      current,
      recoveryImage,
      'commit-version',
    );
  }

  const decisionOf = (id: string): Decision => {
    const image = byId.get(id);
    if (!image) throw new Error(`unknown image '${id}'`);
    return bootDecision(cfg, image);
  };

  const allPowerCutEntries: PowerCutEntry[] = Object.values(powerCutRecoveryEvidence).flatMap(
    (perStep) => Object.values(perStep),
  );
  const stepsCovered = new Set(allPowerCutEntries.map((entry) => entry.step));
  const candidatesCovered = Object.keys(powerCutRecoveryEvidence).length;

  const invariants: Invariant[] = [
    {
      id: 'current-boots',
      statement: 'The board-observed current image boots under the shipped config.',
      holds:
        bootDecision(cfg, current) === 'boot' &&
        decisionOf('current') === 'boot',
      basis: 'emulator-only',
      detail: `bootDecision(current v${current.version}) = ${bootDecision(cfg, current)}`,
    },
    {
      id: 'unsigned-rejects-before-execution',
      statement: 'The unsigned image is rejected before execution.',
      holds: decisionOf('unsigned') === 'reject-signature',
      basis: 'emulator-only',
      detail: `bootDecision(unsigned) = ${decisionOf('unsigned')}`,
    },
    {
      id: 'corrupt-rejects-before-execution',
      statement: 'The corrupt image is rejected before execution.',
      holds: decisionOf('corrupt') === 'reject-corrupt',
      basis: 'emulator-only',
      detail: `bootDecision(corrupt) = ${decisionOf('corrupt')}`,
    },
    {
      id: 'wrong-product-rejects',
      statement:
        'The wrong-product image (v8, newer than minimumVersion) is rejected by product ' +
        'binding, not by version: a newer version alone is not an upgrade.',
      holds: decisionOf('wrong-product') === 'reject-product',
      basis: 'emulator-only',
      detail: `bootDecision(wrong-product v8) = ${decisionOf('wrong-product')}`,
    },
    {
      id: 'older-rejects-rollback',
      statement: 'The signed older image is rejected by protected rollback state.',
      holds: decisionOf('older') === 'reject-rollback',
      basis: 'emulator-only',
      detail: `bootDecision(older v5) = ${decisionOf('older')} (minimumVersion=${cfg.minimumVersion})`,
    },
    {
      id: 'recovery-separately-authorized',
      statement:
        'The recovery image routes to separately authorized recovery rather than booting, ' +
        'i.e. it is not a signature-only rollback bypass.',
      holds: decisionOf('recovery') === 'recovery',
      basis: 'emulator-only',
      detail:
        `bootDecision(recovery v3, authorizedRecovery=true) = ${decisionOf('recovery')} ` +
        `with recoveryRequiresAuthorization=${cfg.recoveryRequiresAuthorization}`,
    },
    {
      id: 'every-step-exercised',
      statement: `Every supplied power-cut step is exercised for all ${candidatesCovered} candidate images.`,
      holds:
        corpus.steps.every((step) => stepsCovered.has(step)) && stepsCovered.size === corpus.steps.length,
      basis: 'emulator-only',
      detail: `steps exercised: ${[...stepsCovered].sort().join(', ')}`,
    },
    {
      id: 'no-unverified-slot-executed-on-power-cut',
      statement:
        'Every power-cut transition resumes an image whose boot decision is boot or ' +
        'recovery; no unverified slot is ever executed.',
      holds: allPowerCutEntries.every((entry) => !entry.executedUnverifiedSlot),
      basis: 'emulator-only',
      detail:
        `${allPowerCutEntries.length} (candidate, step) pairs checked; unverified slots ` +
        `executed: ${allPowerCutEntries.filter((entry) => entry.executedUnverifiedSlot).length}`,
    },
    {
      id: 'debug-lock-not-claimed',
      statement:
        'No debug-lock / fuse / physical-extraction claim is made: config ' +
        'debugFuseObserved is false because the corpus records ' +
        'emulator.debugLockProof=false and emulator.physicalFuseProof=false.',
      holds: cfg.debugFuseObserved === corpus.emulator.debugLockProof,
      basis: 'board-observed',
      detail:
        `debugFuseObserved=${cfg.debugFuseObserved} mirrors corpus ` +
        `emulator.debugLockProof=${corpus.emulator.debugLockProof}; the observed ` +
        'productionLockRegister is a different register and does not prove the debug fuse',
    },
  ];

  const runtime =
    typeof process !== 'undefined' && process.versions?.bun
      ? `bun ${process.versions.bun}`
      : `node ${process.version}`;

  return {
    schema: 'kory-eval/boot-evidence@1',
    board: corpus.board,
    generator: {
      script: 'scripts/generate-evidence.ts',
      runtime,
      simulatorPath: 'src/device-sim.ts',
      simulatorSha256: fileSha256(join(REPO_ROOT, 'src/device-sim.ts')),
      corpusPath: 'evidence/device-corpus.json',
      corpusSha256: fileSha256(join(REPO_ROOT, 'evidence/device-corpus.json')),
      configPath: '.kory-eval/boot-config.json',
      configSha256: fileSha256(join(REPO_ROOT, '.kory-eval/boot-config.json')),
    },
    config: cfg,
    claimBoundary: {
      boardObserved: [
        { fact: 'production key-hash fuse record value', corpusField: 'observed.keyHashFuseRecord' },
        { fact: 'production lock register read', corpusField: 'observed.productionLockRegister' },
        { fact: 'board emits a serial boot log', corpusField: 'observed.serialBootLog' },
      ],
      emulatorOnly: EMULATOR_ONLY,
      notClaimed: NOT_CLAIMED,
    },
    imageIndex,
    bootDecisions,
    powerCutRecovery: powerCutRecoveryEvidence,
    negativeControls: { recoveryAuthorizationBypass: bypass },
    invariants,
  };
}

/** Serialises evidence deterministically (2-space indent, trailing newline). */
export function serialiseEvidence(evidence: Evidence): string {
  return `${JSON.stringify(evidence, null, 2)}\n`;
}
