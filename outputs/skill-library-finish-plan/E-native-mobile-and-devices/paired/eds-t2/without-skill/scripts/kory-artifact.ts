/**
 * Shared, side-effect-light helpers for the Koryphaios device-lifecycle
 * artifacts.
 *
 * Everything here is deterministic: no clock, no randomness, no network. The
 * builders in `scripts/build-lifecycle-evidence.ts` and
 * `scripts/build-threat-model.ts` use these helpers so that re-running them on
 * an unchanged tree reproduces byte-identical artifacts, which is what
 * `tests/evidence-artifacts.test.ts` asserts.
 *
 * The supplied fixture files (`src/device-sim.ts`, `evidence/device-corpus.json`)
 * are read only. They are user-owned inputs and are never rewritten.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { BootConfig, DeviceConfig, Image, UpdateStep } from '../src/device-sim';

export const ROOT = join(import.meta.dir, '..');
export const CONFIG_PATH = join(ROOT, '.kory-eval/device-config.json');
export const EVIDENCE_PATH = join(ROOT, '.kory-eval/device-lifecycle-evidence.json');
export const ANALYSIS_PATH = join(ROOT, '.kory-eval/threat-model.md');
export const CORPUS_PATH = join(ROOT, 'evidence/device-corpus.json');
export const SIM_PATH = join(ROOT, 'src/device-sim.ts');

/** Shape of the fixed board corpus. Read, never written. */
export interface Corpus {
  board: string;
  keyHash: string;
  product: string;
  images: Image[];
  steps: UpdateStep[];
  observed: Record<string, boolean>;
  emulator: Record<string, boolean>;
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

export function readCorpus(): Corpus {
  return JSON.parse(readFileSync(CORPUS_PATH, 'utf8')) as Corpus;
}

/**
 * The authored policy. Reads as `DeviceConfig`; the `binding` block is extra
 * context this fixture resolves, not part of the supplied interface.
 */
export interface AuthoredDeviceConfig extends DeviceConfig {
  binding: {
    board: string;
    product: string;
    productionKeyHash: string;
    applicationVersion: number;
    minimumVersion: number;
    corpusObservedOnHardware: string[];
    emulatorCannotProve: string[];
    authorityTokenGrammar: string;
  };
}

export function readConfig(): AuthoredDeviceConfig {
  return JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as AuthoredDeviceConfig;
}

export function corpusImage(corpus: Corpus, id: string): Image {
  const image = corpus.images.find((candidate) => candidate.id === id);
  if (!image) throw new Error(`corpus is missing required image: ${id}`);
  return image;
}

export function writeArtifact(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/**
 * Evidence labels used throughout the artifacts. A label is attached to every
 * factual statement so a reader can tell what was seen on hardware from what is
 * documentation or simulator behaviour.
 */
export type EvidenceLabel = 'hardware-observed' | 'documentation' | 'simulation';

export const LABEL_DEFINITIONS: Record<EvidenceLabel, string> = {
  'hardware-observed':
    'read off the representative board and recorded in the supplied corpus (corpus.observed), or a register read the fixture contract states was taken on that board',
  documentation:
    'supplied by the fixture README, the device-data-sheet policy it describes, or the authored production policy in .kory-eval/device-config.json; not a measurement',
  simulation:
    'computed by the supplied src/device-sim.ts state machine or by this repository\'s own lifecycle model; proves state-machine logic, not silicon behaviour',
};

/**
 * A derived BootConfig used only to exercise the supplied boot/update state
 * machine for this lifecycle artifact. It is not the t1 BootConfig artifact:
 * nothing here is written as `.kory-eval/boot-config.json`.
 */
export function deriveBootPolicy(corpus: Corpus, config: AuthoredDeviceConfig): BootConfig {
  return {
    productionKeyHash: corpus.keyHash,
    product: corpus.product,
    minimumVersion: corpusImage(corpus, 'current').version,
    bootloaderVerifiesSignature: true,
    bootloaderVerifiesProduct: true,
    rollbackStateProtected: true,
    recoveryRequiresAuthorization: config.authorizedRecoveryOnly,
    // The corpus records emulator.debugLockProof=false, so no debug-lock
    // observation is claimed even though productionLockRegister is observed.
    debugFuseObserved: false,
  };
}
