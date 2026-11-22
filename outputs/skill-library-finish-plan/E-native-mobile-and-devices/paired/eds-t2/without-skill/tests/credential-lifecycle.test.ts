/**
 * Verification of the per-device credential lifecycle.
 *
 * The contract states properties (hardware-backed, non-exportable, protected
 * through update/recovery/RMA, rotate/revoke semantics, reset and decommission
 * destruction, fleet revocation on recovery). These tests execute the lifecycle
 * in `scripts/credential-lifecycle.ts` and check the outcomes, so the recovery
 * condition and the invalid/partial state are demonstrated rather than assumed.
 */
import { describe, expect, test } from 'bun:test';
import {
  LIFECYCLE,
  recordFor,
  runLifecycle,
  type LifecycleRecord,
} from '../scripts/credential-lifecycle';
import { readCorpus } from '../scripts/kory-artifact';

const transcript: LifecycleRecord[] = runLifecycle(7);
const step = (event: string): LifecycleRecord => recordFor(transcript, event);
const outcomes = transcript.map((entry) => `${entry.event}=${entry.outcome}`);

describe('the lifecycle transcript is complete and ordered', () => {
  test('every declared step ran exactly once, in order', () => {
    expect(transcript.length).toBe(LIFECYCLE.length);
    expect(transcript.map((entry) => entry.event)).toEqual(LIFECYCLE.map((entry) => entry.event));
    transcript.forEach((entry, index) => expect(entry.order).toBe(index + 1));
  });

  test('the transcript contains no unexplained negative outcome', () => {
    for (const entry of transcript) {
      expect(entry.enforcedBy.length, entry.event).toBeGreaterThan(0);
      expect(entry.reason.length, entry.event).toBeGreaterThan(0);
    }
  });

  test('the successful path is a real path, not a happy path only', () => {
    const allowed = transcript.filter((entry) => entry.outcome === 'allowed');
    expect(allowed.length).toBeGreaterThan(0);
    const denied = transcript.filter((entry) => entry.outcome === 'denied');
    expect(denied.length).toBeGreaterThan(allowed.length);
  });
});

describe('provisioning, storage and exportability', () => {
  test('the credential is provisioned into a hardware-backed slot', () => {
    expect(step('manufacturing-provision').outcome).toBe('state-change');
    expect(step('manufacturing-provision').slotState).toBe('provisioned');
    expect(step('manufacturing-provision').credentialId).toBe('cred-v1');
  });

  test('no interface can export the credential', () => {
    expect(step('credential-export-attempt').outcome).toBe('denied');
    expect(step('credential-export-attempt').reason).toContain('non-exportable');
  });

  test('a provisioned device authenticates to the fleet service', () => {
    expect(step('authenticated-use').outcome).toBe('allowed');
  });
});

describe('rotation and revocation semantics', () => {
  test('rotation revokes the previous credential in the same operation', () => {
    expect(step('credential-rotate').outcome).toBe('state-change');
    expect(step('credential-rotate').credentialId).toBe('cred-v2');
    expect(step('stale-credential-use').outcome).toBe('denied');
  });

  test('revocation leaves the device holding only stale local authority', () => {
    expect(step('device-revocation').outcome).toBe('state-change');
    expect(step('device-revocation').fleetState).toBe('revoked');
    expect(step('device-revocation').localCredentialAuthority).toBe('stale');
  });

  test('a pre-RMA credential stays refused after RMA reprovisioning', () => {
    expect(step('rma-authorised-reprovision').outcome).toBe('state-change');
    expect(step('post-rma-old-credential-use-attempt').outcome).toBe('denied');
  });
});

