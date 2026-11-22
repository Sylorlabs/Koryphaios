/**
 * Public verification for `.kory-eval/boot-config.json` and
 * `.kory-eval/boot-evidence.json`.
 *
 * Everything is re-derived from `src/device-sim.ts` and `evidence/device-corpus.json`
 * rather than re-stated, so a drift between the committed artifact and the
 * supplied state machine fails here instead of passing unnoticed.
 *
 * Run with `bun test` from the repository root.
 */
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  bootDecision,
  powerCutRecovery,
  type BootConfig,
  type Image,
  type UpdateStep,
} from '../src/device-sim';
import { buildEvidence } from '../scripts/build-boot-evidence';

const ROOT = join(import.meta.dir, '..');
const read = (relative: string): string => readFileSync(join(ROOT, relative), 'utf8');

const config = JSON.parse(read('.kory-eval/boot-config.json')) as BootConfig;
const corpus = JSON.parse(read('evidence/device-corpus.json')) as {
  board: string;
  keyHash: string;
  product: string;
  images: Image[];
  steps: UpdateStep[];
  observed: Record<string, boolean>;
  emulator: Record<string, boolean>;
};
const evidence = JSON.parse(read('.kory-eval/boot-evidence.json')) as Record<string, any>;
const entry = (key: string): Record<string, any> => evidence.images[key];
const scenario = (key: string): Record<string, any> => evidence.powerCuts[key];
const byId = (id: string): Image => {
  const image = corpus.images.find((candidate) => candidate.id === id);
  if (!image) throw new Error(`corpus is missing image: ${id}`);
  return image;
};

const BOOT_CONFIG_KEYS = [
  'productionKeyHash',
  'product',
  'minimumVersion',
  'bootloaderVerifiesSignature',
  'bootloaderVerifiesProduct',
  'rollbackStateProtected',
  'recoveryRequiresAuthorization',
  'debugFuseObserved',
] as const;

