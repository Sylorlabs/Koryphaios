export interface SearchableAdvancedSetting {
  label: string;
  description: string;
  category: string;
  impact: string;
  keywords: string[];
}

export function filterAdvancedSettings<T extends SearchableAdvancedSetting>(
  settings: T[],
  category: string,
  query: string,
): T[] {
  const normalizedQuery = query.trim().toLowerCase();
  return settings.filter((setting) => {
    if (category !== 'All' && setting.category !== category) return false;
    if (!normalizedQuery) return true;

    return [
      setting.label,
      setting.description,
      setting.category,
      setting.impact,
      ...setting.keywords,
    ]
      .join(' ')
      .toLowerCase()
      .includes(normalizedQuery);
  });
}
