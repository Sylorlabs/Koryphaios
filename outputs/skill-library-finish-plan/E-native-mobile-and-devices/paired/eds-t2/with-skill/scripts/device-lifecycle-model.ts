/**
 * Authored per-device credential / fleet lifecycle model.
 *
 * WHY THIS FILE EXISTS
 * -------------------
 * The supplied `src/device-sim.ts` models boot, update and recovery decisions.
 * It has no credential, fleet, RMA or decommission state, so the per-device
 * credential lifecycle this task must evidence cannot be derived from it. This
 * module is therefore an *authored* model of the lifecycle contract the fixture
 * README states:
 *
 *   - the per-device credential is provisioned into a hardware-backed slot,
 *   - it is non-exportable,
 *   - it stays protected through update / recovery / RMA,
 *   - rotation and revocation have explicit semantics,
 *   - factory reset destroys or invalidates local credential authority,
 *   - decommission destroys it, and
 *   - fleet revocation prevents a reset/recovered device from silently
 *     regaining authorization.
 *
 * EVIDENCE CLASS
 * --------------
 * Everything produced here is `documentation/simulation`. It shows the
 * state-machine logic of the contract. No result in this file is
 * hardware-observed: the fixed corpus records no credential, key-slot or fleet
 * observation, and the emulator supplies no physical-slot proof
 * (`corpus.emulator.physicalFuseProof=false`). Do not read a `pass` here as a
 * measurement of a real slot.
 *
 * The model is deliberately pure, non-clock and non-random so that
 * `scripts/build-lifecycle-evidence.ts` and `tests/device-lifecycle.test.ts`
 * both re-run it and agree byte for byte.
 */

/** Lifecycle states of the per-device credential. */
export type CredentialState =
  | 'unprovisioned'
  | 'provisioned'
  | 'rotated'
  | 'invalidated'
  | 'destroyed';

/** Fleet-side authorization status for one device id. */
export type FleetStatus = 'authorized' | 'revoked';

export interface CredentialSlot {
  deviceId: string;
  state: CredentialState;
  /** The credential lives in a hardware-backed slot: no read path is modeled. */
  hardwareBacked: boolean;
  /** `credentialExportable=false` in the authored policy. */
  exportable: boolean;
  /** Monotonic credential generation inside the slot. */
  generation: number;
  /** Opaque handle of the credential currently usable from this slot. */
  activeCredentialId: string | null;
  /** Handles invalidated by rotation / reset / RMA: still rejected on use. */
  retiredCredentialIds: string[];
}

export interface FleetRecord {
  statuses: Record<string, FleetStatus>;
  /** Append-only fleet event log; the "fleet record" this task must show. */
  events: string[];
}

/** One lifecycle transition. `ok` is the *authorization outcome*, not a grade. */
export interface Transition {
  ok: boolean;
  reason: string;
  slot: CredentialSlot;
  fleet: FleetRecord;
}

export interface ExportAttempt {
  exported: boolean;
  material: string | null;
  reason: string;
}

export function initialSlot(deviceId: string): CredentialSlot {
  return {
    deviceId,
    state: 'unprovisioned',
    hardwareBacked: true,
    exportable: false,
    generation: 0,
    activeCredentialId: null,
    retiredCredentialIds: [],
  };
}

export function initialFleet(entries: Array<[string, FleetStatus]> = []): FleetRecord {
  return { statuses: Object.fromEntries(entries), events: [] };
}

function credentialId(slot: CredentialSlot, generation: number): string {
  return `${slot.deviceId}/cred-${generation}`;
}

function refuse(slot: CredentialSlot, fleet: FleetRecord, reason: string): Transition {
  return { ok: false, reason, slot, fleet };
}

function accept(
  slot: CredentialSlot,
  fleet: FleetRecord,
  reason: string,
  event?: string,
): Transition {
  return {
    ok: true,
    reason,
    slot,
    fleet: event ? { ...fleet, events: [...fleet.events, event] } : fleet,
  };
}

