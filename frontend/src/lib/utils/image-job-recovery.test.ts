import { beforeEach, describe, expect, test } from 'vitest';
import {
  clearRecoverableImageJob,
  loadRecoverableImageJob,
  saveRecoverableImageJob,
} from './image-job-recovery';

describe('active image job recovery', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  test('stores only an opaque short-lived job id in sessionStorage', () => {
    const recovered = saveRecoverableImageJob('job-1');

    expect(recovered?.jobId).toBe('job-1');
    expect(recovered?.expiresAt).toBeGreaterThan(Date.now());
    expect(loadRecoverableImageJob()).toEqual(recovered);
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(1);
  });

  test('fails closed and prunes expired records', () => {
    sessionStorage.setItem(
      'koryphaios-active-image-job-v1',
      JSON.stringify({ jobId: 'stale', expiresAt: Date.now() - 1 }),
    );

    expect(loadRecoverableImageJob()).toBeNull();
    expect(sessionStorage.length).toBe(0);
  });

  test('clears only when the caller reaches a terminal outcome', () => {
    saveRecoverableImageJob('job-1');
    clearRecoverableImageJob();
    expect(loadRecoverableImageJob()).toBeNull();
  });
});
