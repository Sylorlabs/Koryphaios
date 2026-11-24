import { createServer } from 'node:http';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, extname, join, resolve } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { hasHardLinks, isContainedBy } from '../runtime/platform';
import {
  chromiumBlockers,
  chromiumLaunchOptions,
  pinnedBrowserPackage,
  pinnedPackageBlockers,
} from './skill-eval-real-web-runtime';
import type {
  SkillEvalDeterministicScore,
  SkillEvalDeterministicScorer,
  SkillEvalFixtureMaterializer,
} from './skill-eval-execution';
import {
  fixtureTextEquals,
  readJsonArtifact,
  writeFixtureFile,
} from './skill-eval-fixture-helpers';

const SEARCH = 'react-engineering-full-task-1-individual';
const LIST = 'react-engineering-full-task-2-individual';
const REACT_VERSION = '19.2.8';
const SCHEDULER_VERSION = '0.27.0';
const PACKAGE_SPECS = [
  ['react', REACT_VERSION],
  ['react-dom', REACT_VERSION],
  ['scheduler', SCHEDULER_VERSION],
] as const;

export function reactBrowserReadiness(): string[] {
  return [...pinnedPackageBlockers(PACKAGE_SPECS), ...chromiumBlockers()];
}

export const REACT_BROWSER_EVAL_CONSTANTS = {
  reactVersion: REACT_VERSION,
  chromiumPath: chromium.executablePath(),
} as const;

const PACKAGE_JSON = `${JSON.stringify(
  {
    name: 'kory-react-real-browser-fixture',
    private: true,
    type: 'module',
    scripts: { build: 'bun build src/main.jsx --target browser --outdir dist' },
    dependencies: { react: REACT_VERSION, 'react-dom': REACT_VERSION },
  },
  null,
  2,
)}\n`;

const INDEX_HTML = `<!doctype html>
<html lang="en"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width,initial-scale=1" /><title>React real browser evaluation</title><link rel="stylesheet" href="/design.css" /></head>
<body><div id="root"></div><script src="/main.js"></script></body></html>\n`;

const STYLE = `*{box-sizing:border-box}body{margin:0;font:16px/1.45 system-ui,sans-serif;color:#182536;background:#f4f7fc}button,input{font:inherit;max-width:100%}button{padding:6px 10px;border:1px solid #96a4b8;border-radius:6px;background:#fff;cursor:pointer}input{padding:8px;border:1px solid #96a4b8;border-radius:5px;min-width:0}button:focus-visible,input:focus-visible{outline:3px solid #4169e1;outline-offset:2px}.shell{width:min(850px,calc(100% - 20px));margin:14px auto}.actions{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:18px}.panel{min-width:0;border:1px solid #d0d9e7;border-radius:9px;padding:15px;background:#fff}.field{display:grid;gap:5px;max-width:500px}.rows{display:grid;gap:5px;list-style:none;padding:0}.row{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,2fr) auto;gap:7px;align-items:center;padding:5px;border-bottom:1px solid #ecf0f5}.row>*{min-width:0}.row label{overflow-wrap:anywhere}.status{overflow-wrap:anywhere}h1{font-size:1.45rem;margin-top:0}@media(max-width:440px){.row{grid-template-columns:minmax(0,1fr)}.actions{gap:5px}}\n`;

const MAIN = `import React from 'react';
import { createRoot } from 'react-dom/client';
import Harness from './Harness.jsx';
createRoot(document.getElementById('root')).render(<Harness />);
`;

// The service deliberately delivers a slow response after an abort. A correct effect must
// both abort the request and ignore an already-queued, non-cancellable response.
const SEARCH_SOURCE = `const metrics = { active: 0, started: 0, completed: 0, aborted: 0, lateAfterAbort: 0, attempts: {} };
window.__searchSource = metrics;

export function search(query, options = {}) {
  const normalized = String(query || '').trim();
  const attempt = (metrics.attempts[normalized] || 0) + 1;
  metrics.attempts[normalized] = attempt;
  metrics.started += 1;
  metrics.active += 1;
  const slow = normalized === 'slow' || normalized === 'slow-unmount';
  const delay = slow ? 420 : 60;
  return new Promise((resolve, reject) => {
    let done = false;
    let aborted = false;
    const end = () => {
      if (done) return false;
      done = true;
      metrics.active -= 1;
      options.signal?.removeEventListener('abort', abort);
      return true;
    };
    const abort = () => {
      if (done || aborted) return;
      aborted = true;
      metrics.aborted += 1;
      if (!slow && end()) {
        clearTimeout(timer);
        reject(new DOMException('Search aborted', 'AbortError'));
      }
    };
    const timer = setTimeout(() => {
      if (!end()) return;
      metrics.completed += 1;
      if (aborted) metrics.lateAfterAbort += 1;
      if (normalized === 'error' && attempt === 1) reject(new Error('Search temporarily unavailable'));
      else resolve(normalized === 'empty' ? [] : [{ id: normalized, title: normalized === 'error' ? 'Recovered result' : normalized + ' result' }]);
    }, delay);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
  });
}
`;

