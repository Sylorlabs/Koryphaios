import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, afterEach, test } from 'bun:test';
import {
  HARDWARE_RUNTIME_SCORERS,
  buildAndCapture,
  elfSymbols,
  expectedChecksum,
  hardwareMaterialize,
  hardwareRuntimeReadiness,
  parseHardwareRecord,
  runHardwareScenario,
  symbolContaining,
} from '../../eval/skills/skill-eval-hardware-runtime';

/**
 * The value of this fixture is that the fault record and the verdict both come
 * from a running target. These tests pin both halves: the shipped source must
 * fault in the way the record says it did, and a repaired source must complete
 * the packet path on the same target with a checksum derived from a seed the
 * candidate never saw.
 */
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function workspace(scenario: 1 | 2): string {
  const root = mkdtempSync(join(tmpdir(), `kory-hw-${scenario}-`));
  roots.push(root);
  hardwareMaterialize(root, scenario);
  return root;
}

function recordOf(root: string) {
  const text = readFileSync(join(root, 'faults', 'fault-1.txt'), 'utf8');
  const record = parseHardwareRecord(text);
  expect(record, `unparsable record: ${text}`).not.toBeNull();
  return record!;
}

function symbolsOf(root: string) {
  return elfSymbols(join(root, 'faults', 'fault-1.elf'));
}

function hex(value: number): string {
  return `0x${(value >>> 0).toString(16).padStart(8, '0')}`;
}

const REPAIR_S1 = [
  [
    '#define GUARDED_REGION_BASE 0x20000000u',
    '#define GUARDED_REGION_BASE ((uint32_t)calibration_scratch)',
  ],
] as const;

const REPAIR_S2 = [
  ['(packet_handler)((uint32_t)handlers[index] & ~1u)', '(packet_handler)(handlers[index])'],
] as const;

function repair(root: string, edits: ReadonlyArray<readonly [string, string]>): void {
  const path = join(root, 'firmware', 'board.c');
  let source = readFileSync(path, 'utf8');
  for (const [from, to] of edits) {
    expect(source.includes(from), `repair anchor missing: ${from}`).toBe(true);
    source = source.replace(from, to);
  }
  writeFileSync(path, source);
}

