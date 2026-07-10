import { describe, expect, it } from 'bun:test';
import { parseDataviewQuery, runDataviewQuery, renderDataviewQuery, type DataviewNote } from './dataview';

const notes: DataviewNote[] = [
  { id: 'a', title: 'Alpha', content: 'about kubernetes', folderPath: '/projects', tags: ['work', 'infra'], pinned: true, includeInContext: false, createdAt: new Date('2024-01-01'), updatedAt: new Date('2024-06-01') },
  { id: 'b', title: 'Beta', content: 'about design', folderPath: '/projects/ui', tags: ['work'], pinned: false, includeInContext: true, createdAt: new Date('2024-02-01'), updatedAt: new Date('2024-05-01') },
  { id: 'c', title: 'Gamma', content: 'personal note', folderPath: '/personal', tags: ['life'], pinned: false, includeInContext: false, createdAt: new Date('2024-03-01'), updatedAt: new Date('2024-04-01') },
];

describe('dataview parser', () => {
  it('parses a LIST query with FROM/WHERE/SORT/LIMIT', () => {
    const q = parseDataviewQuery('LIST FROM #work WHERE pinned = true SORT title desc LIMIT 5');
    expect(q.kind).toBe('LIST');
    expect(q.from).toEqual({ type: 'tag', value: 'work' });
    expect(q.where.clauses[0]).toEqual({ field: 'pinned', op: '=', value: 'true' });
    expect(q.sort).toEqual({ field: 'title', dir: 'desc' });
    expect(q.limit).toBe(5);
  });

  it('parses a TABLE query with columns', () => {
    const q = parseDataviewQuery('TABLE folder, updated FROM "projects"');
    expect(q.kind).toBe('TABLE');
    expect(q.columns).toEqual(['folder', 'updated']);
    expect(q.from).toEqual({ type: 'folder', value: 'projects' });
  });

  it('throws on a non-LIST/TABLE query', () => {
    expect(() => parseDataviewQuery('DELETE everything')).toThrow();
  });
});

describe('dataview evaluation', () => {
  it('filters by tag source', () => {
    const rows = runDataviewQuery('LIST FROM #work', notes);
    expect(rows.map((r) => r.id).sort()).toEqual(['a', 'b']);
  });

  it('filters by folder source (includes subfolders)', () => {
    const rows = runDataviewQuery('LIST FROM "projects"', notes);
    expect(rows.map((r) => r.id).sort()).toEqual(['a', 'b']);
  });

  it('applies WHERE with boolean and contains', () => {
    expect(runDataviewQuery('LIST WHERE pinned = true', notes).map((r) => r.id)).toEqual(['a']);
    expect(runDataviewQuery('LIST WHERE content contains design', notes).map((r) => r.id)).toEqual(['b']);
  });

  it('supports AND / OR joiners', () => {
    expect(runDataviewQuery('LIST WHERE pinned = true AND context = true', notes)).toHaveLength(0);
    expect(runDataviewQuery('LIST WHERE pinned = true OR context = true', notes).map((r) => r.id).sort()).toEqual(['a', 'b']);
  });

  it('sorts and limits', () => {
    const rows = runDataviewQuery('LIST SORT title desc LIMIT 2', notes);
    expect(rows.map((r) => r.id)).toEqual(['c', 'b']);
  });

  it('sorts by date field numerically', () => {
    const rows = runDataviewQuery('LIST SORT updated asc', notes);
    expect(rows.map((r) => r.id)).toEqual(['c', 'b', 'a']);
  });
});

describe('dataview rendering', () => {
  it('renders a LIST as clickable wikilinks', () => {
    const html = renderDataviewQuery('LIST FROM #work SORT title asc', notes);
    expect(html).toContain('dataview-list');
    expect(html).toContain('data-note-title="Alpha"');
    expect(html).toContain('data-note-title="Beta"');
  });

  it('renders a TABLE with headers and cells', () => {
    const html = renderDataviewQuery('TABLE folder FROM #work', notes);
    expect(html).toContain('dataview-table');
    expect(html).toContain('<th>folder</th>');
    expect(html).toContain('/projects');
  });

  it('renders an empty state', () => {
    expect(renderDataviewQuery('LIST WHERE title = Nonexistent', notes)).toContain('No results');
  });

  it('renders an error box instead of throwing', () => {
    expect(renderDataviewQuery('NONSENSE', notes)).toContain('dataview-error');
  });
});
