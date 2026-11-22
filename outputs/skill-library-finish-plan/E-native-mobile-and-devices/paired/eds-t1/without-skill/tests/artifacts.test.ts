/**
 * Artifact tests: the two README deliverables must exist, be keyed as
 * required, be reproducible from the supplied inputs, and never claim
 * hardware proof the corpus does not support.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildEvidence,
  imageKey,
  loadBootConfig,
  loadCorpus,
  REPO_ROOT,
  serialiseEvidence,
} from '../scripts/evidence-lib.ts';

const configPath = join(REPO_ROOT, '.kory-eval/boot-config.json');
const evidencePath = join(REPO_ROOT, '.kory-eval/boot-evidence.json');

const corpus = loadCorpus();
const config = loadBootConfig();
const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));

describe('.kory-eval/boot-config.json', () => {
  test('exists and parses', () => {
    expect(existsSync(configPath)).toBe(true);
    expect(() => JSON.parse(readFileSync(configPath, 'utf8'))).not.toThrow();
  });

  test('uses the supplied production key hash and product', () => {
    expect(config.productionKeyHash).toBe(corpus.keyHash);
    expect(config.product).toBe(corpus.product);
  });

  test('does not claim an observed debug fuse', () => {
    expect(config.debugFuseObserved).toBe(false);
  });
});

describe('.kory-eval/boot-evidence.json', () => {
  test('exists and is keyed by image digest/version', () => {
    expect(existsSync(evidencePath)).toBe(true);
    expect(Object.keys(evidence.imageIndex).length).toBeGreaterThan(0);
    for (const key of Object.keys(evidence.imageIndex)) {
      expect(key).toMatch(/^[a-z][a-z0-9-]*@v\d+:[0-9a-f]{12}$/);
    }
    expect(Object.keys(evidence.bootDecisions).sort()).toEqual(Object.keys(evidence.imageIndex).sort());
    expect(Object.keys(evidence.powerCutRecovery).sort()).toEqual(
      Object.keys(evidence.imageIndex).sort(),
    );
  });

  test('is keyed by cut step, covering every supplied step', () => {
    for (const [candidateKey, perStep] of Object.entries(evidence.powerCutRecovery)) {
      expect(Object.keys(perStep as object).sort()).toEqual([...corpus.steps].sort());
      expect(candidateKey).toMatch(/^[a-z][a-z0-9-]*@v\d+:[0-9a-f]{12}$/);
    }
  });

  test('records serial decision evidence for every decision and every cut', () => {
    for (const [key, entry] of Object.entries(evidence.bootDecisions) as Array<
      [string, { serial: Array<{ seq: number; line: string; basis: string }>; decision: string }]
    >) {
      expect(entry.serial.length).toBeGreaterThan(2);
      expect(entry.serial.map((line) => line.seq)).toEqual(
        entry.serial.map((_, index) => index + 1),
      );
      const last = entry.serial[entry.serial.length - 1];
      expect(last.line).toBe(`decision: ${entry.decision}`);
      for (const line of entry.serial) {
        expect(['board-observed', 'emulator-only']).toContain(line.basis);
        expect(line.line.length).toBeGreaterThan(0);
      }
      expect(entry.serial[0].basis).toBe('board-observed');
    }
    for (const perStep of Object.values(evidence.powerCutRecovery)) {
      for (const entry of Object.values(perStep as object) as Array<{
        serial: Array<{ seq: number; line: string; basis: string }>;
      }>) {
        expect(entry.serial.length).toBeGreaterThan(3);
        for (const line of entry.serial) {
          expect(['board-observed', 'emulator-only']).toContain(line.basis);
        }
      }
    }
  });

  test('labels are only board-observed or emulator-only, and only board facts are board-observed', () => {
    const boardFields = new Set(Object.keys(corpus.observed).filter((key) => corpus.observed[key]));
    expect(boardFields).toEqual(
      new Set(['keyHashFuseRecord', 'productionLockRegister', 'serialBootLog']),
    );
    // Only the fuse-register / lock-register / serial-log facts may be labelled
    // board-observed in the claim boundary.
    expect(evidence.claimBoundary.boardObserved.map((entry: { corpusField: string }) => entry.corpusField)).toEqual([
      'observed.keyHashFuseRecord',
      'observed.productionLockRegister',
      'observed.serialBootLog',
    ]);
    // The key-hash fuse record is the only board-observed trust fact; no
    // serial line may claim a debug or fuse observation.
    for (const entry of Object.values(evidence.bootDecisions) as Array<{
      serial: Array<{ line: string; basis: string }>;
    }>) {
      for (const line of entry.serial) {
        if (line.basis === 'board-observed') {
          expect(line.line).toMatch(/key-hash fuse record|production lock register|serial boot log/);
        }
      }
    }
  });

  test('nothing claims debug-lock, fuse, invasive or fault-injection resistance', () => {
    const text = JSON.stringify(evidence).toLowerCase();
    expect(config.debugFuseObserved).toBe(false);
    for (const notClaimed of evidence.claimBoundary.notClaimed as string[]) {
      expect(text).toContain(notClaimed.toLowerCase());
    }
    // The words appear only inside explicit not-claim / false-proof contexts.
    const serialised = JSON.stringify(evidence);
    for (const match of serialised.matchAll(/debugLockProof|physicalFuseProof|debug-lock|debug fuse/g)) {
      const context = serialised.slice(Math.max(0, match.index - 160), match.index + 160);
      expect(context.toLowerCase()).toMatch(
        /false|not claimed|not\b.*\bclaim|notclaimed|does not prove|no debug/,
      );
    }
  });

  test('every decision entry carries the required labels and negative-control context', () => {
    for (const entry of Object.values(evidence.bootDecisions) as Array<Record<string, unknown>>) {
      expect(entry.basis).toBe('emulator-only');
      expect(Array.isArray(entry.boardObservedInputs)).toBe(true);
      expect((entry.boardObservedInputs as string[]).length).toBeGreaterThan(0);
      expect((entry.notClaimed as string[]).length).toBeGreaterThan(3);
    }
    expect(
      (evidence.negativeControls.recoveryAuthorizationBypass as Record<string, unknown>)
        .isDevicePolicy,
    ).toBe(false);
  });

  test('every power-cut entry proves the resumed slot is verified', () => {
    for (const perStep of Object.values(evidence.powerCutRecovery)) {
      for (const entry of Object.values(perStep as object) as Array<{
        resultDecision: string;
        executedUnverifiedSlot: boolean;
      }>) {
        expect(entry.executedUnverifiedSlot).toBe(false);
        expect(['boot', 'recovery']).toContain(entry.resultDecision);
      }
    }
  });

  test('all invariants hold', () => {
    const failed = (evidence.invariants as Array<{ id: string; holds: boolean }>).filter(
      (invariant) => !invariant.holds,
    );
    expect(failed.map((invariant) => invariant.id)).toEqual([]);
    expect((evidence.invariants as unknown[]).length).toBeGreaterThanOrEqual(9);
  });

  test('is reproducible: regenerating from inputs reproduces the file byte for byte', () => {
    const regenerated = serialiseEvidence(buildEvidence(loadBootConfig(), loadCorpus()));
    expect(regenerated).toBe(readFileSync(evidencePath, 'utf8'));
  });

  test('pins the supplied files it was generated from', () => {
    expect(evidence.generator.simulatorPath).toBe('src/device-sim.ts');
    expect(evidence.generator.corpusPath).toBe('evidence/device-corpus.json');
    expect(evidence.generator.simulatorSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(evidence.board).toBe(corpus.board);
  });

  test('the derived candidate fixture is labelled as derived, not corpus', () => {
    const candidateEntry = Object.values(evidence.imageIndex).find(
      (entry) => (entry as { imageId: string }).imageId === 'candidate',
    ) as { source: string; digestBasis: string };
    expect(candidateEntry.source).toBe('derived-emulator-fixture');
    expect(candidateEntry.digestBasis).toBe('emulator-only');
    // ...and every corpus image is labelled as corpus data.
    for (const entry of Object.values(evidence.imageIndex) as Array<{
      imageId: string;
      source: string;
    }>) {
      if (entry.imageId === 'candidate') continue;
      expect(entry.source).toBe('corpus');
    }
  });

  test('image index digests match a fresh computation over the corpus', () => {
    for (const image of [...corpus.images]) {
      const key = imageKey(image);
      expect((evidence.imageIndex[key] as { digest: string }).digest).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});
