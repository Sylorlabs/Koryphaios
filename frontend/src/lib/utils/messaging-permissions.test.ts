import { describe, expect, it } from 'vitest';
import { DEFAULT_MESSAGING_PERMISSIONS, MESSAGING_TIERS } from '@koryphaios/shared';
import {
  messagingCellState,
  messagingTierOverridden,
  withMessagingCell,
  withoutMessagingTier,
} from './messaging-permissions';

describe('inter-agent messaging grid state', () => {
  it('renders the preset defaults for every tier and role', () => {
    for (const tier of MESSAGING_TIERS) {
      expect(messagingCellState(undefined, tier, 'manager')).toBe(
        DEFAULT_MESSAGING_PERMISSIONS[tier].manager,
      );
      expect(messagingCellState(undefined, tier, 'subAgents')).toBe(
        DEFAULT_MESSAGING_PERMISSIONS[tier].subAgents,
      );
      expect(messagingTierOverridden(undefined, tier)).toBe(false);
    }
  });

  it('stores a non-default cell and marks the tier overridden', () => {
    const next = withMessagingCell(undefined, 'ask', 'manager', 'allow');
    expect(next).toEqual({ ask: { manager: 'allow' } });
    expect(messagingCellState(next, 'ask', 'manager')).toBe('allow');
    expect(messagingCellState(next, 'ask', 'subAgents')).toBe('ask');
    expect(messagingTierOverridden(next, 'ask')).toBe(true);
  });

  it('setting a cell back to its default deletes the stored override', () => {
    const start = withMessagingCell(undefined, 'yolo', 'subAgents', 'block');
    const reverted = withMessagingCell(start, 'yolo', 'subAgents', 'allow');
    expect(reverted).toEqual({});
  });

  it('dropping the last role removes the whole tier entry', () => {
    const start = withMessagingCell(
      withMessagingCell(undefined, 'edits', 'manager', 'block'),
      'edits',
      'subAgents',
      'allow',
    );
    const partial = withMessagingCell(start, 'edits', 'manager', 'ask');
    expect(partial).toEqual({ edits: { subAgents: 'allow' } });
    const emptied = withMessagingCell(partial, 'edits', 'subAgents', 'ask');
    expect(emptied).toEqual({});
  });

  it('reset removes the whole tier without touching others', () => {
    const start = withMessagingCell(
      withMessagingCell(undefined, 'ask', 'manager', 'allow'),
      'guarded',
      'subAgents',
      'allow',
    );
    const next = withoutMessagingTier(start, 'ask');
    expect(next).toEqual({ guarded: { subAgents: 'allow' } });
    expect(messagingCellState(next, 'ask', 'manager')).toBe('ask');
  });
});
