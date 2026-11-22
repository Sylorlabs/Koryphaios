import { createRequire } from 'node:module';
import { createServer, type Server } from 'node:http';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, type Browser } from 'playwright';
import type {
  SkillEvalDeterministicScore,
  SkillEvalDeterministicScorer,
  SkillEvalFixtureMaterializer,
} from './skill-eval-execution';
import { readFixtureText, readJsonArtifact, writeFixtureFile } from './skill-eval-fixture-helpers';

const SCENARIO_STATE = 'svelte-engineering-full-task-1-individual';
const SCENARIO_ROUTE = 'svelte-engineering-full-task-2-individual';
const BRAVE_PATH = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
// This module exists in two trees: `backend/src/kory` sits three levels below the
// project root, `backend/src/eval/skills` four. Resolving a fixed number of parents
// made the eval copy look for `backend/frontend` and report the Svelte compiler as
// missing on a host that has it installed. Locate the root by the workspace it owns.
const PROJECT_ROOT =
  [resolve(MODULE_DIR, '../../..'), resolve(MODULE_DIR, '../../../..')].find((candidate) =>
    existsSync(join(candidate, 'frontend', 'package.json')),
  ) ?? resolve(MODULE_DIR, '../../..');
const FRONTEND_ROOT = join(PROJECT_ROOT, 'frontend');
const SVELTE_PACKAGE = join(FRONTEND_ROOT, 'node_modules/svelte/package.json');
const SVELTE_COMPILER = join(FRONTEND_ROOT, 'node_modules/svelte/compiler/index.js');

let sharedBrowser: Browser | null = null;
let sharedBrowserUsers = 0;
let browserIdleTimer: ReturnType<typeof setTimeout> | null = null;

