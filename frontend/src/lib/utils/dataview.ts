// A small, dependency-free Dataview-style query engine over notes, used to
// render ```dataview / ```query fenced blocks in the notes preview.
//
// Supported grammar (case-insensitive keywords):
//   LIST [FROM <source>] [WHERE <cond>] [SORT <field> [asc|desc]] [LIMIT <n>]
//   TABLE <col>, <col>, ... [FROM ...] [WHERE ...] [SORT ...] [LIMIT ...]
// where
//   <source> := #tag | "folder" | /folder            (tag or folder scope)
//   <cond>   := <clause> [(AND|OR) <clause>]*
//   <clause> := <field> <op> <value>                 op ∈ = != > < >= <= contains
//   <field>  := title|file | folder | tag|tags | pinned | context | created | updated | content | links
//
// The engine is intentionally forgiving: unknown fields compare as empty, and a
// parse error renders an inline error box rather than throwing.

export interface DataviewNote {
  id: string;
  title: string;
  content: string;
  folderPath: string;
  tags: string[];
  pinned: boolean;
  includeInContext: boolean;
  createdAt: Date | string;
  updatedAt: Date | string;
  outlinks?: string[];
  backlinks?: string[];
}

type QueryKind = 'LIST' | 'TABLE';
type SortDir = 'asc' | 'desc';

interface Clause {
  field: string;
  op: '=' | '!=' | '>' | '<' | '>=' | '<=' | 'contains';
  value: string;
}

interface ParsedQuery {
  kind: QueryKind;
  columns: string[]; // TABLE only
  from?: { type: 'tag' | 'folder'; value: string };
  where: { clauses: Clause[]; joiners: ('AND' | 'OR')[] };
  sort?: { field: string; dir: SortDir };
  limit?: number;
}

const FIELD_ALIASES: Record<string, string> = {
  file: 'title',
  title: 'title',
  name: 'title',
  folder: 'folder',
  path: 'folder',
  tag: 'tags',
  tags: 'tags',
  pinned: 'pinned',
  pin: 'pinned',
  context: 'context',
  created: 'created',
  updated: 'updated',
  modified: 'updated',
  content: 'content',
  body: 'content',
  links: 'links',
};

function normField(f: string): string {
  return FIELD_ALIASES[f.trim().toLowerCase()] ?? f.trim().toLowerCase();
}

function stripQuotes(s: string): string {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

export function parseDataviewQuery(src: string): ParsedQuery {
  // Collapse to a single logical line but keep it forgiving about newlines.
  const text = src.replace(/\r/g, '').trim();
  if (!text) throw new Error('Empty query');

  const kindMatch = /^(LIST|TABLE)\b/i.exec(text);
  if (!kindMatch) throw new Error('Query must start with LIST or TABLE');
  const kind = kindMatch[1].toUpperCase() as QueryKind;
  let rest = text.slice(kindMatch[0].length).trim();

  // Split off the clause keywords (FROM / WHERE / SORT / LIMIT) in order.
  // Everything before the first keyword (for TABLE) is the column list.
  const kwRe = /\b(FROM|WHERE|SORT|LIMIT)\b/i;
  const columns: string[] = [];
  if (kind === 'TABLE') {
    const firstKw = kwRe.exec(rest);
    const colPart = (firstKw ? rest.slice(0, firstKw.index) : rest).trim();
    if (colPart) columns.push(...colPart.split(',').map((c) => c.trim()).filter(Boolean));
    rest = firstKw ? rest.slice(firstKw.index) : '';
  }

  // Tokenize remaining into keyword sections.
  const sections: Record<string, string> = {};
  const re = /\b(FROM|WHERE|SORT|LIMIT)\b/gi;
  const marks: { kw: string; start: number; end: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(rest))) marks.push({ kw: m[1].toUpperCase(), start: m.index, end: m.index + m[0].length });
  for (let i = 0; i < marks.length; i++) {
    const seg = rest.slice(marks[i].end, i + 1 < marks.length ? marks[i + 1].start : undefined).trim();
    sections[marks[i].kw] = seg;
  }

  const parsed: ParsedQuery = { kind, columns, where: { clauses: [], joiners: [] } };

  if (sections.FROM) {
    const f = sections.FROM.trim();
    if (f.startsWith('#')) parsed.from = { type: 'tag', value: f.slice(1).trim() };
    else parsed.from = { type: 'folder', value: stripQuotes(f).replace(/^\/+/, '') };
  }

  if (sections.WHERE) {
    const parts = sections.WHERE.split(/\b(AND|OR)\b/i);
    for (let i = 0; i < parts.length; i += 2) {
      const clauseStr = parts[i].trim();
      if (!clauseStr) continue;
      const cm = /^(\S+)\s*(>=|<=|!=|=|>|<|contains)\s*(.+)$/i.exec(clauseStr);
      if (!cm) throw new Error(`Bad WHERE clause: "${clauseStr}"`);
      parsed.where.clauses.push({
        field: normField(cm[1]),
        op: cm[2].toLowerCase() as Clause['op'],
        value: stripQuotes(cm[3]),
      });
      const joiner = parts[i + 1];
      if (joiner) parsed.where.joiners.push(joiner.toUpperCase() as 'AND' | 'OR');
    }
  }

  if (sections.SORT) {
    const sm = /^(\S+)\s*(asc|desc)?$/i.exec(sections.SORT.trim());
    if (sm) parsed.sort = { field: normField(sm[1]), dir: (sm[2]?.toLowerCase() as SortDir) || 'asc' };
  }

  if (sections.LIMIT) {
    const n = parseInt(sections.LIMIT.trim(), 10);
    if (!Number.isNaN(n)) parsed.limit = n;
  }

  return parsed;
}

