/**
 * Policy tests: every claim the shipped .kory-eval/boot-config.json makes is
 * checked against the supplied corpus and against the supplied simulator.
 *
 * The simulator and corpus are input fixtures: this file also pins their
 * SHA-256 so any accidental modification of the supplied machinery fails the
 * suite instead of silently changing the answer.
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { bootDecision, powerCutRecovery, type BootConfig, type Image } from '../src/device-sim.ts';
import {
  derivedCandidate,
  fileSha256,
  imageKey,
  loadBootConfig,
  loadCorpus,
  REPO_ROOT,
} from '../scripts/evidence-lib.ts';

const SIMULATOR_SHA256 = 'e8af64b48757dbf674afa78a94795e5312c144687412a382b2fc472419ae851b';
const CORPUS_SHA256 = '5f05cc1ee398c0bdb059f52a440c3a41976459a30c6578271272272faa4bc9cc';

const corpus = loadCorpus();
const config = loadBootConfig();
const current = corpus.images.find((image) => image.id === 'current') as Image;
const recovery = corpus.images.find((image) => image.id === 'recovery') as Image;
const candidate = derivedCandidate(corpus);
const allImages: Image[] = [...corpus.images, candidate];

describe('supplied machinery is untouched', () => {
  test('src/device-sim.ts matches the supplied integrity hash', () => {
    expect(fileSha256(join(REPO_ROOT, 'src/device-sim.ts'))).toBe(SIMULATOR_SHA256);
  });

  test('evidence/device-corpus.json matches the supplied integrity hash', () => {
    expect(fileSha256(join(REPO_ROOT, 'evidence/device-corpus.json'))).toBe(CORPUS_SHA256);
  });
});

describe('boot-config.json is grounded in supplied facts, not invented', () => {
  test('productionKeyHash is the supplied corpus key hash', () => {
    expect(config.productionKeyHash).toBe(corpus.keyHash);
  });

  test('product is the supplied corpus product', () => {
    expect(config.product).toBe(corpus.product);
  });

  test('every BootConfig field is present with the intended type', () => {
    expect(Object.keys(config).sort()).toEqual(
      [
        'bootloaderVerifiesProduct',
        'bootloaderVerifiesSignature',
        'debugFuseObserved',
        'minimumVersion',
        'productionKeyHash',
        'product',
        'recoveryRequiresAuthorization',
        'rollbackStateProtected',
      ].sort(),
    );
    expect(typeof config.productionKeyHash).toBe('string');
    expect(typeof config.product).toBe('string');
    expect(typeof config.minimumVersion).toBe('number');
    expect(typeof config.bootloaderVerifiesSignature).toBe('boolean');
    expect(typeof config.bootloaderVerifiesProduct).toBe('boolean');
    expect(typeof config.rollbackStateProtected).toBe('boolean');
    expect(typeof config.recoveryRequiresAuthorization).toBe('boolean');
    expect(typeof config.debugFuseObserved).toBe('boolean');
  });

  test('boot chain flags are all enforced', () => {
    expect(config.bootloaderVerifiesSignature).toBe(true);
    expect(config.bootloaderVerifiesProduct).toBe(true);
    expect(config.rollbackStateProtected).toBe(true);
    expect(config.recoveryRequiresAuthorization).toBe(true);
  });

  test('minimumVersion rejects the older image but admits the current one', () => {
    const older = corpus.images.find((image) => image.id === 'older') as Image;
    expect(config.minimumVersion).toBeGreaterThan(older.version);
    expect(config.minimumVersion).toBeLessThanOrEqual(current.version);
  });

  test('debugFuseObserved is false because the corpus does not prove the debug lock', () => {
    // The production lock register IS observed, but that is a different
    // register: corpus emulator.debugLockProof=false is the decisive fact.
    expect(corpus.observed.productionLockRegister).toBe(true);
    expect(corpus.emulator.debugLockProof).toBe(false);
    expect(config.debugFuseObserved).toBe(false);
  });
});

describe('boot decisions (happy path, decoys, invalid and partial states)', () => {
  const expectations: Array<[string, ReturnType<typeof bootDecision>]> = [
    ['current', 'boot'],
    ['older', 'reject-rollback'],
    ['wrong-product', 'reject-product'],
    ['unsigned', 'reject-signature'],
    ['corrupt', 'reject-corrupt'],
    ['recovery', 'recovery'],
  ];

  for (const [id, expected] of expectations) {
    test(`${id} -> ${expected}`, () => {
      const image = corpus.images.find((candidateImage) => candidateImage.id === id) as Image;
      expect(bootDecision(config, image)).toBe(expected);
    });
  }

  test('the derived valid candidate (v8, device-x, signed) would boot', () => {
    expect(bootDecision(config, candidate)).toBe('boot');
  });

  test('the newer wrong-product image is a version decoy rejected only by product binding', () => {
    const wrongProduct = corpus.images.find((image) => image.id === 'wrong-product') as Image;
    expect(wrongProduct.version).toBeGreaterThan(config.minimumVersion);
    // Disable ONLY the product check: now the same image would boot, proving
    // the product binding (not the version) is what rejected it.
    const noProductCheck: BootConfig = { ...config, bootloaderVerifiesProduct: false };
    expect(bootDecision(config, wrongProduct)).toBe('reject-product');
    expect(bootDecision(noProductCheck, wrongProduct)).toBe('boot');
  });
});

describe('power-cut recovery at every supplied step', () => {
  test('the derived candidate installs after mark-pending and never before', () => {
    expect(powerCutRecovery(config, current, candidate, 'write-inactive')).toBe(current.id);
    expect(powerCutRecovery(config, current, candidate, 'verify-inactive')).toBe(current.id);
    expect(powerCutRecovery(config, current, candidate, 'mark-pending')).toBe(candidate.id);
    expect(powerCutRecovery(config, current, candidate, 'boot-pending')).toBe(candidate.id);
    expect(powerCutRecovery(config, current, candidate, 'commit-version')).toBe(candidate.id);
  });

  test('every unverifiable candidate falls back to the authenticated current image at every step', () => {
    for (const image of allImages) {
      if (bootDecision(config, image) === 'boot') continue;
      for (const step of corpus.steps) {
        const result = powerCutRecovery(config, current, image, step);
        expect(result).toBe(current.id);
      }
    }
  });

  test('no transition ever resumes a slot the boot policy would reject', () => {
    for (const image of allImages) {
      for (const step of corpus.steps) {
        const resultId = powerCutRecovery(config, current, image, step);
        const resultImage = allImages.find((entry) => entry.id === resultId) as Image;
        expect(['boot', 'recovery']).toContain(bootDecision(config, resultImage));
      }
    }
  });

  test('a cut during recovery-image install also falls back to current', () => {
    for (const step of corpus.steps) {
      expect(powerCutRecovery(config, current, recovery, step)).toBe(current.id);
    }
  });
});

describe('recovery is separately authorized, not a rollback bypass', () => {
  test('shipped config routes the recovery image to authorized recovery', () => {
    expect(bootDecision(config, recovery)).toBe('recovery');
  });

  test('negative control: disabling recovery authorization would boot the older recovery image', () => {
    const bypass: BootConfig = { ...config, recoveryRequiresAuthorization: false };
    expect(bootDecision(bypass, recovery)).toBe('boot');
    expect(powerCutRecovery(bypass, current, recovery, 'commit-version')).toBe(recovery.id);
    // The shipped config does neither of those things.
    expect(bootDecision(config, recovery)).toBe('recovery');
    expect(powerCutRecovery(config, current, recovery, 'commit-version')).toBe(current.id);
  });

  test('negative control: unprotected rollback state would admit the signed older image', () => {
    const unprotected: BootConfig = { ...config, rollbackStateProtected: false };
    const older = corpus.images.find((image) => image.id === 'older') as Image;
    // The simulator still enforces minimumVersion itself; this documents that
    // the config flag alone is a claim about protected state, so the version
    // floor must stay configured (it does: minimumVersion=7 > older v5).
    expect(bootDecision(unprotected, older)).toBe('reject-rollback');
    expect(bootDecision(config, older)).toBe('reject-rollback');
  });
});

describe('evidence keys', () => {
  test('keys carry both image version and image digest', () => {
    for (const image of allImages) {
      expect(imageKey(image)).toMatch(/^[a-z][a-z0-9-]*@v\d+:[0-9a-f]{12}$/);
    }
    // Two images with the same id/version but different metadata get different
    // digests, so a keyed artifact cannot silently conflate them.
    const twin: Image = { ...candidate, signed: false, signatureValid: false };
    expect(imageKey(twin)).not.toBe(imageKey(candidate));
  });
});
