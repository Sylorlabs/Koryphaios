export type CriticMode = 'auto' | 'always' | 'off';

export function isCriticMode(value: unknown): value is CriticMode {
  return value === 'auto' || value === 'always' || value === 'off';
}

/** Resolve one settings layer before applying a higher-authority layer. */
export function resolveCriticMode(
  settings?: { criticMode?: unknown; criticGateEnabled?: unknown },
  fallback: CriticMode = 'auto',
): CriticMode {
  if (isCriticMode(settings?.criticMode)) return settings.criticMode;
  if (typeof settings?.criticGateEnabled === 'boolean') {
    return settings.criticGateEnabled ? 'always' : 'off';
  }
  return fallback;
}

export const CRITIC_MODE_OPTIONS = [
  { value: 'off', label: 'Off' },
  { value: 'auto', label: 'Auto' },
  { value: 'always', label: 'Always' },
] as const;