/** Credential is usable for authorization only from a live, authorized slot. */
function usable(slot: CredentialSlot, fleet: FleetRecord, credentialId: string | null): boolean {
  if (slot.state !== 'provisioned' && slot.state !== 'rotated') return false;
  if (credentialId === null || credentialId !== slot.activeCredentialId) return false;
  if (slot.retiredCredentialIds.includes(credentialId)) return false;
  return fleet.statuses[slot.deviceId] === 'authorized';
}

/**
 * Provision a credential into the hardware-backed slot. Only reachable from an
 * unprovisioned or invalidated slot, i.e. through an authenticated
 * provisioning/recovery/RMA path — never from a live credential.
 */
export function provision(slot: CredentialSlot, fleet: FleetRecord): Transition {
  if (slot.state !== 'unprovisioned' && slot.state !== 'invalidated') {
    return refuse(slot, fleet, `cannot provision from state ${slot.state}`);
  }
  const generation = slot.generation + 1;
  const next: CredentialSlot = {
    ...slot,
    state: 'provisioned',
    generation,
    activeCredentialId: credentialId(slot, generation),
    retiredCredentialIds: [],
  };
  return accept(next, fleet, `provisioned ${next.activeCredentialId} into the hardware-backed slot`);
}

/** Explicit rotate: the previous handle is retired and rejected from then on. */
export function rotate(slot: CredentialSlot, fleet: FleetRecord): Transition {
  if (slot.state !== 'provisioned' && slot.state !== 'rotated') {
    return refuse(slot, fleet, `cannot rotate from state ${slot.state}`);
  }
  if (slot.activeCredentialId === null) {
    return refuse(slot, fleet, 'cannot rotate without an active credential');
  }
  const generation = slot.generation + 1;
  const next: CredentialSlot = {
    ...slot,
    state: 'rotated',
    generation,
    activeCredentialId: credentialId(slot, generation),
    retiredCredentialIds: [...slot.retiredCredentialIds, credentialId(slot, slot.generation)],
  };
  return accept(next, fleet, `rotated to ${next.activeCredentialId}; previous handle retired`);
}

/**
 * Authorize an action with a credential handle. Authorization requires a live
 * slot, the *current* handle and a fleet record that still authorizes the
 * device — revocation therefore denies use without any device contact.
 */
export function use(
  slot: CredentialSlot,
  fleet: FleetRecord,
  credentialId: string | null = slot.activeCredentialId,
): Transition {
  if (slot.state === 'destroyed') {
    return refuse(slot, fleet, 'credential is destroyed (decommissioned)');
  }
  if (slot.state === 'unprovisioned') {
    return refuse(slot, fleet, 'credential is unprovisioned');
  }
  if (slot.state === 'invalidated') {
    return refuse(slot, fleet, 'local credential authority is invalidated (factory reset or RMA)');
  }
  if (credentialId === null || credentialId !== slot.activeCredentialId) {
    return refuse(slot, fleet, `credential ${credentialId ?? 'none'} is not the active handle`);
  }
  if (slot.retiredCredentialIds.includes(credentialId)) {
    return refuse(slot, fleet, `credential ${credentialId} was retired and is rejected`);
  }
  if (fleet.statuses[slot.deviceId] !== 'authorized') {
    return refuse(slot, fleet, `fleet record for ${slot.deviceId} is ${fleet.statuses[slot.deviceId] ?? 'absent'}`);
  }
  return accept(slot, fleet, `credential ${credentialId} authorized`);
}

/**
 * There is no export path in this model. The policy sets
 * `credentialExportable=false`, so an export attempt returns no material
 * rather than a copy.
 */
export function exportCredential(slot: CredentialSlot): ExportAttempt {
  return {
    exported: false,
    material: null,
    reason:
      slot.exportable || !slot.hardwareBacked
        ? 'policy would allow export; the authored policy forbids it'
        : 'no export path exists for a hardware-backed, non-exportable slot',
  };
}

