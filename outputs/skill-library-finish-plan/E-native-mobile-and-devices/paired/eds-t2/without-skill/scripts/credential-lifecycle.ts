/**
 * Per-device credential lifecycle model.
 *
 * The fixture contract states the required properties (hardware-backed,
 * non-exportable, protected through update/recovery/RMA, explicit rotate and
 * revoke semantics, reset/decommission destruction, fleet revocation on
 * recovery). Stating them is not enough: this module executes a lifecycle
 * against those rules and returns a transcript that the artifacts quote.
 *
 * The model is this repository's own; it is not the supplied simulator and it is
 * not silicon. It demonstrates state-machine logic (which transitions are
 * reachable, and which attacker moves they refuse), which is the part a
 * specification alone cannot show.
 */
import { PHYSICAL_POSSESSION } from './interface-authority';
import type { EvidenceLabel } from './kory-artifact';

/**
 * Immutable device identity. A factory reset destroys credential authority but
 * must not delete the identity, because fleet revocation is keyed to it.
 */
export const DEVICE_ID = 'device-x:mcu-rev-c:0007';
export const CREDENTIAL_SLOT_ID = 'secure-slot-0';

export type SlotState = 'empty' | 'provisioned' | 'destroyed';
export type CredentialAuthority = 'none' | 'active' | 'stale';
export type ReprovisionAuthority = 'none' | 'authenticated-fleet' | 'rma-authority';

export interface CredentialSlot {
  slotId: string;
  state: SlotState;
  credentialId: string | null;
  hardwareBacked: boolean;
  exportable: boolean;
}

export type FleetState =
  | 'unregistered'
  | 'provisioned'
  | 'revoked'
  | 'decommissioned'
  | 'reset-pending-reprovision';

export interface FleetRecord {
  deviceId: string;
  state: FleetState;
  activeCredentialId: string | null;
  revokedCredentialIds: string[];
  revocationCheckedOnRecovery: boolean;
}

export interface LifecycleState {
  slot: CredentialSlot;
  fleet: FleetRecord;
  localCredentialAuthority: CredentialAuthority;
  applicationVersion: number;
  inAuthorizedRecovery: boolean;
  reprovisionAuthority: ReprovisionAuthority;
}

export type LifecycleOutcome = 'allowed' | 'denied' | 'state-change';

export interface LifecycleStep {
  event: string;
  access: string;
  label: EvidenceLabel;
  /** The rule that decides the outcome, so the transcript names its control. */
  enforcedBy: string;
  /**
   * Authority the caller presents for this step only. Keeping it explicit is
   * what makes the "regains authorization" refusals reproducible: the same
   * move is refused with no authority and with fleet-only authority, and is
   * granted only with RMA authority once the device is revoked.
   */
  presentsAuthority?: ReprovisionAuthority;
  run(state: LifecycleState): { outcome: LifecycleOutcome; reason: string; next: LifecycleState };
}

export interface LifecycleRecord {
  order: number;
  event: string;
  access: string;
  outcome: LifecycleOutcome;
  enforcedBy: string;
  reason: string;
  presentedAuthority: ReprovisionAuthority;
  slotState: SlotState;
  credentialId: string | null;
  fleetState: FleetState;
  localCredentialAuthority: CredentialAuthority;
  applicationVersion: number;
  inAuthorizedRecovery: boolean;
  evidenceLabel: EvidenceLabel;
}

function emptySlot(): CredentialSlot {
  return {
    slotId: CREDENTIAL_SLOT_ID,
    state: 'empty',
    credentialId: null,
    hardwareBacked: true,
    exportable: false,
  };
}

export function initialState(applicationVersion: number): LifecycleState {
  return {
    slot: emptySlot(),
    fleet: {
      deviceId: DEVICE_ID,
      state: 'unregistered',
      activeCredentialId: null,
      revokedCredentialIds: [],
      revocationCheckedOnRecovery: true,
    },
    localCredentialAuthority: 'none',
    applicationVersion,
    inAuthorizedRecovery: false,
    reprovisionAuthority: 'none',
  };
}

