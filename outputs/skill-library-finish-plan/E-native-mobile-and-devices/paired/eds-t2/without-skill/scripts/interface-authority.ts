/**
 * Production interface authority for the representative board.
 *
 * The fixture contract asks for SWD, UART and ROM USB authority under two
 * possession states: `normal` (device in its owner's hands, operating) and
 * `physical-possession` (an attacker holds the board on a bench, case open,
 * probes attached). Authority is enumerated in `.kory-eval/device-config.json`
 * with a state-qualified token grammar defined here.
 *
 * Grammar: `<state>:<privilege>` where state is one of POSSESSION_STATES and a
 * `no-` privilege prefix records an explicit denial. `interfaceCan()` from the
 * supplied simulator answers "is this exact token enumerated", so the config is
 * the single source of the policy and every attempt below is re-derived from it
 * rather than re-stated.
 */
import { interfaceCan, type DeviceConfig } from '../src/device-sim';

export const POSSESSION_STATES = ['normal', 'physical-possession'] as const;
export type PossessionState = (typeof POSSESSION_STATES)[number];

export const INTERFACE_NAMES = ['swd', 'uart', 'romUsb'] as const;
export type InterfaceName = (typeof INTERFACE_NAMES)[number];

export const NORMAL: PossessionState = 'normal';
export const PHYSICAL_POSSESSION: PossessionState = 'physical-possession';

export const POSSESSION_STATE_DEFINITIONS: Record<PossessionState, string> = {
  normal: 'device operating in the owner\'s possession: no attacker access to the board',
  'physical-possession':
    'attacker has temporary physical possession: board desoldered or case opened, SWD/UART/ROM pads reachable, no credentials, no persistent firmware write authority',
};

const TOKEN_PATTERN = /^(normal|physical-possession):(no-)?([a-z][a-z0-9-]*)$/u;

export interface AuthorityToken {
  token: string;
  interface: InterfaceName;
  state: PossessionState;
  privilege: string;
  kind: 'grant' | 'denial';
}

export function parseAuthorityToken(name: InterfaceName, token: string): AuthorityToken {
  const match = TOKEN_PATTERN.exec(token);
  if (!match) {
    throw new Error(`interface ${name}: authority token "${token}" does not match the grammar`);
  }
  const [, state, denial, privilege] = match;
  return {
    token,
    interface: name,
    state: state as PossessionState,
    privilege,
    kind: denial ? 'denial' : 'grant',
  };
}

/** Every enumerated authority token in the authored policy, validated. */
export function enumerateAuthority(config: DeviceConfig): AuthorityToken[] {
  const tokens: AuthorityToken[] = [];
  for (const name of INTERFACE_NAMES) {
    const list = config.interfaces[name];
    if (!Array.isArray(list)) {
      throw new Error(`config.interfaces.${name} must be an array of authority tokens`);
    }
    for (const token of list) tokens.push(parseAuthorityToken(name, token));
  }
  return tokens;
}

export function authorityFor(
  config: DeviceConfig,
  name: InterfaceName,
  state: PossessionState,
): AuthorityToken[] {
  return enumerateAuthority(config).filter(
    (token) => token.interface === name && token.state === state,
  );
}

export function grantsFor(
  config: DeviceConfig,
  name: InterfaceName,
  state: PossessionState,
): AuthorityToken[] {
  return authorityFor(config, name, state).filter((token) => token.kind === 'grant');
}

/**
 * Privileges an attacker actually attempts. Each is re-evaluated against the
 * authored policy with the supplied `interfaceCan()`, so the recorded attempt is
 * a computation, not an assertion.
 */
export const PROBE_PRIVILEGES = [
  'firmware-readout',
  'secret-export',
  'secret-readout',
  'flash-erase',
  'rollback-state-clear',
  'image-install',
  'unsigned-image-install',
  'credential-export',
  'authenticated-recovery-entry',
  'read-only-boot-log',
] as const;

export type ProbePrivilege = (typeof PROBE_PRIVILEGES)[number];

export interface ProbeAttempt {
  interface: InterfaceName;
  state: PossessionState;
  privilege: ProbePrivilege;
  /** The exact token the simulator would need in order to answer true. */
  queriedToken: string;
  grantedByPolicy: boolean;
  /** Expected production answer; a mismatch fails the contract test. */
  expectedGranted: boolean;
  matchesExpectation: boolean;
  basis: string;
}

const EXPECTED_GRANTS: Record<ProbePrivilege, Partial<Record<InterfaceName, PossessionState[]>>> = {
  // No privileged readout authority on any interface in any possession state.
  'firmware-readout': {},
  'secret-export': {},
  'secret-readout': {},
  'flash-erase': {},
  'rollback-state-clear': {},
  'image-install': {},
  'unsigned-image-install': {},
  'credential-export': {},
  // The authenticated recovery path survives physical possession on all three
  // debug/download surfaces, and only under physical possession.
  'authenticated-recovery-entry': {
    swd: [PHYSICAL_POSSESSION],
    uart: [PHYSICAL_POSSESSION],
    romUsb: [PHYSICAL_POSSESSION],
  },
  // The serial console stays read-only: the corpus records a board-observed
  // boot log, which is exactly the authority this grant carries.
  'read-only-boot-log': { uart: [NORMAL, PHYSICAL_POSSESSION] },
};

export function expectedGrant(
  privilege: ProbePrivilege,
  name: InterfaceName,
  state: PossessionState,
): boolean {
  return EXPECTED_GRANTS[privilege]?.[name]?.includes(state) ?? false;
}

export function probeAttempts(config: DeviceConfig): ProbeAttempt[] {
  const attempts: ProbeAttempt[] = [];
  for (const name of INTERFACE_NAMES) {
    for (const state of POSSESSION_STATES) {
      for (const privilege of PROBE_PRIVILEGES) {
        const queriedToken = `${state}:${privilege}`;
        const grantedByPolicy = interfaceCan(config, name, queriedToken);
        const expected = expectedGrant(privilege, name, state);
        attempts.push({
          interface: name,
          state,
          privilege,
          queriedToken,
          grantedByPolicy,
          expectedGranted: expected,
          matchesExpectation: grantedByPolicy === expected,
          basis:
            're-derived from the authored policy with the supplied interfaceCan(); the policy itself is documentation, not a hardware measurement',
        });
      }
    }
  }
  return attempts;
}

/** Human-readable policy summary per interface and possession state. */
export function authoritySummary(
  config: DeviceConfig,
): Array<{ interface: InterfaceName; state: PossessionState; grants: string[]; denials: string[] }> {
  return INTERFACE_NAMES.flatMap((name) =>
    POSSESSION_STATES.map((state) => {
      const tokens = authorityFor(config, name, state);
      return {
        interface: name,
        state,
        grants: tokens.filter((token) => token.kind === 'grant').map((token) => token.privilege),
        denials: tokens.filter((token) => token.kind === 'denial').map((token) => token.privilege),
      };
    }),
  );
}