/** Factory reset: local credential authority is destroyed/invalidated. */
export function factoryReset(slot: CredentialSlot, fleet: FleetRecord): Transition {
  if (slot.state === 'destroyed') return refuse(slot, fleet, 'device is already decommissioned');
  const next: CredentialSlot = {
    ...slot,
    state: 'invalidated',
    activeCredentialId: null,
    retiredCredentialIds: [],
  };
  return accept(next, fleet, 'factory reset invalidated local credential authority');
}

/**
 * The "partial state" this fixture insists on: a reset or recovered device that
 * reappears and asks for authorization. It is authorized only through an
 * authenticated provisioning path that consults the fleet record, so a revoked
 * device can never silently regain authorization.
 */
export function silentReauthorizationAttempt(
  slot: CredentialSlot,
  fleet: FleetRecord,
): Transition {
  return use(slot, fleet, slot.activeCredentialId);
}

/**
 * Authenticated re-provisioning after a reset. Both gates must pass: the
 * request itself must be authenticated, and the fleet record must still
 * authorize the device.
 */
export function authenticatedReprovision(
  slot: CredentialSlot,
  fleet: FleetRecord,
  authenticated: boolean,
): Transition {
  if (slot.state !== 'invalidated') {
    return refuse(slot, fleet, `cannot re-provision from state ${slot.state}`);
  }
  if (!authenticated) {
    return refuse(slot, fleet, 're-provisioning request is not authenticated');
  }
  if (fleet.statuses[slot.deviceId] !== 'authorized') {
    return refuse(
      slot,
      fleet,
      `fleet revocation for ${slot.deviceId} blocks re-authorization after reset`,
    );
  }
  return provision(slot, fleet);
}

/**
 * RMA: the previous credential is invalidated first, and a replacement is
 * provisioned only through the authenticated RMA path. An unauthenticated RMA
 * request leaves the slot invalidated with no credential at all.
 */
export function rma(
  slot: CredentialSlot,
  fleet: FleetRecord,
  authenticated: boolean,
): Transition {
  if (slot.state === 'destroyed') return refuse(slot, fleet, 'device is decommissioned');
  const invalidated: CredentialSlot = {
    ...slot,
    state: 'invalidated',
    activeCredentialId: null,
    retiredCredentialIds: [],
  };
  const fleetAfterEvent: FleetRecord = {
    ...fleet,
    events: [...fleet.events, `rma:${invalidated.deviceId}`],
  };
  if (!authenticated) {
    return refuse(
      invalidated,
      fleetAfterEvent,
      'unauthenticated RMA request: previous credential stays invalidated, nothing re-provisioned',
    );
  }
  const provisioned = provision(invalidated, fleetAfterEvent);
  if (!provisioned.ok) return provisioned;
  return accept(
    provisioned.slot,
    { ...provisioned.fleet, events: [...provisioned.fleet.events, `rma-reprovisioned:${slot.deviceId}`] },
    provisioned.reason,
  );
}

/** Fleet-side revocation: no device contact is required or assumed. */
export function revokeFleet(fleet: FleetRecord, deviceId: string): FleetRecord {
  return {
    statuses: { ...fleet.statuses, [deviceId]: 'revoked' },
    events: [...fleet.events, `revoked:${deviceId}`],
  };
}

/** Decommission: destroy the credential and revoke the fleet entry. */
export function decommission(slot: CredentialSlot, fleet: FleetRecord): Transition {
  const destroyed: CredentialSlot = {
    ...slot,
    state: 'destroyed',
    activeCredentialId: null,
    retiredCredentialIds: [],
  };
  const revoked: FleetRecord = revokeFleet(fleet, slot.deviceId);
  return {
    ok: true,
    reason: 'credential destroyed and fleet entry revoked; decommission is final',
    slot: destroyed,
    fleet: { ...revoked, events: [...revoked.events, `decommissioned:${slot.deviceId}`] },
  };
}

