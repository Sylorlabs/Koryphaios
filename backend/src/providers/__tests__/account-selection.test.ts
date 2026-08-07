import { describe, expect, test } from 'bun:test';
import { selectConfiguredAccounts } from '../account-selection';

const discovered = [{ id: 'personal' }, { id: 'work' }];

describe('selectConfiguredAccounts', () => {
  test('keeps every discovered account enabled until the user changes a switch', () => {
    expect(selectConfiguredAccounts(discovered, [], undefined)).toEqual(discovered);
  });

  test('uses only explicitly enabled accounts in their saved order', () => {
    expect(selectConfiguredAccounts(discovered, ['work'], true)).toEqual([{ id: 'work' }]);
  });

  test('makes the provider unavailable when every saved account is off', () => {
    expect(selectConfiguredAccounts(discovered, [], true)).toEqual([]);
  });

  test('does not revive an unknown or removed account', () => {
    expect(selectConfiguredAccounts(discovered, ['gone', 'personal'], true)).toEqual([{ id: 'personal' }]);
  });
});