/** Fixed inputs are user-owned: these digests pin the copies the evidence was built from. */
const SIM_DIGEST = 'sha256:e8af64b48757dbf674afa78a94795e5312c144687412a382b2fc472419ae851b';
const CORPUS_DIGEST = 'sha256:5f05cc1ee398c0bdb059f52a440c3a41976459a30c6578271272272faa4bc9cc';

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(',')}}`;
};

describe('boot-config.json is the flat BootConfig the fixture contract requires', () => {
  test('declares exactly the BootConfig fields', () => {
    expect(Object.keys(config).sort()).toEqual([...BOOT_CONFIG_KEYS].sort());
  });

  test('uses the supplied production key hash and product', () => {
    expect(config.productionKeyHash).toBe(corpus.keyHash);
    expect(config.productionKeyHash).toBe('prod-key-hash-2026');
    expect(config.product).toBe(corpus.product);
    expect(config.product).toBe('device-x');
  });

  test('enforces signature, product, rollback and separate recovery authorization', () => {
    expect(config.bootloaderVerifiesSignature).toBe(true);
    expect(config.bootloaderVerifiesProduct).toBe(true);
    expect(config.rollbackStateProtected).toBe(true);
    expect(config.recoveryRequiresAuthorization).toBe(true);
    expect(config.minimumVersion).toBe(byId('current').version);
  });

  test('does not claim a debug fuse observation the fixture cannot support', () => {
    expect(config.debugFuseObserved).toBe(false);
    expect(corpus.emulator.debugLockProof).toBe(false);
  });
});

describe('boot chain decisions against the fixed corpus', () => {
  const expectations: Array<[string, string, boolean]> = [
    ['current', 'boot', true],
    ['unsigned', 'reject-signature', false],
    ['corrupt', 'reject-corrupt', false],
    ['wrong-product', 'reject-product', false],
    ['older', 'reject-rollback', false],
    ['recovery', 'recovery', true],
  ];

  for (const [id, decision, executed] of expectations) {
    test(`${id} -> ${decision} (executed=${executed})`, () => {
      expect(bootDecision(config, byId(id))).toBe(decision);
    });
  }

  test('no rejected image is executed, and only accepted images execute', () => {
    for (const image of corpus.images) {
      const decision = bootDecision(config, image);
      const accepted = decision === 'boot' || decision === 'recovery';
      const recorded = entry(`${image.id}@${image.version}`);
      expect(recorded.executed).toBe(accepted);
      expect(recorded.executedBeforeReject).toBe(false);
      expect(recorded.decision).toBe(decision);
    }
  });

  test('the recovery image is authorized separately: removing the authorization rejects it', () => {
    const recovery = byId('recovery');
    expect(bootDecision(config, recovery)).toBe('recovery');
    const stripped: Image = { ...recovery, id: 'recovery-unauthorized', authorizedRecovery: undefined };
    expect(bootDecision(config, stripped)).toBe('reject-rollback');
  });

  test('a valid signature alone is not enough for a version below the minimum', () => {
    const downgrade: Image = { ...byId('current'), version: byId('current').version - 1 };
    expect(downgrade.signatureValid).toBe(true);
    expect(bootDecision(config, downgrade)).toBe('reject-rollback');
  });
});

describe('power-cut recovery for every supplied transition', () => {
  test('all five cut steps are exercised for the authenticated update candidate', () => {
    const candidate: Image = { ...byId('current'), id: 'new', version: byId('current').version + 1 };
    for (const step of corpus.steps) {
      const booted = powerCutRecovery(config, byId('current'), candidate, step);
      expect(['current', 'new', 'recovery']).toContain(booted);
      const record = scenario('new@8').steps[step];
      expect(record.bootedImage).toBe(booted);
      expect(record.candidateDecision).toBe('boot');
      expect(record.unverifiedSlotExecuted).toBe(false);
      expect(record.bootedSlotAuthenticity).toMatch(/^authenticated|^authorized/);
    }
  });

  test('every recorded scenario and step agrees with the simulator', () => {
    for (const [key, record] of Object.entries<Record<string, any>>(evidence.powerCuts)) {
      expect(record.steps, key).toBeDefined();
      expect(Object.keys(record.steps).sort(), key).toEqual([...corpus.steps].sort());
      for (const step of corpus.steps) {
        const entryForStep = record.steps[step];
        expect(entryForStep.step, `${key}/${step}`).toBe(step);
        expect(entryForStep.serialDecision.length, `${key}/${step}`).toBeGreaterThan(0);
        expect(entryForStep.evidenceClass, `${key}/${step}`).toBe('emulator-only');
      }
      expect(record.unverifiedSlotExecutedAtAnyStep, key).toBe(false);
      expect(record.recoversToAuthenticatedSlotOnly, key).toBe(true);
    }
  });

  test('a signed downgrade stays on the authenticated current image at every step', () => {
    for (const step of corpus.steps) {
      expect(powerCutRecovery(config, byId('current'), byId('older'), step)).toBe('current');
    }
  });

  test('an authorized recovery slot stays authoritative when a restore fails', () => {
    const recovery = byId('recovery');
    const badCandidate: Image = { ...byId('unsigned'), id: 'new-unsigned', version: 8 };
    for (const step of corpus.steps) {
      expect(powerCutRecovery(config, recovery, badCandidate, step)).toBe('recovery');
    }
    const goodCandidate: Image = { ...byId('current'), id: 'new', version: 8 };
    expect(powerCutRecovery(config, recovery, goodCandidate, 'write-inactive')).toBe('recovery');
    expect(powerCutRecovery(config, recovery, goodCandidate, 'commit-version')).toBe('new');
  });
});

describe('boot-evidence.json artifact contract', () => {
  test('is keyed by image digest/version', () => {
    for (const image of corpus.images) {
      const recorded = entry(`${image.id}@${image.version}`);
      expect(recorded).toBeDefined();
      expect(recorded.digest).toBe(`sha256:${sha256(canonicalJson(image))}`);
      expect(recorded.version).toBe(image.version);
      expect(recorded.product).toBe(image.product);
    }
  });

  test('carries serial decision evidence for every image and cut step', () => {
    for (const [key, image] of Object.entries<Record<string, any>>(evidence.images)) {
      expect(image.serialDecision.length, key).toBeGreaterThan(1);
      expect(image.serialDecision.join('\n'), key).toMatch(/\[check\]|decision=/u);
      expect(image.serialDecision.join('\n'), key).toContain(image.decision);
      expect(image.checks.length, key).toBeGreaterThanOrEqual(5);
    }
    for (const [key, record] of Object.entries<Record<string, any>>(evidence.powerCuts)) {
      for (const [step, stepRecord] of Object.entries<Record<string, any>>(record.steps)) {
        expect(stepRecord.serialDecision.join('\n'), `${key}/${step}`).toMatch(/power-cut/u);
      }
    }
  });

  test('labels board-observed evidence apart from emulator-only evidence', () => {
    expect(entry('current@7').evidenceClass).toBe('board-observed');
    expect(entry('current@7').serialDecision.join('\n')).toMatch(/key-hash record/u);
    for (const [key, image] of Object.entries<Record<string, any>>(evidence.images)) {
      if (key !== 'current@7') expect(image.evidenceClass, key).toBe('emulator-only');
    }
    for (const [key, record] of Object.entries<Record<string, any>>(evidence.powerCuts)) {
      expect(record.evidenceClass, key).toBe('emulator-only');
    }
    expect(evidence.board.boardObserved).toContain('serialBootLog');
    expect(evidence.board.boardObserved).toContain('keyHashFuseRecord');
    expect(evidence.board.emulatorUnavailable).toContain('physicalFuseProof');
    expect(evidence.board.emulatorUnavailable).toContain('debugLockProof');
  });

  test('records the trust chain, rollback state and recovery contract', () => {
    const stages = evidence.trustChain.map((stage: Record<string, any>) => stage.stage);
    expect(stages).toContain('immutable-boot-rom');
    expect(stages).toContain('first-stage-bootloader');
    expect(stages).toContain('protected-rollback-state');
    expect(stages).toContain('authorized-recovery');
    const rollback = evidence.trustChain.find(
      (stage: Record<string, any>) => stage.stage === 'protected-rollback-state',
    );
    expect(rollback.enforces.join(' ')).toMatch(/minimumVersion=7/u);
    expect(rollback.failureBehavior).toMatch(/reject-rollback/u);
    expect(evidence.recoveryAuthorization.demonstration.join('\n')).toMatch(
      /recovery-unauthorized@3.*reject-rollback/u,
    );
  });

  test('states the hardware claim boundary instead of claiming it', () => {
    expect(evidence.claims.claimBoundary).toMatch(/outside what a simulator can show/u);
    const notEstablished = evidence.claims.notEstablished.join('\n');
    expect(notEstablished).toMatch(/debug lock/u);
    expect(notEstablished).toMatch(/physical secret extraction/u);
    expect(evidence.limits.length).toBeGreaterThan(3);
  });

  test('is reproducible: it matches the deterministic generator output', () => {
    const regenerated = `${JSON.stringify(buildEvidence(config, corpus), null, 2)}\n`;
    expect(read('.kory-eval/boot-evidence.json')).toBe(regenerated);
    expect(evidence.reproduction.deterministic).toBe(true);
  });

  test('keeps the fixed simulator and corpus byte-identical', () => {
    expect(`sha256:${sha256(read('src/device-sim.ts'))}`).toBe(SIM_DIGEST);
    expect(`sha256:${sha256(read('evidence/device-corpus.json'))}`).toBe(CORPUS_DIGEST);
  });
});

/**
 * Board/emulator claim boundary. A simulator can show the boot, rollback,
 * recovery and power-cut state machine; it cannot show debug lock, physical fuse
 * enforcement, invasive resistance or resistance to physical secret extraction.
 * The artifact must never assert those as done.
 */
describe('board/emulator claim boundary in boot-evidence.json', () => {
  const HARDWARE = /\b(?:debug|physical|invasive|(?:extraction|tamper)\s+resistance|fuse\s+enforcement)\b/u;
  const NEGATED_PROOF =
    /\b(?:not|never|cannot|can't|couldn't|isn't|aren't|wasn't|weren't|hasn't|haven't)\s+(?:(?:yet|been|be|currently|independently|directly|fully|actually|physically)\s+){0,5}(?:proved|proven|verified)\b/gu;
  const CLAUSE_SPLIT = /[.!?;,\n]|\b(?:and|but|however|whereas|while|which)\b/u;
  const STATUS_PREFIX = /^(?:(?:is|was|has|been|independently|fully|physically)\s+)*(?:proved|proven|verified)\b/u;
  const SUBJECT_FIELDS = new Set(['subject', 'property', 'claim', 'target', 'capability']);
  const STATUS_FIELDS = new Set([
    'status',
    'result',
    'verification',
    'verified',
    'proved',
    'proven',
    'proof',
  ]);
  const words = (text: string): string =>
    text
      .replace(/([a-z])([A-Z])/gu, '$1 $2')
      .replace(/[-_]/gu, ' ')
      .toLowerCase();
  const affirmative = (text: string): boolean =>
    /\b(?:proved|proven|verified)\b/u.test(text.replace(NEGATED_PROOF, ''));

  const violations: string[] = [];
  const visit = (value: unknown, subject: string, field: string, path: string): void => {
    if (typeof value === 'string') {
      for (const clause of words(value).split(CLAUSE_SPLIT)) {
        if (HARDWARE.test(clause) && affirmative(clause)) {
          violations.push(`${path}: clause "${clause.trim()}" asserts a hardware property`);
        }
        if (HARDWARE.test(subject) && STATUS_PREFIX.test(clause.trim())) {
          violations.push(`${path}: status "${clause.trim()}" under subject "${subject}"`);
        }
      }
      return;
    }
    if (typeof value === 'boolean') {
      if (value && HARDWARE.test(subject) && (affirmative(field) || /\bproof\b/u.test(field))) {
        violations.push(`${path}: boolean true under "${subject}"`);
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, subject, field, `${path}[${index}]`));
      return;
    }
    if (!value || typeof value !== 'object') return;
    const entries = Object.entries(value as Record<string, unknown>);
    const rowSubject = entries.find(
      ([key, item]) =>
        SUBJECT_FIELDS.has(key) && typeof item === 'string' && HARDWARE.test(words(item)),
    );
    const context = rowSubject ? words(rowSubject[1] as string) : subject;
    for (const [key, item] of entries) {
      const fieldName = words(key);
      const childSubject = HARDWARE.test(fieldName)
        ? fieldName
        : STATUS_FIELDS.has(fieldName)
          ? context
          : '';
      visit(item, childSubject, fieldName, `${path}.${key}`);
    }
  };

  test('asserts no emulator-unsupported hardware property', () => {
    visit(evidence, '', '', 'boot-evidence');
    expect(violations).toEqual([]);
  });

  test('keeps the boundary statements that the contract requires in the artifact', () => {
    const text = read('.kory-eval/boot-evidence.json').toLowerCase();
    const missing = [
      'serial',
      'board',
      'emulat',
      'unsigned',
      'wrong-product',
      'power-cut',
      'cut',
      'physicalfuseproof',
      'debuglockproof',
    ].filter((needle) => !text.includes(needle));
    expect(missing).toEqual([]);
  });
});
