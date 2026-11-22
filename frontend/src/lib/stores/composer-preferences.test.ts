import { describe, expect, it } from 'vitest';
import { initialSpeedTier } from './composer-preferences';
import type { ModelSpeedTier } from '@koryphaios/shared';

const fast: ModelSpeedTier[] = [{ id: 'fast', label: 'Fast', description: 'faster' }];
const two: ModelSpeedTier[] = [
  { id: 'a', label: 'A', description: 'a' },
  { id: 'b', label: 'B', description: 'b' },
];

describe('initialSpeedTier', () => {
  it('defaults to off when the model has no saved choice', () => {
    expect(initialSpeedTier({}, fast)).toBeNull();
    expect(initialSpeedTier({ speedTier: undefined }, fast)).toBeNull();
  });

  it('restores the saved tier when the model still offers it', () => {
    expect(initialSpeedTier({ speedTier: 'fast' }, fast)).toBe('fast');
    expect(initialSpeedTier({ speedTier: 'b' }, two)).toBe('b');
  });

  it('rejects a saved tier the model no longer offers', () => {
    expect(initialSpeedTier({ speedTier: 'ultraspeed' }, fast)).toBeNull();
    expect(initialSpeedTier({ speedTier: 'b' }, fast)).toBeNull();
    expect(initialSpeedTier({ speedTier: 'a' }, [])).toBeNull();
  });

  it('migrates a legacy saved fastMode:true onto the first tier', () => {
    expect(initialSpeedTier({ fastMode: true }, fast)).toBe('fast');
    expect(initialSpeedTier({ fastMode: true }, two)).toBe('a');
  });

  it('prefers a valid saved speedTier over the legacy flag', () => {
    expect(initialSpeedTier({ speedTier: 'b', fastMode: true }, two)).toBe('b');
    // A stale speedTier does not block the legacy migration.
    expect(initialSpeedTier({ speedTier: 'gone', fastMode: true }, fast)).toBe('fast');
  });

  it('stays off for legacy fastMode:false and when no tiers exist', () => {
    expect(initialSpeedTier({ fastMode: false }, fast)).toBeNull();
    expect(initialSpeedTier({ fastMode: true }, [])).toBeNull();
    expect(initialSpeedTier({ speedTier: null }, fast)).toBeNull();
  });
});