const SEARCH_HARNESS = `import React, { Profiler, useState } from 'react';
import App from './App.jsx';

window.__reactCommits = { total: 0, afterDestroy: 0, destroyed: false };

export default function Harness() {
  const [mounted, setMounted] = useState(true);
  const navigate = (query) => {
    history.pushState({}, '', '/?q=' + encodeURIComponent(query));
    window.dispatchEvent(new PopStateEvent('popstate'));
  };
  return <main className="shell">
    <nav className="actions" aria-label="Search route controls">
      <button type="button" id="route-slow" onClick={() => navigate('slow')}>Slow route</button>
      <button type="button" id="route-fast" onClick={() => navigate('fast')}>Fast route</button>
      <button type="button" id="route-error" onClick={() => navigate('error')}>Error route</button>
      <button type="button" id="route-empty" onClick={() => navigate('empty')}>Empty route</button>
      <button type="button" id="route-unmount" onClick={() => { window.__reactCommits.destroyed = true; setMounted(false); }}>Unmount</button>
      <button type="button" id="route-remount" onClick={() => { window.__reactCommits.destroyed = false; setMounted(true); }}>Remount</button>
    </nav>
    {mounted ? <Profiler id="search-app" onRender={() => {
      window.__reactCommits.total++;
      if (window.__reactCommits.destroyed) window.__reactCommits.afterDestroy++;
    }}><App /></Profiler> : <p data-unmounted>Search component unmounted</p>}
  </main>;
}
`;

// Intentionally plausible happy path, with a missing effect cleanup and broken history
// synchronization. A repaired candidate changes App.jsx only.
const SEARCH_STARTER = `import React, { useEffect, useState } from 'react';
import { search } from './search-source.js';

export default function App() {
  const [query, setQuery] = useState(new URLSearchParams(location.search).get('q') || 'slow');
  const [input, setInput] = useState(query);
  const [state, setState] = useState({ status: 'loading', results: [] });
  useEffect(() => {
    setState({ status: 'loading', results: [] });
    search(query).then((results) => setState({ status: 'done', results }))
      .catch((error) => setState({ status: 'error', message: error.message, results: [] }));
  }, [query]);
  const submit = (event) => {
    event.preventDefault();
    history.pushState({}, '', '/?q=' + encodeURIComponent(input));
    setQuery(input);
  };
  return <section className="panel" data-search-app>
    <h1>Search</h1>
    <form onSubmit={submit}><label className="field" htmlFor="search-field">Search items
      <input id="search-field" value={input} onChange={(event) => setInput(event.target.value)} />
    </label><button type="submit">Find</button></form>
    {state.status === 'loading' ? <p role="status" aria-busy="true">Loading results</p> : null}
    {state.status === 'error' ? <p role="alert">{state.message}</p> : null}
    {state.status === 'done' && !state.results.length ? <p data-empty>No matches</p> : null}
    {state.results.map((item) => <h2 key={item.id} data-result-query={item.id}>{item.title}</h2>)}
  </section>;
}
`;

const LIST_SOURCE = `export const initialItems = Array.from({ length: 420 }, (_, index) => ({
  id: 'item-' + String(index + 1).padStart(3, '0'),
  title: 'Item ' + String(index + 1).padStart(3, '0'),
}));

const metrics = { active: 0, started: 0, aborted: 0, failed: 0, completed: 0, lateAfterAbort: 0, attempts: {} };
window.__listSource = metrics;

export function saveItem(id, title, options = {}) {
  const key = id + '|' + title;
  const attempt = (metrics.attempts[key] || 0) + 1;
  metrics.attempts[key] = attempt;
  metrics.started++;
  metrics.active++;
  const slow = title.includes('slow save');
  return new Promise((resolve, reject) => {
    let done = false;
    let aborted = false;
    const end = () => {
      if (done) return false;
      done = true;
      metrics.active--;
      options.signal?.removeEventListener('abort', abort);
      return true;
    };
    const abort = () => {
      if (done || aborted) return;
      aborted = true;
      metrics.aborted++;
      if (!slow && end()) {
        clearTimeout(timer);
        reject(new DOMException('Save aborted', 'AbortError'));
      }
    };
    const timer = setTimeout(() => {
      if (!end()) return;
      if (aborted) metrics.lateAfterAbort++;
      if (title.includes('fail first') && attempt === 1) {
        metrics.failed++;
        reject(new Error('Save temporarily unavailable'));
      } else {
        metrics.completed++;
        resolve({ id, title });
      }
    }, slow ? 420 : 65);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
  });
}
`;

const LIST_HARNESS = `import React, { Profiler, useEffect, useState } from 'react';
import App from './App.jsx';
import { initialItems } from './list-source.js';

window.__reactCommits = { total: 0, afterDestroy: 0, destroyed: false };

export default function Harness() {
  const [items, setItems] = useState(initialItems);
  const [descending, setDescending] = useState(false);
  const [filter, setFilter] = useState('');
  const [offset, setOffset] = useState(0);
  const [mounted, setMounted] = useState(true);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (revision === 0) return;
    const timer = setTimeout(() => setItems((current) => current.map((item) => item.id === 'item-005'
      ? { ...item, title: 'Item 005 updated server' } : item)), 65);
    return () => clearTimeout(timer);
  }, [revision]);
  const commit = (id, title) => setItems((current) => current.map((item) => item.id === id ? { ...item, title } : item));
  return <main className="shell">
    <nav className="actions" aria-label="List controls">
      <button type="button" id="sort" onClick={() => setDescending((x) => !x)}>Reverse sort</button>
      <button type="button" id="filter" onClick={() => { setFilter('Item 00'); setOffset(0); }}>Filter nine</button>
      <button type="button" id="filter-none" onClick={() => { setFilter(''); setOffset(0); }}>Clear filter</button>
      <button type="button" id="filter-hide" onClick={() => { setFilter('No matching item'); setOffset(0); }}>Filter none</button>
      <button type="button" id="insert" onClick={() => setItems((current) => [{ id: 'item-000', title: 'Item 000 inserted' }, ...current])}>Insert</button>
      <button type="button" id="delete" onClick={() => setItems((current) => current.filter((item) => item.id !== 'item-001'))}>Delete first</button>
      <button type="button" id="refresh" onClick={() => setRevision((x) => x + 1)}>Server refresh</button>
      <button type="button" id="window-next" onClick={() => setOffset((x) => x + 15)}>Next window</button>
      <button type="button" id="window-prev" onClick={() => setOffset((x) => Math.max(0, x - 15))}>Previous window</button>
      <button type="button" id="list-unmount" onClick={() => { window.__reactCommits.destroyed = true; setMounted(false); }}>Unmount</button>
      <button type="button" id="list-remount" onClick={() => { window.__reactCommits.destroyed = false; setMounted(true); }}>Remount</button>
    </nav>
    {mounted ? <Profiler id="list-app" onRender={() => {
      window.__reactCommits.total++;
      if (window.__reactCommits.destroyed) window.__reactCommits.afterDestroy++;
    }}><App items={items} descending={descending} filter={filter} offset={offset} onCommit={commit} /></Profiler>
      : <p data-unmounted>List component unmounted</p>}
  </main>;
}
`;

