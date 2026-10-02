import { Storage } from 'happy-dom';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  isSessionActionWarningSuppressed,
  restoreSessionActionWarning,
  suppressSessionActionWarning,
} from './session-action-warnings';

const STORAGE_KEY = 'koryphaios-session-action-warnings-v1';

describe('session action warning dismissals', () => {
  let storage: Storage;

  beforeEach(() => {
    storage = new Storage();
  });

  it('shows every warning until the user opts out', () => {
    expect(isSessionActionWarningSuppressed('archive', storage)).toBe(false);
    expect(isSessionActionWarningSuppressed('delete', storage)).toBe(false);
  });

  it('suppresses one action without touching the other', () => {
    suppressSessionActionWarning('archive', storage);

    expect(isSessionActionWarningSuppressed('archive', storage)).toBe(true);
    expect(isSessionActionWarningSuppressed('delete', storage)).toBe(false);
  });

  it('persists the dismissal for later reads', () => {
    suppressSessionActionWarning('delete', storage);

    expect(JSON.parse(storage.getItem(STORAGE_KEY) ?? '{}')).toEqual({ delete: true });
  });

  it('brings a suppressed warning back', () => {
    suppressSessionActionWarning('delete', storage);
    restoreSessionActionWarning('delete', storage);

    expect(isSessionActionWarningSuppressed('delete', storage)).toBe(false);
  });

  it('keeps warning when stored data is unusable', () => {
    for (const stored of ['not json', '["archive"]', '{"archive":"yes"}', 'null']) {
      storage.setItem(STORAGE_KEY, stored);
      expect(isSessionActionWarningSuppressed('archive', storage)).toBe(false);
    }
  });
});