describe('the credential survives update, recovery and RMA', () => {
  test('an authenticated update does not clear the credential', () => {
    const update = step('authenticated-application-update');
    expect(update.outcome).toBe('state-change');
    expect(update.applicationVersion).toBe(8);
    expect(update.slotState).toBe('provisioned');
    expect(update.credentialId).toBe('cred-v2');
  });

  test('authorized recovery keeps the credential provisioned', () => {
    expect(step('authorized-recovery-entry').outcome).toBe('allowed');
    expect(step('authorized-recovery-entry').inAuthorizedRecovery).toBe(true);
    expect(step('authorized-recovery-entry').credentialId).toBe('cred-v2');
  });

  test('recovery without the separate authorization is refused', () => {
    expect(step('unauthorized-recovery-entry').outcome).toBe('denied');
    expect(step('unauthorized-recovery-entry').inAuthorizedRecovery).toBe(false);
  });
});

describe('factory reset and the invalid/partial state', () => {
  test('reset destroys local credential authority', () => {
    const reset = step('factory-reset');
    expect(reset.outcome).toBe('state-change');
    expect(reset.slotState).toBe('destroyed');
    expect(reset.credentialId).toBeNull();
    expect(reset.localCredentialAuthority).toBe('none');
    expect(reset.fleetState).toBe('reset-pending-reprovision');
  });

  test('the partial state after reset is not an authorization', () => {
    const attempt = step('post-reset-silent-reauthorization-attempt');
    expect(attempt.outcome).toBe('denied');
    expect(attempt.reason).toContain('partial state');
    expect(attempt.localCredentialAuthority).toBe('none');
  });

  test('an authorized reprovision is the only way back after a reset', () => {
    const reprovision = step('post-reset-authorized-reprovision');
    expect(reprovision.outcome).toBe('state-change');
    expect(reprovision.presentedAuthority).toBe('authenticated-fleet');
    expect(reprovision.credentialId).toBe('cred-v3');
  });
});

describe('fleet revocation defeats a reset-and-retry device', () => {
  test('fleet authority alone cannot reprovision a device the fleet refused', () => {
    const attempt = step('reset-after-revocation-with-fleet-authority');
    expect(attempt.outcome).toBe('denied');
    expect(attempt.presentedAuthority).toBe('authenticated-fleet');
    expect(attempt.reason).toContain('RMA authority');
  });

  test('a silent attempt after a reset is refused by the immutable device identity', () => {
    const attempt = step('reset-after-revocation-silent-attempt');
    expect(attempt.outcome).toBe('denied');
    expect(attempt.fleetState).toBe('revoked');
  });

  test('revocation is checked on recovery, so a refused device stays refused', () => {
    const attempt = step('recovery-after-revocation-attempt');
    expect(attempt.outcome).toBe('denied');
    expect(attempt.reason).toContain('fleet revocation is checked on recovery');
  });
});

describe('decommission is terminal', () => {
  test('decommission destroys the credential locally and at the fleet', () => {
    const decommission = step('decommission');
    expect(decommission.outcome).toBe('state-change');
    expect(decommission.slotState).toBe('destroyed');
    expect(decommission.fleetState).toBe('decommissioned');
    expect(decommission.localCredentialAuthority).toBe('none');
  });

  test('later use and later recovery are both refused', () => {
    expect(step('post-decommission-use-attempt').outcome).toBe('denied');
    expect(step('post-decommission-recovery-attempt').outcome).toBe('denied');
  });

  test('the final state has no credential authority left to present', () => {
    const last = transcript.at(-1);
    expect(last?.slotState).toBe('destroyed');
    expect(last?.localCredentialAuthority).toBe('none');
    expect(last?.fleetState).toBe('decommissioned');
  });
});

describe('the transcript matches the corpus facts it is derived from', () => {
  test('the update step advances from the corpus application version', () => {
    const corpus = readCorpus();
    expect(corpus.images.find((image) => image.id === 'current')?.version).toBe(7);
    expect(step('authenticated-application-update').applicationVersion).toBe(8);
  });

  test('the whole transcript is reproducible in one pass', () => {
    expect(runLifecycle(7)).toEqual(transcript);
    expect(outcomes.length).toBe(transcript.length);
  });
});
