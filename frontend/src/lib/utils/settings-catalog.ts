export type SettingsTab =
  | 'providers'
  | 'agent'
  | 'memory'
  | 'notes'
  | 'appearance'
  | 'shortcuts'
  | 'voice'
  | 'teams'
  | 'billing'
  | 'experimental'
  | 'images';

export type SettingsGroup = 'Intelligence' | 'Workspace' | 'Experience' | 'Operations';

export interface SettingsCatalogEntry {
  id: SettingsTab;
  label: string;
  description: string;
  scope: 'This device' | 'This app' | 'Current project' | 'Current hosted session';
  group: SettingsGroup;
  keywords: string[];
}

/** Stable, intentionally small Settings information architecture.
 *
 * Task-specific controls remain next to the task that they affect. This
 * catalog contains durable or infrequently changed preferences and truthful
 * capability/status panes only. Ordering is a product contract: search never
 * reorders entries, so muscle memory remains useful as the catalog grows.
 */
export const SETTINGS_CATALOG: readonly SettingsCatalogEntry[] = [
  {
    id: 'providers',
    label: 'Providers & models',
    description: 'Accounts, endpoints, model access, and provider fallback order.',
    scope: 'This app',
    group: 'Intelligence',
    keywords: ['ai', 'model', 'account', 'authentication', 'api key', 'cli', 'fallback'],
  },
  {
    id: 'agent',
    label: 'Agent behavior',
    description: 'Permissions, quality gates, workflows, context, research, and routing.',
    scope: 'Current project',
    group: 'Intelligence',
    keywords: ['permission', 'autonomy', 'critic', 'planning', 'skills', 'sandbox', 'tools'],
  },
  {
    id: 'memory',
    label: 'Memory',
    description: 'Universal, project, session, and rule context used by agents.',
    scope: 'Current project',
    group: 'Workspace',
    keywords: ['context', 'remember', 'rules', 'token budget', 'universal', 'session'],
  },
  {
    id: 'notes',
    label: 'Notes',
    description: 'Long-form knowledge, agent access, context budgets, and graph behavior.',
    scope: 'Current project',
    group: 'Workspace',
    keywords: ['essay', 'knowledge', 'wikilink', 'graph', 'budget', 'agent permissions'],
  },
  {
    id: 'teams',
    label: 'Team access',
    description: 'Hosted-session paths, invitations, access profiles, and join policy.',
    scope: 'Current hosted session',
    group: 'Workspace',
    keywords: ['collaboration', 'guest', 'invite', 'relay', 'access', 'share'],
  },
  {
    id: 'appearance',
    label: 'Appearance',
    description: 'Theme, accent color, and interface typography.',
    scope: 'This device',
    group: 'Experience',
    keywords: ['theme', 'color', 'font', 'contrast', 'dark', 'light'],
  },
  {
    id: 'shortcuts',
    label: 'Keyboard shortcuts',
    description: 'Global keyboard bindings and their recommended defaults.',
    scope: 'This device',
    group: 'Experience',
    keywords: ['keys', 'binding', 'command', 'hotkey', 'focus'],
  },
  {
    id: 'voice',
    label: 'Voice',
    description: 'Detected speech output and explicit unavailable speech capabilities.',
    scope: 'This device',
    group: 'Experience',
    keywords: ['speech', 'tts', 'dictation', 'microphone', 'audio', 'preview'],
  },
  {
    id: 'billing',
    label: 'Usage & billing',
    description: 'Recorded metered usage and balances reported by connected providers.',
    scope: 'This app',
    group: 'Operations',
    keywords: ['cost', 'spend', 'credits', 'quota', 'subscription', 'tokens'],
  },
  {
    id: 'experimental',
    label: 'Safety limits',
    description: 'Runtime-enforced spend limits and recovery for paused sessions.',
    scope: 'This app',
    group: 'Operations',
    keywords: ['advanced', 'budget', 'cap', 'pause', 'block', 'recovery', 'limit'],
  },
  {
    id: 'images',
    label: 'Image capabilities',
    description: 'Truthful status for image inspection, generation, and editing.',
    scope: 'This app',
    group: 'Operations',
    keywords: ['image', 'vision', 'generation', 'editing', 'capability'],
  },
] as const;

export const SETTINGS_GROUPS: readonly SettingsGroup[] = [
  'Intelligence',
  'Workspace',
  'Experience',
  'Operations',
];

export function filterSettingsCatalog(
  entries: readonly SettingsCatalogEntry[],
  query: string,
): SettingsCatalogEntry[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return [...entries];
  return entries.filter((entry) =>
    [entry.label, entry.description, entry.scope, entry.group, ...entry.keywords]
      .join(' ')
      .toLocaleLowerCase()
      .includes(normalized),
  );
}

export function isSettingsTab(value: unknown): value is SettingsTab {
  return typeof value === 'string' && SETTINGS_CATALOG.some((entry) => entry.id === value);
}

export function resolveSettingsTab(
  requested: unknown,
  persisted: unknown,
  fallback: SettingsTab = 'providers',
): SettingsTab {
  if (isSettingsTab(requested)) return requested;
  if (isSettingsTab(persisted)) return persisted;
  return fallback;
}