async function withBrave<T>(run: (browser: Browser) => Promise<T>): Promise<T> {
  if (browserIdleTimer) {
    clearTimeout(browserIdleTimer);
    browserIdleTimer = null;
  }
  if (!sharedBrowser?.isConnected()) {
    sharedBrowser = await chromium.launch({
      executablePath: BRAVE_PATH,
      headless: true,
      timeout: 8_000,
    });
  }
  const browser = sharedBrowser;
  sharedBrowserUsers += 1;
  try {
    return await run(browser);
  } finally {
    sharedBrowserUsers = Math.max(0, sharedBrowserUsers - 1);
    if (sharedBrowserUsers === 0) {
      browserIdleTimer = setTimeout(() => {
        const closing = sharedBrowser;
        sharedBrowser = null;
        browserIdleTimer = null;
        void closing?.close().catch(() => undefined);
      }, 1_000);
    }
  }
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

const INDEX_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Kory Svelte evaluation</title>
  </head>
  <body><div id="app"></div><script type="module" src="/app.js"></script></body>
</html>
`;

const MAIN_JS = `import { mount } from 'svelte';
import Harness from './Harness.svelte';

mount(Harness, { target: document.querySelector('#app') });
`;

const BASE_STYLE = `<style>
  :global(*) { box-sizing: border-box; }
  :global(body) { margin: 0; font: 16px/1.45 system-ui, sans-serif; color: #172033; background: #f5f7fb; }
  :global(button), :global(a) { font: inherit; }
  :global(:focus-visible) { outline: 3px solid #4169e1; outline-offset: 2px; }
  :global(.shell) { width: min(760px, calc(100% - 28px)); margin: 24px auto; }
  :global(.panel) { min-width: 0; padding: 20px; background: white; border: 1px solid #d9dfeb; border-radius: 10px; }
  :global(.harness-actions) { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 16px; }
  :global(.status) { overflow-wrap: anywhere; }
</style>`;

const KORY_SELECT = `<script>
  import { onMount } from 'svelte';
  let { options = [], value = $bindable(''), label = 'Item' } = $props();
  let open = $state(false);
  let activeIndex = $state(0);
  let button;
  let selected = $derived(options.find((option) => option.id === value) ?? options[0] ?? null);

  onMount(() => {
    window.__korySelectMounts = (window.__korySelectMounts ?? 0) + 1;
    window.__korySelectActive = (window.__korySelectActive ?? 0) + 1;
    return () => { window.__korySelectActive = Math.max(0, (window.__korySelectActive ?? 1) - 1); };
  });

  function choose(index) {
    const option = options[index];
    if (!option) return;
    value = option.id;
    open = false;
    queueMicrotask(() => button?.focus());
  }

  function keydown(event) {
    if (event.key === 'Escape') {
      open = false;
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (open) choose(activeIndex);
      else {
        open = true;
        activeIndex = Math.max(0, options.findIndex((option) => option.id === value));
      }
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (!open) open = true;
      activeIndex = Math.min(options.length - 1, activeIndex + 1);
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) open = true;
      activeIndex = Math.max(0, activeIndex - 1);
    }
  }
</script>

<div class="select-shell">
  <span id="kory-select-label">{label}</span>
  <button
    id="kory-select-trigger"
    bind:this={button}
    type="button"
    role="combobox"
    aria-labelledby="kory-select-label"
    aria-haspopup="listbox"
    aria-expanded={open}
    onkeydown={keydown}
  >{selected?.label ?? 'Choose an item'}</button>
  {#if open}
    <ul role="listbox" aria-labelledby="kory-select-label">
      {#each options as option, index (option.id)}
        <li>
          <button
            type="button"
            role="option"
            aria-selected={option.id === value}
            class:active={index === activeIndex}
            onclick={() => choose(index)}
          >{option.label}</button>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .select-shell { position: relative; display: grid; gap: 6px; max-width: 100%; }
  #kory-select-trigger { min-height: 42px; text-align: left; padding: 8px 12px; background: white; border: 1px solid #aeb8c8; border-radius: 8px; }
  ul { position: absolute; z-index: 5; top: 70px; left: 0; right: 0; max-height: 220px; overflow: auto; margin: 0; padding: 6px; list-style: none; background: white; border: 1px solid #aeb8c8; border-radius: 8px; box-shadow: 0 8px 24px #0002; }
  li button { width: 100%; min-height: 38px; text-align: left; border: 0; border-radius: 6px; background: transparent; padding: 7px 9px; }
  li button.active, li button[aria-selected='true'] { background: #e9efff; }
</style>`;

const STATE_HARNESS = `<script>
  import App from './App.svelte';
  let items = $state([
    { id: 'alpha', label: 'Alpha' },
    { id: 'beta', label: 'Beta' },
    { id: 'gamma', label: 'Gamma' },
  ]);
  let filter = $state('');
  let loading = $state(false);
  let error = $state('');
  let mounted = $state(true);

  function normal() {
    items = [
      { id: 'alpha', label: 'Alpha' },
      { id: 'beta', label: 'Beta' },
      { id: 'gamma', label: 'Gamma' },
    ];
    filter = '';
    loading = false;
    error = '';
  }
  function rapidUpdate() {
    items = [
      { id: 'gamma', label: 'Gamma' },
      { id: 'beta', label: 'Beta' },
      { id: 'alpha', label: 'Alpha' },
    ];
    filter = 'a';
    items = [
      { id: 'gamma', label: 'Gamma' },
      { id: 'alpha', label: 'Alpha' },
      { id: 'beta', label: 'Beta' },
    ];
  }
</script>

<div class="shell">
  <div class="harness-actions" aria-label="Evaluation states">
    <button id="normal" type="button" onclick={normal}>Normal</button>
    <button id="rapid-update" type="button" onclick={rapidUpdate}>Rapid update</button>
    <button id="remove-beta" type="button" onclick={() => { items = items.filter((item) => item.id !== 'beta'); }}>Remove Beta</button>
    <button id="loading" type="button" onclick={() => { loading = true; error = ''; }}>Loading</button>
    <button id="empty" type="button" onclick={() => { items = []; loading = false; error = ''; }}>Empty</button>
    <button id="error" type="button" onclick={() => { error = 'Fixture request failed'; loading = false; }}>Error</button>
    <button id="destroy" type="button" onclick={() => { mounted = false; }}>Destroy</button>
    <button id="remount" type="button" onclick={() => { mounted = true; }}>Remount</button>
  </div>
  {#if mounted}
    <App {items} {filter} {loading} {error} />
  {:else}
    <p data-destroyed>Component destroyed</p>
  {/if}
</div>
${BASE_STYLE}`;

const STATE_STARTER = `<script>
  import KorySelect from './KorySelect.svelte';
  let { items, filter, loading = false, error = '' } = $props();
  let visible = $state([]);
  let selectedId = $state('');

  $effect(() => {
    visible = items.filter((item) => item.label.toLowerCase().includes(filter.toLowerCase()));
    selectedId = visible[0]?.id ?? '';
  });
</script>

<section class="panel" data-component-state>
  <h1>Item inspector</h1>
  {#if loading}
    <p aria-busy="true">Loading items…</p>
  {:else if error}
    <p role="alert">{error}</p>
  {:else if visible.length === 0}
    <p data-empty>No matching items</p>
  {:else}
    <KorySelect options={visible} bind:value={selectedId} label="Active item" />
    <p class="status" data-selected>Selected: {visible.find((item) => item.id === selectedId)?.label ?? 'None'}</p>
  {/if}
</section>`;

const ROUTE_SOURCE = `const attempts = new Map();
let active = 0;
let cleanups = 0;

function publish() {
  window.__detailMetrics = { active, cleanups, attempts: Object.fromEntries(attempts) };
}

export function subscribeDetail(id, handlers) {
  active += 1;
  const attempt = (attempts.get(id) ?? 0) + 1;
  attempts.set(id, attempt);
  publish();
  let settled = false;
  const delay = id === 'alpha' ? 350 : id === 'beta' ? 55 : 80;
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    active -= 1;
    publish();
    if (id === 'error' && attempt === 1) handlers.error(new Error('Fixture detail failure'));
    else handlers.data({ id, title: id === 'alpha' ? 'Alpha detail' : id === 'beta' ? 'Beta detail' : 'Recovered detail' });
  }, delay);
  return () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    active -= 1;
    cleanups += 1;
    publish();
  };
}

publish();
`;

const ROUTE_HARNESS = `<script>
  import { onMount } from 'svelte';
  import App from './App.svelte';
  const routeFromPath = () => location.pathname.split('/').filter(Boolean).at(-1) ?? 'alpha';
  let id = $state(routeFromPath());
  let mounted = $state(true);

  function navigate(next) {
    history.pushState({}, '', '/details/' + next);
    id = next;
  }
  onMount(() => {
    const pop = () => { id = routeFromPath(); };
    addEventListener('popstate', pop);
    return () => removeEventListener('popstate', pop);
  });
</script>

<div class="shell">
  <nav class="harness-actions" aria-label="Fixture routes">
    <a id="route-alpha" href="/details/alpha" onclick={(event) => { event.preventDefault(); navigate('alpha'); }}>Alpha</a>
    <a id="route-beta" href="/details/beta" onclick={(event) => { event.preventDefault(); navigate('beta'); }}>Beta</a>
    <a id="route-error" href="/details/error" onclick={(event) => { event.preventDefault(); navigate('error'); }}>Error</a>
    <button id="destroy" type="button" onclick={() => { mounted = false; }}>Destroy detail</button>
    <button id="remount" type="button" onclick={() => { mounted = true; }}>Remount detail</button>
  </nav>
  {#if mounted}<App {id} />{:else}<p data-destroyed>Detail component destroyed</p>{/if}
</div>
${BASE_STYLE}`;

const ROUTE_STARTER = `<script>
  import { tick } from 'svelte';
  import { subscribeDetail } from './detail-source.js';
  let { id } = $props();
  let detail = $state(null);
  let loading = $state(true);
  let error = $state('');
  let retry = $state(0);

  $effect(() => {
    retry;
    loading = true;
    error = '';
    detail = null;
    subscribeDetail(id, {
      data: async (value) => {
        detail = value;
        loading = false;
        await tick();
        document.querySelector('[data-detail-heading]')?.focus();
      },
      error: async (failure) => {
        error = failure.message;
        loading = false;
        await tick();
        document.querySelector('#retry-detail')?.focus();
      },
    });
  });
</script>

<section class="panel">
  <h1>Detail route</h1>
  {#if loading}
    <p aria-busy="true">Loading detail…</p>
  {:else if error}
    <div role="alert"><p>{error}</p><button id="retry-detail" type="button" onclick={() => { retry += 1; }}>Retry detail</button></div>
  {:else if detail}
    <h2 data-detail-heading tabindex="-1">{detail.title}</h2>
    <p data-detail-id>{detail.id}</p>
  {/if}
</section>`;

interface SvelteResultArtifact {
  svelteVersion?: string;
  reactivityGeneration?: string;
  executionBoundary?: string;
  broaderSkill?: string;
  nearNeighbor?: string;
  sharedControl?: string;
  status?: string;
  reason?: string;
  authored_evidence?: {
    success_path?: string;
    failure_recovery_path?: string;
    browser_observations?: unknown[];
  };
}

interface SvelteVerificationArtifact {
  evidenceType?: string;
  checks?: string[];
  negativeRecovery?: string[];
  status?: string;
  environment?: {
    reactivity?: string;
    exact_versions?: string;
    execution_boundary?: string;
  };
  scenarios?: Array<{
    name?: string;
    steps?: string[];
    expect?: string[];
  }>;
}

interface BrowserCheck {
  name: string;
  passed: boolean;
  detail: string;
}

function add(checks: BrowserCheck[], name: string, passed: boolean, detail: string): void {
  checks.push({ name, passed, detail });
}

function score(checks: BrowserCheck[], integrityFailure = false): SkillEvalDeterministicScore {
  const passed = checks.filter((item) => item.passed).length;
  const all = checks.length > 0 && passed === checks.length && !integrityFailure;
  return {
    passed: all,
    quality: checks.length ? passed / checks.length : 0,
    verification: all ? 1 : 0,
    integrityFailure,
    evidence: checks.map(
      (item) => `${item.name}: ${item.passed ? 'pass' : 'fail'} — ${item.detail}`,
    ),
  };
}

function fixed(root: string, path: string, expected: string): boolean {
  try {
    return readFixtureText(root, path) === expected;
  } catch {
    return false;
  }
}

function svelteVersion(): string {
  try {
    return JSON.parse(readFileSync(SVELTE_PACKAGE, 'utf8')).version as string;
  } catch {
    return 'unavailable';
  }
}

async function buildSvelteFixture(root: string): Promise<string> {
  // Registration and integrity checks do not require an installed compiler/runtime.
  const SVELTE_ROOT = dirname(realpathSync(SVELTE_PACKAGE));
  const svelteRequire = createRequire(join(SVELTE_ROOT, 'package.json'));
  const runtime = join(root, 'evaluation', 'svelte-runtime');
  mkdirSync(runtime, { recursive: true });
  const compilerModule = await import(pathToFileURL(SVELTE_COMPILER).href);
  const compiler = (compilerModule.default ?? compilerModule) as {
    compile: (source: string, options: Record<string, unknown>) => { js: { code: string } };
  };
  let build;
  try {
    build = await Bun.build({
      entrypoints: [join(root, 'src', 'main.js')],
      outdir: runtime,
      target: 'browser',
      format: 'esm',
      sourcemap: 'none',
      minify: false,
      plugins: [
        {
          name: 'kory-svelte-eval',
          setup(builder) {
            builder.onResolve({ filter: /^[A-Za-z@][^:]*$/u }, (args) => {
              if (args.path === 'svelte') return { path: join(SVELTE_ROOT, 'src/index-client.js') };
              if (args.path === 'svelte/store')
                return { path: join(SVELTE_ROOT, 'src/store/index-client.js') };
              if (args.path === 'svelte/reactivity')
                return { path: join(SVELTE_ROOT, 'src/reactivity/index-client.js') };
              if (args.path.startsWith('svelte/'))
                return { path: svelteRequire.resolve(args.path) };
              if (args.importer.startsWith(SVELTE_ROOT)) {
                try {
                  return { path: svelteRequire.resolve(args.path) };
                } catch {
                  return undefined;
                }
              }
              return undefined;
            });
            builder.onLoad({ filter: /\.svelte$/u }, async (args) => {
              const source = readFileSync(args.path, 'utf8');
              const compiled = compiler.compile(source, {
                filename: args.path,
                generate: 'client',
                dev: true,
              });
              return { contents: compiled.js.code, loader: 'js' };
            });
          },
        },
      ],
    });
  } catch (error) {
    const nested =
      error instanceof AggregateError
        ? error.errors
            .map((item) => (item instanceof Error ? `${item.name}: ${item.message}` : String(item)))
            .join(' | ')
        : '';
    const owned =
      error && typeof error === 'object'
        ? Reflect.ownKeys(error)
            .map((key) => `${String(key)}=${String(Reflect.get(error, key))}`)
            .join(' | ')
        : '';
    throw new Error(
      `Svelte browser bundle threw: ${error instanceof Error ? error.message : String(error)}${nested ? `; nested=${nested}` : ''}${owned ? `; details=${owned}` : ''}`,
    );
  }
  if (!build.success) {
    throw new Error(
      `Svelte browser build failed: ${build.logs.map((item) => item.message).join('; ')}`,
    );
  }
  const entry = build.outputs.find((output) => output.kind === 'entry-point') ?? build.outputs[0];
  if (!entry) throw new Error('Svelte browser build emitted no entry point');
  const entryName = basename(entry.path);
  writeFixtureFile(runtime, 'index.html', INDEX_HTML.replace('/app.js', `/${entryName}`));
  return runtime;
}

function safeFile(root: string, urlPath: string): string | null {
  const decoded = decodeURIComponent(urlPath).replace(/^\/+/, '') || 'index.html';
  const candidate = resolve(root, decoded);
  const rel = relative(root, candidate);
  if (rel.startsWith('..') || rel.split(/[\\/]/u).some((part) => part === '..')) return null;
  if (!existsSync(candidate)) return null;
  const stat = lstatSync(candidate);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 5_000_000) return null;
  return candidate;
}

function mime(path: string): string {
  if (extname(path) === '.html') return 'text/html; charset=utf-8';
  if (extname(path) === '.js') return 'text/javascript; charset=utf-8';
  if (extname(path) === '.css') return 'text/css; charset=utf-8';
  return 'application/octet-stream';
}

async function withServer<T>(root: string, run: (baseUrl: string) => Promise<T>): Promise<T> {
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/favicon.ico') {
      response.writeHead(204);
      response.end();
      return;
    }
    const path = safeFile(root, extname(url.pathname) ? url.pathname : '/index.html');
    if (!path) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('not found');
      return;
    }
    response.writeHead(200, { 'content-type': mime(path), 'cache-control': 'no-store' });
    response.end(readFileSync(path));
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', () => resolveListen());
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Svelte evaluator server failed to bind');
  try {
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }
}

function artifactsReady(root: string, scenario: 1 | 2): { passed: boolean; detail: string } {
  const result = readJsonArtifact<SvelteResultArtifact>(
    root,
    `verification/scenario-${scenario}-result.json`,
  );
  const verification = readJsonArtifact<SvelteVerificationArtifact>(
    root,
    `verification/scenario-${scenario}-verification.json`,
  );
  const expectedNeighbor = scenario === 1 ? 'angular-engineering' : 'react-engineering';
  const expectedChecks =
    scenario === 1
      ? [
          'rapid-prop-update',
          'selection-removal',
          'keyboard-focus',
          'loading-empty-error',
          'narrow-viewport',
          'component-destroy',
        ]
      : [
          'out-of-order-route',
          'resource-cleanup',
          'browser-history',
          'error-retry-focus',
          'component-destroy',
        ];
  if (scenario === 1) {
    const verificationText = JSON.stringify(verification ?? {}).toLowerCase();
    const resultText = JSON.stringify(result ?? {}).toLowerCase();
    const canonicalChecks = expectedChecks.every((item) => verification?.checks?.includes(item));
    const semanticChecks = [
      /prop[^\n]*update|selection survives/iu,
      /selection[^\n]*(remove|disappear)|removed selection/iu,
      /keyboard[^\n]*focus|focus[^\n]*keyboard/iu,
      /loading[^\n]*empty[^\n]*error|loading, empty, error/iu,
      /narrow[^\n]*viewport|390/iu,
      /destroy|destruction/iu,
    ].every((pattern) => pattern.test(verificationText));
    const canonicalMetadata =
      result?.svelteVersion === svelteVersion() &&
      result.reactivityGeneration === 'runes' &&
      result.executionBoundary === 'browser-only' &&
      result.sharedControl === 'KorySelect.svelte';
    const authoredMetadata =
      /svelte\s*5|runes/iu.test(verification?.environment?.reactivity ?? '') &&
      /browser|hydration|render/iu.test(verification?.environment?.execution_boundary ?? '') &&
      typeof result?.authored_evidence?.success_path === 'string' &&
      typeof result?.authored_evidence?.failure_recovery_path === 'string' &&
      Array.isArray(result.authored_evidence.browser_observations);
    const recoveryReady =
      (verification?.negativeRecovery?.length ?? 0) >= 1 ||
      /failure_recovery|recovery/iu.test(resultText);
    const passed =
      Boolean(result && verification) &&
      (canonicalMetadata || authoredMetadata) &&
      (canonicalChecks || semanticChecks) &&
      recoveryReady;
    return {
      passed,
      detail: passed
        ? verification?.evidenceType === 'real-browser'
          ? 'complete authored browser evidence contract'
          : 'complete authored verification plan; host real-browser execution remains required'
        : 'missing or incomplete result/verification artifacts',
    };
  }
  const passed =
    result?.svelteVersion === svelteVersion() &&
    result.reactivityGeneration === 'runes' &&
    result.executionBoundary === 'browser-only' &&
    result.broaderSkill === 'frontend-engineering' &&
    result.nearNeighbor === expectedNeighbor &&
    (scenario === 2 || result.sharedControl === 'KorySelect.svelte') &&
    verification?.evidenceType === 'real-browser' &&
    expectedChecks.every((item) => verification.checks?.includes(item)) &&
    (verification.negativeRecovery?.length ?? 0) >= 1;
  return {
    passed,
    detail: passed
      ? 'complete current-version browser evidence contract'
      : 'missing or incomplete result/verification artifacts',
  };
}

async function scoreState(root: string): Promise<SkillEvalDeterministicScore> {
  const checks: BrowserCheck[] = [];
  const integrityFailure =
    !fixed(root, 'src/main.js', MAIN_JS) ||
    !fixed(root, 'src/Harness.svelte', STATE_HARNESS) ||
    !fixed(root, 'src/KorySelect.svelte', KORY_SELECT);
  add(
    checks,
    'fixed harness/shared-control integrity',
    !integrityFailure,
    integrityFailure ? 'evaluator-owned input changed' : 'unchanged',
  );
  const artifact = artifactsReady(root, 1);
  add(checks, 'version/boundary/verification artifacts', artifact.passed, artifact.detail);
  let appSource = '';
  try {
    appSource = readFixtureText(root, 'src/App.svelte');
  } catch {
    appSource = '';
  }
  const generationPass =
    /\$props\s*\(/u.test(appSource) && !/\$:\s/u.test(appSource) && !/<select\b/iu.test(appSource);
  add(
    checks,
    'runes generation and shared-control boundary',
    generationPass,
    generationPass
      ? 'runes source without native select/legacy reactive label'
      : 'mixed/legacy/native-control shortcut detected',
  );
  if (integrityFailure || !artifact.passed || !generationPass)
    return score(checks, integrityFailure);

  try {
    const runtime = await buildSvelteFixture(root);
    await withServer(runtime, async (baseUrl) => {
      await withBrave(async (browser) => {
        const context = await browser.newContext({ viewport: { width: 900, height: 820 } });
        const page = await context.newPage();
        page.setDefaultTimeout(3_000);
        page.setDefaultNavigationTimeout(3_000);
        const runtimeErrors: string[] = [];
        page.on('pageerror', (error) => runtimeErrors.push(error.message));
        page.on('console', (message) => {
          if (message.type() === 'error') runtimeErrors.push(message.text());
        });
        await page.goto(baseUrl, { waitUntil: 'load' });
        try {
          await page.locator('#kory-select-trigger').waitFor();
        } catch (error) {
          const body = (await page.locator('body').innerText()).slice(0, 800);
          throw new Error(
            `Svelte state fixture did not render shared control: ${runtimeErrors.join(' | ') || 'no browser error captured'}; body=${body}; ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        add(
          checks,
          'shared KorySelect rendered',
          (await page.locator('#kory-select-trigger').count()) === 1,
          'fixed shared control is live',
        );

        const trigger = page.locator('#kory-select-trigger');
        await trigger.focus();
        await page.keyboard.press('Enter');
        await page.keyboard.press('ArrowDown');
        await page.keyboard.press('Enter');
        const selectedBeta = /Beta/u.test(await page.locator('[data-selected]').innerText());
        const focusRestored = await page.evaluate(
          () => (document.activeElement as HTMLElement | null)?.id === 'kory-select-trigger',
        );
        add(
          checks,
          'keyboard selection and focus restoration',
          selectedBeta && focusRestored,
          'Enter/ArrowDown/Enter selects Beta and returns focus',
        );

        await page.locator('#rapid-update').click();
        await page.waitForTimeout(40);
        add(
          checks,
          'rapid external prop updates preserve owned selection',
          /Beta/u.test(await page.locator('[data-selected]').innerText()),
          'Beta remains selected after reorder/filter/reorder sequence',
        );
        await page.locator('#remove-beta').click();
        await page.waitForTimeout(40);
        const removalText = await page.locator('[data-selected]').innerText();
        add(
          checks,
          'removed selection recovers deterministically',
          !/Beta/u.test(removalText) && /Gamma|Alpha/u.test(removalText),
          removalText,
        );

        await page.locator('#loading').click();
        const loading = (await page.locator('[aria-busy="true"]').count()) === 1;
        await page.locator('#normal').click();
        await page.locator('#empty').click();
        const empty = (await page.locator('[data-empty]').count()) === 1;
        await page.locator('#normal').click();
        await page.locator('#error').click();
        const error = (await page.getByRole('alert').count()) === 1;
        add(
          checks,
          'loading/empty/error states render',
          loading && empty && error,
          `loading=${loading} empty=${empty} error=${error}`,
        );

        await page.setViewportSize({ width: 390, height: 844 });
        await page.locator('#normal').click();
        const narrow = await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth + 1,
        );
        add(
          checks,
          '390px viewport has no horizontal overflow',
          narrow,
          'real rendered narrow viewport',
        );

        const activeBeforeDestroy = await page.evaluate(() => {
          const metrics = window as unknown as {
            __korySelectActive?: number;
            __korySelectMounts?: number;
          };
          return {
            active: metrics.__korySelectActive ?? 0,
            mounts: metrics.__korySelectMounts ?? 0,
          };
        });
        await page.locator('#destroy').click();
        await page.waitForTimeout(20);
        const activeAfterDestroy = await page.evaluate(() => {
          const metrics = window as unknown as { __korySelectActive?: number };
          return metrics.__korySelectActive ?? -1;
        });
        add(
          checks,
          'component destruction tears down shared control',
          activeBeforeDestroy.active === 1 &&
            activeBeforeDestroy.mounts >= 1 &&
            activeAfterDestroy === 0,
          `before=${JSON.stringify(activeBeforeDestroy)} after=${activeAfterDestroy}`,
        );
        add(
          checks,
          'real Svelte browser runtime has no errors',
          runtimeErrors.length === 0,
          runtimeErrors.join(' | ') || `Svelte ${svelteVersion()} / Brave ${browser.version()}`,
        );
        await context.close();
      });
    });
  } catch (error) {
    add(
      checks,
      'real Svelte browser execution',
      false,
      error instanceof Error ? error.message : String(error),
    );
  }
  return score(checks, false);
}

async function scoreRoute(root: string): Promise<SkillEvalDeterministicScore> {
  const checks: BrowserCheck[] = [];
  const integrityFailure =
    !fixed(root, 'src/main.js', MAIN_JS) ||
    !fixed(root, 'src/Harness.svelte', ROUTE_HARNESS) ||
    !fixed(root, 'src/detail-source.js', ROUTE_SOURCE);
  add(
    checks,
    'fixed route/source integrity',
    !integrityFailure,
    integrityFailure ? 'evaluator-owned input changed' : 'unchanged',
  );
  const artifact = artifactsReady(root, 2);
  add(checks, 'version/boundary/verification artifacts', artifact.passed, artifact.detail);
  let appSource = '';
  try {
    appSource = readFixtureText(root, 'src/App.svelte');
  } catch {
    appSource = '';
  }
  const generationPass =
    /\$props\s*\(/u.test(appSource) &&
    /\$effect\s*\(/u.test(appSource) &&
    !/\$:\s/u.test(appSource);
  add(
    checks,
    'runes lifecycle boundary',
    generationPass,
    generationPass
      ? 'runes effect owns external subscription'
      : 'required runes/effect boundary missing or legacy syntax mixed in',
  );
  if (integrityFailure || !artifact.passed || !generationPass)
    return score(checks, integrityFailure);

  try {
    const runtime = await buildSvelteFixture(root);
    await withServer(runtime, async (baseUrl) => {
      await withBrave(async (browser) => {
        const context = await browser.newContext({ viewport: { width: 900, height: 820 } });
        const page = await context.newPage();
        page.setDefaultTimeout(3_000);
        page.setDefaultNavigationTimeout(3_000);
        const runtimeErrors: string[] = [];
        page.on('pageerror', (error) => runtimeErrors.push(error.message));
        page.on('console', (message) => {
          if (message.type() === 'error') runtimeErrors.push(message.text());
        });
        await page.goto(`${baseUrl}/details/alpha`, { waitUntil: 'load' });
        try {
          await page.locator('[aria-busy="true"]').waitFor();
        } catch (error) {
          const body = (await page.locator('body').innerText()).slice(0, 800);
          throw new Error(
            `Svelte route fixture did not render loading state: ${runtimeErrors.join(' | ') || 'no browser error captured'}; body=${body}; ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        await page.locator('#route-beta').click();
        await page.locator('[data-detail-id]').waitFor();
        const betaFirst = (await page.locator('[data-detail-id]').innerText()).trim() === 'beta';
        const activeDuringRace = await page.evaluate(() => {
          const metrics = window as unknown as { __detailMetrics?: { active?: number } };
          return metrics.__detailMetrics?.active ?? -1;
        });
        await page.waitForTimeout(380);
        const betaAfterLateAlpha =
          (await page.locator('[data-detail-id]').innerText()).trim() === 'beta';
        add(
          checks,
          'out-of-order route response cannot overwrite current detail',
          betaFirst && betaAfterLateAlpha,
          `initialBeta=${betaFirst} afterLateAlpha=${betaAfterLateAlpha}`,
        );
        add(
          checks,
          'superseded subscription tears down immediately',
          activeDuringRace === 0,
          `active after beta settled=${activeDuringRace}`,
        );

        await page.goBack({ timeout: 3_000 });
        await page.waitForURL(/\/details\/alpha$/u);
        const alphaDetail = page.locator('[data-detail-id]').filter({ hasText: 'alpha' });
        await alphaDetail.waitFor();
        add(
          checks,
          'browser history restores prior route',
          (await alphaDetail.innerText()).trim() === 'alpha',
          page.url(),
        );

        await page.locator('#route-error').click();
        const retry = page.locator('#retry-detail');
        await retry.waitFor();
        const retryFocused = await page.evaluate(
          () => (document.activeElement as HTMLElement | null)?.id === 'retry-detail',
        );
        await retry.click();
        await page.locator('[data-detail-id]').waitFor();
        const recovered = (await page.locator('[data-detail-id]').innerText()).trim() === 'error';
        const headingFocused = await page.evaluate(
          () =>
            (document.activeElement as HTMLElement | null)?.hasAttribute('data-detail-heading') ??
            false,
        );
        add(
          checks,
          'error/retry/focus recovery preserved',
          retryFocused && recovered && headingFocused,
          `retryFocused=${retryFocused} recovered=${recovered} headingFocused=${headingFocused}`,
        );

        await page.locator('#route-alpha').click();
        await page.waitForTimeout(25);
        const activeBeforeDestroy = await page.evaluate(() => {
          const metrics = window as unknown as { __detailMetrics?: { active?: number } };
          return metrics.__detailMetrics?.active ?? -1;
        });
        await page.locator('#destroy').click();
        await page.waitForTimeout(20);
        const metricsAfterDestroy = await page.evaluate(() => {
          const metrics = window as unknown as {
            __detailMetrics?: { active?: number; cleanups?: number };
          };
          return metrics.__detailMetrics ?? null;
        });
        add(
          checks,
          'component destruction cancels in-flight resource',
          activeBeforeDestroy === 1 &&
            metricsAfterDestroy?.active === 0 &&
            (metricsAfterDestroy?.cleanups ?? 0) >= 1,
          `before=${activeBeforeDestroy} after=${JSON.stringify(metricsAfterDestroy)}`,
        );
        add(
          checks,
          'real Svelte browser runtime has no errors',
          runtimeErrors.length === 0,
          runtimeErrors.join(' | ') || `Svelte ${svelteVersion()} / Brave ${browser.version()}`,
        );
        await context.close();
      });
    });
  } catch (error) {
    add(
      checks,
      'real Svelte browser execution',
      false,
      error instanceof Error ? error.message : String(error),
    );
  }
  return score(checks, false);
}

const readinessBlockers = [
  ...(existsSync(BRAVE_PATH) ? [] : [`Requires system Brave at ${BRAVE_PATH}.`]),
  ...(existsSync(SVELTE_COMPILER) && existsSync(SVELTE_PACKAGE)
    ? []
    : ['Requires the installed Svelte compiler/runtime from frontend dependencies.']),
];

export const SVELTE_BROWSER_SKILL_EVAL_MATERIALIZERS: readonly SkillEvalFixtureMaterializer[] = [
  {
    id: 'svelte-engineering/derived-state-real-browser@2',
    readinessBlockers: readinessBlockers.length ? readinessBlockers : undefined,
    matches: (scenario) => scenario.id === SCENARIO_STATE,
    materialize: (root) => {
      writeFixtureFile(root, 'src/main.js', MAIN_JS);
      writeFixtureFile(root, 'src/Harness.svelte', STATE_HARNESS);
      writeFixtureFile(root, 'src/KorySelect.svelte', KORY_SELECT);
      writeFixtureFile(root, 'src/App.svelte', STATE_STARTER);
      writeFixtureFile(root, 'verification/scenario-1-result.json', json({ status: 'TODO' }));
      writeFixtureFile(root, 'verification/scenario-1-verification.json', json({ status: 'TODO' }));
      writeFixtureFile(
        root,
        'README.md',
        `# Svelte 5 derived-state fixture\n\nFix only the candidate component and its verification artifacts. The harness and shared KorySelect are fixed repository contracts. Preserve user-owned selection across prop updates and recover when the selected item disappears.\n\nThis workspace has no build toolchain, no test runner, and no installed package dependencies, and none are expected: the evaluator bundles your component itself and drives real Chromium against it. Do not install packages, edit the package manifest, or write your own build, server, or browser harness. The checks below are the ones the evaluator will run, so use them to decide what correct behaviour means; record a check you could not run yourself as unverified with the reason, and never claim a browser observation you did not make.\n${svelteEvidenceInstructions(1)}`,
      );
    },
  },
  {
    id: 'svelte-engineering/route-race-real-browser@2',
    readinessBlockers: readinessBlockers.length ? readinessBlockers : undefined,
    matches: (scenario) => scenario.id === SCENARIO_ROUTE,
    materialize: (root) => {
      writeFixtureFile(root, 'src/main.js', MAIN_JS);
      writeFixtureFile(root, 'src/Harness.svelte', ROUTE_HARNESS);
      writeFixtureFile(root, 'src/detail-source.js', ROUTE_SOURCE);
      writeFixtureFile(root, 'src/App.svelte', ROUTE_STARTER);
      writeFixtureFile(root, 'verification/scenario-2-result.json', json({ status: 'TODO' }));
      writeFixtureFile(root, 'verification/scenario-2-verification.json', json({ status: 'TODO' }));
      writeFixtureFile(
        root,
        'README.md',
        `# Svelte 5 route-race fixture\n\nFix the candidate component without changing the route harness or detail source. The active route owns its subscription: superseded routes and component destruction must tear down immediately, late responses must not overwrite current state, and the existing error/retry/focus behavior plus browser history must remain intact.\n\nThis workspace has no build toolchain, no test runner, and no installed package dependencies, and none are expected: the evaluator bundles your component itself and drives real Chromium against it. Do not install packages, edit the package manifest, or write your own build, server, or browser harness. Record under verification/ what you could observe, and mark a check you could not run as unverified with the reason.\n${svelteEvidenceInstructions(2)}`,
      );
    },
  },
] as const;

// The scorer requires exact field names and check identifiers. React, Vue and
// Next publish the same contract in the task packet; Svelte did not, so a
// correct candidate could fail on serialization alone.
// Check identifiers the scorer requires in verification.checks, in the order the
// task narrative presents them.
const SVELTE_CHECKS: Record<1 | 2, readonly string[]> = {
  1: [
    'rapid-prop-update',
    'selection-removal',
    'keyboard-focus',
    'loading-empty-error',
    'narrow-viewport',
    'component-destroy',
  ],
  2: [
    'out-of-order-route',
    'resource-cleanup',
    'browser-history',
    'error-retry-focus',
    'component-destroy',
  ],
};

function svelteEvidenceInstructions(scenario: 1 | 2): string {
  const nearNeighbor = scenario === 1 ? 'angular-engineering' : 'react-engineering';
  const checks = [...SVELTE_CHECKS[scenario]];
  return `
### Evidence artifact contract (exact JSON field names)

Write both files below as JSON objects. They are candidate-authored claims; the evaluator separately builds your code and drives real Chromium. Do not claim a browser check you did not perform.

\`verification/scenario-${scenario}-result.json\` requires these flat fields:

\`\`\`json
{
  "status": "TODO",
  "svelteVersion": "${svelteVersion()}",
  "reactivityGeneration": "runes",
  "executionBoundary": "browser-only",
  "sharedControl": "KorySelect.svelte",
  "broaderSkill": "frontend-engineering",
  "nearNeighbor": "${nearNeighbor}"
}
\`\`\`

\`verification/scenario-${scenario}-verification.json\` requires these flat fields:

\`\`\`json
{
  "status": "TODO",
  "evidenceType": "real-browser",
  "checks": ${JSON.stringify(checks)},
  "negativeRecovery": ["<observed failure and how it recovered>"]
}
\`\`\`

Set the status to verified only after the browser run completed.
`;
}

export const SVELTE_BROWSER_SKILL_EVAL_SCORERS: readonly SkillEvalDeterministicScorer[] = [
  {
    id: 'svelte-engineering/derived-state-real-browser-scorer@2',
    scenarioIds: [SCENARIO_STATE],
    score: ({ workingDirectory }) => scoreState(workingDirectory),
  },
  {
    id: 'svelte-engineering/route-race-real-browser-scorer@1',
    scenarioIds: [SCENARIO_ROUTE],
    score: ({ workingDirectory }) => scoreRoute(workingDirectory),
  },
] as const;

export const SVELTE_BROWSER_EVAL_CONSTANTS = {
  version: svelteVersion(),
  stateScenario: SCENARIO_STATE,
  routeScenario: SCENARIO_ROUTE,
} as const;
