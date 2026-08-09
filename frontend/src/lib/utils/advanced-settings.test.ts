import { describe, expect, it } from 'vitest';
import { filterAdvancedSettings, type SearchableAdvancedSetting } from './advanced-settings';

const settings: SearchableAdvancedSetting[] = [
  {
    label: 'Worker Pool',
    description: 'Keep workers warm.',
    category: 'Data & performance',
    impact: 'Reduces startup latency.',
    keywords: ['agents', 'spawn'],
  },
  {
    label: 'Hard Spend Caps',
    description: 'Pause work at configured limits.',
    category: 'Cost & safety',
    impact: 'Contains runaway costs.',
    keywords: ['billing', 'budget'],
  },
];

describe('filterAdvancedSettings', () => {
  it('filters by category while preserving the original order', () => {
    expect(filterAdvancedSettings(settings, 'Cost & safety', '')).toEqual([settings[1]]);
  });

  it('searches labels, descriptions, impact copy, and keywords without case sensitivity', () => {
    expect(filterAdvancedSettings(settings, 'All', 'SPAWN')).toEqual([settings[0]]);
    expect(filterAdvancedSettings(settings, 'All', 'runaway')).toEqual([settings[1]]);
    expect(filterAdvancedSettings(settings, 'All', 'configured limits')).toEqual([settings[1]]);
  });

  it('combines category and query filters and treats whitespace as an empty query', () => {
    expect(filterAdvancedSettings(settings, 'Data & performance', 'budget')).toEqual([]);
    expect(filterAdvancedSettings(settings, 'All', '   ')).toEqual(settings);
  });
});
