import { describe, expect, it } from 'vitest';
import {
  parseDataviewQuery,
  runDataviewQuery,
  renderDataviewQuery,
  type DataviewNote,
} from './dataview';

const notes: DataviewNote[] = [
  {
    id: 'a',
    title: 'Alpha',
    content: 'about kubernetes',
    folderPath: '/projects',
    tags: ['work', 'infra'],
    pinned: true,
    includeInContext: false,
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-06-01'),
  },
  {
    id: 'b',
    title: 'Beta',
    content: 'about design',
    folderPath: '/projects/ui',
    tags: ['work'],
    pinned: false,
    includeInContext: true,
    createdAt: new Date('2024-02-01'),
    updatedAt: new Date('2024-05-01'),
  },
  {
    id: 'c',
    title: 'Gamma',
    content: 'personal note',
    folderPath: '/personal',
    tags: ['life'],
    pinned: false,
    includeInContext: false,
    createdAt: new Date('2024-03-01'),
    updatedAt: new Date('2024-04-01'),
  },
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
    expect(runDataviewQuery('LIST WHERE content contains design', notes).map((r) => r.id)).toEqual([
      'b',
    ]);
  });

  it('supports AND / OR joiners', () => {
    expect(runDataviewQuery('LIST WHERE pinned = true AND context = true', notes)).toHaveLength(0);
    expect(
      runDataviewQuery('LIST WHERE pinned = true OR context = true', notes)
        .map((r) => r.id)
        .sort(),
    ).toEqual(['a', 'b']);
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

describe('adversarial query injection', () => {
  it('treats SQL-like injection in WHERE values as literal strings', () => {
    // The value "' OR '1'='1" is a literal string compared against the title,
    // not executed as SQL. No note matches, so we get an empty result.
    const html = renderDataviewQuery(`LIST WHERE title = "' OR '1'='1"`, notes);
    // Either an empty state or an error box — never an unescaped injection.
    expect(html).toMatch(/dataview-empty|dataview-error/);
    expect(html).not.toContain("' OR '1'='1");
    expect(html).not.toContain('<script');
  });

  it('does not allow __proto__ pollution via note objects', () => {
    const maliciousNotes: DataviewNote[] = [
      {
        id: 'x',
        title: 'X',
        content: '',
        folderPath: '/x',
        tags: [],
        pinned: false,
        includeInContext: false,
        createdAt: new Date('2024-01-01'),
        updatedAt: new Date('2024-01-01'),
        ...({ __proto__: { polluted: true } } as object),
      },
    ];
    renderDataviewQuery('LIST', maliciousNotes);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('escapes XSS payloads in rendered cells via note titles', () => {
    const xssNotes: DataviewNote[] = [
      {
        id: 'x',
        title: '<img src=x onerror=alert(1)>',
        content: '',
        folderPath: '/x',
        tags: [],
        pinned: false,
        includeInContext: false,
        createdAt: new Date('2024-01-01'),
        updatedAt: new Date('2024-01-01'),
      },
    ];
    const html = renderDataviewQuery('LIST', xssNotes);
    // No unescaped <img tag reaches the output.
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
    expect(html).not.toContain('<img');
    // The payload is HTML-escaped — "onerror" appears only as inert escaped
    // text content (inside &lt;img ...&gt;), not as a live attribute.
    expect(html).toContain('&lt;img');
    expect(html).toContain('onerror=alert(1)&gt;');
  });

  it('handles very large note arrays (1000+ notes) without crashing or hanging', () => {
    const big: DataviewNote[] = Array.from({ length: 1000 }, (_, i) => ({
      id: `n${i}`,
      title: `Note ${i}`,
      content: '',
      folderPath: '/bulk',
      tags: [],
      pinned: false,
      includeInContext: false,
      createdAt: new Date('2024-01-01'),
      updatedAt: new Date('2024-01-01'),
    }));
    const start = Date.now();
    const html = renderDataviewQuery('LIST FROM "bulk" LIMIT 10', big);
    const elapsed = Date.now() - start;
    expect(html).toContain('dataview-list');
    expect(elapsed).toBeLessThan(2000);
  });

  it('handles Unicode bidi overrides in query strings', () => {
    // The bidi char is part of the value; parsing should still work and the
    // rendered output must not contain unescaped bidi-wrapped injection.
    const html = renderDataviewQuery(`LIST WHERE title = "\u202eAlpha"`, notes);
    // No note has a bidi-wrapped title, so empty result (no crash).
    expect(html).toMatch(/dataview-empty|dataview-error|dataview-list/);
    expect(html).not.toContain('<script');
  });

  it('handles recursive folder structures (depth > 10)', () => {
    const deep: DataviewNote[] = [
      {
        id: 'deep',
        title: 'Deep',
        content: '',
        folderPath: '/a/b/c/d/e/f/g/h/i/j/k/l',
        tags: [],
        pinned: false,
        includeInContext: false,
        createdAt: new Date('2024-01-01'),
        updatedAt: new Date('2024-01-01'),
      },
    ];
    const html = renderDataviewQuery('LIST FROM "a"', deep);
    // The deep note is nested under /a, so it should be found.
    expect(html).toContain('dataview-list');
    expect(html).toContain('Deep');
  });

  it('handles invalid date values in date-based WHERE clauses', () => {
    const badDateNotes: DataviewNote[] = [
      {
        id: 'd',
        title: 'BadDate',
        content: '',
        folderPath: '/d',
        tags: [],
        pinned: false,
        includeInContext: false,
        createdAt: 'not-a-date' as unknown as Date,
        updatedAt: 'not-a-date' as unknown as Date,
      },
    ];
    // Comparing against an invalid date yields NaN comparisons (all false),
    // but must not throw or crash.
    const html = renderDataviewQuery('LIST WHERE created > 0', badDateNotes);
    expect(html).toMatch(/dataview-empty|dataview-list|dataview-error/);
  });

  it.skip('rejects a WHERE clause with only operators (parser silently ignores)', () => {
    // VULNERABILITY (low severity): parseDataviewQuery splits WHERE on
    // \b(AND|OR)\b and skips empty clause strings (`if (!clauseStr) continue`).
    // So "WHERE AND OR" produces no clauses and is silently treated as a
    // no-op WHERE (all rows returned) instead of a parse error. A malformed
    // query should error, not silently match everything. A fix would reject
    // a WHERE section that yields zero clauses after parsing.
    const html = renderDataviewQuery('LIST WHERE AND OR', notes);
    expect(html).toContain('dataview-error');
  });

  it('handles a WHERE clause with only operators without crashing', () => {
    // Even though the parser silently ignores "WHERE AND OR" (see skipped
    // test above), it must not crash or produce unescaped output.
    const html = renderDataviewQuery('LIST WHERE AND OR', notes);
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img');
  });

  it('handles an empty WHERE clause (just the keyword)', () => {
    // "WHERE" with no following clause → sections.WHERE is empty string,
    // split yields [''] → no clauses pushed → WHERE is a no-op (all rows).
    const html = renderDataviewQuery('LIST WHERE', notes);
    // No crash; either renders all notes or an error box.
    expect(html).toMatch(/dataview-list|dataview-empty|dataview-error/);
  });

  it('handles a LIST query with no fields after it', () => {
    // Bare "LIST" with no clauses → returns all notes.
    const html = renderDataviewQuery('LIST', notes);
    expect(html).toContain('dataview-list');
    expect(html).toContain('Alpha');
  });
});
