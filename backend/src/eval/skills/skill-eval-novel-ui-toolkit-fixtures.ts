import { existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { extname, join, relative, resolve } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import type {
  SkillEvalDeterministicScore,
  SkillEvalDeterministicScorer,
  SkillEvalFixtureMaterializer,
} from './skill-eval-execution';
import { readFixtureText, writeFixtureFile } from './skill-eval-fixture-helpers';

const CANVAS_SCENARIO = 'novel-ui-toolkit-full-task-1-individual';
const PALETTE_SCENARIO = 'novel-ui-toolkit-full-task-2-individual';
const DEFAULT_BRAVE_PATH = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
// Real browser startup can vary across machines. Keep the evaluator bounded while
// allowing the command palette scenario enough time to complete its virtualization
// and cleanup checks on slower hosts.
const DEFAULT_RUN_TIMEOUT_MS = 20_000;

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

interface BrowserCheck {
  name: string;
  passed: boolean;
  detail: string;
}

interface EvaluatorOptions {
  bravePath?: string;
  runTimeoutMs?: number;
}

interface EvaluatorSet {
  materializers: readonly SkillEvalFixtureMaterializer[];
  scorers: readonly SkillEvalDeterministicScorer[];
}

const NODE_DATASET = {
  version: 'novel-canvas-node-dataset@1',
  canvas: { width: 900, height: 520 },
  transform: { zoom: 1.25, offsetX: 20, offsetY: 15 },
  nodeSize: { width: 160, height: 90 },
  nodes: [
    { id: 'node-1', label: 'Source', x: 60, y: 70 },
    { id: 'node-2', label: 'Transform', x: 330, y: 80 },
    { id: 'node-3', label: 'Sink', x: 520, y: 230 },
  ],
  edges: [{ from: 'node-1', to: 'node-2' }],
  expectedCreatedNode: { id: 'node-4', label: 'Created node', x: 250, y: 280 },
  highContrast: { background: '#000000', node: '#ffffff', selected: '#ffff00' },
} as const;

const COMMAND_DATASET = {
  version: 'novel-command-dataset@1',
  count: 20_000,
  groups: 5,
  groupSize: 4_000,
  groupHeaderHeight: 26,
  itemHeights: [28, 36, 44],
  viewportHeight: 360,
  stableIdPrefix: 'command-',
  titleWords: ['Alpha', 'Beta', 'Fast', 'Slow', 'Gamma'],
} as const;

const BASE_STYLE = `
* { box-sizing: border-box; }
html, body { margin: 0; min-width: 0; color: #172033; background: #f5f7fb; font: 16px/1.4 system-ui, sans-serif; }
main { width: min(960px, calc(100% - 24px)); margin: 16px auto; min-width: 0; }
button, input { font: inherit; }
:focus-visible { outline: 3px solid #315fd6; outline-offset: 2px; }
canvas { display: block; max-width: 100%; border: 1px solid #68758a; background: white; touch-action: none; }
.evaluator-semantic-projection { position: fixed; left: -10000px; top: 0; width: 1px; height: 1px; overflow: hidden; }
#fixture-status, #invoked { min-height: 24px; overflow-wrap: anywhere; }
`;

const CANVAS_INDEX = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Custom canvas node editor</title><link rel="stylesheet" href="/evaluator/style.css"></head>
<body><main><h1>Custom canvas node editor</h1><canvas id="surface" tabindex="0" aria-label="Node editor surface"></canvas><p id="fixture-status" aria-live="polite"></p><div id="semantics" class="evaluator-semantic-projection"></div></main><script type="module" src="/evaluator/harness.js"></script></body>
</html>
`;

const CANVAS_DATASET_SOURCE = `export const dataset = Object.freeze(${JSON.stringify(NODE_DATASET)});\n`;

const CANVAS_HARNESS = `import { createNodeEditor } from '/src/toolkit.js';
import { dataset } from '/evaluator/dataset.js';

const canvas = document.querySelector('#surface');
const semanticRoot = document.querySelector('#semantics');
const status = document.querySelector('#fixture-status');
const editor = createNodeEditor({ canvas, semanticRoot, status, dataset });
if (!editor || typeof editor.destroy !== 'function') throw new Error('createNodeEditor must return a destroy controller');
Object.defineProperty(window, '__koryFixtureDestroy', { value: () => editor.destroy(), writable: false, configurable: false });
`;

const CANVAS_STARTER = `export function createNodeEditor({ canvas, status, dataset }) {
  canvas.width = dataset.canvas.width;
  canvas.height = dataset.canvas.height;
  const context = canvas.getContext('2d');
  let selected = dataset.nodes[0].id;
  function draw() {
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    for (const node of dataset.nodes) {
      const x = node.x * dataset.transform.zoom + dataset.transform.offsetX;
      const y = node.y * dataset.transform.zoom + dataset.transform.offsetY;
      context.fillStyle = node.id === selected ? '#88aaff' : '#dce5f5';
      context.fillRect(x, y, dataset.nodeSize.width * dataset.transform.zoom, dataset.nodeSize.height * dataset.transform.zoom);
      context.fillStyle = '#172033';
      context.fillText(node.label, x + 12, y + 24);
    }
    status.textContent = 'Canvas editor ready';
  }
  function pointer(event) {
    const rect = canvas.getBoundingClientRect();
    const x = (event.clientX - rect.left) * canvas.width / rect.width;
    const y = (event.clientY - rect.top) * canvas.height / rect.height;
    for (const node of dataset.nodes) {
      const left = node.x * dataset.transform.zoom + dataset.transform.offsetX;
      const top = node.y * dataset.transform.zoom + dataset.transform.offsetY;
      if (x >= left && x <= left + dataset.nodeSize.width * dataset.transform.zoom && y >= top && y <= top + dataset.nodeSize.height * dataset.transform.zoom) selected = node.id;
    }
    requestAnimationFrame(draw);
  }
  const keyboard = () => requestAnimationFrame(draw);
  canvas.addEventListener('pointerdown', pointer);
  canvas.addEventListener('keydown', keyboard);
  requestAnimationFrame(draw);
  return { destroy() { canvas.removeEventListener('pointerdown', pointer); canvas.removeEventListener('keydown', keyboard); } };
}
`;

const CANVAS_README = `# Canvas node editor evaluator

Implement only \`src/toolkit.js\`. The evaluator-owned HTML, harness, dataset, geometry, action sequence, style, screenshots, and runtime receipts are fixed inputs.

Export \`createNodeEditor({ canvas, semanticRoot, status, dataset })\`. The returned controller must expose \`destroy()\`. The toolkit owns canvas layout/rendering, transformed hit testing, focus, pointer and keyboard interaction, edge/node state, high-contrast rendering, and a semantic projection. It must not replace the canvas with a DOM-rendered editor.

Pointer hit testing converts a client position exactly once, as \`(clientX - rect.left - offsetX) / zoom\` and the same for the vertical axis, then compares it with model node bounds."" Required keyboard contract on the focused canvas: \`Home\` selects the first stable node, \`n\` creates and selects \`node-4\`, \`c\` starts/completes a connection, arrow keys move stable focus, \`Delete\` removes the selected node and incident edges, \`+\` changes zoom from 1.25 to 1.5, and \`h\` toggles high contrast. The semantic projection uses \`role=tree\`, \`role=treeitem\`, \`data-node-id\`, and \`aria-current\`. Set the canvas backing store to \`dataset.canvas\` and let the CSS box fill it within two pixels; a decorative border that shrinks the drawing area is measured as a mismatch. The status element exposes authoritative live fields through \`data-nodes\`, \`data-edges\`, \`data-selected\`, \`data-zoom\`, and \`data-theme\`.

Do not write evidence JSON. The evaluator independently drives Brave, measures bounded rendering, captures screenshots, and writes runtime receipts.
`;

const PALETTE_INDEX = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Custom virtualized command palette</title><link rel="stylesheet" href="/evaluator/style.css"></head>
<body><main><h1>Custom command palette</h1><div id="palette-host"></div><p id="invoked" aria-live="polite"></p></main><script type="module" src="/evaluator/harness.js"></script></body>
</html>
`;

const PALETTE_DATASET_SOURCE = `export const manifest = Object.freeze(${JSON.stringify(COMMAND_DATASET)});
export function createCommands() {
  return Array.from({ length: manifest.count }, (_, index) => {
    const groupIndex = Math.floor(index / manifest.groupSize);
    const word = manifest.titleWords[index % manifest.titleWords.length];
    return Object.freeze({ id: manifest.stableIdPrefix + String(index).padStart(5, '0'), title: word + ' command ' + String(index).padStart(5, '0'), group: 'Group ' + (groupIndex + 1), height: manifest.itemHeights[index % manifest.itemHeights.length] });
  });
}
`;

const PALETTE_HARNESS = `import { createCommandPalette } from '/src/widget.js';
import { createCommands, manifest } from '/evaluator/dataset.js';

const commands = createCommands();
const attempts = new Map();
const metrics = { requests: [], active: 0, aborts: 0, completions: 0, invocations: [] };
function snapshot() { return structuredClone(metrics); }
function search(query, { signal }) {
  metrics.requests.push(query);
  metrics.active += 1;
  const attempt = (attempts.get(query) || 0) + 1;
  attempts.set(query, attempt);
  const delay = query === 'slow' ? 280 : query === 'fast' ? 35 : 45;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = () => { if (!settled) { settled = true; metrics.active -= 1; } };
    const timer = setTimeout(() => {
      finish();
      if (query === 'error' && attempt === 1) { reject(new Error('Fixture search failed')); return; }
      const normalized = query.toLowerCase();
      const result = query === 'error' && attempt > 1
        ? commands.filter((command) => command.title.startsWith('Gamma')).slice(0, 40)
        : commands.filter((command) => command.title.toLowerCase().includes(normalized));
      metrics.completions += 1;
      resolve(result);
    }, delay);
    signal.addEventListener('abort', () => {
      if (settled) return;
      clearTimeout(timer);
      finish();
      metrics.aborts += 1;
      reject(new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  });
}
const host = document.querySelector('#palette-host');
const invoked = document.querySelector('#invoked');
const controller = createCommandPalette({ host, commands, manifest, search, onInvoke(command) { metrics.invocations.push(command.id); invoked.dataset.invokedId = command.id; invoked.textContent = 'Invoked ' + command.title; } });
if (!controller || typeof controller.destroy !== 'function') throw new Error('createCommandPalette must return a destroy controller');
Object.defineProperty(window, '__koryFixtureRead', { value: snapshot, writable: false, configurable: false });
Object.defineProperty(window, '__koryFixtureDestroy', { value: () => controller.destroy(), writable: false, configurable: false });
`;

const PALETTE_STARTER = `export function createCommandPalette({ host, commands, search }) {
  const input = document.createElement('input');
  input.dataset.commandQuery = '';
  input.setAttribute('aria-label', 'Search commands');
  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 360;
  canvas.tabIndex = 0;
  const status = document.createElement('p');
  status.dataset.commandStatus = '';
  host.append(input, canvas, status);
  const context = canvas.getContext('2d');
  function draw(items) {
    context.clearRect(0, 0, canvas.width, canvas.height);
    items.forEach((item, index) => context.fillText(item.title, 10, 20 + index * 18));
    status.textContent = items.length + ' commands';
  }
  async function update() { draw(await search(input.value, { signal: new AbortController().signal })); }
  input.addEventListener('input', update);
  input.addEventListener('keydown', () => requestAnimationFrame(() => {}));
  canvas.addEventListener('pointerdown', () => requestAnimationFrame(() => {}));
  canvas.addEventListener('wheel', () => requestAnimationFrame(() => {}));
  void update();
  return { destroy() { host.replaceChildren(); } };
}
`;

const PALETTE_README = `# Virtualized custom command palette evaluator

Implement only \`src/widget.js\`. The evaluator owns the immutable 20,000-command generator, stable ids, variable row heights, group geometry, async source, out-of-order delays, action sequences, performance budgets, screenshots, and runtime receipts.

Export \`createCommandPalette({ host, commands, manifest, search, onInvoke })\` and return a controller with \`destroy()\`. The widget owns its custom canvas list, layout, virtualization, hit testing, focus, keyboard/pointer interaction, async request cancellation, loading/empty/error/retry states, cleanup, and semantic listbox projection. A DOM-rendered result list is not a substitute; DOM may be used for the query input, status/recovery controls, and bounded semantic projection only.

Use \`data-command-query\` for the query input, \`data-command-canvas\` for the canvas, \`data-command-status\` with \`data-state\`, \`data-count\`, \`data-query\`, and \`data-active-id\` for live state, and \`data-command-semantics\` with \`role=listbox\`. Project only visible \`role=option\` rows with stable \`data-command-id\`, \`aria-posinset\`, and \`aria-setsize=20000\`. Keep the projected option count above two and below sixty while the dataset holds 20,000 commands, and keep each render under 120 filled text draws. Arrow keys move active focus, Enter invokes, wheel/PageDown virtualize, pointer hit testing follows evaluator-owned variable-height/group geometry, retry recovers errors, and destroy aborts in-flight work.

The widget must fit its container: size the canvas from its host element and never exceed the available width, and at a 390 pixel viewport the page must not scroll horizontally. Do not write evidence JSON. The evaluator independently drives Brave and writes the only accepted runtime receipts.
`;

function add(checks: BrowserCheck[], name: string, passed: boolean, detail: string): void {
  checks.push({ name, passed, detail });
}

function scoreFromChecks(
  checks: readonly BrowserCheck[],
  integrityFailure = false,
): SkillEvalDeterministicScore {
  const passedCount = checks.filter((check) => check.passed).length;
  const passed = checks.length > 0 && passedCount === checks.length && !integrityFailure;
  return {
    passed,
    quality: checks.length ? passedCount / checks.length : 0,
    verification: passed ? 1 : 0,
    integrityFailure,
    evidence: checks.map(
      (check) => `${check.name}: ${check.passed ? 'pass' : 'fail'} — ${check.detail}`,
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

function subjectSource(root: string, path: string): string {
  try {
    return readFixtureText(root, path);
  } catch {
    return '';
  }
}

function canvasSubjectGate(source: string): boolean {
  return (
    /getContext\s*\(\s*['"]2d['"]\s*\)/u.test(source) &&
    /addEventListener\s*\(\s*['"]pointerdown['"]/u.test(source) &&
    /addEventListener\s*\(\s*['"]keydown['"]/u.test(source) &&
    /requestAnimationFrame/u.test(source)
  );
}

function eventRegistrationGate(source: string, eventPattern: string): boolean {
  const direct = new RegExp(`addEventListener\\s*\\(\\s*['"](?:${eventPattern})['"]`, 'u').test(
    source,
  );
  if (direct) return true;

  // Event-listener helpers are a normal implementation detail. Keep the
  // cheap source preflight focused on ownership signals, then let the real
  // browser checks prove that the handlers actually work.
  const delegatesRegistration = /addEventListener\s*\(\s*[A-Za-z_$][\w$]*\s*,/u.test(source);
  const namesEvent = new RegExp(`['"](?:${eventPattern})['"]`, 'u').test(source);
  return delegatesRegistration && namesEvent;
}

function paletteSubjectGate(source: string): boolean {
  return (
    /getContext\s*\(\s*['"]2d['"]\s*\)/u.test(source) &&
    eventRegistrationGate(source, 'pointerdown|click') &&
    eventRegistrationGate(source, 'keydown') &&
    eventRegistrationGate(source, 'wheel') &&
    /requestAnimationFrame/u.test(source)
  );
}

function safeFile(root: string, urlPath: string): string | null {
  const decoded = decodeURIComponent(urlPath).replace(/^\/+/, '') || 'index.html';
  const candidate = resolve(root, decoded);
  const rel = relative(root, candidate);
  if (rel.startsWith('..') || rel.split(/[\\/]/u).some((part) => part === '..')) return null;
  let current = resolve(root);
  for (const part of rel.split(/[\\/]/u)) {
    current = join(current, part);
    if (!existsSync(current)) return null;
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) return null;
  }
  const stat = lstatSync(candidate);
  if (!stat.isFile() || stat.size > 2_000_000) return null;
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
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (url.pathname === '/favicon.ico') {
        response.writeHead(204, { 'cache-control': 'no-store' });
        response.end();
        return;
      }
      const file = safeFile(root, extname(url.pathname) ? url.pathname : '/index.html');
      if (!file) {
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('not found');
        return;
      }
      response.writeHead(200, {
        'content-type': mime(file),
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      });
      response.end(readFileSync(file));
    } catch (error) {
      response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      response.end(error instanceof Error ? error.message : String(error));
    }
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture server failed to bind');
  try {
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }
}

/** Startup attempts share the evaluation deadline, with a separate maximum launch cap.
 * Neither retrying a launch nor starting the browser checks resets the caller's budget. */
const LAUNCH_TIMEOUT_MS = 20_000;
const MAX_LAUNCH_ATTEMPTS = 2;

async function launchBrave(bravePath: string, evaluationDeadline: number): Promise<Browser> {
  const deadline = Math.min(evaluationDeadline, performance.now() + LAUNCH_TIMEOUT_MS);
  let lastError: unknown;
  let attempts = 0;
  while (attempts < MAX_LAUNCH_ATTEMPTS) {
    const remaining = deadline - performance.now();
    if (remaining <= 0) break;
    attempts += 1;
    try {
      return await chromium.launch({
        executablePath: bravePath,
        headless: true,
        args: ['--disable-background-networking'],
        // Reserve time for another attempt without extending the shared deadline.
        timeout: Math.max(1, Math.floor(remaining / (MAX_LAUNCH_ATTEMPTS - attempts + 1))),
      });
    } catch (error) {
      lastError = error;
      if (attempts >= MAX_LAUNCH_ATTEMPTS) break;
      const retryDelay = Math.min(500, deadline - performance.now());
      if (retryDelay <= 0) break;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, retryDelay));
    }
  }
  throw new Error(
    `Brave launch failed after ${attempts} bounded attempts: ${
      lastError instanceof Error ? lastError.message.split('\n')[0] : String(lastError)
    }`,
  );
}

async function withBoundedBrave<T>(
  bravePath: string,
  timeoutMs: number,
  run: (browser: Browser) => Promise<T>,
): Promise<T> {
  if (!existsSync(bravePath)) throw new Error(`Brave executable unavailable at ${bravePath}`);
  const deadline = performance.now() + timeoutMs;
  const browser = await launchBrave(bravePath, deadline);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw new Error(`real-browser evaluation exceeded ${timeoutMs}ms`);
    return await Promise.race([
      run(browser),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          void browser.close().catch(() => undefined);
          reject(new Error(`real-browser evaluation exceeded ${timeoutMs}ms`));
        }, remaining);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    await Promise.race([
      browser.close().catch(() => undefined),
      new Promise<void>((resolveClose) => setTimeout(resolveClose, 1_000)),
    ]);
  }
}

function safeArtifactPath(root: string, relativePath: string): string {
  const parts = relativePath.split('/');
  let current = resolve(root);
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    if (!existsSync(current)) mkdirSync(current, { mode: 0o700 });
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('evaluator artifact directory must be a non-symlink directory');
    }
  }
  return join(root, ...parts);
}

async function installCanvasCounters(page: Page, initialFillTextLimit: number | null = null): Promise<void> {
  await page.addInitScript(({ initialFillTextLimit }) => {
    const counters = { clearRect: 0, fillRect: 0, fillText: 0, stroke: 0, arc: 0 };
    let measuringInitialPaint = initialFillTextLimit !== null;
    const prototype = CanvasRenderingContext2D.prototype as unknown as Record<
      string,
      (...args: unknown[]) => unknown
    >;
    for (const name of Object.keys(counters) as Array<keyof typeof counters>) {
      const original = prototype[name];
      if (typeof original !== 'function') continue;
      prototype[name] = function (this: CanvasRenderingContext2D, ...args: unknown[]) {
        counters[name] += 1;
        // Bound the initial canvas work before an unwindowed candidate can
        // monopolize the browser thread with 20,000 paints and DOM projections.
        // The observed count still fails the original virtualization check.
        if (
          name === 'fillText' && measuringInitialPaint &&
          initialFillTextLimit !== null && counters.fillText > initialFillTextLimit
        ) {
          throw new Error(`Initial canvas paint exceeded ${initialFillTextLimit} labels`);
        }
        return Reflect.apply(original, this, args);
      };
    }
    // Assigning a canvas width or height resets its bitmap, which is the other way
    // a renderer clears the surface. Count it as a paint pass so a candidate that
    // resizes to clear is measured on the same budget as one that calls clearRect.
    for (const dimension of ['width', 'height'] as const) {
      const descriptor = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, dimension);
      if (!descriptor?.set || !descriptor.get) continue;
      Object.defineProperty(HTMLCanvasElement.prototype, dimension, {
        configurable: true,
        enumerable: descriptor.enumerable,
        get: descriptor.get,
        set(this: HTMLCanvasElement, value: number) {
          counters.clearRect += 1;
          descriptor.set!.call(this, value);
        },
      });
    }
    Object.defineProperty(window, '__koryCanvasReceipt', {
      value: () => {
        measuringInitialPaint = false;
        return { ...counters };
      },
      writable: false,
      configurable: false,
    });
  }, { initialFillTextLimit });
}

async function canvasCounters(page: Page): Promise<Record<string, number>> {
  return page.evaluate(() => {
    const receipt = (window as unknown as { __koryCanvasReceipt?: () => Record<string, number> })
      .__koryCanvasReceipt;
    return receipt ? receipt() : {};
  });
}

async function capture(page: Page, root: string, relativePath: string): Promise<string> {
  const absolute = safeArtifactPath(root, relativePath);
  await page.screenshot({
    path: absolute,
    fullPage: false,
    animations: 'disabled',
    timeout: 2_500,
  });
  const stat = lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1_000) {
    throw new Error(`invalid evaluator screenshot ${relativePath}`);
  }
  return relativePath;
}

function contrastRatio(first: number[], second: number[]): number {
  const luminance = (rgb: number[]): number => {
    const channels = rgb.slice(0, 3).map((value) => {
      const normalized = value / 255;
      return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
    });
    return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
  };
  const a = luminance(first);
  const b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

async function scoreCanvas(
  root: string,
  bravePath: string,
  timeoutMs: number,
): Promise<SkillEvalDeterministicScore> {
  const checks: BrowserCheck[] = [];
  const sealedCanvasInputs: Array<[string, string]> = [
    ['index.html', CANVAS_INDEX],
    ['evaluator/style.css', BASE_STYLE],
    ['evaluator/dataset.js', CANVAS_DATASET_SOURCE],
    ['evaluator/harness.js', CANVAS_HARNESS],
    ['README.md', CANVAS_README],
  ];
  const changedCanvasInputs = sealedCanvasInputs
    .filter(([path, expected]) => !fixed(root, path, expected))
    .map(([path]) => path);
  const integrityFailure = changedCanvasInputs.length > 0;
  add(
    checks,
    'sealed canvas harness/dataset/geometry integrity',
    !integrityFailure,
    integrityFailure
      ? `evaluator-owned fixed input changed: ${changedCanvasInputs.join(', ')}`
      : NODE_DATASET.version,
  );
  const sourceGate = canvasSubjectGate(subjectSource(root, 'src/toolkit.js'));
  add(
    checks,
    'subject owns a custom canvas interaction implementation',
    sourceGate,
    sourceGate
      ? 'canvas, pointer, keyboard, and scheduled rendering hooks present'
      : 'DOM-only or incomplete canvas implementation',
  );
  if (integrityFailure || !sourceGate) return scoreFromChecks(checks, integrityFailure);

  const screenshots: string[] = [];
  try {
    await withServer(root, async (baseUrl) => {
      await withBoundedBrave(bravePath, timeoutMs, async (browser) => {
        const context = await browser.newContext({
          viewport: { width: 1000, height: 700 },
          deviceScaleFactor: 1,
          reducedMotion: 'reduce',
        });
        const page = await context.newPage();
        page.setDefaultTimeout(2_000);
        // Browser navigation can slow under the full suite's process load. The
        // shared evaluator deadline still bounds startup and all behavior checks.
        page.setDefaultNavigationTimeout(5_000);
        await installCanvasCounters(page);
        const runtimeErrors: string[] = [];
        page.on('pageerror', (error) => runtimeErrors.push(`pageerror:${error.message}`));
        page.on('console', (message) => {
          if (message.type() === 'error') runtimeErrors.push(`console:${message.text()}`);
        });
        await page.goto(baseUrl, { waitUntil: 'load' });
        const canvas = page.locator('#surface');
        await canvas.waitFor({ state: 'visible' });
        await page.waitForTimeout(80);

        const initial = await page.evaluate((dataset) => {
          const element = document.querySelector('#surface') as HTMLCanvasElement | null;
          if (!element) return null;
          const context2d = element.getContext('2d');
          if (!context2d) return null;
          const samples = dataset.nodes.map((node) => {
            const x = Math.round(
              (node.x + dataset.nodeSize.width / 2) * dataset.transform.zoom +
                dataset.transform.offsetX,
            );
            const y = Math.round(
              (node.y + dataset.nodeSize.height / 2) * dataset.transform.zoom +
                dataset.transform.offsetY,
            );
            return [...context2d.getImageData(x, y, 1, 1).data];
          });
          const background = [...context2d.getImageData(4, 4, 1, 1).data];
          const status = document.querySelector('#fixture-status') as HTMLElement | null;
          return {
            width: element.width,
            height: element.height,
            cssWidth: element.clientWidth,
            cssHeight: element.clientHeight,
            samples,
            background,
            nodes: status?.dataset.nodes,
            edges: status?.dataset.edges,
            selected: status?.dataset.selected,
            zoom: status?.dataset.zoom,
          };
        }, NODE_DATASET);
        const renderedGeometry =
          !!initial &&
          initial.width === NODE_DATASET.canvas.width &&
          initial.height === NODE_DATASET.canvas.height &&
          Math.abs(initial.cssWidth - NODE_DATASET.canvas.width) <= 2 &&
          Math.abs(initial.cssHeight - NODE_DATASET.canvas.height) <= 2 &&
          initial.samples.every(
            (sample) =>
              JSON.stringify(sample.slice(0, 3)) !== JSON.stringify(initial.background.slice(0, 3)),
          ) &&
          initial.nodes === '3' &&
          initial.edges === '1' &&
          initial.selected === 'node-1' &&
          initial.zoom === '1.25';
        add(
          checks,
          'real canvas uses evaluator-owned layout and initial state',
          renderedGeometry,
          initial ? JSON.stringify(initial) : 'canvas context unavailable',
        );

        const semanticInitial =
          (await page.locator('#semantics[role="tree"]').count()) === 1 &&
          (await page.locator('#semantics [role="treeitem"][data-node-id]').count()) === 3 &&
          (await page
            .locator('#semantics [role="treeitem"][aria-current="true"]')
            .getAttribute('data-node-id')) === 'node-1';
        add(
          checks,
          'semantic adapter projects stable node focus',
          semanticInitial,
          'tree/treeitem projection is cross-checked against rendered state',
        );
        screenshots.push(await capture(page, root, 'evaluation/scenario-1/initial.png'));

        const box = await canvas.boundingBox();
        if (!box) throw new Error('canvas has no browser geometry');
        const point = (
          worldX: number,
          worldY: number,
          zoom: number = NODE_DATASET.transform.zoom,
        ) => ({
          x: box.x + worldX * zoom + NODE_DATASET.transform.offsetX,
          y: box.y + worldY * zoom + NODE_DATASET.transform.offsetY,
        });
        const initialNodeThree = point(
          NODE_DATASET.nodes[2].x + NODE_DATASET.nodeSize.width / 2,
          NODE_DATASET.nodes[2].y + NODE_DATASET.nodeSize.height / 2,
        );
        await page.mouse.click(initialNodeThree.x, initialNodeThree.y);
        const pointerState = await page.locator('#fixture-status').evaluate((element) => ({
          edges: (element as HTMLElement).dataset.edges,
          selected: (element as HTMLElement).dataset.selected,
        }));
        add(
          checks,
          'transformed pointer hit testing selects the expected stable node',
          pointerState.edges === '1' && pointerState.selected === 'node-3',
          JSON.stringify(pointerState),
        );

        await canvas.focus();
        await page.keyboard.press('+');
        await page.waitForTimeout(30);
        const nodeTwoAtZoom = point(
          NODE_DATASET.nodes[1].x + NODE_DATASET.nodeSize.width / 2,
          NODE_DATASET.nodes[1].y + NODE_DATASET.nodeSize.height / 2,
          1.5,
        );
        await page.mouse.click(nodeTwoAtZoom.x, nodeTwoAtZoom.y);
        const zoomState = await page.locator('#fixture-status').evaluate((element) => ({
          zoom: (element as HTMLElement).dataset.zoom,
          selected: (element as HTMLElement).dataset.selected,
        }));
        add(
          checks,
          'zoom transform and post-zoom hit testing agree',
          zoomState.zoom === '1.5' && zoomState.selected === 'node-2',
          JSON.stringify(zoomState),
        );

        await canvas.focus();
        for (const key of ['Home', 'n', 'c', 'Home', 'c', 'Delete']) {
          await page.keyboard.press(key);
        }
        await page.waitForTimeout(50);
        const keyboardState = await page.locator('#fixture-status').evaluate((element) => ({
          nodes: (element as HTMLElement).dataset.nodes,
          edges: (element as HTMLElement).dataset.edges,
          selected: (element as HTMLElement).dataset.selected,
          activeElement: document.activeElement?.id,
        }));
        const projectedIds = await page
          .locator('#semantics [role="treeitem"][data-node-id]')
          .evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).dataset.nodeId));
        add(
          checks,
          'keyboard-only create/select/connect/delete preserves focus and graph invariants',
          keyboardState.nodes === '3' &&
            keyboardState.edges === '0' &&
            keyboardState.selected === 'node-2' &&
            keyboardState.activeElement === 'surface' &&
            JSON.stringify(projectedIds) === JSON.stringify(['node-2', 'node-3', 'node-4']),
          `${JSON.stringify(keyboardState)} ids=${projectedIds.join(',')}`,
        );

        await page.keyboard.press('h');
        await page.waitForTimeout(40);
        const highContrast = await page.evaluate((dataset) => {
          const element = document.querySelector('#surface') as HTMLCanvasElement;
          const context2d = element.getContext('2d')!;
          const status = document.querySelector('#fixture-status') as HTMLElement;
          const background = [...context2d.getImageData(4, 4, 1, 1).data];
          const node = dataset.nodes[1];
          const x = Math.round(
            (node.x + dataset.nodeSize.width / 2) * 1.5 + dataset.transform.offsetX,
          );
          const y = Math.round(
            (node.y + dataset.nodeSize.height / 2) * 1.5 + dataset.transform.offsetY,
          );
          return {
            background,
            foreground: [...context2d.getImageData(x, y, 1, 1).data],
            theme: status.dataset.theme,
          };
        }, NODE_DATASET);
        const contrast = contrastRatio(highContrast.background, highContrast.foreground);
        add(
          checks,
          'high-contrast token rendering is observable on canvas',
          highContrast.theme === 'high-contrast' && contrast >= 7,
          `theme=${highContrast.theme} contrast=${contrast.toFixed(2)}`,
        );

        const before = await canvasCounters(page);
        const renderBudget = await page.evaluate(async () => {
          const element = document.querySelector('#surface')!;
          const start = performance.now();
          for (let index = 0; index < 40; index += 1) {
            element.dispatchEvent(
              new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
            );
          }
          // Two frames, because a renderer may coalesce by scheduling its paint from
          // inside a frame callback. The four pass upper bound measures the same
          // overdraw budget either way.
          await new Promise<void>((resolveFrame) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolveFrame())),
          );
          return performance.now() - start;
        });
        const after = await canvasCounters(page);
        const frameDelta = (after.clearRect ?? 0) - (before.clearRect ?? 0);
        add(
          checks,
          'navigation rendering is coalesced and bounded',
          renderBudget < 250 && frameDelta > 0 && frameDelta <= 4,
          `${renderBudget.toFixed(1)}ms; ${frameDelta} canvas frames for 40 actions`,
        );
        screenshots.push(
          await capture(page, root, 'evaluation/scenario-1/final-high-contrast.png'),
        );
        add(
          checks,
          'real Brave runtime has no application errors',
          runtimeErrors.length === 0,
          runtimeErrors.join(' | ').slice(0, 500) || `Brave ${browser.version()}`,
        );
        await context.close();
      });
    });
  } catch (error) {
    add(
      checks,
      'bounded real Brave execution',
      false,
      error instanceof Error ? error.message : String(error),
    );
  }
  writeFixtureFile(
    root,
    'evaluation/scenario-1/runtime-receipt.json',
    json({
      schemaVersion: 1,
      scenarioId: CANVAS_SCENARIO,
      collector: 'evaluator-owned Playwright/Brave',
      screenshots,
      checks,
    }),
  );
  return scoreFromChecks(checks, false);
}

async function waitForPaletteState(
  page: Page,
  state: string,
  query?: string,
  timeout = 2_000,
): Promise<void> {
  await page.waitForFunction(
    ({ expectedState, expectedQuery }) => {
      const status = document.querySelector('[data-command-status]') as HTMLElement | null;
      return (
        status?.dataset.state === expectedState &&
        (expectedQuery === undefined || status.dataset.query === expectedQuery)
      );
    },
    { expectedState: state, expectedQuery: query },
    { timeout },
  );
}

/**
 * Non-throwing readiness probe. A subject that never publishes the status contract is a
 * legitimate red outcome, so it must surface as a scored check instead of an exception that
 * aborts the whole bounded browser run.
 */
async function paletteReady(page: Page, timeout: number): Promise<boolean> {
  try {
    await waitForPaletteState(page, 'ready', '', timeout);
    return true;
  } catch {
    return false;
  }
}

async function scorePalette(
  root: string,
  bravePath: string,
  timeoutMs: number,
): Promise<SkillEvalDeterministicScore> {
  const checks: BrowserCheck[] = [];
  const integrityFailure =
    !fixed(root, 'index.html', PALETTE_INDEX) ||
    !fixed(root, 'evaluator/style.css', BASE_STYLE) ||
    !fixed(root, 'evaluator/dataset.js', PALETTE_DATASET_SOURCE) ||
    !fixed(root, 'evaluator/harness.js', PALETTE_HARNESS) ||
    !fixed(root, 'README.md', PALETTE_README);
  add(
    checks,
    'sealed command dataset/source/action-contract integrity',
    !integrityFailure,
    integrityFailure ? 'evaluator-owned fixed input changed' : COMMAND_DATASET.version,
  );
  const source = subjectSource(root, 'src/widget.js');
  // The materializer deliberately ships a non-virtualized scaffold. When it is
  // byte-for-byte unchanged, no candidate behavior exists to exercise in Brave.
  // Reject that exact scaffold before launching a costly browser; every edited
  // implementation still has to pass the complete real-browser sequence.
  const sourceGate = source !== PALETTE_STARTER && paletteSubjectGate(source);
  add(
    checks,
    'subject owns a custom canvas widget implementation',
    sourceGate,
    sourceGate
      ? 'canvas, keyboard, pointer, wheel, and scheduled rendering hooks present'
      : source === PALETTE_STARTER
        ? 'unchanged materializer starter has no virtualized command widget'
        : 'DOM-only or incomplete custom widget',
  );
  if (integrityFailure || !sourceGate) return scoreFromChecks(checks, integrityFailure);

  const screenshots: string[] = [];
  try {
    await withServer(root, async (baseUrl) => {
      await withBoundedBrave(bravePath, timeoutMs, async (browser) => {
        const context = await browser.newContext({
          viewport: { width: 900, height: 700 },
          deviceScaleFactor: 1,
          reducedMotion: 'reduce',
        });
        const page = await context.newPage();
        page.setDefaultTimeout(2_000);
        // Allow loaded Brave instances a little more time under suite load;
        // withBoundedBrave still enforces the original total run budget.
        page.setDefaultNavigationTimeout(5_000);
        await installCanvasCounters(page, 500);
        const runtimeErrors: string[] = [];
        page.on('pageerror', (error) => runtimeErrors.push(`pageerror:${error.message}`));
        page.on('console', (message) => {
          if (message.type() === 'error') runtimeErrors.push(`console:${message.text()}`);
        });
        await page.goto(baseUrl, { waitUntil: 'load' });
        const ready = await paletteReady(page, 3_000);
        add(
          checks,
          'subject publishes the command status contract and reaches the ready state',
          ready,
          ready ? 'ready' : 'status contract not published within 3000ms',
        );
        if (!ready) {
          await context.close();
          return;
        }
        const query = page.locator('[data-command-query]');
        const canvas = page.locator('[data-command-canvas]');
        // A non-windowed candidate can publish "ready" before its enormous DOM
        // finishes rendering. Treat failure to expose a usable canvas within the
        // bounded observation as a measured virtualization failure, rather than
        // discarding the browser observation as an unrelated Playwright error.
        const canvasVisible = await canvas.waitFor({ state: 'visible' }).then(
          () => true,
          () => false,
        );
        if (!canvasVisible) {
          add(
            checks,
            '20,000-item custom canvas list is genuinely virtualized',
            false,
            'command canvas was not visible within the bounded browser observation',
          );
          await context.close();
          return;
        }
        // "ready" can be published before the first animation frame paints.
        // Wait for an actual semantic projection rather than relying on a fixed
        // delay, while retaining the bounded failure for unrendered candidates.
        const options = page.locator('[data-command-semantics] [role="option"]');
        await options.first().waitFor({ state: 'attached', timeout: 2_500 }).catch(() => undefined);

        // A non-windowed 20,000-row candidate can publish "ready" and then
        // block its own main thread while it builds the DOM, so every read below
        // can time out. That timeout is the virtualization failure being
        // measured, not an unrelated harness error: record it as the scored
        // check instead of letting the outer catch discard the observation.
        let customVirtualized = false;
        let projectionEvidence = '';
        try {
          const initial = await page.locator('[data-command-status]').evaluate((element) => ({
            state: (element as HTMLElement).dataset.state,
            count: (element as HTMLElement).dataset.count,
            active: (element as HTMLElement).dataset.activeId,
          }));
          const optionCount = await options.count();
          const firstOption = options.first();
          const counters = await canvasCounters(page);
          customVirtualized =
            initial.state === 'ready' &&
            initial.count === String(COMMAND_DATASET.count) &&
            initial.active === 'command-00000' &&
            optionCount > 2 &&
            optionCount < 60 &&
            (await firstOption.getAttribute('aria-posinset')) === '1' &&
            (await firstOption.getAttribute('aria-setsize')) === String(COMMAND_DATASET.count) &&
            (counters.fillText ?? 0) > 0 &&
            (counters.fillText ?? Number.POSITIVE_INFINITY) < 120 &&
            (await page.locator('[data-command-canvas]').count()) === 1;
          projectionEvidence = `${JSON.stringify(initial)} projected=${optionCount} fillText=${counters.fillText ?? 'missing'}`;
        } catch (error) {
          projectionEvidence = `bounded projection observation failed (the control did not answer within 2000ms): ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`;
        }
        add(
          checks,
          '20,000-item custom canvas list is genuinely virtualized',
          customVirtualized,
          projectionEvidence,
        );
        // A non-windowed 20,000-row control is already disqualified by the
        // observed browser projection. Avoid repeatedly interacting with its
        // enormous DOM; the same bounded budget still applies to all passing
        // candidates and the failed browser observation remains in the receipt.
        if (!customVirtualized) {
          await context.close();
          return;
        }
        screenshots.push(await capture(page, root, 'evaluation/scenario-2/initial.png'));

        const box = await canvas.boundingBox();
        if (!box) throw new Error('command canvas has no browser geometry');
        await page.mouse.click(
          box.x + 80,
          box.y + COMMAND_DATASET.groupHeaderHeight + COMMAND_DATASET.itemHeights[0] / 2,
        );
        const pointerActive = await page
          .locator('[data-command-status]')
          .getAttribute('data-active-id');
        add(
          checks,
          'variable-height grouped pointer hit testing selects the expected stable id',
          pointerActive === 'command-00000',
          `active=${pointerActive}`,
        );

        await query.focus();
        await page.keyboard.press('ArrowDown');
        await page.keyboard.press('Enter');
        const invoked = await page.locator('#invoked').getAttribute('data-invoked-id');
        const keyboardActive = await page
          .locator('[data-command-status]')
          .getAttribute('data-active-id');
        add(
          checks,
          'keyboard focus moves and Enter invokes the stable command',
          keyboardActive === 'command-00001' && invoked === 'command-00001',
          `active=${keyboardActive} invoked=${invoked}`,
        );

        const beforeScrollId = await options.first().getAttribute('data-command-id');
        const beforeScroll = await canvasCounters(page);
        const scrollBudget = await page.evaluate(async () => {
          const element = document.querySelector('[data-command-canvas]')!;
          const start = performance.now();
          for (let index = 0; index < 30; index += 1) {
            element.dispatchEvent(
              new WheelEvent('wheel', { deltaY: 60, bubbles: true, cancelable: true }),
            );
          }
          await new Promise<void>((resolveFrame) => requestAnimationFrame(() => resolveFrame()));
          return performance.now() - start;
        });
        const afterScroll = await canvasCounters(page);
        const firstAfterScroll = await options.first().getAttribute('data-command-id');
        const projectedAfterScroll = await options.count();
        const scrollFrames =
          (afterScroll.clearRect ?? Number.POSITIVE_INFINITY) - (beforeScroll.clearRect ?? 0);
        add(
          checks,
          'wheel virtualization changes the window within bounded render work',
          beforeScrollId !== firstAfterScroll &&
            projectedAfterScroll > 2 &&
            projectedAfterScroll < 60 &&
            scrollBudget < 250 &&
            scrollFrames > 0 &&
            scrollFrames <= 4,
          `${beforeScrollId}->${firstAfterScroll}; projected=${projectedAfterScroll}; ${scrollBudget.toFixed(1)}ms/${scrollFrames} frames`,
        );

        await query.fill('slow');
        await waitForPaletteState(page, 'loading', 'slow');
        await query.fill('fast');
        await waitForPaletteState(page, 'ready', 'fast');
        await page.waitForTimeout(320);
        const raceState = await page.locator('[data-command-status]').evaluate((element) => ({
          state: (element as HTMLElement).dataset.state,
          query: (element as HTMLElement).dataset.query,
          count: (element as HTMLElement).dataset.count,
        }));
        const visibleTitles = await options.evaluateAll((nodes) =>
          nodes.map((node) => node.textContent?.trim() ?? ''),
        );
        const raceMetrics = await page.evaluate(() =>
          (
            window as unknown as { __koryFixtureRead: () => Record<string, unknown> }
          ).__koryFixtureRead(),
        );
        const racePass =
          raceState.state === 'ready' &&
          raceState.query === 'fast' &&
          Number(raceState.count) > 0 &&
          visibleTitles.length > 0 &&
          visibleTitles.every((title) => title.startsWith('Fast')) &&
          Number(raceMetrics.active) === 0 &&
          Number(raceMetrics.aborts) >= 1;
        add(
          checks,
          'out-of-order async search cannot overwrite current results',
          racePass,
          `${JSON.stringify(raceState)} metrics=${JSON.stringify(raceMetrics)}`,
        );

        await query.fill('zzzz');
        await waitForPaletteState(page, 'empty', 'zzzz');
        const emptyStatus = page.locator('[data-command-status][data-state="empty"]');
        const emptyRole = await emptyStatus.getAttribute('role');
        const emptyLive = await emptyStatus.getAttribute('aria-live');
        const emptyText = (await emptyStatus.textContent())?.trim() ?? '';
        const emptyPass =
          (await options.count()) === 0 &&
          emptyText.length > 0 &&
          (emptyRole === 'status' ||
            emptyRole === 'alert' ||
            emptyLive === 'polite' ||
            emptyLive === 'assertive');
        add(
          checks,
          'empty state is semantic and clears projected options',
          emptyPass,
          `options=${await options.count()} role=${emptyRole ?? 'none'} live=${emptyLive ?? 'none'}`,
        );

        await query.fill('error');
        await waitForPaletteState(page, 'error', 'error');
        const retry = page.locator('#palette-host').getByRole('button', { name: /retry/i });
        const errorStatus = page.locator('[data-command-status][data-state="error"]');
        const errorRole = await errorStatus.getAttribute('role');
        const errorLive = await errorStatus.getAttribute('aria-live');
        const errorText = (await errorStatus.textContent())?.trim() ?? '';
        const alert = page.locator('#palette-host [role="alert"]');
        const hasAlert =
          (await alert.count()) > 0 &&
          ((await alert.first().textContent())?.trim().length ?? 0) > 0;
        const retryCount = await retry.count();
        const errorPass =
          retryCount === 1 &&
          errorText.length > 0 &&
          (errorRole === 'status' ||
            errorRole === 'alert' ||
            errorLive === 'polite' ||
            errorLive === 'assertive' ||
            hasAlert);
        await retry.click();
        await waitForPaletteState(page, 'ready', 'error');
        const recoveryFocus = await page.evaluate(() => {
          const active = document.activeElement as HTMLElement | null;
          if (!active) return 'none';
          if (active.hasAttribute('data-command-query')) return 'query';
          if (active.hasAttribute('data-command-canvas')) return 'canvas';
          return active.tagName.toLowerCase();
        });
        add(
          checks,
          'error state exposes semantic retry and recovery restores durable widget focus',
          errorPass &&
            (recoveryFocus === 'query' || recoveryFocus === 'canvas') &&
            Number(await page.locator('[data-command-status]').getAttribute('data-count')) > 0,
          `error=${errorPass} role=${errorRole ?? 'none'} live=${errorLive ?? 'none'} alert=${hasAlert} retry=${retryCount} recoveryFocus=${recoveryFocus}`,
        );
        screenshots.push(await capture(page, root, 'evaluation/scenario-2/recovered.png'));

        await page.setViewportSize({ width: 390, height: 700 });
        await page.waitForTimeout(80);
        const narrow = await page.evaluate(() => {
          const canvasElement = document.querySelector(
            '[data-command-canvas]',
          ) as HTMLCanvasElement;
          return {
            noOverflow: document.documentElement.scrollWidth <= window.innerWidth + 1,
            canvasWidth: Math.round(canvasElement.getBoundingClientRect().width),
          };
        });
        add(
          checks,
          '390px viewport preserves custom widget usability',
          narrow.noOverflow && narrow.canvasWidth <= 366,
          JSON.stringify(narrow),
        );

        await query.fill('slow');
        await waitForPaletteState(page, 'loading', 'slow');
        const cleanupBefore = await page.evaluate(() =>
          (
            window as unknown as { __koryFixtureRead: () => Record<string, unknown> }
          ).__koryFixtureRead(),
        );
        await page.evaluate(() =>
          (window as unknown as { __koryFixtureDestroy: () => void }).__koryFixtureDestroy(),
        );
        await page.waitForTimeout(40);
        const cleanupAfter = await page.evaluate(() =>
          (
            window as unknown as { __koryFixtureRead: () => Record<string, unknown> }
          ).__koryFixtureRead(),
        );
        add(
          checks,
          'destroy aborts in-flight async work and removes widget resources',
          Number(cleanupBefore.active) === 1 &&
            Number(cleanupAfter.active) === 0 &&
            Number(cleanupAfter.aborts) > Number(cleanupBefore.aborts) &&
            (await page.locator('[data-command-canvas]').count()) === 0,
          `before=${JSON.stringify(cleanupBefore)} after=${JSON.stringify(cleanupAfter)}`,
        );
        add(
          checks,
          'real Brave runtime has no application errors',
          runtimeErrors.length === 0,
          runtimeErrors.join(' | ').slice(0, 500) || `Brave ${browser.version()}`,
        );
        await context.close();
      });
    });
  } catch (error) {
    add(
      checks,
      'bounded real Brave execution',
      false,
      error instanceof Error ? error.message : String(error),
    );
  }
  writeFixtureFile(
    root,
    'evaluation/scenario-2/runtime-receipt.json',
    json({
      schemaVersion: 1,
      scenarioId: PALETTE_SCENARIO,
      collector: 'evaluator-owned Playwright/Brave',
      screenshots,
      checks,
    }),
  );
  return scoreFromChecks(checks, false);
}

function materializeCanvas(root: string): void {
  writeFixtureFile(root, 'index.html', CANVAS_INDEX);
  writeFixtureFile(root, 'evaluator/style.css', BASE_STYLE);
  writeFixtureFile(root, 'evaluator/dataset.js', CANVAS_DATASET_SOURCE);
  writeFixtureFile(root, 'evaluator/harness.js', CANVAS_HARNESS);
  writeFixtureFile(root, 'src/toolkit.js', CANVAS_STARTER);
  writeFixtureFile(root, 'README.md', CANVAS_README);
}

function materializePalette(root: string): void {
  writeFixtureFile(root, 'index.html', PALETTE_INDEX);
  writeFixtureFile(root, 'evaluator/style.css', BASE_STYLE);
  writeFixtureFile(root, 'evaluator/dataset.js', PALETTE_DATASET_SOURCE);
  writeFixtureFile(root, 'evaluator/harness.js', PALETTE_HARNESS);
  writeFixtureFile(root, 'src/widget.js', PALETTE_STARTER);
  writeFixtureFile(root, 'README.md', PALETTE_README);
}

export function createNovelUiToolkitFixtureEvaluators(
  options: EvaluatorOptions = {},
): EvaluatorSet {
  const bravePath = options.bravePath ?? DEFAULT_BRAVE_PATH;
  const timeoutMs = Math.max(1_000, options.runTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS);
  const readinessBlockers = existsSync(bravePath)
    ? undefined
    : [`Requires system Brave at ${bravePath} for real-browser evidence.`];
  const materializers: readonly SkillEvalFixtureMaterializer[] = [
    {
      id: 'novel-ui-toolkit/canvas-node-editor-real-browser@1',
      readinessBlockers,
      realRuntime: true,
      matches: (scenario) => scenario.id === CANVAS_SCENARIO,
      materialize: materializeCanvas,
    },
    {
      id: 'novel-ui-toolkit/virtualized-command-palette-real-browser@1',
      readinessBlockers,
      realRuntime: true,
      matches: (scenario) => scenario.id === PALETTE_SCENARIO,
      materialize: materializePalette,
    },
  ];
  const scorers: readonly SkillEvalDeterministicScorer[] = [
    {
      id: 'novel-ui-toolkit/canvas-node-editor-real-browser-scorer@2',
      scenarioIds: [CANVAS_SCENARIO],
      score: ({ workingDirectory }) => scoreCanvas(workingDirectory, bravePath, timeoutMs),
    },
    {
      id: 'novel-ui-toolkit/virtualized-command-palette-real-browser-scorer@4',
      scenarioIds: [PALETTE_SCENARIO],
      score: ({ workingDirectory }) => scorePalette(workingDirectory, bravePath, timeoutMs),
    },
  ];
  return { materializers, scorers };
}

const defaultEvaluators = createNovelUiToolkitFixtureEvaluators();

export const NOVEL_UI_TOOLKIT_SKILL_EVAL_MATERIALIZERS = defaultEvaluators.materializers;
export const NOVEL_UI_TOOLKIT_SKILL_EVAL_SCORERS = defaultEvaluators.scorers;

export const NOVEL_UI_TOOLKIT_EVAL_CONSTANTS = {
  bravePath: DEFAULT_BRAVE_PATH,
  canvasScenario: CANVAS_SCENARIO,
  paletteScenario: PALETTE_SCENARIO,
  nodeDatasetVersion: NODE_DATASET.version,
  commandDatasetVersion: COMMAND_DATASET.version,
  commandCount: COMMAND_DATASET.count,
} as const;
