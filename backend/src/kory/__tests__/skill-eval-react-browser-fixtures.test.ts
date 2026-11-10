import { afterEach, expect, spyOn, test } from 'bun:test';
import { linkSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { browserControlTest } from './browser-runtime-test-policy';
import { isWindows } from '../../runtime/platform';
import { auditSkillEvalExecutionReadiness } from '../skill-eval-execution';
import {
  BUILTIN_SKILL_EVAL_MATERIALIZERS,
  BUILTIN_SKILL_EVAL_SCORERS,
} from '../skill-eval-fixtures';
import { buildSkillEvalSuiteV3 } from '../skill-eval-harness';
import { writeFixtureFile } from '../skill-eval-fixture-helpers';
import { loadV5SkillPackages } from '../skill-packages';
import {
  REACT_BROWSER_EVAL_CONSTANTS,
  REACT_BROWSER_SKILL_EVAL_MATERIALIZERS,
  REACT_BROWSER_SKILL_EVAL_SCORERS,
  reactBrowserReadiness,
  writeReactBrowserFixtureContract,
} from '../skill-eval-react-browser-fixtures';

const SEARCH = 'react-engineering-full-task-1-individual';
const LIST = 'react-engineering-full-task-2-individual';
const roots: string[] = [];
const browserTest = browserControlTest('React/Chromium', reactBrowserReadiness());

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scenario(id: string) {
  const pkg = loadV5SkillPackages().packages.find(
    (item) => item.sidecar.name === 'react-engineering',
  );
  expect(pkg).toBeDefined();
  const result = buildSkillEvalSuiteV3(pkg!).scenarios.find((item) => item.id === id);
  expect(result).toBeDefined();
  return result!;
}

function fixture(id: string, runtime = false) {
  const root = mkdtempSync(join(tmpdir(), 'kory-react-browser-test-'));
  roots.push(root);
  const evalScenario = scenario(id);
  const materializer = REACT_BROWSER_SKILL_EVAL_MATERIALIZERS.find((item) =>
    item.matches(evalScenario),
  )!;
  const scorer = REACT_BROWSER_SKILL_EVAL_SCORERS.find((item) => item.scenarioIds.includes(id))!;
  if (runtime) materializer.materialize(root, evalScenario);
  else writeReactBrowserFixtureContract(root, id === SEARCH ? 1 : 2);
  const score = () =>
    scorer.score({
      scenario: evalScenario,
      experiment: {} as never,
      workingDirectory: root,
      observation: { output: '', evidence: [], artifacts: [], durationMs: 0 },
    });
  return { root, materializer, score };
}

function evidence(root: string, number: 1 | 2): void {
  const checks =
    number === 1
      ? [
          'stale-race',
          'abort-on-unmount',
          'history',
          'loading-empty-error',
          'retry-focus',
          'keyboard',
          'mobile',
          'durable-preference',
        ]
      : [
          'stable-keys',
          'draft-preservation',
          'server-refresh',
          'virtual-window',
          'retry-focus',
          'abort-on-unmount',
          'mobile',
          'render-commits',
        ];
  writeFixtureFile(
    root,
    `verification/scenario-${number}-result.json`,
    JSON.stringify({
      status: 'verified',
      reactVersion: REACT_BROWSER_EVAL_CONSTANTS.reactVersion,
      broaderSkill: 'frontend-engineering',
      nearNeighbor: number === 1 ? 'angular-engineering' : 'svelte-engineering',
      stateBoundary:
        'Server state is asynchronous; URL state controls routes; saved favorite is durable; drafts and focus are local view state.',
      success:
        'Observed actual browser interaction, stable state, correct results and focus restoration.',
      negativeRecovery:
        'Verified delayed responses, aborted transitions, failures, retry and restored user-owned state.',
    }),
  );
  writeFixtureFile(
    root,
    `verification/scenario-${number}-verification.json`,
    JSON.stringify({
      status: 'verified',
      evidenceType: 'real-browser',
      checks,
      observations: [
        'React mounted and received real browser clicks.',
        'Recovery and unmount were exercised.',
      ],
    }),
  );
}

const GREEN_SEARCH = `import React, { useEffect, useRef, useState } from 'react';
import { search } from './search-source.js';

const routeQuery = () => new URLSearchParams(location.search).get('q') || 'slow';

export default function App() {
  const [query, setQuery] = useState(routeQuery);
  const [input, setInput] = useState(query);
  const [retry, setRetry] = useState(0);
  const [state, setState] = useState({ status: 'loading', results: [] });
  const [favorite, setFavorite] = useState(() => localStorage.getItem('react-fixture-favorite') === 'true');
  const [focusResult, setFocusResult] = useState(false);
  const retryRef = useRef(null);
  const headingRef = useRef(null);

  useEffect(() => {
    const onRoute = () => { const next = routeQuery(); setQuery(next); setInput(next); setRetry(0); setFocusResult(false); };
    addEventListener('popstate', onRoute);
    return () => removeEventListener('popstate', onRoute);
  }, []);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setState({ status: 'loading', results: [] });
    search(query, { signal: controller.signal }).then((results) => {
      if (active) setState({ status: 'done', results });
    }).catch((error) => {
      if (active && error.name !== 'AbortError') setState({ status: 'error', message: error.message, results: [] });
    });
    return () => { active = false; controller.abort(); };
  }, [query, retry]);

  useEffect(() => {
    if (state.status === 'error') retryRef.current?.focus();
    if (state.status === 'done' && state.results.length && focusResult) headingRef.current?.focus();
  }, [state, focusResult]);

  const submit = (event) => {
    event.preventDefault();
    history.pushState({}, '', '/?q=' + encodeURIComponent(input));
    setQuery(input);
    setFocusResult(false);
  };
  const toggleFavorite = () => {
    const next = !favorite;
    localStorage.setItem('react-fixture-favorite', String(next));
    setFavorite(next);
  };
  return <section className="panel" data-search-app>
    <h1>Search items</h1>
    <form onSubmit={submit}><label className="field" htmlFor="search-field">Query
      <input id="search-field" value={input} onChange={(event) => setInput(event.target.value)} />
    </label><button type="submit">Search</button></form>
    <button type="button" id="favorite" aria-pressed={favorite} onClick={toggleFavorite}>Saved preference</button>
    {state.status === 'loading' ? <p role="status" aria-busy="true">Loading results</p> : null}
    {state.status === 'error' ? <div role="alert"><p>{state.message}</p>
      <button ref={retryRef} id="retry-search" type="button" onClick={() => { setRetry((x) => x + 1); setFocusResult(true); }}>Retry</button></div> : null}
    {state.status === 'done' && !state.results.length ? <p data-empty>No matches</p> : null}
    {state.status === 'done' && state.results.map((item) => <h2 key={item.id} ref={headingRef} tabIndex={-1} data-result-heading data-result-query={item.id}>{item.title}</h2>)}
  </section>;
}
`;

const GREEN_LIST = `import React, { memo, useEffect, useRef, useState } from 'react';
import { saveItem } from './list-source.js';

const Row = memo(function Row({ item, draft, onDraft, onCommit }) {
  const [status, setStatus] = useState('idle');
  const [message, setMessage] = useState('');
  const controller = useRef(null);
  const retryRef = useRef(null);
  useEffect(() => () => { controller.current?.abort(); }, []);
  useEffect(() => { if (status === 'error') retryRef.current?.focus(); }, [status]);

  function save() {
    controller.current?.abort();
    const pending = new AbortController();
    controller.current = pending;
    setMessage('');
    setStatus('saving');
    saveItem(item.id, draft, { signal: pending.signal })
      .then((record) => {
        if (pending.signal.aborted) return;
        onCommit(record.id, record.title);
        setStatus('saved');
      })
      .catch((error) => {
        if (pending.signal.aborted) return;
        setMessage(error.message);
        setStatus('error');
      });
  }

  return <li className="row" data-row-id={item.id}>
    <label htmlFor={'draft-' + item.id}>{item.id}</label>
    <input id={'draft-' + item.id} data-draft-id={item.id} value={draft}
      onChange={(event) => onDraft(item.id, event.target.value)} />
    <div>
      <button type="button" data-save-id={item.id} onClick={save} disabled={status === 'saving'}>Save</button>
      {status === 'saving' ? <span role="status" aria-busy="true">Saving</span> : null}
      {status === 'error' ? <span role="alert" data-error-id={item.id}>{message}
        <button type="button" data-retry-id={item.id} ref={retryRef} onClick={save}>Retry</button></span> : null}
      {status === 'saved' ? <span data-status-id={item.id}>Saved</span> : null}
    </div>
  </li>;
});

export default function App({ items, descending, filter, offset, onCommit }) {
  const [drafts, setDrafts] = useState({});
  const setDraft = (id, text) => setDrafts((previous) => ({ ...previous, [id]: text }));
  const visible = [...items].filter((item) => item.title.includes(filter))
    .sort((a, b) => descending ? b.title.localeCompare(a.title) : a.title.localeCompare(b.title))
    .slice(offset, offset + 30);
  return <section className="panel" data-list-app>
    <h1>Editable records</h1><p data-total>{items.length} items</p>
    <ul className="rows">{visible.map((item) => <Row key={item.id} item={item}
      draft={drafts[item.id] ?? item.title} onDraft={setDraft} onCommit={onCommit} />)}</ul>
    {!visible.length ? <p data-empty>No items in this window</p> : null}
  </section>;
}
`;

test('React runtime registration reports its actual prerequisites', () => {
  expect(REACT_BROWSER_EVAL_CONSTANTS.reactVersion).toBe('19.2.8');
  expect(REACT_BROWSER_SKILL_EVAL_MATERIALIZERS).toHaveLength(2);
  for (const item of REACT_BROWSER_SKILL_EVAL_MATERIALIZERS) {
    expect(item.realRuntime).toBe(true);
    expect(item.readinessBlockers ?? []).toEqual(reactBrowserReadiness());
  }
});

test('registered real-browser evaluators supersede both external React environment gates', () => {
  const packages = loadV5SkillPackages().packages;
  const readiness = auditSkillEvalExecutionReadiness(
    packages,
    BUILTIN_SKILL_EVAL_MATERIALIZERS,
    BUILTIN_SKILL_EVAL_SCORERS,
  );
  for (const id of [SEARCH, LIST]) {
    const row = readiness.find((item) => item.scenarioId === id);
    expect(row).toBeDefined();
    expect(row?.ready).toBe(reactBrowserReadiness().length === 0);
    expect(row?.reasons).toEqual(reactBrowserReadiness());
    expect(row?.materializerId).toContain('real-react-chromium@2');
    expect(row?.deterministicScorerId).toContain('real-react-chromium-scorer@1');
  }
}, 90_000);

test('missing assets block React materialization without launching a browser', () => {
  const cache = mkdtempSync(join(tmpdir(), 'kory-react-empty-cache-'));
  roots.push(cache);
  const previousCache = process.env.BUN_INSTALL_CACHE_DIR;
  const path = spyOn(chromium, 'executablePath').mockReturnValue(join(cache, 'missing-chromium'));
  const launch = spyOn(chromium, 'launch').mockRejectedValue(new Error('Unexpected browser launch'));
  try {
    process.env.BUN_INSTALL_CACHE_DIR = cache;
    const blockers = reactBrowserReadiness();
    expect(blockers).toHaveLength(4);
    expect(blockers.join('\n')).toContain('Missing pinned react@19.2.8');
    expect(() => fixture(SEARCH, true)).toThrow('Missing pinned react@19.2.8');
    expect(REACT_BROWSER_SKILL_EVAL_MATERIALIZERS[0].readinessBlockers).toEqual(blockers);
    expect(launch).not.toHaveBeenCalled();
  } finally {
    if (previousCache === undefined) delete process.env.BUN_INSTALL_CACHE_DIR;
    else process.env.BUN_INSTALL_CACHE_DIR = previousCache;
    path.mockRestore();
    launch.mockRestore();
  }
});

test('both React fixtures disclose the required evidence schema and exact browser checks', () => {
  for (const [id, number, neighbor, checks] of [
    [SEARCH, 1, 'angular-engineering', ['stale-race', 'durable-preference']],
    [LIST, 2, 'svelte-engineering', ['stable-keys', 'render-commits']],
  ] as const) {
    const { root } = fixture(id);
    const readme = readFileSync(join(root, 'README.md'), 'utf8');
    const fields = [
      'status',
      'reactVersion',
      'broaderSkill',
      'nearNeighbor',
      'stateBoundary',
      'success',
      'negativeRecovery',
      'evidenceType',
      'checks',
      'observations',
    ];
    for (const name of fields) expect(readme, `${id} is missing ${name}`).toContain(`"${name}"`);
    expect(readme).toContain(`"nearNeighbor": "${neighbor}"`);
    expect(readme).toContain(`verification/scenario-${number}-result.json`);
    expect(readme).toContain(`verification/scenario-${number}-verification.json`);
    for (const name of checks) expect(readme).toContain(`"${name}"`);
    expect(readme).toContain('Leave status as TODO if you cannot substantiate verification');
  }
});

browserTest('search stale-race starter fails while corrected React passes actual Chromium assertions', async () => {
  const { root, score } = fixture(SEARCH, true);
  evidence(root, 1);
  const red = await score();
  expect(red.passed).toBe(false);
  expect(
    red.evidence.some((text) => text.includes('out-of-order response') && text.includes('fail')),
  ).toBe(true);

  writeFixtureFile(root, 'src/App.jsx', GREEN_SEARCH);
  const green = await score();
  if (!green.passed) console.error(green.evidence.join('\n'));
  expect(green.passed).toBe(true);
  expect(green.verification).toBe(1);
  expect(green.evidence.some((text) => text.includes('Chromium') && text.includes('pass'))).toBe(
    true,
  );
}, 120_000);

browserTest('index-key starter fails but ID-keyed React list passes real focus, refresh and cleanup', async () => {
  const { root, score } = fixture(LIST, true);
  evidence(root, 2);
  const red = await score();
  expect(red.passed).toBe(false);
  expect(
    red.evidence.some((text) => text.includes('stable keyed identity') && text.includes('fail')),
  ).toBe(true);

  writeFixtureFile(root, 'src/App.jsx', GREEN_LIST);
  const green = await score();
  if (!green.passed) console.error(green.evidence.join('\n'));
  expect(green.passed).toBe(true);
  expect(green.verification).toBe(1);
  expect(
    green.evidence.some((text) => text.includes('420 real records') && text.includes('pass')),
  ).toBe(true);
}, 120_000);

test('unverified narrative cannot enable browser certification', async () => {
  const { score } = fixture(SEARCH);
  const result = await score();
  expect(result.passed).toBe(false);
  expect(result.verification).toBe(0);
  expect(result.evidence.join(' ')).toContain('missing/incomplete/unverified artifacts');
});

test('tampered control source fails integrity without executing Chromium', async () => {
  const { root, score } = fixture(LIST);
  evidence(root, 2);
  writeFixtureFile(
    root,
    'src/list-source.js',
    'export function fakeCertification() { return true; }\n',
  );
  const result = await score();
  expect(result.integrityFailure).toBe(true);
  expect(result.passed).toBe(false);
  expect(result.verification).toBe(0);
});

test.skipIf(isWindows())('hard-linked candidate source fails integrity without executing Chromium', async () => {
  const { root, score } = fixture(SEARCH);
  const external = mkdtempSync(join(tmpdir(), 'kory-react-browser-hardlink-'));
  roots.push(external);
  writeFileSync(join(external, 'App.jsx'), readFileSync(join(root, 'src', 'App.jsx')));
  rmSync(join(root, 'src', 'App.jsx'));
  linkSync(join(external, 'App.jsx'), join(root, 'src', 'App.jsx'));
  evidence(root, 1);

  const result = await score();
  expect(result.integrityFailure).toBe(true);
  expect(result.passed).toBe(false);
  expect(result.verification).toBe(0);
});
