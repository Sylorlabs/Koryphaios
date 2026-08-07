import { describe, expect, it } from 'bun:test';
import { excludeCurrentPersistedMessage } from './conversation-history';

describe('excludeCurrentPersistedMessage', () => {
  it('removes only the persisted row for the current provider dispatch', () => {
    const history = [
      { id: 'earlier', content: 'hey' },
      { id: 'current', content: 'hey' },
    ];

    expect(excludeCurrentPersistedMessage(history, 'current')).toEqual([
      { id: 'earlier', content: 'hey' },
    ]);
  });

  it('keeps history unchanged when the current message was not persisted', () => {
    const history = [{ id: 'current', content: 'hey' }];
    expect(excludeCurrentPersistedMessage(history)).toEqual(history);
  });
});