// Starter reproduces the index-key and prop-to-state trap. Correct solution must use
// stable IDs, retain drafts across window changes, and cancel pending external writes.
const LIST_STARTER = `import React, { useState } from 'react';
import { saveItem } from './list-source.js';

function Row({ item, onCommit }) {
  const [draft, setDraft] = useState(item.title);
  return <li className="row" data-row-id={item.id}>
    <label htmlFor={'draft-' + item.id}>{item.id}</label>
    <input id={'draft-' + item.id} data-draft-id={item.id} value={draft} onChange={(event) => setDraft(event.target.value)} />
    <button type="button" data-save-id={item.id} onClick={() => saveItem(item.id, draft).then(() => onCommit(item.id, draft))}>Save</button>
  </li>;
}

export default function App({ items, descending, filter, offset, onCommit }) {
  const shown = items.filter((item) => item.title.includes(filter))
    .sort((a, b) => descending ? b.title.localeCompare(a.title) : a.title.localeCompare(b.title))
    .slice(offset, offset + 30);
  return <section className="panel" data-list-app>
    <h1>Editable list</h1><p data-total>{items.length} items</p>
    <ul className="rows">{shown.map((item, index) => <Row key={index} item={item} onCommit={onCommit} />)}</ul>
    {!shown.length ? <p data-empty>No items</p> : null}
  </section>;
}
`;

const REACT_BROWSER_CHECKS = {
  1: [
    'stale-race',
    'abort-on-unmount',
    'history',
    'loading-empty-error',
    'retry-focus',
    'keyboard',
    'mobile',
    'durable-preference',
  ],
  2: [
    'stable-keys',
    'draft-preservation',
    'server-refresh',
    'virtual-window',
    'retry-focus',
    'abort-on-unmount',
    'mobile',
    'render-commits',
  ],
} as const;

// Agents must be given the complete machine-readable artifact contract before
// the independent scorer can fairly evaluate their actual browser behavior.
function evidenceInstructions(number: 1 | 2): string {
  const neighbor = number === 1 ? 'angular-engineering' : 'svelte-engineering';
  return `
### Evidence artifact contract (exact JSON field names)

Write both files below as JSON objects. These are candidate-authored claims; the evaluator separately builds your code and tests real Chromium behavior. Do not claim a browser check you did not perform or invent observations. Leave status as TODO if you cannot substantiate verification.

\`verification/scenario-${number}-result.json\` requires these flat fields:

\`\`\`json
{
  "status": "TODO",
  "reactVersion": "${REACT_VERSION}",
  "broaderSkill": "frontend-engineering",
  "nearNeighbor": "${neighbor}",
  "stateBoundary": "<at least 20 characters explaining which state React owns and why>",
  "success": "<at least 20 characters reporting observed success and how it was measured>",
  "negativeRecovery": "<at least 20 characters reporting an observed failure and recovery>"
}
\`\`\`

\`verification/scenario-${number}-verification.json\` requires these flat fields:

\`\`\`json
{
  "status": "TODO",
  "evidenceType": "real-browser",
  "checks": ${JSON.stringify(REACT_BROWSER_CHECKS[number])},
  "observations": [
    "<actual browser action and observed result>",
    "<second independent browser action and observed result>"
  ]
}
\`\`\`

Replace the \`TODO\` placeholder with an honest declared status: \`verified\` when you observed every behavior you claim, \`partially-verified\` when you observed some, \`unverified\` when you observed none, and \`failed\` when an observation contradicted the claim. Leaving \`TODO\` in either file fails this check, because it means no claim was authored at all. All listed check names must be present; they are not evidence by themselves. The independent evaluator builds and tests real Chromium behavior regardless of these claims, so an inflated status cannot rescue a defect and an honest narrower status cannot hide one.
`;
}

