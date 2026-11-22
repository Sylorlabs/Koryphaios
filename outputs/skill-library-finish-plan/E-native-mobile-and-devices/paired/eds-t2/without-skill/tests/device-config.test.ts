/**
 * Public contract verification for `.kory-eval/device-config.json`.
 *
 * The config must be the `DeviceConfig` the fixture contract requires, bound to
 * the facts the fixed corpus actually supplies, with the credential lifecycle
 * flags and the two resistance flags the contract pins. Every value is checked
 * against the corpus rather than against prose.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { interfaceCan, type DeviceConfig } from '../src/device-sim';
import { readConfig, readCorpus, type Corpus } from '../scripts/kory-artifact';

const ROOT = join(import.meta.dir, '..');
const read = (relative: string): string => readFileSync(join(ROOT, relative), 'utf8');

const config: DeviceConfig & Record<string, unknown> = JSON.parse(
  read('.kory-eval/device-config.json'),
) as DeviceConfig & Record<string, unknown>;
const corpus: Corpus = readCorpus();

const REQUIRED_FIELDS = [
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

describe('device-config.json is the DeviceConfig the fixture contract requires', () => {
  test('declares every required DeviceConfig field at the top level', () => {
    for (const field of REQUIRED_FIELDS) {
      expect(config, field).toHaveProperty(field);
    }
  });

  test('enumerates all three interfaces as arrays of authority tokens', () => {
    for (const name of ['swd', 'uart', 'romUsb'] as const) {
      expect(Array.isArray(config.interfaces[name]), name).toBe(true);
      expect(config.interfaces[name].length, name).toBeGreaterThan(0);
    }
  });

  test('binds the environment facts the corpus supplies, not assumed ones', () => {
    expect(config.binding).toMatchObject({
      board: corpus.board,
      product: corpus.product,
      productionKeyHash: corpus.keyHash,
      applicationVersion: 7,
      minimumVersion: 7,
    });
    expect(config.binding.corpusObservedOnHardware).toEqual(
      Object.entries(corpus.observed)
        .filter(([, value]) => value)
        .map(([key]) => key),
    );
    expect(config.binding.emulatorCannotProve).toEqual(
      Object.entries(corpus.emulator)
        .filter(([, value]) => value === false)
        .map(([key]) => key),
    );
  });

  test('records why each ambiguous fact was resolved', () => {
    expect(config.binding.rationale.length).toBeGreaterThanOrEqual(6);
    const rationale = config.binding.rationale.join(' ');
    expect(rationale).toContain('mcu-rev-c');
    expect(rationale).toContain('device-x');
    expect(rationale).toContain('prod-key-hash-2026');
  });
});

describe('production debug authority is bounded while recovery stays explicit', () => {
  test('the production lock state is observed and SWD readout is locked', () => {
    expect(config.observedProductionLockState).toBe(true);
    expect(config.swdReadoutLocked).toBe(true);
    expect(corpus.observed.productionLockRegister).toBe(true);
  });

  test('no interface grants unrestricted firmware or secret readout', () => {
    for (const name of ['swd', 'uart', 'romUsb'] as const) {
      expect(interfaceCan(config, name, 'firmware-readout'), name).toBe(false);
      expect(interfaceCan(config, name, 'secret-export'), name).toBe(false);
      expect(interfaceCan(config, name, 'credential-export'), name).toBe(false);
      expect(interfaceCan(config, name, 'flash-erase'), name).toBe(false);
      expect(interfaceCan(config, name, 'rollback-state-clear'), name).toBe(false);
    }
  });

  test('only the authenticated recovery path remains on the debug surfaces', () => {
    expect(config.authorizedRecoveryOnly).toBe(true);
    for (const name of ['swd', 'uart', 'romUsb'] as const) {
      expect(interfaceCan(config, name, 'physical-possession:authenticated-recovery-entry'), name).toBe(
        true,
      );
    }
  });

  test('ROM download authority is bounded by the same gate as an ordinary update', () => {
    expect(interfaceCan(config, 'romUsb', 'physical-possession:authenticated-image-install')).toBe(
      true,
    );
    expect(interfaceCan(config, 'romUsb', 'physical-possession:unsigned-image-install')).toBe(false);
    expect(interfaceCan(config, 'romUsb', 'physical-possession:downgrade')).toBe(false);
    expect(interfaceCan(config, 'romUsb', 'normal:image-install')).toBe(false);
  });
});

describe('the per-device credential lifecycle is bounded', () => {
  test('the credential is hardware-backed and non-exportable', () => {
    expect(config.credentialHardwareBacked).toBe(true);
    expect(config.credentialExportable).toBe(false);
  });

  test('reset and decommission destroy local credential authority', () => {
    expect(config.resetDestroysOrInvalidatesCredential).toBe(true);
    expect(config.decommissionDestroysCredential).toBe(true);
  });

  test('fleet revocation is checked on recovery', () => {
    expect(config.fleetRevocationCheckedOnRecovery).toBe(true);
  });

  test('algorithm design stays with applied-cryptography', () => {
    expect(config.algorithmOwnedBy).toBe('applied-cryptography');
  });

  test('resistance claims that were not exercised stay false', () => {
    expect(config.invasiveResistanceClaimed).toBe(false);
    expect(config.faultInjectionResistanceClaimed).toBe(false);
    expect(corpus.emulator.physicalFuseProof).toBe(false);
    expect(corpus.emulator.debugLockProof).toBe(false);
  });
});

describe('the authored config round-trips through the shared reader', () => {
  test('readConfig returns the same object as the file parse', () => {
    expect(readConfig()).toEqual(config);
  });
});
