import { describe, expect, test } from 'bun:test';
import { timeTravelDegradedResponse, withSessionRecoveryGuard } from './session-recovery-guard';

describe('session recovery route guard', () => {
  test('returns busy without acquiring the process barrier when the manager lease is unavailable', async () => {
    let processAcquired = 0;
    let ran = 0;
    const result = await withSessionRecoveryGuard({
      tryAcquireManager: () => null,
      tryAcquireProcess: () => {
        processAcquired++;
        return { release() {} };
      },
      onBusy: () => 'busy',
      run: async () => {
        ran++;
        return 'ran';
      },
    });
    expect(result).toBe('busy');
    expect(processAcquired).toBe(0);
    expect(ran).toBe(0);
  });

  test('returns busy and releases the manager lease when the process barrier cannot be acquired', async () => {
    let ran = 0;
    let managerReleases = 0;
    const result = await withSessionRecoveryGuard({
      tryAcquireManager: () => ({ release: () => managerReleases++ }),
      tryAcquireProcess: () => null,
      onBusy: () => 'busy',
      run: async () => {
        ran++;
        return 'ran';
      },
    });
    expect(result).toBe('busy');
    expect(ran).toBe(0);
    expect(managerReleases).toBe(1);
  });

  test('holds through the operation and releases exactly once on success', async () => {
    let managerHeld = false;
    let processHeld = false;
    let managerReleases = 0;
    let processReleases = 0;
    const result = await withSessionRecoveryGuard({
      tryAcquireManager: () => {
        managerHeld = true;
        return {
          release() {
            managerHeld = false;
            managerReleases++;
          },
        };
      },
      tryAcquireProcess: () => {
        processHeld = true;
        return {
          release: () => {
            processHeld = false;
            processReleases++;
          },
        };
      },
      onBusy: () => 'busy',
      run: async () => {
        expect(managerHeld).toBe(true);
        expect(processHeld).toBe(true);
        return 'recovered';
      },
    });
    expect(result).toBe('recovered');
    expect(managerHeld).toBe(false);
    expect(processHeld).toBe(false);
    expect(managerReleases).toBe(1);
    expect(processReleases).toBe(1);
  });

  test('releases in finally when preview or recovery throws', async () => {
    let managerReleases = 0;
    let processReleases = 0;
    await expect(
      withSessionRecoveryGuard({
        tryAcquireManager: () => ({
          release() {
            managerReleases++;
          },
        }),
        tryAcquireProcess: () => ({ release: () => processReleases++ }),
        onBusy: () => 'busy',
        run: async () => {
          throw new Error('injected recovery failure');
        },
      }),
    ).rejects.toThrow('injected recovery failure');
    expect(managerReleases).toBe(1);
    expect(processReleases).toBe(1);
  });

  test('reports missing or corrupt history as a bounded degraded response', () => {
    const response = timeTravelDegradedResponse(
      new Error(`Unreconciled recovery journal\n${'corrupt shadow storage '.repeat(40)}`),
    );

    expect(response.ok).toBe(false);
    expect(response.degraded).toBe(true);
    expect(response.error).toStartWith('Time Travel history is unavailable:');
    expect(response.error.length).toBeLessThanOrEqual(500);
    expect(response.error).not.toContain('\n');
    expect(response.data.timeline).toEqual([]);
    expect(response.data.canUndo).toBe(false);
  });
});