/**
 * Update and authorized recovery leave the credential authority intact: the
 * boot transitions that select a slot do not touch the credential slot. This is
 * the contract being modeled; the boot-side half of the claim is demonstrated
 * separately with the supplied simulator (see `recoveryDemonstration` in the
 * evidence artifact).
 */
export function applyUpdate(slot: CredentialSlot, fleet: FleetRecord): Transition {
  return accept(slot, fleet, 'update applied; credential slot untouched');
}

export function enterAuthorizedRecovery(slot: CredentialSlot, fleet: FleetRecord): Transition {
  return accept(slot, fleet, 'authorized recovery entered; credential slot untouched');
}

export interface ScenarioStep {
  action: string;
  ok: boolean;
  detail: string;
  slotState: CredentialState;
  activeCredentialId: string | null;
  fleetStatus: FleetStatus | 'absent';
}

export interface Scenario {
  id: string;
  title: string;
  description: string;
  deviceId: string;
  steps: ScenarioStep[];
  /** The outcome this analysis requires; compared against the model's own run. */
  expected: { ok: boolean; reason: string };
  actual: { ok: boolean; reason: string };
  pass: boolean;
  evidenceClass: 'documentation/simulation';
  hardwareObservation: 'none in this fixture';
}

function step(
  action: string,
  transition: Transition,
  detail?: string,
): ScenarioStep {
  return {
    action,
    ok: transition.ok,
    detail: detail ?? transition.reason,
    slotState: transition.slot.state,
    activeCredentialId: transition.slot.activeCredentialId,
    fleetStatus: transition.fleet.statuses[transition.slot.deviceId] ?? 'absent',
  };
}

function scenario(
  id: string,
  title: string,
  description: string,
  deviceId: string,
  steps: ScenarioStep[],
  final: { ok: boolean; reason: string },
  expected: { ok: boolean; reason: string },
): Scenario {
  return {
    id,
    title,
    description,
    deviceId,
    steps,
    expected,
    actual: { ok: final.ok, reason: final.reason },
    pass: final.ok === expected.ok && final.reason === expected.reason,
    evidenceClass: 'documentation/simulation',
    hardwareObservation: 'none in this fixture',
  };
}

const DEVICE = 'device-x/mcu-rev-c#001';

/**
 * The nine lifecycle cases this task must demonstrate rather than assume:
 * success, invalid/partial state, and the recovery condition.
 */