const README_SEARCH = `# React 19 browser evaluation: search and ownership

React 19.2.8 + real Playwright Chromium are installed locally in this evaluation snapshot. Run \`bun run build\` to compile the React app. Edit \`src/App.jsx\` and add focused tests/evidence under \`verification/\`; \`src/main.jsx\`, \`src/Harness.jsx\`, \`src/search-source.js\`, \`design.css\` and runtime dependencies are fixed evaluator contracts.

Search terms: \`slow\` (420ms, deliberately delivers after abort), \`fast\`, \`error\` (first request fails, retry succeeds), \`empty\`, and arbitrary keyboard entries. The harness pushes URL query routes and supports browser back/forward, unmount, remount. Preserve loading/error/empty UI, retry and heading focus, keyboard Enter/input focus, 390px layout, and a locally persisted favorite preference across route and remount. Abort requests and ignore late results after route changes or unmount. Separate remote results, URL query, durable preference, and input view state. Do not modify harness/source to make tests pass.

Selectors the independent scorer uses, which your component must supply: \`#retry-search\` for the retry control shown in the error state, \`[role="alert"]\` for the failure message, \`[data-result-heading]\` for the results heading that receives focus, and \`#favorite\` with a boolean \`aria-pressed\` for the durable preference. The starter already carries \`#search-field\`, \`[data-result-query]\`, and \`[data-empty]\`; keep them.

The independent scorer runs its own actual Chromium assertions; narrative claims alone never pass.
${evidenceInstructions(1)}`;

const README_LIST = `# React 19 browser evaluation: keyed editable window

React 19.2.8 + real Playwright Chromium are installed locally in this evaluation snapshot. Run \`bun run build\`. Edit \`src/App.jsx\`, add focused tests and author verification artifacts. Other \`src/\` fixture files, \`design.css\` and runtime dependencies are fixed evaluator contracts.

The harness supplies 420 server-backed records and editable windows of <=30 rows. Keep drafts associated with stable item IDs through reverse sort, insert, delete, filtering away/back, server refresh of item-005 while item-003 has an unsaved draft, and moving virtual windows. Preserve focused row identity through reorder. \`saveItem\` fails the first time for a draft containing \`fail first\`, then succeeds on retry; a draft containing \`slow save\` completes after abort so cleanup must suppress late commits. Show retry/focus and busy/error states. Do not mirror row props blindly into drafts. Preserve 390px layout and bounded DOM/React commits; use real React keys rather than array indices.

Selectors the independent scorer uses, which your component must supply: \`[data-retry-id]\` on the retry control for a failed save, set to that row's item id (for example \`data-retry-id="item-004"\`), alongside the \`[data-row-id]\`, \`[data-draft-id]\`, \`[data-save-id]\`, and \`[data-total]\` hooks the starter already carries.

Only independent browser assertions establish success.
${evidenceInstructions(2)}`;

function copyRuntime(root: string): void {
  for (const [name, version] of PACKAGE_SPECS) {
    const dest = join(root, 'node_modules', name);
    mkdirSync(join(root, 'node_modules'), { recursive: true });
    cpSync(pinnedBrowserPackage(name, version), dest, { recursive: true });
  }
}

function materialize(root: string, number: 1 | 2): void {
  const readinessBlockers = reactBrowserReadiness();
  if (readinessBlockers.length) throw new Error(readinessBlockers.join('; '));
  writeReactBrowserFixtureContract(root, number);
  copyRuntime(root);
}

/** Asset-independent contract authoring only; this does not provision or certify a runtime. */
export function writeReactBrowserFixtureContract(root: string, number: 1 | 2): void {
  writeFixtureFile(root, 'package.json', PACKAGE_JSON);
  writeFixtureFile(root, 'src/main.jsx', MAIN);
  writeFixtureFile(root, 'src/Harness.jsx', number === 1 ? SEARCH_HARNESS : LIST_HARNESS);
  writeFixtureFile(root, 'src/App.jsx', number === 1 ? SEARCH_STARTER : LIST_STARTER);
  writeFixtureFile(
    root,
    number === 1 ? 'src/search-source.js' : 'src/list-source.js',
    number === 1 ? SEARCH_SOURCE : LIST_SOURCE,
  );
  writeFixtureFile(root, 'design.css', STYLE);
  writeFixtureFile(root, 'index.html', INDEX_HTML);
  writeFixtureFile(root, 'README.md', number === 1 ? README_SEARCH : README_LIST);
  writeFixtureFile(root, `verification/scenario-${number}-result.json`, '{"status":"TODO"}\n');
  writeFixtureFile(
    root,
    `verification/scenario-${number}-verification.json`,
    '{"status":"TODO"}\n',
  );
}

export const REACT_BROWSER_SKILL_EVAL_MATERIALIZERS: readonly SkillEvalFixtureMaterializer[] = [
  {
    id: 'react-engineering/search-real-react-chromium@2',
    realRuntime: true,
    get readinessBlockers() {
      return reactBrowserReadiness();
    },
    matches: (scenario) => scenario.id === SEARCH,
    materialize: (root) => materialize(root, 1),
  },
  {
    id: 'react-engineering/keyed-window-real-react-chromium@2',
    realRuntime: true,
    get readinessBlockers() {
      return reactBrowserReadiness();
    },
    matches: (scenario) => scenario.id === LIST,
    materialize: (root) => materialize(root, 2),
  },
];

interface Check {
  name: string;
  passed: boolean;
  detail: string;
  browser: boolean;
}

function check(
  checks: Check[],
  name: string,
  passed: boolean,
  detail: unknown,
  browser = true,
): void {
  checks.push({ name, passed, detail: String(detail), browser });
}

function finish(checks: Check[], integrityFailure: boolean): SkillEvalDeterministicScore {
  const browserChecks = checks.filter((item) => item.browser);
  const good = checks.filter((item) => item.passed).length;
  return {
    passed: checks.length > 0 && checks.every((item) => item.passed) && !integrityFailure,
    quality: checks.length ? good / checks.length : 0,
    verification: browserChecks.length
      ? browserChecks.filter((item) => item.passed).length / browserChecks.length
      : 0,
    integrityFailure,
    evidence: checks.map(
      (item) => `${item.name}: ${item.passed ? 'pass' : 'fail'} — ${item.detail}`,
    ),
  };
}

