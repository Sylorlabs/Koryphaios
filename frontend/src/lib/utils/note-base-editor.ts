import type { NoteBaseField, NotePropertyType } from '@koryphaios/shared';

/** Keep editor affordances aligned with the backend's typed Base compiler. */
export function noteBaseFieldType(field: NoteBaseField | null): NotePropertyType | null {
  if (!field) return null;
  if (field.source === 'property') return field.type;
  switch (field.field) {
    case 'tags':
      return 'tags';
    case 'pinned':
    case 'context':
      return 'checkbox';
    case 'created':
    case 'updated':
      return 'datetime';
    default:
      return 'text';
  }
}

export function noteBaseFieldCanSort(field: NoteBaseField | null): boolean {
  const type = noteBaseFieldType(field);
  return type !== null && type !== 'list' && type !== 'tags';
}

export function defaultNoteBaseFilterValue(
  field: NoteBaseField,
  now = new Date(),
): string | number | boolean {
  const type = noteBaseFieldType(field);
  if (type === 'number') return 0;
  if (type === 'checkbox') return true;
  if (type === 'date') return now.toISOString().slice(0, 10);
  if (type === 'datetime') return now.toISOString();
  return '';
}

export function normalizedNoteBasePropertyKey(key: string): string {
  return key.normalize('NFKC').toLowerCase();
}
