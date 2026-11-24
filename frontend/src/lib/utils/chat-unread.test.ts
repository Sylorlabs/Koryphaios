import { describe, expect, it } from 'vitest';
import { ChatUnreadTracker } from './chat-unread';

describe('ChatUnreadTracker', () => {
  it('marks a background chat unread when its turn settles', () => {
    const tracker = new ChatUnreadTracker();
    tracker.observe('a', 'idle', false);
    tracker.observe('a', 'streaming', false);
    expect(tracker.unread.has('a')).toBe(false);
    expect(tracker.observe('a', 'done', false)).toBe(true);
    expect(tracker.unread.has('a')).toBe(true);
  });

  it('never marks the open chat, and opening clears the marker', () => {
    const tracker = new ChatUnreadTracker();
    tracker.observe('a', 'thinking', true);
    tracker.observe('a', 'done', true);
    expect(tracker.unread.has('a')).toBe(false);

    tracker.observe('b', 'thinking', false);
    tracker.observe('b', 'error', false);
    expect(tracker.unread.has('b')).toBe(true);
    expect(tracker.observe('b', 'error', true)).toBe(true);
    expect(tracker.unread.has('b')).toBe(false);
  });

  it('does not mark a chat on its first observation', () => {
    const tracker = new ChatUnreadTracker();
    expect(tracker.observe('a', 'done', false)).toBe(false);
    expect(tracker.unread.size).toBe(0);
  });

  it('keeps sessions isolated and forgets removed ones', () => {
    const tracker = new ChatUnreadTracker();
    tracker.observe('a', 'streaming', false);
    tracker.observe('b', 'streaming', false);
    tracker.observe('a', 'done', false);
    expect([...tracker.unread]).toEqual(['a']);
    expect(tracker.retain(['b'])).toBe(true);
    expect(tracker.unread.size).toBe(0);
  });
});