const HONEST_STATUS = new Set(['verified', 'partially-verified', 'unverified', 'failed']);

function artifactsReady(root: string, number: 1 | 2): boolean {
  const result = readJsonArtifact<{
    reactVersion?: string;
    broaderSkill?: string;
    nearNeighbor?: string;
    stateBoundary?: string;
    success?: string;
    negativeRecovery?: string;
    status?: string;
  }>(root, `verification/scenario-${number}-result.json`);
  const verification = readJsonArtifact<{
    evidenceType?: string;
    checks?: string[];
    observations?: string[];
    status?: string;
  }>(root, `verification/scenario-${number}-verification.json`);
  const checks = REACT_BROWSER_CHECKS[number];
  // A missing or unreadable artifact is a failed check, not a crash in the scorer.
  if (!result || !verification) return false;
  // The claim must be authored and honest, not inflated. Requiring the single word
  // "verified" punished a careful candidate that observed some behavior and said so.
  return (
    HONEST_STATUS.has(result?.status ?? '') &&
    result.reactVersion === REACT_VERSION &&
    result.broaderSkill === 'frontend-engineering' &&
    result.nearNeighbor === (number === 1 ? 'angular-engineering' : 'svelte-engineering') &&
    (result.stateBoundary?.length ?? 0) >= 20 &&
    (result.success?.length ?? 0) >= 20 &&
    (result.negativeRecovery?.length ?? 0) >= 20 &&
    HONEST_STATUS.has(verification?.status ?? '') &&
    verification.evidenceType === 'real-browser' &&
    checks.every((name) => verification.checks?.includes(name)) &&
    (verification.observations?.length ?? 0) >= 2
  );
}

function immutable(root: string, number: 1 | 2): boolean {
  const invariants = [
    ['package.json', PACKAGE_JSON],
    ['index.html', INDEX_HTML],
    ['design.css', STYLE],
    ['src/main.jsx', MAIN],
    ['src/Harness.jsx', number === 1 ? SEARCH_HARNESS : LIST_HARNESS],
    [
      number === 1 ? 'src/search-source.js' : 'src/list-source.js',
      number === 1 ? SEARCH_SOURCE : LIST_SOURCE,
    ],
  ] as const;
  return invariants.every(([path, content]) => fixtureTextEquals(root, path, content));
}

function safeSource(root: string): boolean {
  // Never follow an agent-created symlink or special file into the scorer build.
  const scan = (dir: string, depth: number): boolean => {
    if (depth > 12) return false;
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const stat = lstatSync(path);
      if (stat.isDirectory()) {
        if (!scan(path, depth + 1)) return false;
      } else if (!stat.isFile() || hasHardLinks(stat) || stat.size > 2_000_000) return false;
    }
    return true;
  };
  try {
    return scan(join(root, 'src'), 0);
  } catch {
    return false;
  }
}

async function compiledRuntime(root: string): Promise<string> {
  const runtime = mkdtempSync(join(tmpdir(), 'kory-react-browser-build-'));
  try {
    cpSync(join(root, 'src'), join(runtime, 'src'), { recursive: true });
    copyRuntime(runtime);
    const build = await Bun.build({
      entrypoints: [join(runtime, 'src', 'main.jsx')],
      target: 'browser',
      outdir: join(runtime, 'dist'),
      minify: false,
    });
    if (!build.success) throw new Error(build.logs.map((item) => item.message).join('; '));
    const entry = build.outputs.find((item) => item.kind === 'entry-point');
    if (!entry) throw new Error('No React entry point emitted');
    writeFileSync(
      join(runtime, 'index.html'),
      INDEX_HTML.replace('/main.js', `/dist/${basename(entry.path)}`),
    );
    writeFileSync(join(runtime, 'design.css'), STYLE);
    return runtime;
  } catch (error) {
    rmSync(runtime, { recursive: true, force: true });
    throw error;
  }
}