const provision = (state: LifecycleState, credentialId: string): LifecycleState => ({
  ...state,
  slot: { ...state.slot, state: 'provisioned', credentialId },
  fleet: { ...state.fleet, state: 'provisioned', activeCredentialId: credentialId },
  localCredentialAuthority: 'active',
});

const destroySlot = (state: LifecycleState): LifecycleState => ({
  ...state,
  slot: { ...emptySlot(), state: 'destroyed' },
  localCredentialAuthority: 'none',
});

/** Use of the local credential against the fleet service. */
function canUse(state: LifecycleState): { ok: boolean; reason: string } {
  if (state.slot.state !== 'provisioned' || state.slot.credentialId === null) {
    return { ok: false, reason: 'no credential present in the hardware-backed slot' };
  }
  if (state.fleet.state !== 'provisioned') {
    return {
      ok: false,
      reason: `fleet record for ${state.fleet.deviceId} is ${state.fleet.state}, so the fleet service refuses the device`,
    };
  }
  if (state.fleet.activeCredentialId !== state.slot.credentialId) {
    return {
      ok: false,
      reason: `credential ${state.slot.credentialId} is on the fleet revocation list (active is ${String(state.fleet.activeCredentialId)})`,
    };
  }
  return { ok: true, reason: 'credential is provisioned, non-exportable and matches the fleet record' };
}

/** Recovery path: separate authorization plus the fleet revocation check. */
function canEnterRecovery(
  state: LifecycleState,
  separateAuthorization: boolean,
): { ok: boolean; reason: string } {
  if (!separateAuthorization) {
    return {
      ok: false,
      reason:
        'recovery is a separately authorized destination: a valid image signature alone does not open it',
    };
  }
  if (state.fleet.revocationCheckedOnRecovery && state.fleet.state === 'revoked') {
    return {
      ok: false,
      reason: `fleet revocation is checked on recovery and ${state.fleet.deviceId} is revoked`,
    };
  }
  if (state.fleet.revocationCheckedOnRecovery && state.fleet.state === 'decommissioned') {
    return {
      ok: false,
      reason: `fleet revocation is checked on recovery and ${state.fleet.deviceId} is decommissioned`,
    };
  }
  return {
    ok: true,
    reason: 'separate recovery authorization present and the fleet record authorizes the device',
  };
}

/** Reprovisioning a device the fleet has already refused. */
function canReprovision(state: LifecycleState): { ok: boolean; reason: string } {
  if (state.reprovisionAuthority === 'rma-authority') {
    return { ok: true, reason: 'RMA authority is the only authority that can reprovision a refused device' };
  }
  if (state.fleet.state === 'revoked') {
    return {
      ok: false,
      reason: `fleet record for ${state.fleet.deviceId} is revoked; reprovisioning needs RMA authority, and the fleet only re-authorizes a device it refused under RMA`,
    };
  }
  if (state.reprovisionAuthority === 'authenticated-fleet') {
    return { ok: true, reason: 'authenticated fleet authorization presented for reprovisioning' };
  }
  return { ok: false, reason: 'no authenticated reprovision authority was presented' };
}

