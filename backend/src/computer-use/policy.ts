import type {
  ComputerCapability,
  ComputerPermission,
  ComputerRole,
  ComputerTier,
  ComputerUseSettings,
} from '@koryphaios/shared';

// Permission settings, rather than a hidden Plan/Critic override, determine
// whether an action is allowed or asks. Explicit role/app blocks still win.
const READ_ONLY = new Set<ComputerCapability>(['discover', 'observe']);
const IMPLEMENTED = new Set<ComputerCapability>([
  'discover',
  'observe',
  'interact',
  'manageWindows',
]);

/** Independent of generic tool allowlists, sub-agent auto approval, and YOLO. */
export function decideComputerPermission(
  settings: ComputerUseSettings,
  tier: ComputerTier,
  role: ComputerRole,
  capability: ComputerCapability,
  appId?: string,
): ComputerPermission {
  if (!settings.enabled || !IMPLEMENTED.has(capability)) return 'block';
  const gates: (ComputerPermission | undefined)[] = [
    settings.byTier?.[tier]?.[capability],
    settings.byRole?.[role]?.[capability],
  ];
  if (capability !== 'discover') {
    const grants = settings.apps.filter((app) => app.appId === appId);
    if (grants.length !== 1) return 'block';
    gates.push(grants[0].capabilities[capability]);
  }
  if (gates.some((gate) => gate !== 'allow' && gate !== 'ask')) return 'block';
  // YOLO is explicitly zero-prompt for Kory approvals. It does not override
  // explicit blocks, disabled authority, invalid targets, or OS capability
  // failures, which are execution failures rather than approval guardrails.
  if (tier === 'yolo') return 'allow';
  return gates.includes('ask') ? 'ask' : 'allow';
}