async function withServer<T>(root: string, run: (url: string) => Promise<T>): Promise<T> {
  const server = createServer((request, response) => {
    let url: URL;
    try {
      url = new URL(request.url ?? '/', 'http://127.0.0.1');
    } catch {
      response.writeHead(400).end();
      return;
    }
    const requested = extname(url.pathname) ? url.pathname : '/index.html';
    const path = resolve(root, '.' + requested);
    if (
      !isContainedBy(root, path) ||
      !existsSync(path) ||
      !lstatSync(path).isFile() ||
      lstatSync(path).isSymbolicLink()
    ) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      'Content-Type':
        extname(path) === '.css'
          ? 'text/css'
          : extname(path) === '.js'
            ? 'text/javascript'
            : 'text/html',
      'Cache-Control': 'no-store',
    });
    response.end(readFileSync(path));
  });
  await new Promise<void>((ok, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', ok);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('React fixture server failed to bind');
  try {
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((ok) => server.close(() => ok()));
  }
}

let sharedBrowser: Browser | null = null;
let launchingBrowser: Promise<Browser> | null = null;
let browserUsers = 0;
let browserIdleTimer: ReturnType<typeof setTimeout> | null = null;

async function withBrowser<T>(run: (browser: Browser) => Promise<T>): Promise<T> {
  if (browserIdleTimer) {
    clearTimeout(browserIdleTimer);
    browserIdleTimer = null;
  }
  // A second Chromium launch has intermittently hung under Bun's test runner
  // after a scored page closes. Reuse the browser process but create and close
  // a separate browser context for every score (see runBrowser below).
  if (!sharedBrowser?.isConnected()) {
    if (!launchingBrowser) {
      launchingBrowser = chromium
        .launch({ ...chromiumLaunchOptions(), timeout: 30_000 })
        .then((browser) => {
          sharedBrowser = browser;
          return browser;
        });
    }
    try {
      await launchingBrowser;
    } finally {
      launchingBrowser = null;
    }
  }
  const browser = sharedBrowser!;
  browserUsers += 1;
  try {
    return await run(browser);
  } finally {
    browserUsers -= 1;
    if (browserUsers === 0) {
      browserIdleTimer = setTimeout(() => {
        browserIdleTimer = null;
        const closing = sharedBrowser;
        sharedBrowser = null;
        void closing?.close().catch(() => undefined);
      }, 5_000);
    }
  }
}

function metrics<T>(page: Page, key: string): Promise<T> {
  return page.evaluate((name) => (window as unknown as Record<string, T>)[name], key);
}

async function runBrowser(
  root: string,
  checks: Check[],
  exercise: (page: Page, browser: Browser, checks: Check[]) => Promise<void>,
  initialPath: string,
): Promise<void> {
  const runtime = await compiledRuntime(root);
  try {
    await withServer(runtime, async (url) =>
      withBrowser(async (browser) => {
        const context = await browser.newContext({ viewport: { width: 900, height: 740 } });
        try {
          const page = await context.newPage();
          page.setDefaultTimeout(2_500);
          page.setDefaultNavigationTimeout(3_000);
          const errors: string[] = [];
          page.on('pageerror', (error) => errors.push(error.message));
          await page.goto(url + initialPath, { waitUntil: 'load' });
          await exercise(page, browser, checks);
          check(
            checks,
            'real React browser without runtime errors',
            errors.length === 0,
            errors.join(' | ') || `React ${REACT_VERSION} / Chromium ${browser.version()}`,
          );
        } finally {
          await context.close();
        }
      }),
    );
  } finally {
    rmSync(runtime, { recursive: true, force: true });
  }
}

async function attempt(
  checks: Check[],
  name: string,
  run: () => Promise<[boolean, string]>,
): Promise<void> {
  try {
    const [passed, detail] = await run();
    check(checks, name, passed, detail);
  } catch (error) {
    check(
      checks,
      name,
      false,
      error instanceof Error ? error.message.slice(0, 450) : String(error),
    );
  }
}

interface SearchMetrics {
  active: number;
  started: number;
  aborted: number;
  lateAfterAbort: number;
  attempts: Record<string, number>;
}

async function exerciseSearch(page: Page, _browser: Browser, checks: Check[]): Promise<void> {
  await attempt(checks, 'initial loading state in rendered React', async () => {
    await page.locator('[aria-busy="true"]').waitFor();
    return [true, 'real mounted component displays pending request'];
  });

  await attempt(
    checks,
    'out-of-order response, cleanup and late non-cancellable result',
    async () => {
      await page.locator('#route-fast').click();
      await page.locator('[data-result-query="fast"]').waitFor();
      await page.waitForTimeout(465);
      const active = await page.locator('[data-result-query]').allTextContents();
      const source = await metrics<SearchMetrics>(page, '__searchSource');
      const ok =
        active.length === 1 &&
        active[0] === 'fast result' &&
        source.aborted >= 1 &&
        source.lateAfterAbort >= 1 &&
        source.active === 0;
      return [ok, `visible=${JSON.stringify(active)} source=${JSON.stringify(source)}`];
    },
  );

  await attempt(
    checks,
    'real browser back and forward restore URL-derived remote state',
    async () => {
      await page.goBack();
      await page.waitForURL(/\?q=slow$/u);
      await page.locator('[data-result-query="slow"]').waitFor();
      await page.goForward();
      await page.waitForURL(/\?q=fast$/u);
      await page.locator('[data-result-query="fast"]').waitFor();
      return [true, `history restored query=${new URL(page.url()).searchParams.get('q')}`];
    },
  );

  await attempt(checks, 'keyboard submit, URL sync and input focus', async () => {
    const field = page.locator('#search-field');
    await field.fill('keyboard');
    await field.press('Enter');
    await page.waitForURL(/\?q=keyboard$/u);
    await page.locator('[data-result-query="keyboard"]').waitFor();
    const focus = await field.evaluate((element) => document.activeElement === element);
    return [focus, `query=${new URL(page.url()).searchParams.get('q')} focused=${focus}`];
  });

  await attempt(
    checks,
    'durable preference survives route changes, unmount and reload',
    async () => {
      const favorite = page.locator('#favorite');
      await favorite.click();
      const persisted = await page.evaluate(() => localStorage.getItem('react-fixture-favorite'));
      await page.locator('#route-slow').click();
      await page.locator('#route-unmount').click();
      await page.locator('[data-unmounted]').waitFor();
      await page.locator('#route-remount').click();
      await page.locator('#favorite[aria-pressed="true"]').waitFor();
      await page.reload();
      await page.locator('#favorite[aria-pressed="true"]').waitFor();
      return [persisted === 'true', `localStorage=${persisted} restored after remount/reload`];
    },
  );

  await attempt(checks, 'error and retry recover with keyboard focus', async () => {
    await page.locator('#route-error').click();
    await page.locator('[role="alert"]').waitFor();
    const retry = page.locator('#retry-search');
    await retry.waitFor();
    const focused = await retry.evaluate((element) => document.activeElement === element);
    await retry.click();
    const heading = page.locator('[data-result-heading]');
    await heading.waitFor();
    const restored = await heading.evaluate((element) => document.activeElement === element);
    const source = await metrics<SearchMetrics>(page, '__searchSource');
    return [
      focused && restored && source.attempts.error >= 2,
      `retryFocused=${focused} resultFocused=${restored} attempts=${source.attempts.error}`,
    ];
  });

  await attempt(checks, 'empty presentation, narrow viewport, no horizontal overflow', async () => {
    await page.locator('#route-empty').click();
    await page.locator('[data-empty]').waitFor();
    const resultCount = await page.locator('[data-result-query]').count();
    await page.setViewportSize({ width: 390, height: 700 });
    const body = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      width: window.innerWidth,
    }));
    const field = page.locator('#search-field');
    await field.focus();
    const focused = await field.evaluate((element) => document.activeElement === element);
    return [
      resultCount === 0 && body.scroll <= body.width + 2 && focused,
      `results=${resultCount} viewport=${JSON.stringify(body)} inputFocused=${focused}`,
    ];
  });

  await attempt(checks, 'unmount aborts slow search with zero later React commits', async () => {
    await page.locator('#route-slow').click();
    await page.waitForFunction(
      () => (window as unknown as { __searchSource: SearchMetrics }).__searchSource.active >= 1,
    );
    const before = await metrics<SearchMetrics>(page, '__searchSource');
    await page.locator('#route-unmount').click();
    await page.locator('[data-unmounted]').waitFor();
    await page.waitForTimeout(465);
    const after = await metrics<SearchMetrics>(page, '__searchSource');
    const commits = await metrics<{ afterDestroy: number }>(page, '__reactCommits');
    const ok =
      after.aborted > before.aborted &&
      after.lateAfterAbort >= 1 &&
      after.active === 0 &&
      commits.afterDestroy === 0 &&
      (await page.locator('[data-result-query]').count()) === 0;
    await page.locator('#route-remount').click();
    await page.locator('[data-result-query="slow"]').waitFor();
    return [
      ok,
      `aborts ${before.aborted}->${after.aborted}; active=${after.active} afterUnmountCommits=${commits.afterDestroy}`,
    ];
  });
}

