import type { FeedEntryLocal } from '$lib/types';
import { toolPresentation } from './tool-presentation';

/**
 * One readable line for a collapsed group of exploration steps, built from the
 * same ordered entries the expanded view lists:
 *
 *   "Read math.ts and answer.txt → searched “add” → listed src"
 *
 * Consecutive steps of the same kind merge into one clause, clauses keep the
 * order the agent worked in, and a step still running is narrated in the
 * present tense ("Reading auth.ts…"). The full log stays one click away.
 */

type ClauseKind = 'read' | 'search' | 'list' | 'other';

interface Clause {
  kind: ClauseKind;
  items: string[];
  running: boolean;
  /** Present/past verbs for clauses that are not read/search/list. */
  action?: { running: string; done: string; target: string };
}

const MAX_NAMED = 2;
const MAX_CLAUSES = 3;

function basename(path: string): string {
  return path.split(/[/\\]/).filter(Boolean).pop() ?? path;
}

function quote(text: string): string {
  const trimmed = text.replace(/\s+/g, ' ').trim();
  const short = trimmed.length > 32 ? `${trimmed.slice(0, 31)}…` : trimmed;
  return `“${short}”`;
}

function stepClause(step: FeedEntryLocal): Clause {
  const tool = toolPresentation(step);
  const running = step.type === 'tool_call';
  if (tool.intent === 'read' && tool.kind === 'file') {
    const names = tool.paths.length ? tool.paths.map(basename) : [tool.target];
    return { kind: 'read', items: names, running };
  }
  if (tool.kind === 'search') {
    return {
      kind: 'search',
      items: tool.target && tool.target !== 'workspace' ? [quote(tool.target)] : [],
      running,
    };
  }
  if (tool.intent === 'list') {
    return {
      kind: 'list',
      items: [tool.target === 'workspace' ? 'workspace' : basename(tool.target)],
      running,
    };
  }
  return {
    kind: 'other',
    items: [],
    running,
    action: { running: tool.action, done: tool.action, target: tool.target },
  };
}

function namedList(items: string[], noun: [string, string]): string {
  const unique = [...new Set(items.filter(Boolean))];
  if (unique.length === 0) return noun[1];
  if (unique.length <= MAX_NAMED) return unique.join(' and ');
  return `${unique.length} ${noun[1]}`;
}

function phrase(clause: Clause): string {
  const ing = clause.running;
  switch (clause.kind) {
    case 'read':
      return `${ing ? 'Reading' : 'Read'} ${namedList(clause.items, ['file', 'files'])}`;
    case 'search': {
      const count = Math.max(clause.items.length, 1);
      const what = clause.items.length === 1 ? clause.items[0] : `${count} queries`;
      return `${ing ? 'Searching' : 'Searched'} ${what}`;
    }
    case 'list':
      return `${ing ? 'Listing' : 'Listed'} ${namedList(clause.items, ['folder', 'folders'])}`;
    default:
      return `${clause.action?.running ?? 'Used'} ${clause.action?.target ?? 'a tool'}`;
  }
}

export function narrateToolGroup(steps: readonly FeedEntryLocal[]): string {
  const clauses: Clause[] = [];
  for (const step of steps) {
    const next = stepClause(step);
    const last = clauses.at(-1);
    if (last && last.kind === next.kind && next.kind !== 'other') {
      last.items.push(...next.items);
      last.running = last.running || next.running;
    } else {
      clauses.push(next);
    }
  }
  if (clauses.length === 0) return '';
  // Keep the newest work visible: when there are too many clauses, fold the
  // oldest ones into a count rather than truncating the live end.
  const shown = clauses.length > MAX_CLAUSES ? clauses.slice(-MAX_CLAUSES) : clauses;
  const hidden = clauses.length - shown.length;
  const text = shown
    .map((clause, index) => {
      const line = phrase(clause);
      return index === 0 && hidden === 0 ? line : line.charAt(0).toLowerCase() + line.slice(1);
    })
    .join(' → ');
  const running = shown.at(-1)?.running ?? false;
  return `${hidden > 0 ? `${hidden} earlier step${hidden === 1 ? '' : 's'} → ` : ''}${text}${running ? '…' : ''}`;
}
