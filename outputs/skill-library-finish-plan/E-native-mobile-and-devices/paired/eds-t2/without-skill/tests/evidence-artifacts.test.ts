/**
 * Verification of the committed artifacts themselves.
 *
 * Three things are checked:
 *  1. reproducibility — the artifacts are byte-identical to what the generators
 *     produce on an unchanged tree, so no claim in them can drift;
 *  2. labels — every section carries a hardware-observed / documentation /
 *     simulation label, and the two readings are never blended;
 *  3. the claim boundary — no artifact asserts a hardware property this fixture
 *     cannot show (debug-lock, physical fuse enforcement, invasive or
 *     fault-injection resistance), and the fixed simulator and corpus are still
 *     byte-identical.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { buildEvidence } from '../scripts/build-lifecycle-evidence';
import { buildAnalysis } from '../scripts/build-threat-model';
import { readConfig, readCorpus } from '../scripts/kory-artifact';

const ROOT = join(import.meta.dir, '..');
const read = (relative: string): string => readFileSync(join(ROOT, relative), 'utf8');
const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** Content digests pinning the user-owned fixture inputs. */
const SIM_DIGEST = 'sha256:e8af64b48757dbf674afa78a94795e5312c144687412a382b2fc472419ae851b';
const CORPUS_DIGEST = 'sha256:5f05cc1ee398c0bdb059f52a440c3a41976459a30c6578271272272faa4bc9cc';

const evidence = JSON.parse(read('.kory-eval/device-lifecycle-evidence.json')) as Record<string, any>;
const analysis = read('.kory-eval/threat-model.md');

/**
 * A simulator can show state machines; it cannot show fuse state, debug lock,
 * physical extraction resistance or power-fail behaviour. An artifact must
 * never turn one of those into an accomplished hardware fact.
 */