export function runScenarios(): Scenario[] {
  const scenarios: Scenario[] = [];

  // 1. Success path: provisioned credential is usable.
  {
    const fleet = initialFleet([[DEVICE, 'authorized']]);
    const provisioned = provision(initialSlot(DEVICE), fleet);
    const used = use(provisioned.slot, provisioned.fleet);
    scenarios.push(
      scenario(
        'provision-and-use',
        'provisioned credential authorizes use',
        'A device provisioned into the hardware-backed slot and still authorized in the fleet record can use its credential.',
        DEVICE,
        [step('provision', provisioned), step('use', used)],
        used,
        { ok: true, reason: `credential ${DEVICE}/cred-1 authorized` },
      ),
    );
  }

  // 2. Non-exportability: an export attempt returns no material.
  {
    const fleet = initialFleet([[DEVICE, 'authorized']]);
    const provisioned = provision(initialSlot(DEVICE), fleet);
    const attempt = exportCredential(provisioned.slot);
    scenarios.push(
      scenario(
        'export-attempt-blocked',
        'the credential cannot be exported',
        'The credential is non-exportable: the model exposes no path that yields credential material.',
        DEVICE,
        [
          step('provision', provisioned),
          {
            action: 'export',
            ok: false,
            detail: attempt.reason,
            slotState: provisioned.slot.state,
            activeCredentialId: provisioned.slot.activeCredentialId,
            fleetStatus: 'authorized',
          },
        ],
        { ok: attempt.exported, reason: attempt.reason },
        { ok: false, reason: 'no export path exists for a hardware-backed, non-exportable slot' },
      ),
    );
  }

  // 3. Rotate: the retired handle is rejected, the new one is accepted.
  {
    const fleet = initialFleet([[DEVICE, 'authorized']]);
    const provisioned = provision(initialSlot(DEVICE), fleet);
    const oldId = provisioned.slot.activeCredentialId;
    const rotated = rotate(provisioned.slot, provisioned.fleet);
    const useOld = use(rotated.slot, rotated.fleet, oldId);
    const useNew = use(rotated.slot, rotated.fleet);
    scenarios.push(
      scenario(
        'rotate-invalidates-previous-handle',
        'rotation has explicit semantics',
        'After rotation the previous handle is rejected and only the new handle authorizes use.',
        DEVICE,
        [step('provision', provisioned), step('rotate', rotated), step('use-old-handle', useOld), step('use-new-handle', useNew)],
        useNew,
        { ok: true, reason: `credential ${DEVICE}/cred-2 authorized` },
      ),
    );
  }

  // 4. Fleet revocation denies use without any device contact.
  {
    const fleet = initialFleet([[DEVICE, 'authorized']]);
    const provisioned = provision(initialSlot(DEVICE), fleet);
    const revokedFleet = revokeFleet(provisioned.fleet, DEVICE);
    const used = use(provisioned.slot, revokedFleet);
    scenarios.push(
      scenario(
        'fleet-revocation-denies-use',
        'revocation is enforced fleet-side',
        'A locally intact credential still fails authorization once the fleet record revokes the device.',
        DEVICE,
        [step('provision', provisioned), step('revoke-fleet', { ok: true, reason: `fleet record for ${DEVICE} is revoked`, slot: provisioned.slot, fleet: revokedFleet }), step('use', used)],
        used,
        { ok: false, reason: `fleet record for ${DEVICE} is revoked` },
      ),
    );
  }

  // 5. Factory reset destroys/invalidates local credential authority.
  {
    const fleet = initialFleet([[DEVICE, 'authorized']]);
    const provisioned = provision(initialSlot(DEVICE), fleet);
    const reset = factoryReset(provisioned.slot, provisioned.fleet);
    const used = use(reset.slot, reset.fleet);
    scenarios.push(
      scenario(
        'factory-reset-invalidates-credential',
        'factory reset removes local credential authority',
        'After a factory reset the device holds no usable credential, even though the fleet entry is unchanged.',
        DEVICE,
        [step('provision', provisioned), step('factory-reset', reset), step('use', used)],
        used,
        { ok: false, reason: 'local credential authority is invalidated (factory reset or RMA)' },
      ),
    );
  }

  // 6. The invalid/partial state: a reset device must not silently regain authorization.
  {
    const fleet = initialFleet([[DEVICE, 'authorized']]);
    const provisioned = provision(initialSlot(DEVICE), fleet);
    const reset = factoryReset(provisioned.slot, provisioned.fleet);
    const silent = silentReauthorizationAttempt(reset.slot, reset.fleet);
    const revokedFleet = revokeFleet(reset.fleet, DEVICE);
    const unauthenticated = authenticatedReprovision(reset.slot, revokedFleet, false);
    const revokedReprovision = authenticatedReprovision(reset.slot, revokedFleet, true);
    scenarios.push(
      scenario(
        'reset-device-cannot-silently-regain-authorization',
        'recovery is gated by authentication and the fleet record',
        'A reset device gets no authorization from local state alone; an authenticated re-provisioning request is refused while the fleet entry is revoked.',
        DEVICE,
        [
          step('provision', provisioned),
          step('factory-reset', reset),
          step('silent-reauthorization-attempt', silent),
          step('revoke-fleet', { ok: true, reason: `fleet record for ${DEVICE} is revoked`, slot: reset.slot, fleet: revokedFleet }),
          step('unauthenticated-reprovision', unauthenticated),
          step('authenticated-reprovision-while-revoked', revokedReprovision),
        ],
        revokedReprovision,
        { ok: false, reason: `fleet revocation for ${DEVICE} blocks re-authorization after reset` },
      ),
    );
  }

  // 7. Update and authorized recovery keep the credential usable.
  {
    const fleet = initialFleet([[DEVICE, 'authorized']]);
    const provisioned = provision(initialSlot(DEVICE), fleet);
    const updated = applyUpdate(provisioned.slot, provisioned.fleet);
    const recovered = enterAuthorizedRecovery(updated.slot, updated.fleet);
    const used = use(recovered.slot, recovered.fleet);
    scenarios.push(
      scenario(
        'update-and-authorized-recovery-preserve-credential',
        'update and recovery do not destroy credential authority',
        'Selecting an updated slot or entering authorized recovery leaves the credential slot usable; only reset, RMA and decommission remove it.',
        DEVICE,
        [step('provision', provisioned), step('update', updated), step('authorized-recovery', recovered), step('use', used)],
        used,
        { ok: true, reason: `credential ${DEVICE}/cred-1 authorized` },
      ),
    );
  }

  // 8. RMA invalidates the previous credential and re-provisions only when authenticated.
  {
    const fleet = initialFleet([[DEVICE, 'authorized']]);
    const provisioned = provision(initialSlot(DEVICE), fleet);
    const oldId = provisioned.slot.activeCredentialId;
    const unauthenticated = rma(provisioned.slot, provisioned.fleet, false);
    const useAfterUnauthenticated = use(unauthenticated.slot, unauthenticated.fleet, oldId);
    const authenticated = rma(unauthenticated.slot, unauthenticated.fleet, true);
    const useOldAfterRma = use(authenticated.slot, authenticated.fleet, oldId);
    const useNewAfterRma = use(authenticated.slot, authenticated.fleet);
    scenarios.push(
      scenario(
        'rma-invalidates-previous-credential',
        'RMA does not carry credential authority forward',
        'An unauthenticated RMA request leaves the slot invalidated; an authenticated one provisions a new handle and the previous handle stays rejected.',
        DEVICE,
        [
          step('provision', provisioned),
          step('rma-unauthenticated', unauthenticated),
          step('use-old-handle', useAfterUnauthenticated),
          step('rma-authenticated', authenticated),
          step('use-old-handle', useOldAfterRma),
          step('use-new-handle', useNewAfterRma),
        ],
        useNewAfterRma,
        { ok: true, reason: `credential ${DEVICE}/cred-2 authorized` },
      ),
    );
  }

  // 9. Decommission destroys the credential and blocks everything afterwards.
  {
    const fleet = initialFleet([[DEVICE, 'authorized']]);
    const provisioned = provision(initialSlot(DEVICE), fleet);
    const decommissioned = decommission(provisioned.slot, provisioned.fleet);
    const used = use(decommissioned.slot, decommissioned.fleet);
    const reprovisioned = provision(decommissioned.slot, decommissioned.fleet);
    scenarios.push(
      scenario(
        'decommission-destroys-credential',
        'decommission is final',
        'After decommission the credential is destroyed, use is refused, the fleet entry is revoked and re-provisioning is refused.',
        DEVICE,
        [step('provision', provisioned), step('decommission', decommissioned), step('use', used), step('re-provision', reprovisioned)],
        reprovisioned,
        { ok: false, reason: 'cannot provision from state destroyed' },
      ),
    );
  }

  return scenarios;
}

export function scenarioById(id: string): Scenario {
  const found = runScenarios().find((entry) => entry.id === id);
  if (!found) throw new Error(`no credential lifecycle scenario: ${id}`);
  return found;
}
