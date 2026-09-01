import { describe, expect, it } from 'vitest';
import {
  filterSettingsCatalog,
  resolveSettingsTab,
  SETTINGS_CATALOG,
  SETTINGS_GROUPS,
} from './settings-catalog';

describe('settings catalog', () => {
  it('keeps every destination unique and in stable group order', () => {
    expect(new Set(SETTINGS_CATALOG.map((entry) => entry.id)).size).toBe(SETTINGS_CATALOG.length);
    const groupIndexes = SETTINGS_CATALOG.map((entry) => SETTINGS_GROUPS.indexOf(entry.group));
    expect(groupIndexes).toEqual([...groupIndexes].sort((left, right) => left - right));
  });

  it('searches behavior, scope, and synonyms without reordering matches', () => {
    expect(
      filterSettingsCatalog(SETTINGS_CATALOG, 'token budget').map((entry) => entry.id),
    ).toEqual(['memory']);
    expect(
      filterSettingsCatalog(SETTINGS_CATALOG, 'current project').map((entry) => entry.id),
    ).toEqual(['agent', 'memory', 'notes']);
    expect(filterSettingsCatalog(SETTINGS_CATALOG, 'PAUSE').map((entry) => entry.id)).toEqual([
      'experimental',
    ]);
    expect(
      filterSettingsCatalog(SETTINGS_CATALOG, 'chat history').map((entry) => entry.id),
    ).toEqual(['archived']);
  });

  it('places archived chats precisely in Workspace after Notes', () => {
    const archivedIndex = SETTINGS_CATALOG.findIndex((entry) => entry.id === 'archived');
    expect(archivedIndex).toBeGreaterThan(0);
    expect(SETTINGS_CATALOG[archivedIndex - 1]?.id).toBe('notes');
    expect(SETTINGS_CATALOG[archivedIndex]?.group).toBe('Workspace');
    expect(SETTINGS_CATALOG[archivedIndex]?.scope).toBe('This app');
  });

  it('prefers a contextual destination, then a valid saved pane, then the default', () => {
    expect(resolveSettingsTab('agent', 'appearance')).toBe('agent');
    expect(resolveSettingsTab(undefined, 'appearance')).toBe('appearance');
    expect(resolveSettingsTab(undefined, 'removed-pane')).toBe('providers');
  });
});