function hasUnsupportedHardwareClaim(artifact: unknown): string[] {
  const words = (text: string): string =>
    text
      .replace(/([a-z])([A-Z])/gu, '$1 $2')
      .replace(/[-_]/gu, ' ')
      .toLowerCase();
  const hardware = /\b(?:debug|physical|invasive|(?:extraction|tamper)\s+resistance|fuse\s+enforcement)\b/u;
  const affirmative = (text: string): boolean => {
    const positive = text.replace(
      /\b(?:not|never|cannot|can't|couldn't|isn't|aren't|wasn't|weren't|hasn't|haven't)\s+(?:(?:yet|been|be|currently|independently|directly|fully|actually|physically)\s+){0,5}(?:proved|proven|verified)\b/gu,
      '',
    );
    return /\b(?:proved|proven|verified)\b/u.test(positive);
  };
  const clauses = (text: string): string[] =>
    text.split(/[.!?;,\n]|\b(?:and|but|however|whereas|while|which)\b/u);
  const status = /^(?:(?:is|was|has|been|independently|fully|physically)\s+)*(?:proved|proven|verified)\b/u;
  const subjectFields = new Set(['subject', 'property', 'claim', 'target', 'capability']);
  const statusFields = new Set([
    'status',
    'result',
    'verification',
    'verified',
    'proved',
    'proven',
    'proof',
  ]);
  const violations: string[] = [];
  const visit = (value: unknown, subject: string, field: string, path: string): void => {
    if (typeof value === 'string') {
      for (const clause of clauses(words(value))) {
        if (hardware.test(clause) && affirmative(clause)) {
          violations.push(`${path}: "${clause.trim()}" asserts a hardware property`);
        }
        if (hardware.test(subject) && status.test(clause.trim())) {
          violations.push(`${path}: status "${clause.trim()}" under "${subject}"`);
        }
      }
      return;
    }
    if (typeof value === 'boolean') {
      if (value && hardware.test(subject) && (affirmative(field) || /\bproof\b/u.test(field))) {
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
        subjectFields.has(key) && typeof item === 'string' && hardware.test(words(item)),
    );
    const context = rowSubject ? words(rowSubject[1] as string) : subject;
    for (const [key, item] of entries) {
      const fieldName = words(key);
      const childSubject = hardware.test(fieldName) ? fieldName : statusFields.has(fieldName) ? context : '';
      visit(item, childSubject, fieldName, `${path}.${key}`);
    }
  };
  visit(artifact, '', '', 'evidence');
  return violations;
}

describe('the artifacts are reproducible from their generators', () => {
  test('device-lifecycle-evidence.json matches the deterministic builder', () => {
    const regenerated = `${JSON.stringify(buildEvidence(readCorpus(), readConfig()), null, 2)}\n`;
    expect(read('.kory-eval/device-lifecycle-evidence.json')).toBe(regenerated);
    expect(evidence.reproduction.deterministic).toBe(true);
  });

  test('threat-model.md matches the deterministic builder', () => {
    expect(analysis).toBe(buildAnalysis(readCorpus(), readConfig()));
  });

  test('the evidence records the commands and the pinned input digests', () => {
    expect(evidence.reproduction.commands).toContain('bun test');
    expect(evidence.reproduction.deterministic).toBe(true);
    expect(evidence.environment.inputs['src/device-sim.ts']).toBe(
      `sha256:${sha256(read('src/device-sim.ts'))}`,
    );
    expect(evidence.environment.inputs['evidence/device-corpus.json']).toBe(
      `sha256:${sha256(read('evidence/device-corpus.json'))}`,
    );
    expect(evidence.environment.inputs['.kory-eval/device-config.json']).toBe(
      `sha256:${sha256(read('.kory-eval/device-config.json'))}`,
    );
  });
});

describe('the fixed fixture inputs are untouched', () => {
  test('src/device-sim.ts is byte-identical to the supplied simulator', () => {
    expect(`sha256:${sha256(read('src/device-sim.ts'))}`).toBe(SIM_DIGEST);
  });

  test('evidence/device-corpus.json is byte-identical to the supplied corpus', () => {
    expect(`sha256:${sha256(read('evidence/device-corpus.json'))}`).toBe(CORPUS_DIGEST);
  });

  test('the corpus still holds exactly the six supplied images and five steps', () => {
    const corpus = readCorpus();
    expect(corpus.images.map((image) => image.id)).toEqual([
      'current',
      'older',
      'wrong-product',
      'unsigned',
      'corrupt',
      'recovery',
    ]);
    expect(corpus.steps).toEqual([
      'write-inactive',
      'verify-inactive',
      'mark-pending',
      'boot-pending',
      'commit-version',
    ]);
  });

  test('derived fixtures are labelled derived and never written into the corpus', () => {
    const images = evidence.update.images as Record<string, any>;
    expect(images['recovery-unauthorized@3'].source).toBe('derived');
    expect(images['update-candidate@8'].source).toBe('derived');
    expect(images['current@7'].source).toBe('corpus');
  });
});

describe('hardware-observed and documentation/simulation labels are separated', () => {
  test('the label vocabulary is stated in the artifact', () => {
    expect(Object.keys(evidence.labels.vocabulary).sort()).toEqual([
      'documentation',
      'hardware-observed',
      'simulation',
    ]);
    expect(evidence.labels.rule).toContain('evidenceLabel');
  });

  test('only the board-observed facts carry the hardware-observed label', () => {
    expect(evidence.environment.observedOnHardware).toEqual([
      'serialBootLog',
      'keyHashFuseRecord',
      'productionLockRegister',
    ]);
    expect(evidence.environment.emulatorCannotProve).toEqual([
      'physicalFuseProof',
      'debugLockProof',
    ]);
    expect(evidence.update.images['current@7'].evidenceLabel).toBe('hardware-observed');
    for (const [key, image] of Object.entries<any>(evidence.update.images)) {
      if (key !== 'current@7') {
        expect(image.evidenceLabel, key).toBe('simulation');
      }
    }
    for (const [key, scenario] of Object.entries<any>(evidence.update.powerCuts)) {
      expect(scenario.evidenceLabel, key).toBe('simulation');
    }
  });

  test('the production lock state names what is observed and what is not', () => {
    expect(evidence.productionLockState.observed).toBe(true);
    expect(evidence.productionLockState.evidenceLabel).toBe('hardware-observed');
    expect(evidence.productionLockState.evidenceLabelForEnforcement).toBe('documentation');
    expect(evidence.productionLockState.notEstablished.join(' ')).toContain('tamper-proof');
  });

  test('every lifecycle step and interface attempt carries a label or a basis', () => {
    for (const entry of evidence.credentialLifecycle.transcript) {
      expect(entry.evidenceLabel, entry.event).toBeDefined();
    }
    for (const attempt of evidence.interfaceAuthority.attempts) {
      expect(attempt.basis.length, attempt.queriedToken).toBeGreaterThan(0);
    }
    expect(evidence.interfaceAuthority.evidenceLabel).toBe('documentation');
  });
});

describe('the artifact covers the contract surface', () => {
  const text = read('.kory-eval/device-lifecycle-evidence.json').toLowerCase();

  test('interface authority, lifecycle and reset/decommission/fleet are all present', () => {
    for (const needle of [
      'swd',
      'uart',
      'rom',
      'physical-possession',
      'reset',
      'decommission',
      'revoke',
      'credential',
      'observed',
      'simulat',
      'document',
    ]) {
      expect(text, needle).toContain(needle);
    }
  });

  test('interface attempts are re-derived from the supplied interfaceCan', () => {
    expect(evidence.interfaceAuthority.attemptSummary.total).toBe(60);
    expect(evidence.interfaceAuthority.attemptSummary.denied).toBe(55);
    expect(evidence.interfaceAuthority.attemptSummary.granted).toBe(5);
    expect(evidence.interfaceAuthority.attemptSummary.expectationsMismatched).toBe(0);
    for (const attempt of evidence.interfaceAuthority.attempts) {
      expect(attempt.grantedByPolicy, attempt.queriedToken).toBe(attempt.expectedGranted);
    }
  });

  test('the boot/update section records every supplied cut transition', () => {
    expect(Object.keys(evidence.update.powerCuts).length).toBe(9);
    let transitions = 0;
    for (const scenario of Object.values<any>(evidence.update.powerCuts)) {
      expect(Object.keys(scenario.steps).length).toBe(5);
      expect(scenario.unverifiedSlotExecutedAtAnyStep).toBe(false);
      expect(scenario.recoversToAuthenticatedSlotOnly).toBe(true);
      transitions += Object.keys(scenario.steps).length;
    }
    expect(transitions).toBe(45);
  });

  test('the credential lifecycle transcript is complete', () => {
    expect(evidence.credentialLifecycle.stepCount).toBe(21);
    expect(evidence.credentialLifecycle.events).toContain('factory-reset');
    expect(evidence.credentialLifecycle.events).toContain('post-reset-silent-reauthorization-attempt');
    expect(evidence.credentialLifecycle.events).toContain('recovery-after-revocation-attempt');
  });

  test('recovery, reset, decommission and fleet revocation are demonstrated with steps', () => {
    expect(evidence.recovery.demonstration.length).toBeGreaterThanOrEqual(5);
    expect(evidence.resetDecommissionAndFleet.demonstrations.length).toBeGreaterThanOrEqual(6);
    const fleet = evidence.resetDecommissionAndFleet.demonstrations.find(
      (entry: any) => entry.step === 'reset-after-revocation-with-fleet-authority',
    );
    expect(fleet.outcome).toContain('denied');
  });

  test('safety consequences are recorded separately from the other consequences', () => {
    const severities = evidence.safetyConsequences.map((entry: any) => entry.severity);
    expect(severities).toContain('safety');
    expect(severities).toContain('privacy');
    expect(severities).toContain('availability');
    expect(severities).toContain('fleet');
    expect(severities).toContain('credential');
  });

  test('limits, scope boundaries and the claim boundary are all stated', () => {
    expect(evidence.limits.length).toBeGreaterThanOrEqual(8);
    expect(evidence.scope.adjacentSkillsNotCovered.join(' ')).toContain('applied-cryptography');
    expect(evidence.claims.claimBoundary).toContain('outside what this fixture can show');
  });

  test('the analysis document carries the same tables and the claim boundary', () => {
    for (const needle of ['swd', 'uart', 'rom', 'reset', 'decommission', 'revoke', 'observed']) {
      expect(analysis.toLowerCase(), needle).toContain(needle);
    }
    expect(analysis).toContain('## 4. Debug interface authority');
    expect(analysis).toContain('## 6. Per-device credential lifecycle');
    expect(analysis).toContain('no debug-lock, physical-fuse, invasive-extraction or fault-injection resistance is claimed');
  });
});

describe('no hardware property is claimed that this fixture cannot show', () => {
  test('the evidence artifact asserts no unsupported hardware claim', () => {
    expect(hasUnsupportedHardwareClaim(evidence)).toEqual([]);
  });

  test('both resistance flags are false and explained', () => {
    expect(evidence.resistanceClaims.invasiveExtractionClaimed).toBe(false);
    expect(evidence.resistanceClaims.faultInjectionClaimed).toBe(false);
    expect(evidence.resistanceClaims.reason).toContain('exercised');
    expect(evidence.resistanceClaims.reason).toContain('physicalFuseProof=false');
    expect(evidence.claims.notEstablished.join(' ')).toContain('debugLockProof=false');
  });

  test('the not-established list names the emulator gaps', () => {
    const notEstablished = evidence.claims.notEstablished.join(' ');
    expect(notEstablished).toContain('physicalFuseProof=false');
    expect(notEstablished).toContain('debugLockProof=false');
    expect(notEstablished).toContain('fault-injection');
  });
});
