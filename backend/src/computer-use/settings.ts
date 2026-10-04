import {
  COMPUTER_CAPABILITIES,
  COMPUTER_ROLES,
  COMPUTER_TIERS,
  defaultComputerUseSettings,
  type ComputerUseSettings,
  type ComputerPermission,
  type ComputerCapability,
} from '@koryphaios/shared';

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const permission = (value: unknown): ComputerPermission =>
  value === 'allow' || value === 'ask' ? value : 'block';
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);

/** Partial edits retain omitted gates; malformed explicit gates fail closed. App lists replace. */
export function mergeComputerUseSettings(
  base: ComputerUseSettings,
  patch: unknown,
): ComputerUseSettings {
  const next = structuredClone(base);
  if (patch === undefined) return next;
  if (!record(patch)) return defaultComputerUseSettings();
  if (own(patch, 'enabled')) next.enabled = patch.enabled === true;
  for (const [field, keys] of [
    ['byTier', COMPUTER_TIERS],
    ['byRole', COMPUTER_ROLES],
  ] as const) {
    if (!own(patch, field)) continue;
    const layer = patch[field];
    for (const key of keys) {
      const gates = (next[field] as Record<string, Record<ComputerCapability, ComputerPermission>>)[
        key
      ];
      if (record(layer) && !own(layer, key)) continue;
      const values = record(layer) ? layer[key] : null;
      for (const capability of COMPUTER_CAPABILITIES) {
        if (!record(values) || own(values, capability))
          gates[capability] = permission(record(values) ? values[capability] : null);
      }
    }
  }
  if (own(patch, 'apps')) {
    next.apps = [];
    if (Array.isArray(patch.apps) && patch.apps.length <= 200) {
      const seen = new Set<string>();
      const duplicates = new Set<string>();
      for (const app of patch.apps) {
        if (
          !record(app) ||
          typeof app.appId !== 'string' ||
          !app.appId.trim() ||
          app.appId.length > 1024 ||
          /[\x00-\x1f]/.test(app.appId)
        )
          continue;
        if (seen.has(app.appId)) {
          duplicates.add(app.appId);
          continue;
        }
        seen.add(app.appId);
        const capabilities: Partial<Record<ComputerCapability, ComputerPermission>> = {};
        if (record(app.capabilities))
          for (const c of COMPUTER_CAPABILITIES) {
            if (own(app.capabilities, c)) capabilities[c] = permission(app.capabilities[c]);
          }
        next.apps.push({
          appId: app.appId,
          label:
            typeof app.label === 'string'
              ? app.label.replace(/[\x00-\x1f]/g, ' ').slice(0, 256)
              : app.appId.slice(0, 256),
          capabilities,
        });
      }
      // Duplicate identities are ambiguous, never resolve them with first/last-wins grants.
      next.apps = next.apps.filter((app) => !duplicates.has(app.appId));
    }
  }
  return next;
}

export function normalizeComputerUseSettings(value: unknown): ComputerUseSettings {
  return mergeComputerUseSettings(defaultComputerUseSettings(), value);
}