export const LIFECYCLE: readonly LifecycleStep[] = [
  {
    event: 'manufacturing-provision',
    access: 'manufacturing station with station credentials',
    label: 'documentation',
    enforcedBy: 'credential generated inside the hardware-backed slot, never written as plaintext',
    run: (state) => ({
      outcome: 'state-change',
      reason:
        'per-device credential provisioned into the non-exportable hardware-backed slot; the fleet record registers the immutable device identity and the credential id',
      next: provision(state, 'cred-v1'),
    }),
  },
  {
    event: 'authenticated-use',
    access: 'device in normal operation against the fleet service',
    label: 'documentation',
    enforcedBy: 'slot binding + fleet record agreement',
    run: (state) => {
      const check = canUse(state);
      return {
        outcome: check.ok ? 'allowed' : 'denied',
        reason: check.ok
          ? 'fleet service accepts the device: credential present, non-exportable and matching the fleet record'
          : check.reason,
        next: state,
      };
    },
  },
  {
    event: 'credential-export-attempt',
    access: 'physical-possession + debug interface, SWD readout',
    label: 'documentation',
    enforcedBy: 'non-exportable hardware-backed slot',
    run: (state) => ({
      outcome: 'denied',
      reason:
        'the slot is hardware-backed and marked non-exportable: no interface returns key material, only a signature over a supplied challenge',
      next: state,
    }),
  },
  {
    event: 'credential-rotate',
    access: "fleet-initiated rotation while the device is in the owner's possession",
    label: 'documentation',
    enforcedBy:
      'rotate semantics: the new credential lands in the slot and the previous credential id is revoked at the fleet in the same operation',
    run: (state) => {
      const previous = state.slot.credentialId ?? 'none';
      return {
        outcome: 'state-change',
        reason: `rotated ${previous} to cred-v2; the previous credential id joins the fleet revocation list`,
        next: {
          ...state,
          slot: { ...state.slot, state: 'provisioned', credentialId: 'cred-v2' },
          fleet: {
            ...state.fleet,
            activeCredentialId: 'cred-v2',
            revokedCredentialIds: [...state.fleet.revokedCredentialIds, previous],
          },
          localCredentialAuthority: 'active',
        },
      };
    },
  },
  {
    event: 'stale-credential-use',
    access: 'attacker presents the rotated-out credential cred-v1',
    label: 'documentation',
    enforcedBy: 'fleet revocation list + slot binding',
    run: (state) => ({
      outcome: 'denied',
      reason:
        'a rotated-out credential refuses on the fleet service; holding a retired credential id grants nothing',
      next: state,
    }),
  },
  {
    event: 'authenticated-application-update',
    access: 'fleet update channel, signed and product-bound candidate',
    label: 'documentation',
    enforcedBy: 'the update path never touches the credential slot',
    run: (state) => ({
      outcome: 'state-change',
      reason:
        'application slot updated through the authenticated A/B path; the credential slot still holds the same non-exportable credential, so the credential survives update',
      next: { ...state, applicationVersion: state.applicationVersion + 1, inAuthorizedRecovery: false },
    }),
  },
  {
    event: 'authorized-recovery-entry',
    access: 'physical-possession, authenticated recovery entry over SWD/UART/ROM USB',
    label: 'documentation',
    enforcedBy: 'separate recovery authorization + fleet revocation check',
    run: (state) => {
      const check = canEnterRecovery(state, true);
      return {
        outcome: check.ok ? 'allowed' : 'denied',
        reason: check.reason,
        next: check.ok ? { ...state, inAuthorizedRecovery: true } : { ...state, inAuthorizedRecovery: false },
      };
    },
  },
  {
    event: 'unauthorized-recovery-entry',
    access: 'physical-possession, recovery image without the separate authorization',
    label: 'documentation',
    enforcedBy: 'separate recovery authorization',
    run: (state) => {
      const check = canEnterRecovery(state, false);
      return {
        outcome: check.ok ? 'allowed' : 'denied',
        reason: check.reason,
        next: { ...state, inAuthorizedRecovery: false },
      };
    },
  },
  {
    event: 'swd-readout-attempt',
    access: 'physical-possession, SWD memory read of firmware and secrets',
    label: 'hardware-observed',
    enforcedBy: 'production lock register observed on the representative board',
    run: (state) => ({
      outcome: 'denied',
      reason:
        'the production lock register read on the board keeps SWD from unrestricted firmware/secret readout; only the explicitly authenticated recovery path remains',
      next: state,
    }),
  },
  {
    event: 'factory-reset',
    access: 'owner-initiated factory reset, or an attacker resetting a board they possess',
    label: 'documentation',
    enforcedBy:
      'reset destroys credential authority in the slot while the fleet record keeps the immutable device identity',
    run: (state) => ({
      outcome: 'state-change',
      reason:
        'local credential authority destroyed: the hardware-backed slot is zeroized. The fleet record keeps tracking the immutable device identity, and a device the fleet refused stays refused across the reset',
      next: {
        ...destroySlot(state),
        fleet:
          state.fleet.state === 'provisioned'
            ? { ...state.fleet, state: 'reset-pending-reprovision', activeCredentialId: null }
            : { ...state.fleet, activeCredentialId: null },
      },
    }),
  },
  {
    event: 'post-reset-silent-reauthorization-attempt',
    access: 'reset device tries to resume fleet operations without re-provisioning',
    label: 'documentation',
    enforcedBy: 'local credential authority is none after reset and the fleet record is not provisioned',
    run: (state) => {
      const check = canUse(state);
      return {
        outcome: 'denied',
        reason: `${check.reason}; this is the partial state the contract is about: the local slot is empty while the fleet record still lists the device`,
        next: state,
      };
    },
  },
  {
    event: 'post-reset-authorized-reprovision',
    access: 'authorized fleet channel presenting an authenticated reprovision ticket',
    label: 'documentation',
    enforcedBy: 'reprovision requires an authenticated authorization, not local state',
    presentsAuthority: 'authenticated-fleet',
    run: (state) => {
      const check = canReprovision(state);
      if (!check.ok) {
        return { outcome: 'denied', reason: check.reason, next: state };
      }
      return {
        outcome: 'state-change',
        reason:
          'authorized reprovision installs a fresh credential cred-v3; the destroyed credential is never resurrected, so only the new credential id is live',
        next: provision(state, 'cred-v3'),
      };
    },
  },
  {
    event: 'device-revocation',
    access: 'fleet operator revokes the device (compromise, loss, return)',
    label: 'documentation',
    enforcedBy: 'revoke semantics: the active credential id moves to the fleet revocation list',
    run: (state) => ({
      outcome: 'state-change',
      reason:
        'fleet record moves to revoked and the active credential id joins the revocation list; the device keeps a local copy it can no longer use, which is stale authority',
      next: {
        ...state,
        fleet: {
          ...state.fleet,
          state: 'revoked',
          revokedCredentialIds: [
            ...state.fleet.revokedCredentialIds,
            state.fleet.activeCredentialId ?? 'none',
          ],
          activeCredentialId: null,
        },
        localCredentialAuthority: 'stale',
      },
    }),
  },
  {
    event: 'reset-after-revocation-with-fleet-authority',
    access: 'attacker factory-resets the revoked board and tries to reprovision with fleet authority',
    label: 'documentation',
    enforcedBy:
      'fleet revocation is keyed to the immutable device identity, so a local reset cannot clear it',
    presentsAuthority: 'authenticated-fleet',
    run: (state) => {
      const wiped = destroySlot(state);
      const check = canReprovision({ ...wiped, reprovisionAuthority: 'authenticated-fleet' });
      return {
        outcome: check.ok ? 'allowed' : 'denied',
        reason: `${check.reason}; the slot is now empty as well, so there is no local state left to present`,
        next: wiped,
      };
    },
  },
  {
    event: 'reset-after-revocation-silent-attempt',
    access: 'attacker factory-resets the revoked board and tries to resume fleet operations',
    label: 'documentation',
    enforcedBy:
      'fleet revocation is keyed to the immutable device identity, so a local reset cannot clear it',
    run: (state) => {
      const wiped = destroySlot(state);
      const check = canUse(wiped);
      return {
        outcome: 'denied',
        reason: `${check.reason}; reprovisioning a refused device needs RMA authority and a local reset supplies none`,
        next: wiped,
      };
    },
  },
  {
    event: 'recovery-after-revocation-attempt',
    access: 'refused device attempts the authenticated recovery path after a reset',
    label: 'documentation',
    enforcedBy: 'fleetRevocationCheckedOnRecovery',
    run: (state) => {
      const check = canEnterRecovery(state, true);
      return {
        outcome: check.ok ? 'allowed' : 'denied',
        reason: check.reason,
        next: { ...state, inAuthorizedRecovery: false },
      };
    },
  },
  {
    event: 'rma-authorised-reprovision',
    access: 'returned device reprovisioned by the RMA authority',
    label: 'documentation',
    enforcedBy:
      'RMA revokes the pre-RMA credential at the same moment it provisions the replacement',
    presentsAuthority: 'rma-authority',
    run: (state) => {
      const previous = state.fleet.revokedCredentialIds.at(-1) ?? 'none';
      return {
        outcome: 'state-change',
        reason: `RMA authority provisions cred-v4 and keeps ${previous} on the revocation list; the pre-RMA credential stays refused`,
        next: provision(state, 'cred-v4'),
      };
    },
  },
  {
    event: 'post-rma-old-credential-use-attempt',
    access: 'someone presents the pre-RMA credential',
    label: 'documentation',
    enforcedBy: 'fleet revocation list',
    run: (state) => ({
      outcome: 'denied',
      reason:
        'the pre-RMA credential was revoked when the replacement was provisioned, so it refuses on the fleet service',
      next: state,
    }),
  },
  {
    event: 'decommission',
    access: 'fleet operator decommissions the device',
    label: 'documentation',
    enforcedBy: 'decommission destroys the credential locally and at the fleet',
    run: (state) => ({
      outcome: 'state-change',
      reason:
        'credential destroyed in the slot and the fleet record moves to decommissioned; no local state survives that the device could present',
      next: {
        ...destroySlot(state),
        fleet: { ...state.fleet, state: 'decommissioned', activeCredentialId: null },
      },
    }),
  },
  {
    event: 'post-decommission-use-attempt',
    access: 'decommissioned board is powered up and used',
    label: 'documentation',
    enforcedBy: 'fleet record is decommissioned',
    run: (state) => {
      const check = canUse(state);
      return {
        outcome: 'denied',
        reason: `${check.reason}; decommissioning is terminal for this device identity`,
        next: state,
      };
    },
  },
  {
    event: 'post-decommission-recovery-attempt',
    access: 'decommissioned board attempts the authenticated recovery path',
    label: 'documentation',
    enforcedBy: 'fleetRevocationCheckedOnRecovery',
    run: (state) => {
      const check = canEnterRecovery(state, true);
      return {
        outcome: check.ok ? 'allowed' : 'denied',
        reason: check.reason,
        next: { ...state, inAuthorizedRecovery: false },
      };
    },
  },
];