describe('Cortex-M hardware runtime fixture', () => {
  test.skipIf(hardwareRuntimeReadiness().length > 0)(
    'scenario 1 ships a real MemManage record whose frame resolves in the shipped ELF',
    () => {
      const root = workspace(1);
      const record = recordOf(root);
      // DACCVIOL (bit 1) with MMARVALID (bit 7) and a Forced HardFault.
      expect(record.tag).toBe('FAULT');
      expect(record.cfsr & 0x82).toBe(0x82);
      expect(record.hfsr & 0x4000_0000).toBe(0x4000_0000);
      expect(record.mmfar).toBe(0x2000_0000);
      // The core faulted inside the calibration read, called from reset.
      expect(symbolContaining(symbolsOf(root), record.frame[6])).toBe('read_calibration');
      expect(symbolContaining(symbolsOf(root), record.frame[5])).toBe('reset_handler');
    },
    240_000,
  );

  test.skipIf(hardwareRuntimeReadiness().length > 0)(
    'scenario 1 passes only when the diagnosis matches the record and the repair runs',
    () => {
      const root = workspace(1);
      const record = recordOf(root);

      const untouched = runHardwareScenario(root, 1);
      expect(untouched.passed).toBe(false);
      expect(untouched.checks.filter((check) => !check.passed).map((check) => check.id)).toEqual([
        'contract',
        'repair-runs',
      ]);

      repair(root, REPAIR_S1);
      writeFileSync(
        join(root, 'diagnosis.json'),
        JSON.stringify({
          faultStatus: 'MemManage',
          cfsr: hex(record.cfsr),
          hfsr: hex(record.hfsr),
          mmfar: hex(record.mmfar),
          mmfarValid: true,
          bfarValid: false,
          pcSymbol: 'read_calibration',
          cause: 'mpu-region-misconfigured',
          mpuRegion: 0,
          regionBase: hex(record.mmfar),
          regionSizeBytes: 32,
          regionAccess: 'no-access',
          repair: 'guard the calibration scratch block instead of the sample buffer',
        }),
      );
      const fixed = runHardwareScenario(root, 1);
      expect(fixed.checks.map((check) => check.id)).toEqual([
        'contract',
        'fault-class',
        'fault-address',
        'cause',
        'pc-symbol',
        'repair-builds',
        'repair-runs',
      ]);
      expect(fixed.passed).toBe(true);
    },
    300_000,
  );

  test.skipIf(hardwareRuntimeReadiness().length > 0)(
    'scenario 1 rejects a diagnosis that names the wrong symbol or claims an invalid address register',
    () => {
      const root = workspace(1);
      const record = recordOf(root);
      repair(root, REPAIR_S1);
      writeFileSync(
        join(root, 'diagnosis.json'),
        JSON.stringify({
          faultStatus: 'MemManage',
          cfsr: hex(record.cfsr),
          hfsr: hex(record.hfsr),
          mmfar: hex(record.mmfar),
          mmfarValid: true,
          bfarValid: true,
          pcSymbol: 'reset_handler',
          cause: 'mpu-region-misconfigured',
          mpuRegion: 0,
          regionBase: hex(record.mmfar),
          regionSizeBytes: 32,
          regionAccess: 'no-access',
          repair: 'moved the guard',
        }),
      );
      const result = runHardwareScenario(root, 1);
      expect(result.passed).toBe(false);
      expect(
        result.checks
          .filter((check) => !check.passed)
          .map((check) => check.id)
          .sort(),
      ).toEqual(['fault-address', 'pc-symbol']);
    },
    300_000,
  );

  test.skipIf(hardwareRuntimeReadiness().length > 0)(
    'scenario 2 ships a real UsageFault INVSTATE record and rejects an unrepaired image',
    () => {
      const root = workspace(2);
      const record = recordOf(root);
      expect(record.cfsr & 0x2_0000).toBe(0x2_0000);
      expect(record.hfsr & 0x4000_0000).toBe(0x4000_0000);
      const symbols = symbolsOf(root);
      const target = symbolContaining(symbols, record.frame[6]);
      expect(target).toBe('on_command');
      expect(symbolContaining(symbols, record.frame[5])).toBe('reset_handler');

      const untouched = runHardwareScenario(root, 2);
      expect(untouched.passed).toBe(false);
      expect(untouched.checks.filter((check) => !check.passed).map((check) => check.id)).toEqual([
        'contract',
        'repair-runs',
      ]);

      repair(root, REPAIR_S2);
      writeFileSync(
        join(root, 'diagnosis.json'),
        JSON.stringify({
          faultStatus: 'UsageFault',
          cfsr: hex(record.cfsr),
          hfsr: hex(record.hfsr),
          stackedPc: hex(record.frame[6]),
          returnAddress: hex(record.frame[5]),
          invstate: true,
          pcSymbol: target,
          cause: 'thumb-bit-cleared',
          repair: 'keep the Thumb bit on the stored handler pointer',
        }),
      );
      const fixed = runHardwareScenario(root, 2);
      expect(fixed.passed).toBe(true);
    },
    300_000,
  );

  test.skipIf(hardwareRuntimeReadiness().length > 0)(
    'the published checksum is derived from the seed the harness chose for that run',
    () => {
      const root = workspace(1);
      repair(root, REPAIR_S1);
      for (const seed of [0x10_0001, 0x2f_44c1]) {
        const run = buildAndCapture(root, seed);
        expect(run.built).toBe(true);
        const published = Number.parseInt(/checksum=([0-9a-f]{8})/u.exec(run.record)![1], 16);
        expect(published).toBe(expectedChecksum(seed, 1));
      }
    },
    300_000,
  );

  test('the scorers are registered for exactly the two hardware scenarios', () => {
    expect(HARDWARE_RUNTIME_SCORERS.map((scorer) => scorer.scenarioIds).flat()).toEqual([
      'hardware-runtime-debugging-full-task-1',
      'hardware-runtime-debugging-full-task-2',
    ]);
  });
});