interface ListMetrics {
  active: number;
  started: number;
  aborted: number;
  completed: number;
  failed: number;
  lateAfterAbort: number;
}

async function draft(page: Page, id: string): Promise<string> {
  return page.locator(`[data-draft-id="${id}"]`).inputValue();
}

async function exerciseList(page: Page, _browser: Browser, checks: Check[]): Promise<void> {
  await attempt(checks, '420 real records with bounded rendered virtual window', async () => {
    await page.locator('[data-row-id="item-003"]').waitFor();
    const count = await page.locator('[data-row-id]').count();
    const total = await page.locator('[data-total]').textContent();
    return [
      count > 0 && count <= 30 && total?.includes('420') === true,
      `visible DOM rows=${count}; ${total}`,
    ];
  });

  await attempt(checks, 'stable keyed identity and focused unsaved draft on sort', async () => {
    await page.locator('#filter').click();
    const row = page.locator('[data-draft-id="item-003"]');
    await row.fill('Item 003 unsaved draft');
    await row.evaluate((element) => {
      (window as unknown as { __rowIdentity: Element }).__rowIdentity = element;
    });
    const focusedBefore = await row.evaluate((element) => document.activeElement === element);
    const before = await page.locator('[data-row-id]').allTextContents();
    const startCommits = await metrics<{ total: number }>(page, '__reactCommits');
    // Trigger React's real handler in Chromium while the row input retains focus.
    // A pointer click would intentionally focus the sort button instead.
    await page.locator('#sort').evaluate((button) => (button as HTMLButtonElement).click());
    const after = await page.locator('[data-row-id]').allTextContents();
    const identity = await row.evaluate(
      (element) => element === (window as unknown as { __rowIdentity: Element }).__rowIdentity,
    );
    const focused = await row.evaluate((element) => document.activeElement === element);
    const endCommits = await metrics<{ total: number }>(page, '__reactCommits');
    return [
      before[0] !== after[0] &&
        identity &&
        focusedBefore &&
        focused &&
        (await draft(page, 'item-003')) === 'Item 003 unsaved draft' &&
        endCommits.total - startCommits.total <= 5,
      `DOM node retained=${identity} focusedBefore=${focusedBefore} focusedAfter=${focused} commits=${endCommits.total - startCommits.total}`,
    ];
  });

  await attempt(
    checks,
    'insert/delete shift positions without moving another row draft',
    async () => {
      await page.locator('#insert').click();
      await page.locator('[data-row-id="item-000"]').waitFor();
      await page.locator('#delete').click();
      const draft03 = await draft(page, 'item-003');
      const draft04 = await draft(page, 'item-004');
      const removed = (await page.locator('[data-row-id="item-001"]').count()) === 0;
      return [
        removed && draft03 === 'Item 003 unsaved draft' && draft04 === 'Item 004',
        `deleted=${removed} draft03=${draft03} draft04=${draft04}`,
      ];
    },
  );

  await attempt(
    checks,
    'server refresh updates clean row and preserves unsaved remote draft',
    async () => {
      await page.locator('#refresh').click();
      await page.locator('[data-draft-id="item-005"]').waitFor();
      await page.waitForFunction(() => {
        const el = document.querySelector<HTMLInputElement>('[data-draft-id="item-005"]');
        return el?.value === 'Item 005 updated server';
      });
      return [
        (await draft(page, 'item-003')) === 'Item 003 unsaved draft',
        `updated05=${await draft(page, 'item-005')} draft03=${await draft(page, 'item-003')}`,
      ];
    },
  );

  await attempt(
    checks,
    'drafts survive filter disappearance and virtual window recycling',
    async () => {
      await page.locator('#filter-hide').click();
      await page.locator('[data-empty]').waitFor();
      await page.locator('#filter').click();
      const restored = await draft(page, 'item-003');
      await page.locator('#sort').click(); // ascending, item-003 is in the first 30 again
      await page.locator('#filter-none').click();
      await page.locator('#window-next').click();
      const hidden = (await page.locator('[data-row-id="item-003"]').count()) === 0;
      await page.locator('#window-prev').click();
      const current = await draft(page, 'item-003');
      const count = await page.locator('[data-row-id]').count();
      return [
        hidden && current === 'Item 003 unsaved draft' && restored === current && count <= 30,
        `filterDraft=${restored} windowDraft=${current} hiddenInNext=${hidden} DOM rows=${count}`,
      ];
    },
  );

  await attempt(checks, 'failed async save has focused retry and successful recovery', async () => {
    const field = page.locator('[data-draft-id="item-004"]');
    await field.fill('Item 004 fail first');
    await page.locator('[data-save-id="item-004"]').click();
    const retry = page.locator('[data-retry-id="item-004"]');
    await retry.waitFor();
    const focused = await retry.evaluate((element) => document.activeElement === element);
    await retry.click();
    await page.locator('[data-status-id="item-004"]').waitFor();
    const source = await metrics<ListMetrics>(page, '__listSource');
    return [
      focused &&
        source.failed >= 1 &&
        source.completed >= 1 &&
        (await draft(page, 'item-004')) === 'Item 004 fail first',
      `focused=${focused} failed=${source.failed} saved=${source.completed}`,
    ];
  });

  await attempt(
    checks,
    'slow save abort on unmount prevents server commit and later React render',
    async () => {
      const row = page.locator('[data-draft-id="item-003"]');
      await row.fill('Item 003 slow save');
      await page.locator('[data-save-id="item-003"]').click();
      await page.waitForFunction(
        () => (window as unknown as { __listSource: ListMetrics }).__listSource.active >= 1,
      );
      const before = await metrics<ListMetrics>(page, '__listSource');
      await page.locator('#list-unmount').click();
      await page.locator('[data-unmounted]').waitFor();
      await page.waitForTimeout(465);
      const after = await metrics<ListMetrics>(page, '__listSource');
      const commits = await metrics<{ afterDestroy: number }>(page, '__reactCommits');
      await page.locator('#list-remount').click();
      const unchanged = await draft(page, 'item-003');
      return [
        after.aborted > before.aborted &&
          after.lateAfterAbort >= 1 &&
          after.active === 0 &&
          commits.afterDestroy === 0 &&
          unchanged === 'Item 003',
        `aborts=${before.aborted}->${after.aborted} late=${after.lateAfterAbort} commits=${commits.afterDestroy} serverItem=${unchanged}`,
      ];
    },
  );

  await attempt(
    checks,
    'narrow viewport and render commit budget without overflowing',
    async () => {
      await page.setViewportSize({ width: 390, height: 710 });
      const sizes = await page.evaluate(() => ({
        scroll: document.documentElement.scrollWidth,
        viewport: innerWidth,
      }));
      const before = await metrics<{ total: number }>(page, '__reactCommits');
      // Reorder through the fixed harness while leaving the input focused. A physical
      // mouse click would correctly transfer focus to the sort button itself.
      await page.locator('#sort').evaluate((button) => (button as HTMLButtonElement).click());
      const after = await metrics<{ total: number }>(page, '__reactCommits');
      return [
        sizes.scroll <= sizes.viewport + 2 &&
          after.total - before.total <= 6 &&
          (await page.locator('[data-row-id]').count()) <= 30,
        `viewport=${JSON.stringify(sizes)} profilerCommits=${after.total - before.total}`,
      ];
    },
  );
}

