// Inter-agent messaging permission policy, per permission preset tier.
// Governs whether an agent may message agents in *other* chats; agents in the
// same chat always exchange mail freely.

export type MessagingPermissionLevel = 'allow' | 'ask' | 'block';

export type MessagingRole = 'manager' | 'subAgent';

export type MessagingTierKey = 'yolo' | 'guarded' | 'edits' | 'ask' | 'custom';

export interface MessagingTierPermissions {
  manager?: MessagingPermissionLevel;
  subAgents?: MessagingPermissionLevel;
}

export type MessagingPermissionsByTier = Partial<
  Record<MessagingTierKey, MessagingTierPermissions>
>;

export const MESSAGING_TIERS: readonly MessagingTierKey[] = [
  'yolo',
  'guarded',
  'edits',
  'ask',
  'custom',
];

export const DEFAULT_MESSAGING_PERMISSIONS: Record<
  MessagingTierKey,
  Required<MessagingTierPermissions>
> = {
  yolo: { manager: 'allow', subAgents: 'allow' },
  guarded: { manager: 'allow', subAgents: 'ask' },
  edits: { manager: 'ask', subAgents: 'ask' },
  ask: { manager: 'ask', subAgents: 'ask' },
  custom: { manager: 'ask', subAgents: 'ask' },
};

function tierKeyOf(mode: string | undefined): MessagingTierKey {
  const candidate = mode as MessagingTierKey | undefined;
  return candidate && candidate in DEFAULT_MESSAGING_PERMISSIONS ? candidate : 'ask';
}

/** Effective rule for the sender: a stored tier override wins, otherwise the
 *  preset default above. `role` describes the sender, not the recipient. */
export function resolveMessagingPermission(
  settings: {
    permissionMode?: string;
    messagingPermissionsByTier?: MessagingPermissionsByTier;
  },
  role: MessagingRole,
): MessagingPermissionLevel {
  const tier = tierKeyOf(settings.permissionMode);
  const roleKey = role === 'manager' ? 'manager' : 'subAgents';
  return settings.messagingPermissionsByTier?.[tier]?.[roleKey] ?? DEFAULT_MESSAGING_PERMISSIONS[tier][roleKey];
}