function fieldValue(note: DataviewNote, field: string): string | number | boolean | string[] {
  switch (field) {
    case 'title': return note.title;
    case 'folder': return note.folderPath;
    case 'tags': return note.tags ?? [];
    case 'pinned': return !!note.pinned;
    case 'context': return !!note.includeInContext;
    case 'content': return note.content ?? '';
    case 'created': return new Date(note.createdAt).getTime();
    case 'updated': return new Date(note.updatedAt).getTime();
    case 'links': return (note.outlinks?.length ?? 0) + (note.backlinks?.length ?? 0);
    default: return '';
  }
}

function coerce(raw: string): string | number | boolean {
  const low = raw.toLowerCase();
  if (low === 'true') return true;
  if (low === 'false') return false;
  if (raw !== '' && !Number.isNaN(Number(raw))) return Number(raw);
  return raw;
}

function evalClause(note: DataviewNote, c: Clause): boolean {
  const lhs = fieldValue(note, c.field);
  const rhs = coerce(c.value);
  // Array fields (tags): membership semantics.
  if (Array.isArray(lhs)) {
    const has = lhs.some((t) => t.toLowerCase() === String(rhs).toLowerCase());
    if (c.op === '=' || c.op === 'contains') return has;
    if (c.op === '!=') return !has;
    return false;
  }
  if (c.op === 'contains') return String(lhs).toLowerCase().includes(String(rhs).toLowerCase());
  if (typeof lhs === 'number' && typeof rhs === 'number') {
    switch (c.op) {
      case '=': return lhs === rhs;
      case '!=': return lhs !== rhs;
      case '>': return lhs > rhs;
      case '<': return lhs < rhs;
      case '>=': return lhs >= rhs;
      case '<=': return lhs <= rhs;
    }
  }
  const a = String(lhs).toLowerCase();
  const b = String(rhs).toLowerCase();
  switch (c.op) {
    case '=': return a === b;
    case '!=': return a !== b;
    case '>': return a > b;
    case '<': return a < b;
    case '>=': return a >= b;
    case '<=': return a <= b;
    default: return false;
  }
}

function evalWhere(note: DataviewNote, where: ParsedQuery['where']): boolean {
  if (where.clauses.length === 0) return true;
  let acc = evalClause(note, where.clauses[0]);
  for (let i = 1; i < where.clauses.length; i++) {
    const j = where.joiners[i - 1] ?? 'AND';
    const next = evalClause(note, where.clauses[i]);
    acc = j === 'OR' ? acc || next : acc && next;
  }
  return acc;
}

export function runDataviewQuery(src: string, notes: DataviewNote[]): DataviewNote[] {
  const q = parseDataviewQuery(src);
  let rows = notes.slice();

  if (q.from) {
    if (q.from.type === 'tag') {
      const tag = q.from.value.toLowerCase();
      rows = rows.filter((n) => (n.tags ?? []).some((t) => t.toLowerCase() === tag));
    } else {
      const folder = '/' + q.from.value.replace(/^\/+|\/+$/g, '');
      rows = rows.filter((n) => n.folderPath === folder || n.folderPath.startsWith(folder === '/' ? '/' : folder + '/'));
    }
  }

  rows = rows.filter((n) => evalWhere(n, q.where));

  if (q.sort) {
    const { field, dir } = q.sort;
    rows.sort((a, b) => {
      const av = fieldValue(a, field);
      const bv = fieldValue(b, field);
      const an = Array.isArray(av) ? av.length : av;
      const bn = Array.isArray(bv) ? bv.length : bv;
      let cmp = 0;
      if (typeof an === 'number' && typeof bn === 'number') cmp = an - bn;
      else cmp = String(an).localeCompare(String(bn));
      return dir === 'desc' ? -cmp : cmp;
    });
  }

  if (typeof q.limit === 'number') rows = rows.slice(0, Math.max(0, q.limit));
  return rows;
}

function esc(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function noteLink(n: DataviewNote): string {
  return `<a class="wikilink" data-note-title="${esc(n.title)}" href="javascript:void 0">${esc(n.title)}</a>`;
}

function cellFor(n: DataviewNote, column: string): string {
  const col = column.trim();
  const field = normField(col);
  if (field === 'title') return noteLink(n);
  const v = fieldValue(n, field);
  if (Array.isArray(v)) return esc(v.join(', '));
  if (field === 'created' || field === 'updated') {
    const d = new Date(field === 'created' ? n.createdAt : n.updatedAt);
    return esc(Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString());
  }
  return esc(String(v));
}

/** Render a dataview block to sanitizable HTML. Never throws. */
export function renderDataviewQuery(src: string, notes: DataviewNote[]): string {
  let q: ParsedQuery;
  let rows: DataviewNote[];
  try {
    q = parseDataviewQuery(src);
    rows = runDataviewQuery(src, notes);
  } catch (err) {
    return `<div class="dataview-error">⚠ Dataview: ${esc(String((err as Error)?.message ?? err))}</div>`;
  }

  if (rows.length === 0) {
    return `<div class="dataview-empty">No results</div>`;
  }

  if (q.kind === 'TABLE' && q.columns.length > 0) {
    const head = q.columns.map((c) => `<th>${esc(c)}</th>`).join('');
    const body = rows
      .map((n) => `<tr>${q.columns.map((c) => `<td>${cellFor(n, c)}</td>`).join('')}</tr>`)
      .join('');
    return `<div class="dataview-result"><table class="dataview-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
  }

  const items = rows.map((n) => `<li>${noteLink(n)}</li>`).join('');
  return `<div class="dataview-result"><ul class="dataview-list">${items}</ul></div>`;
}