async function scoreScenario(root: string, number: 1 | 2): Promise<SkillEvalDeterministicScore> {
  const checks: Check[] = [];
  const valid = immutable(root, number) && safeSource(root);
  check(
    checks,
    'immutable harness/service and safe local source',
    valid,
    valid
      ? 'React harness, external services, pinned runtime contract preserved'
      : 'missing or modified immutable source, or symlink/special file',
    false,
  );
  const artifacts = artifactsReady(root, number);
  check(
    checks,
    'candidate-authored boundary and verification artifacts',
    artifacts,
    artifacts
      ? 'version, hierarchy, required scenarios and recovery evidence present'
      : 'missing/incomplete/unverified artifacts',
    false,
  );
  if (!valid || !artifacts) return finish(checks, !valid);
  try {
    await runBrowser(
      root,
      checks,
      number === 1 ? exerciseSearch : exerciseList,
      number === 1 ? '/?q=slow' : '/',
    );
  } catch (error) {
    check(
      checks,
      'build or native Chromium assertion execution',
      false,
      error instanceof Error ? error.message.slice(0, 1_000) : String(error),
    );
  }
  return finish(checks, false);
}

export const REACT_BROWSER_SKILL_EVAL_SCORERS: readonly SkillEvalDeterministicScorer[] = [
  {
    id: 'react-engineering/search-real-react-chromium-scorer@1',
    scenarioIds: [SEARCH],
    score: ({ workingDirectory }) => scoreScenario(workingDirectory, 1),
  },
  {
    id: 'react-engineering/keyed-window-real-react-chromium-scorer@1',
    scenarioIds: [LIST],
    score: ({ workingDirectory }) => scoreScenario(workingDirectory, 2),
  },
];
