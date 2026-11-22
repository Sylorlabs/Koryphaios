import {
  DEFAULT_MESSAGING_PERMISSIONS,
  type MessagingPermissionLevel,
  type MessagingPermissionsByTier,
  type MessagingTierKey,
} from '@koryphaios/shared';

export type MessagingRoleKey = 'manager' | 'subAgents';

/** Effective cell value: a stored override wins, else the preset default. */
export function messagingCellState(
  overrides: MessagingPermissionsByTier | undefined,
  tier: MessagingTierKey,
  role: MessagingRoleKey,
): MessagingPermissionLevel {
  return overrides?.[tier]?.[role] ?? DEFAULT_MESSAGING_PERMISSIONS[tier][role];
}

/** True when at least one role column for this tier is overridden. */
export function messagingTierOverridden(
  overrides: MessagingPermissionsByTier | undefined,
  tier: MessagingTierKey,
): boolean {
  const cell = overrides?.[tier];
  return cell?.manager !== undefined || cell?.subAgents !== undefined;
}

/** Merge a cell change into the overrides map for saving. Setting a cell back
 *  to its preset default deletes the stored override, and dropping the last
 *  role in a tier removes the tier entry entirely. */
export function withMessagingCell(
  overrides: MessagingPermissionsByTier | undefined,
  tier: MessagingTierKey,
  role: MessagingRoleKey,
  level: MessagingPermissionLevel,
): MessagingPermissionsByTier {
  const next = { ...(overrides ?? {}) };
  const cell = { ...(next[tier] ?? {}) };
  if (level === DEFAULT_MESSAGING_PERMISSIONS[tier][role]) {
    delete cell[role];
  } else {
    cell[role] = level;
  }
  if (cell.manager !== undefined || cell.subAgents !== undefined) {
    next[tier] = cell;
  } else {
    delete next[tier];
  }
  return next;
}

/** Merge removing a whole tier's overrides (row reset). */
export function withoutMessagingTier(
  overrides: MessagingPermissionsByTier | undefined,
  tier: MessagingTierKey,
): MessagingPermissionsByTier {
  const next = { ...(overrides ?? {}) };
  delete next[tier];
  return next;
}
