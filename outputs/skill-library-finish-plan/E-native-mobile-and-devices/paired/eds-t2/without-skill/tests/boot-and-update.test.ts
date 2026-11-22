/**
 * Verification of the boot, rollback, recovery and power-cut behaviour that the
 * interface and credential policy depends on.
 *
 * Every decision comes from the supplied `src/device-sim.ts` state machine and
 * the fixed corpus; derived fixtures are constructed in memory and labelled.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bootDecision, powerCutRecovery, type BootConfig, type Image } from '../src/device-sim';
import {
  checkOutcomes,
  imageEntry,
  powerCutScenario,
  powerCutStep,
  resolvedEnvironmentFacts,
  serialDecision,
  trustChain,
} from '../scripts/boot-and-update';
import {
  type AuthoredDeviceConfig,
  type Corpus,
  corpusImage,
  deriveBootPolicy,
  readCorpus,
} from '../scripts/kory-artifact';

const corpus: Corpus = readCorpus();
const config = JSON.parse(
  readFileSync(join(import.meta.dir, '..', '.kory-eval/device-config.json'), 'utf8'),
) as AuthoredDeviceConfig;
const policy: BootConfig = deriveBootPolicy(corpus, config);

const current = corpusImage(corpus, 'current');
const older = corpusImage(corpus, 'older');
const wrongProduct = corpusImage(corpus, 'wrong-product');
const unsigned = corpusImage(corpus, 'unsigned');
const corrupt = corpusImage(corpus, 'corrupt');
const recovery = corpusImage(corpus, 'recovery');
const candidate: Image = { ...current, id: 'update-candidate', version: current.version + 1 };
const recoveryUnauthorized: Image = {
  ...recovery,
  id: 'recovery-unauthorized',
  authorizedRecovery: undefined,
};

describe('the boot chain enforces authenticity, product and freshness', () => {
  const expectations: Array<[string, Image, string, boolean]> = [
    ['the board-observed current image boots', current, 'boot', true],
    ['the correctly signed older image is a rollback', older, 'reject-rollback', false],
    ['an image signed for another product is rejected', wrongProduct, 'reject-product', false],
    ['an unsigned image is rejected before product and version', unsigned, 'reject-signature', false],
    ['a corrupt slot is rejected first', corrupt, 'reject-corrupt', false],
    ['the authorized recovery image enters recovery', recovery, 'recovery', true],
  ];

  for (const [title, image, decision, executed] of expectations) {
    test(`${title} -> ${decision}`, () => {
      expect(bootDecision(policy, image)).toBe(decision);
      const entry = imageEntry(policy, corpus, image, 'simulation', []);
      expect(entry.executed).toBe(executed);
      expect(entry.executedBeforeReject).toBe(false);
    });
  }

  test('no rejected image is ever executed', () => {
    for (const image of corpus.images) {
      const decision = bootDecision(policy, image);
      expect(decision === 'boot' || decision === 'recovery', image.id).toBe(
        decision !== 'reject-signature' && decision !== 'reject-product' && decision !== 'reject-rollback' && decision !== 'reject-corrupt',
      );
    }
  });

  test('checks are reported in evaluation order and stop at the failing gate', () => {
    const entry = imageEntry(policy, corpus, corrupt, 'simulation', []);
    expect(entry.checks.map((check) => check.check)).toEqual([
      'integrity',
      'signature',
      'product-binding',
      'rollback-version',
      'recovery-authorization',
    ]);
    expect(entry.checks[0].result).toBe('fail');
    expect(entry.serialDecision.join('\n')).toContain('reject-corrupt');
    expect(entry.serialDecision.length).toBe(4);
  });

  test('the serial trace carries the key-hash anchor and the decision', () => {
    const lines = serialDecision(policy, corpus, current).join('\n');
    expect(lines).toContain(corpus.keyHash);
    expect(lines).toContain('decision=boot');
    expect(lines).toContain('integrity: pass');
  });
});

describe('recovery is a separate authorization, not a rollback bypass', () => {
  test('the supplied recovery image is accepted only with its authorization', () => {
    expect(bootDecision(policy, recovery)).toBe('recovery');
    expect(bootDecision(policy, recoveryUnauthorized)).toBe('reject-rollback');
  });

  test('the counterfactual is a derived fixture, not a corpus edit', () => {
    const entry = imageEntry(policy, corpus, recoveryUnauthorized, 'simulation', []);
    expect(entry.source).toBe('derived');
    expect(corpus.images.some((image) => image.id === 'recovery-unauthorized')).toBe(false);
  });

  test('recovery authorization is required by policy', () => {
    expect(policy.recoveryRequiresAuthorization).toBe(config.authorizedRecoveryOnly);
    expect(config.authorizedRecoveryOnly).toBe(true);
  });
});

describe('update interruption recovers to an authenticated slot', () => {
  test('all five supplied cut steps keep the device on an authenticated slot', () => {
    for (const step of corpus.steps) {
      const record = powerCutStep(policy, current, candidate, step);
      expect(record.unverifiedSlotExecuted, step).toBe(false);
      expect(record.bootedSlotAuthenticity, step).toMatch(/^authenticated|^authorized/u);
      if (step === 'write-inactive' || step === 'verify-inactive') {
        expect(record.bootedImage, step).toBe(current.id);
      } else {
        expect(record.bootedImage, step).toBe(candidate.id);
      }
    }
  });

  test('the simulator and the recorded step agree for every scenario', () => {
    const scenarios: Array<[string, Image, Image]> = [
      ['downgrade', current, older],
      ['wrong-product', current, wrongProduct],
      ['unsigned', current, unsigned],
      ['corrupt', current, corrupt],
      ['recovery-as-candidate', current, recovery],
      ['restore-from-recovery', recovery, candidate],
      ['unsigned-while-in-recovery', recovery, { ...unsigned, id: 'unsigned-candidate', version: 8 }],
      ['authorization-removed', current, recoveryUnauthorized],
    ];
    for (const [title, active, candidateImage] of scenarios) {
      const scenario = powerCutScenario(policy, corpus, title, active, candidateImage, []);
      expect(scenario.steps.length, title).toBe(corpus.steps.length);
      expect(scenario.unverifiedSlotExecutedAtAnyStep, title).toBe(false);
      expect(scenario.recoversToAuthenticatedSlotOnly, title).toBe(true);
      for (const step of corpus.steps) {
        expect(powerCutRecovery(policy, active, candidateImage, step), `${title}/${step}`).toBe(
          scenario.steps.find((entry) => entry.step === step)?.bootedImage,
        );
      }
    }
  });

  test('a failed update from authorized recovery falls back to an authorized state', () => {
    const bad: Image = { ...unsigned, id: 'unsigned-candidate', version: 8 };
    expect(powerCutRecovery(policy, recovery, bad, 'commit-version')).toBe(recovery.id);
    expect(powerCutRecovery(policy, recovery, candidate, 'write-inactive')).toBe(recovery.id);
    expect(powerCutRecovery(policy, recovery, candidate, 'commit-version')).toBe(candidate.id);
  });

  test('a signed downgrade never becomes the booted slot', () => {
    for (const step of corpus.steps) {
      expect(powerCutRecovery(policy, current, older, step), step).toBe(current.id);
    }
  });
});

describe('environment facts that change the answer are resolved and demonstrated', () => {
  const resolved = resolvedEnvironmentFacts(corpus, config);

  test('the resolved policy binds the corpus key hash and product', () => {
    expect(policy.productionKeyHash).toBe(corpus.keyHash);
    expect(policy.product).toBe(corpus.product);
    expect(policy.bootloaderVerifiesSignature).toBe(true);
    expect(policy.bootloaderVerifiesProduct).toBe(true);
    expect(policy.rollbackStateProtected).toBe(true);
  });

  test('the minimum-version ambiguity is resolved to the deployed version', () => {
    expect(policy.minimumVersion).toBe(current.version);
    expect(resolved.minimumVersionDemonstration.resolvedPolicyDecision).toBe('reject-rollback');
    const counterfactual: BootConfig = { ...policy, minimumVersion: older.version };
    expect(resolved.minimumVersionDemonstration.counterfactualPolicyDecision).toBe(
      bootDecision(counterfactual, older),
    );
    expect(bootDecision(counterfactual, older)).toBe('boot');
    expect(checkOutcomes(policy, older)[3].result).toBe('fail');
  });

  test('no debug-lock observation is claimed from the emulator', () => {
    expect(policy.debugFuseObserved).toBe(false);
    expect(corpus.emulator.debugLockProof).toBe(false);
    expect(corpus.emulator.physicalFuseProof).toBe(false);
  });

  test('the trust chain records the immutable root and the protected rollback state', () => {
    const stages = trustChain(policy, corpus);
    expect(stages.map((stage) => String(stage.stage))).toEqual([
      'immutable-boot-rom',
      'first-stage-bootloader',
      'protected-rollback-state',
      'authorized-recovery',
      'application',
    ]);
    const rollback = stages.find((stage) => stage.stage === 'protected-rollback-state');
    expect(String(rollback?.enforces)).toContain(`minimumVersion=${policy.minimumVersion}`);
    expect(String(rollback?.failureBehavior)).toContain('reject-rollback');
  });
});
