/**
 * Verification of the production interface authority enumeration.
 *
 * The policy lives in `.kory-eval/device-config.json`; these tests exercise the
 * grammar, both possession states, and every attacker attempt, all re-derived
 * with the supplied `interfaceCan()` rather than restated.
 */
import { describe, expect, test } from 'bun:test';
import { interfaceCan, type DeviceConfig } from '../src/device-sim';
import {
  INTERFACE_NAMES,
  NORMAL,
  PHYSICAL_POSSESSION,
  POSSESSION_STATES,
  PROBE_PRIVILEGES,
  authorityFor,
  authoritySummary,
  enumerateAuthority,
  grantsFor,
  parseAuthorityToken,
  probeAttempts,
} from '../scripts/interface-authority';
import { readConfig } from '../scripts/kory-artifact';

const config = readConfig() as DeviceConfig;

describe('the authority token grammar', () => {
  test('every enumerated token matches the grammar', () => {
    for (const name of INTERFACE_NAMES) {
      for (const token of config.interfaces[name]) {
        expect(() => parseAuthorityToken(name, token), token).not.toThrow();
      }
    }
  });

  test('a state prefix and a no- denial prefix are recognised', () => {
    expect(parseAuthorityToken('swd', 'normal:no-debug-attach')).toEqual({
      token: 'normal:no-debug-attach',
      interface: 'swd',
      state: NORMAL,
      privilege: 'debug-attach',
      kind: 'denial',
    });
    expect(parseAuthorityToken('uart', 'normal:read-only-boot-log').privilege).toBe(
      'read-only-boot-log',
    );
    expect(parseAuthorityToken('uart', 'normal:read-only-boot-log').kind).toBe('grant');
  });

  test('a malformed token is rejected instead of silently accepted', () => {
    expect(() => parseAuthorityToken('swd', 'firmware-readout')).toThrow();
    expect(() => parseAuthorityToken('swd', 'production:no-debug-attach')).toThrow();
    expect(() => parseAuthorityToken('swd', 'normal:no Debug')).toThrow();
  });

  test('both possession states are enumerated for every interface', () => {
    for (const name of INTERFACE_NAMES) {
      for (const state of POSSESSION_STATES) {
        expect(authorityFor(config, name, state).length, `${name}/${state}`).toBeGreaterThan(0);
      }
    }
  });
});

describe('every attacker attempt is refused by the enumeration', () => {
  const attempts = probeAttempts(config);

  test('all attempts match the expected production answer', () => {
    expect(attempts.length).toBe(
      INTERFACE_NAMES.length * POSSESSION_STATES.length * PROBE_PRIVILEGES.length,
    );
    const mismatched = attempts.filter((attempt) => !attempt.matchesExpectation);
    expect(mismatched.map((attempt) => attempt.queriedToken)).toEqual([]);
  });

  test('no privileged readout, erase or rollback grant exists in any state', () => {
    const forbidden = [
      'firmware-readout',
      'secret-export',
      'secret-readout',
      'flash-erase',
      'rollback-state-clear',
      'image-install',
      'unsigned-image-install',
      'credential-export',
    ];
    for (const name of INTERFACE_NAMES) {
      for (const state of POSSESSION_STATES) {
        for (const privilege of forbidden) {
          expect(interfaceCan(config, name, `${state}:${privilege}`), `${name}/${state}/${privilege}`).toBe(
            false,
          );
        }
      }
    }
  });

  test('the only grants are the read-only boot log and the authenticated recovery entry', () => {
    const granted = attempts.filter((attempt) => attempt.grantedByPolicy);
    // Iteration order is interface (swd, uart, romUsb) x state (normal, physical).
    expect(granted.map((attempt) => `${attempt.interface} ${attempt.state}:${attempt.privilege}`)).toEqual([
      `swd ${PHYSICAL_POSSESSION}:authenticated-recovery-entry`,
      `uart ${NORMAL}:read-only-boot-log`,
      `uart ${PHYSICAL_POSSESSION}:authenticated-recovery-entry`,
      `uart ${PHYSICAL_POSSESSION}:read-only-boot-log`,
      `romUsb ${PHYSICAL_POSSESSION}:authenticated-recovery-entry`,
    ]);
  });
});

describe('the enumeration is a bounded policy, not an open one', () => {
  test('SWD grants nothing except the authenticated recovery route', () => {
    expect(grantsFor(config, 'swd', NORMAL)).toEqual([]);
    expect(grantsFor(config, 'swd', PHYSICAL_POSSESSION).map((token) => token.privilege)).toEqual([
      'authenticated-recovery-entry',
    ]);
  });

  test('the UART console is read-only in both possession states', () => {
    expect(grantsFor(config, 'uart', NORMAL).map((token) => token.privilege)).toEqual([
      'read-only-boot-log',
    ]);
    expect(interfaceCan(config, 'uart', 'normal:image-install')).toBe(false);
    expect(interfaceCan(config, 'uart', 'physical-possession:image-install')).toBe(false);
  });

  test('ROM download is closed under normal possession and gated under physical possession', () => {
    expect(grantsFor(config, 'romUsb', NORMAL)).toEqual([]);
    expect(grantsFor(config, 'romUsb', PHYSICAL_POSSESSION).map((token) => token.privilege)).toEqual([
      'authenticated-recovery-entry',
      'authenticated-image-install',
    ]);
  });

  test('the summary covers every interface and state with grants plus denials', () => {
    const summary = authoritySummary(config);
    expect(summary.length).toBe(INTERFACE_NAMES.length * POSSESSION_STATES.length);
    for (const row of summary) {
      expect(row.grants.length + row.denials.length).toBeGreaterThan(0);
    }
    expect(enumerateAuthority(config).length).toBeGreaterThanOrEqual(24);
  });
});