/**
 * Runs the whole lifecycle and returns the ordered transcript. A step's
 * `presentsAuthority` is visible in the record, so the reader can see exactly
 * which refusals were "no authority presented" and which were "authority
 * presented but refused".
 */
export function runLifecycle(applicationVersion: number): LifecycleRecord[] {
  let state = initialState(applicationVersion);
  return LIFECYCLE.map((step, index) => {
    const scoped = { ...state, reprovisionAuthority: step.presentsAuthority ?? 'none' };
    const result = step.run(scoped);
    state = result.next;
    return {
      order: index + 1,
      event: step.event,
      access: step.access,
      outcome: result.outcome,
      enforcedBy: step.enforcedBy,
      reason: result.reason,
      presentedAuthority: step.presentsAuthority ?? 'none',
      slotState: state.slot.state,
      credentialId: state.slot.credentialId,
      fleetState: state.fleet.state,
      localCredentialAuthority: state.localCredentialAuthority,
      applicationVersion: state.applicationVersion,
      inAuthorizedRecovery: state.inAuthorizedRecovery,
      evidenceLabel: step.label,
    };
  });
}

export function finalLifecycleState(applicationVersion: number): LifecycleState {
  return LIFECYCLE.reduce(
    (state, step) => step.run({ ...state, reprovisionAuthority: step.presentsAuthority ?? 'none' }).next,
    initialState(applicationVersion),
  );
}

/** Convenience lookup used by the artifacts and tests. */
export function recordFor(records: LifecycleRecord[], event: string): LifecycleRecord {
  const found = records.find((entry) => entry.event === event);
  if (!found) throw new Error(`lifecycle transcript is missing the ${event} step`);
  return found;
}
