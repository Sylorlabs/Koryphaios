import { createServer } from 'node:http';
import {
  closeSync,
  constants,
  cpSync,
  existsSync,
  fstatSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { canonicalizePath, hasHardLinks, isContainedBy } from '../runtime/platform';
import { chromiumLaunchOptions, pinnedBrowserPackage } from './skill-eval-real-web-runtime';

// Only the disposable React scenarios receive this evaluator-owned service.
// Neither the model nor its Codex sandbox may start or control host processes.
const REACT_SCENARIOS = new Set([
  'react-engineering-full-task-1-individual',
  'react-engineering-full-task-2-individual',
]);
const PACKAGE_VERSIONS = [
  ['react', '19.2.8'],
  ['react-dom', '19.2.8'],
  ['scheduler', '0.27.0'],
] as const;
const ALLOWED_PACKAGE_IMPORT =
  /^(?:react(?:\/(?:jsx-runtime|jsx-dev-runtime))?|react-dom(?:\/(?:client|server))?|scheduler(?:\/.*)?)$/u;
const MAX_REQUESTS = 16;
const MAX_ACTIONS = 18;
// Playwright owns the Chromium process tree and kills it on its launch timeout.
// Retry a failed startup once, but never overlap a launch that has not settled.
const LAUNCH_TIMEOUT_MS = 20_000;
const LAUNCH_WATCHDOG_MS = LAUNCH_TIMEOUT_MS + 5_000;
const LAUNCH_RETRY_DELAY_MS = 400;
// The evaluator must never keep the single ledger writer alive indefinitely
// when a disconnected Playwright transport fails to settle browser.close().
const CLOSE_TIMEOUT_MS = 15_000;
const REQUEST_FILE = 'react-browser-request.json';
const RESPONSE_FILE = 'react-browser-response.json';
const IMMUTABLE_FIXTURE_FILES = [
  'package.json',
  'index.html',
  'design.css',
  'src/main.jsx',
  'src/Harness.jsx',
  'src/search-source.js',
  'src/list-source.js',
] as const;
type FixtureLocks = Map<string, Buffer>;

type BrowserAction =
  | { type: 'navigate'; path: string }
  | { type: 'back' | 'forward' | 'reload' | 'url' | 'layout' }
  | { type: 'metrics'; source: 'search' | 'list' | 'commits' }
  | { type: 'viewport'; width: number; height: number }
  | { type: 'pause'; ms: number }
  | {
      type: 'click' | 'activate' | 'wait' | 'text' | 'value' | 'count' | 'focused';
      selector: string;
    }
  | { type: 'fill' | 'press'; selector: string; value: string };

interface BrowserRequest {
  requestId: string;
  actions: BrowserAction[];
}

export interface ReactBrowserBroker {
  close(): Promise<void>;
}

export const REACT_BROWSER_BROKER_INSTRUCTIONS = [
  'This React fixture has an evaluator-owned, limited real Chromium inspector that works without starting Chromium inside the Codex sandbox.',
  'You can inspect rendered behavior without launching a browser or changing sandbox permissions.',
  'Write verification/react-browser-request.json as JSON with a unique requestId and up to 18 actions.',
  'Example: {"requestId":"check-1","actions":[{"type":"wait","selector":"#route-fast"},{"type":"click","selector":"#route-fast"},{"type":"text","selector":"[data-result-query]"}]}',
  'Actions: navigate (local path), back, forward, reload, viewport (width/height), pause (ms <= 1500), click, activate (click without moving focus), wait, text, value, count, focused, fill (value), press (ordinary key), url, layout, metrics (source: search/list/commits).',
  'Wait for complete, valid JSON in verification/react-browser-response.json with your requestId. Each request gets a fresh browser context; use a NEW requestId after modifying code (maximum 16 requests).',
  'The response contains actual Chromium observations or an explicit error. Inspector status ok means actions ran without page exceptions; it is not a passing score.',
  'The inspector builds a fresh, isolated copy of the local React source and blocks external network and WebSocket traffic. The independent hidden scorer runs separately.',
  'Mark verification artifacts as verified only after observing real successful browser evidence. Report failed, unavailable or untested behavior as unverified.',
].join('\n');

export function isReactBrowserScenario(scenarioId: string): boolean {
  return REACT_SCENARIOS.has(scenarioId);
}

function verificationDirectory(root: string): string {
  const path = join(root, 'verification');
  const stats = lstatSync(path);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error('React browser verification directory must be a real directory');
  }
  return path;
}

// Capture evaluator-created contracts before Codex runs. The candidate may edit
// App.jsx, but browser observations from modified harnesses are not trusted.
function captureFixtureLocks(root: string): FixtureLocks {
  const locks: FixtureLocks = new Map();
  for (const name of IMMUTABLE_FIXTURE_FILES) {
    const path = join(root, name);
    if (!existsSync(path)) continue;
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || hasHardLinks(stat) || stat.size > 200_000) {
      throw new Error('React inspector rejected immutable fixture file: ' + name);
    }
    locks.set(name, readFileSync(path));
  }
  return locks;
}

function verifyFixtureLocks(root: string, locks: FixtureLocks): void {
  for (const [name, expected] of locks) {
    const path = join(root, name);
    try {
      const stat = lstatSync(path);
      if (stat.isFile() && !stat.isSymbolicLink() && readFileSync(path).equals(expected)) continue;
    } catch {
      /* A missing fixture file is also a contract violation. */
    }
    throw new Error('React inspector detected modified immutable fixture: ' + name);
  }
}

function assertSafeSource(root: string): void {
  let files = 0;
  let totalBytes = 0;
  const scan = (directory: string, depth: number): void => {
    if (depth > 8) throw new Error('React browser source directory is too deeply nested');
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      const stat = lstatSync(path);
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        scan(path, depth + 1);
      } else if (stat.isFile() && !stat.isSymbolicLink() && !hasHardLinks(stat)) {
        files += 1;
        totalBytes += stat.size;
        if (files > 80 || stat.size > 200_000 || totalBytes > 1_000_000) {
          throw new Error('React browser source exceeds verification limits');
        }
      } else {
        throw new Error('React browser source contains a symlink, hard link or special file');
      }
    }
  };
  scan(join(root, 'src'), 0);
  if (!existsSync(join(root, 'src', 'main.jsx'))) {
    throw new Error('React browser fixture entry point is missing');
  }
}

function copyPinnedRuntime(runtime: string): void {
  for (const [name, version] of PACKAGE_VERSIONS) {
    const source = pinnedBrowserPackage(name, version);
    cpSync(source, join(runtime, 'node_modules', name), { recursive: true });
  }
}

async function buildRuntime(
  root: string,
  locks: FixtureLocks,
): Promise<{
  directory: string;
  scriptName: string;
}> {
  assertSafeSource(root);
  verifyFixtureLocks(root, locks);
  const directory = canonicalizePath(mkdtempSync(join(tmpdir(), 'kory-react-browser-inspector-')));
  try {
    cpSync(join(root, 'src'), join(directory, 'src'), { recursive: true });
    assertSafeSource(directory);
    verifyFixtureLocks(root, locks);
    for (const [name, expected] of locks) {
      if (name.startsWith('src/') && !readFileSync(join(directory, name)).equals(expected)) {
        throw new Error('React inspector detected a changed fixture during source copy: ' + name);
      }
    }
    mkdirSync(join(directory, 'node_modules'), { recursive: true });
    copyPinnedRuntime(directory);
    const sourceRoot = join(directory, 'src');
    const dependencyRoot = join(directory, 'node_modules');
    let rejectedImport = false;
    let result: Awaited<ReturnType<typeof Bun.build>>;
    try {
      result = await Bun.build({
        entrypoints: [join(sourceRoot, 'main.jsx')],
        target: 'browser',
        outdir: join(directory, 'dist'),
        minify: false,
        plugins: [
          {
            name: 'react-inspector-import-boundary',
            setup(builder) {
              builder.onResolve({ filter: /.*/u }, (args) => {
                if (!args.importer && resolve(args.path) === join(sourceRoot, 'main.jsx'))
                  return undefined;
                if (ALLOWED_PACKAGE_IMPORT.test(args.path)) return undefined;
                if (args.path.startsWith('./') || args.path.startsWith('../')) {
                  const target = resolve(dirname(args.importer), args.path);
                  if (isContainedBy(sourceRoot, target) || isContainedBy(dependencyRoot, target)) {
                    return undefined;
                  }
                }
                rejectedImport = true;
                throw new Error('React inspector rejected import outside its sealed runtime');
              });
            },
          },
        ],
      });
    } catch (error) {
      if (rejectedImport)
        throw new Error('React inspector rejected import outside its sealed runtime');
      throw error;
    }
    if (rejectedImport)
      throw new Error('React inspector rejected import outside its sealed runtime');
    if (!result.success) {
      throw new Error('React build failed: ' + result.logs.map((log) => log.message).join(' | '));
    }
    const entry = result.outputs.find((output) => output.kind === 'entry-point');
    if (!entry) throw new Error('React inspector produced no browser entry point');
    writeFileSync(
      join(directory, 'index.html'),
      '<!doctype html><html lang="en"><head><meta charset="UTF-8">' +
        '<meta name="viewport" content="width=device-width,initial-scale=1">' +
        '<link rel="stylesheet" href="/design.css"></head>' +
        '<body><div id="root"></div><script type="module" src="/dist/' +
        basename(entry.path) +
        '"></script></body></html>',
    );
    const css = join(root, 'design.css');
    const cssStat = lstatSync(css);
    if (
      !cssStat.isFile() ||
      cssStat.isSymbolicLink() ||
      hasHardLinks(cssStat) ||
      cssStat.size > 200_000
    ) {
      throw new Error('React inspector rejected modified stylesheet type or size');
    }
    const stylesheet = readFileSync(css);
    if (locks.get('design.css') && !stylesheet.equals(locks.get('design.css')!)) {
      throw new Error('React inspector detected modified immutable fixture: design.css');
    }
    writeFileSync(join(directory, 'design.css'), stylesheet);
    return { directory, scriptName: basename(entry.path) };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

async function serveRuntime<T>(
  runtime: { directory: string; scriptName: string },
  run: (url: string) => Promise<T>,
): Promise<T> {
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    const allowed = new Set(['/', '/index.html', '/design.css', '/dist/' + runtime.scriptName]);
    if (!allowed.has(path)) {
      response.writeHead(404).end();
      return;
    }
    const resolved = resolve(runtime.directory, '.' + (path === '/' ? '/index.html' : path));
    if (!isContainedBy(runtime.directory, resolved)) {
      response.writeHead(404).end();
      return;
    }
    try {
      const stat = lstatSync(resolved);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, {
        'Content-Type':
          extname(resolved) === '.js'
            ? 'text/javascript'
            : extname(resolved) === '.css'
              ? 'text/css'
              : 'text/html',
        'Cache-Control': 'no-store',
      });
      response.end(readFileSync(resolved));
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((ok, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', ok);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No local browser server port');
  try {
    return await run('http://127.0.0.1:' + address.port);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((ok) => server.close(() => ok()));
  }
}

function parseRequest(raw: string): BrowserRequest {
  const input: unknown = JSON.parse(raw);
  if (!input || typeof input !== 'object') throw new Error('Invalid browser request');
  const value = input as Partial<BrowserRequest>;
  if (
    typeof value.requestId !== 'string' ||
    !/^[a-zA-Z0-9_-]{1,48}$/u.test(value.requestId) ||
    !Array.isArray(value.actions) ||
    value.actions.length < 1 ||
    value.actions.length > MAX_ACTIONS
  )
    throw new Error('Invalid browser request ID or number of actions');
  for (const action of value.actions as BrowserAction[]) {
    if (!action || typeof action !== 'object') throw new Error('Invalid browser action');
    if (
      ['click', 'activate', 'wait', 'text', 'value', 'count', 'focused', 'fill', 'press'].includes(
        action.type,
      )
    ) {
      if (
        !('selector' in action) ||
        typeof action.selector !== 'string' ||
        action.selector.length < 1 ||
        action.selector.length > 180
      )
        throw new Error('Invalid browser selector');
    }
    switch (action.type) {
      case 'navigate':
        if (
          typeof action.path !== 'string' ||
          !action.path.startsWith('/') ||
          action.path.startsWith('//') ||
          action.path.length > 300
        ) {
          throw new Error('Only local browser paths are permitted');
        }
        break;
      case 'metrics':
        if (action.source !== 'search' && action.source !== 'list' && action.source !== 'commits') {
          throw new Error('Invalid public React instrumentation source');
        }
        break;
      case 'viewport':
        if (
          !Number.isInteger(action.width) ||
          action.width < 320 ||
          action.width > 1600 ||
          !Number.isInteger(action.height) ||
          action.height < 400 ||
          action.height > 1200
        ) {
          throw new Error('Invalid browser viewport');
        }
        break;
      case 'pause':
        if (!Number.isInteger(action.ms) || action.ms < 0 || action.ms > 1500) {
          throw new Error('Invalid browser pause');
        }
        break;
      case 'fill':
        if (typeof action.value !== 'string' || action.value.length > 400) {
          throw new Error('Invalid browser input');
        }
        break;
      case 'press':
        if (
          typeof action.value !== 'string' ||
          !/^(?:[a-zA-Z0-9]|Enter|Tab|Escape|Backspace|Delete|Arrow(?:Up|Down|Left|Right)|Home|End)$/u.test(
            action.value,
          )
        ) {
          throw new Error('Only ordinary browser keys are permitted');
        }
        break;
      case 'click':
      case 'activate':
      case 'wait':
      case 'text':
      case 'value':
      case 'count':
      case 'focused':
      case 'back':
      case 'forward':
      case 'layout':
      case 'reload':
      case 'url':
        break;
      default:
        throw new Error('Browser inspector does not permit this action');
    }
  }
  return value as BrowserRequest;
}

async function perform(page: Page, base: string, action: BrowserAction): Promise<unknown> {
  switch (action.type) {
    case 'navigate': {
      const target = new URL(action.path, base);
      if (target.origin !== new URL(base).origin) throw new Error('External browser path denied');
      await page.goto(target.href, { waitUntil: 'load' });
      return page.url();
    }
    case 'back':
      await page.goBack({ waitUntil: 'load' });
      return page.url();
    case 'forward':
      await page.goForward({ waitUntil: 'load' });
      return page.url();
    case 'reload':
      await page.reload({ waitUntil: 'load' });
      return page.url();
    case 'url':
      return page.url();
    case 'layout':
      return page.evaluate(() => ({
        viewportWidth: window.innerWidth,
        documentWidth: document.documentElement.scrollWidth,
      }));
    case 'metrics': {
      const key = { search: '__searchSource', list: '__listSource', commits: '__reactCommits' }[
        action.source
      ];
      return page.evaluate((name) => {
        const observed = (window as unknown as Record<string, unknown>)[name];
        if (!observed || typeof observed !== 'object') return null;
        const record = observed as Record<string, unknown>;
        const counts: Record<string, unknown> = {};
        for (const key of [
          'active',
          'started',
          'completed',
          'aborted',
          'lateAfterAbort',
          'failed',
          'total',
          'afterDestroy',
          'destroyed',
        ]) {
          if (typeof record[key] === 'number' || typeof record[key] === 'boolean') {
            counts[key] = record[key];
          }
        }
        const attempts = record.attempts;
        if (attempts && typeof attempts === 'object') {
          counts.attempts = Object.fromEntries(
            Object.entries(attempts)
              .slice(0, 20)
              .filter(([, count]) => typeof count === 'number'),
          );
        }
        return counts;
      }, key);
    }
    case 'viewport':
      await page.setViewportSize({ width: action.width, height: action.height });
      return action.width + 'x' + action.height;
    case 'pause':
      await page.waitForTimeout(action.ms);
      return action.ms;
    case 'click':
      await page.locator(action.selector).click();
      return true;
    case 'activate':
      await page.locator(action.selector).evaluate((node) => (node as HTMLElement).click());
      return true;
    case 'wait':
      await page.locator(action.selector).waitFor({ state: 'visible' });
      return true;
    case 'text':
      return (await page.locator(action.selector).textContent())?.slice(0, 500) ?? '';
    case 'value':
      return (await page.locator(action.selector).inputValue()).slice(0, 500);
    case 'count':
      return page.locator(action.selector).count();
    case 'focused':
      return page.locator(action.selector).evaluate((node) => document.activeElement === node);
    case 'fill':
      await page.locator(action.selector).fill(action.value);
      return true;
    case 'press':
      await page.locator(action.selector).press(action.value);
      return true;
  }
}

async function inspect(
  root: string,
  request: BrowserRequest,
  browser: Browser,
  locks: FixtureLocks,
): Promise<Record<string, unknown>> {
  const runtime = await buildRuntime(root, locks);
  try {
    return await serveRuntime(runtime, async (base) => {
      const context: BrowserContext = await browser.newContext({
        viewport: { width: 900, height: 740 },
        serviceWorkers: 'block',
        acceptDownloads: false,
      });
      try {
        // Candidate code runs only in Chromium's renderer, with no outbound HTTP or WS.
        await context.route('**/*', (route) => {
          if (
            route
              .request()
              .url()
              .startsWith(base + '/')
          ) {
            return route.continue();
          }
          return route.abort('blockedbyclient');
        });
        await context.routeWebSocket('**/*', (socket) => socket.close());
        // Playwright routes HTTP requests and WebSockets. Disable browser transport
        // APIs that are outside that interception path as well.
        await context.addInitScript(() => {
          for (const api of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'WebTransport']) {
            Object.defineProperty(window, api, {
              value: undefined,
              writable: false,
              configurable: false,
            });
          }
        });
        const page = await context.newPage();
        page.setDefaultTimeout(2_000);
        page.setDefaultNavigationTimeout(3_000);
        const pageErrors: string[] = [];
        page.on('pageerror', (error) => pageErrors.push(error.message.slice(0, 300)));
        await page.goto(base + '/', { waitUntil: 'load' });
        const observations: { type: string; value: unknown }[] = [];
        for (const action of request.actions) {
          observations.push({
            type: action.type,
            value: await perform(page, base, action),
          });
        }
        return {
          requestId: request.requestId,
          status: pageErrors.length === 0 ? 'ok' : 'error',
          scoring: 'unscored; independent evaluator runs separately',
          ...(pageErrors.length > 0
            ? { error: 'Uncaught error while running React in Chromium' }
            : {}),
          browser: 'Chromium ' + browser.version(),
          observations,
          pageErrors: pageErrors.slice(0, 8),
        };
      } finally {
        await context.close();
      }
    });
  } finally {
    rmSync(runtime.directory, { recursive: true, force: true });
  }
}

// Open file handles remain attached to the evaluator-created inodes throughout
// the candidate turn. A candidate swapping `verification/` for a symlink can no
// longer redirect these evaluator writes to a host file outside the workspace.
function writeResponse(fd: number, result: Record<string, unknown>): void {
  const content = Buffer.from(JSON.stringify(result, null, 2) + '\n');
  ftruncateSync(fd, 0);
  let written = 0;
  while (written < content.length) {
    written += writeSync(fd, content, written, content.length - written, written);
  }
}

async function launchInspectorAttempt(): Promise<Browser> {
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let expired = false;
  const launching = chromium.launch({
    ...chromiumLaunchOptions(),
    chromiumSandbox: true,
    timeout: LAUNCH_TIMEOUT_MS,
  });
  // If Playwright returns a browser after the independent watchdog fires,
  // close it instead of leaking a process or crediting an uninspected attempt.
  const result = launching.then(async (browser) => {
    if (!expired) return browser;
    await shutdownInspectorBrowser(browser);
    throw new Error('Chromium inspector browser became ready after its launch deadline');
  });
  try {
    return await Promise.race([
      result,
      new Promise<never>((_, reject) => {
        watchdog = setTimeout(() => {
          expired = true;
          reject(new Error(`Chromium inspector launch stalled after ${LAUNCH_WATCHDOG_MS}ms`));
        }, LAUNCH_WATCHDOG_MS);
      }),
    ]);
  } finally {
    if (watchdog) clearTimeout(watchdog);
  }
}

async function launchInspectorBrowser(): Promise<Browser> {
  try {
    return await launchInspectorAttempt();
  } catch (firstError) {
    const firstMessage = firstError instanceof Error ? firstError.message : String(firstError);
    // An unsettled launch may still own a Chromium child. Fail closed rather
    // than starting another one while Playwright is cleaning up the first.
    if (
      !/Timeout \d+ms exceeded|Target page, context or browser has been closed|Connection terminated while reading from pipe|Could not write into pipe/iu.test(
        firstMessage,
      )
    ) {
      throw firstError;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, LAUNCH_RETRY_DELAY_MS));
    try {
      return await launchInspectorAttempt();
    } catch (retryError) {
      const retryMessage = retryError instanceof Error ? retryError.message : String(retryError);
      throw new Error(
        `Chromium inspector failed both launch attempts: ${firstMessage.slice(0, 400)} | ${retryMessage.slice(0, 400)}`,
        { cause: retryError },
      );
    }
  }
}

async function shutdownInspectorBrowser(browser: Browser, active?: Promise<void>): Promise<void> {
  let closeTimeout: ReturnType<typeof setTimeout> | undefined;
  // A closed Playwright pipe can make browser.close() reject or never settle.
  // Cleanup is best effort; an inspection failure still goes through its
  // explicit error response, and an unfinished inspection gets no response.
  const closing = Promise.resolve()
    .then(() => browser.close())
    .catch((error: unknown) => {
      console.warn('React browser inspector Chromium cleanup failed:', error);
    });
  try {
    await Promise.race([
      Promise.all([active ?? Promise.resolve(), closing]),
      new Promise<void>((resolve) => {
        closeTimeout = setTimeout(() => {
          console.warn(`React browser inspector cleanup timed out after ${CLOSE_TIMEOUT_MS}ms`);
          resolve();
        }, CLOSE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (closeTimeout) clearTimeout(closeTimeout);
  }
}

/**
 * Only a hard-coded React fixture may start this bridge. The candidate can submit
 * bounded declarative browser actions through its disposable workspace; it gets
 * neither hidden scorer logic nor shell, script evaluation, URLs, CDP, or host APIs.
 * The independent evaluator still launches its own Chromium and scores afterward.
 */
export async function startReactBrowserBroker(
  root: string,
  // Evaluator-owned injection seam for transport/lifecycle unit tests only.
  // Candidate requests cannot select an implementation or bypass inspect().
  inspectCandidate: typeof inspect = inspect,
): Promise<ReactBrowserBroker> {
  const directory = verificationDirectory(root);
  const locks = captureFixtureLocks(root);
  // Fail setup before running the candidate if the evaluator cannot launch Chromium.
  const browser = await launchInspectorBrowser();
  let requestFd: number | undefined;
  let responseFd: number | undefined;
  try {
    // Create and pin both transport files before the candidate starts. A
    // replacement file, directory symlink, or hard link cannot redirect I/O.
    const flags =
      constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0);
    requestFd = openSync(join(directory, REQUEST_FILE), flags, 0o600);
    responseFd = openSync(join(directory, RESPONSE_FILE), flags, 0o600);
  } catch (error) {
    if (requestFd !== undefined) closeSync(requestFd);
    if (responseFd !== undefined) closeSync(responseFd);
    await shutdownInspectorBrowser(browser);
    throw error;
  }
  const requestFile = requestFd;
  const responseFile = responseFd;
  let active: Promise<void> | undefined;
  let closed = false;
  let closeTask: Promise<void> | undefined;
  let handled = 0;
  let lastId: string | undefined;
  const poll = async () => {
    if (closed || active || handled >= MAX_REQUESTS) return;
    let raw: string;
    try {
      const stat = fstatSync(requestFile);
      if (!stat.isFile() || stat.size < 1 || stat.size > 16_384) return;
      const buffer = Buffer.alloc(stat.size);
      if (readSync(requestFile, buffer, 0, buffer.length, 0) !== buffer.length) return;
      raw = buffer.toString('utf8');
    } catch {
      return;
    }
    let request: BrowserRequest;
    try {
      request = parseRequest(raw);
    } catch (error) {
      // Once a request ID is complete, invalid actions get an explicit error.
      // Partial JSON is retried because the candidate may still be writing.
      let invalidId: string | undefined;
      try {
        const parsed: unknown = JSON.parse(raw);
        if (
          parsed &&
          typeof parsed === 'object' &&
          'requestId' in parsed &&
          typeof parsed.requestId === 'string' &&
          /^[a-zA-Z0-9_-]{1,48}$/u.test(parsed.requestId)
        ) {
          invalidId = parsed.requestId;
        }
      } catch {
        return;
      }
      if (invalidId && invalidId !== lastId) {
        lastId = invalidId;
        handled += 1;
        writeResponse(responseFile, {
          requestId: invalidId,
          status: 'error',
          error: error instanceof Error ? error.message : 'Invalid browser request',
        });
      }
      return;
    }
    if (request.requestId === lastId) return;
    lastId = request.requestId;
    handled += 1;
    active = (async () => {
      let result: Record<string, unknown>;
      try {
        result = await inspectCandidate(root, request, browser, locks);
      } catch (error) {
        result = {
          requestId: request.requestId,
          status: 'error',
          error: error instanceof Error ? error.message.slice(0, 1_000) : String(error),
        };
      }
      // The candidate process has ended once close() starts. An in-flight
      // inspection must not write into transport descriptors after shutdown.
      if (!closed) writeResponse(responseFile, result);
    })().finally(() => {
      active = undefined;
    });
    await active;
  };
  const timer = setInterval(() => void poll(), 150);
  return {
    close: () =>
      (closeTask ??= (async () => {
        closed = true;
        clearInterval(timer);
        try {
          // Close Chromium immediately to unblock an inspection stuck in a
          // browser operation; an unresolved transport cannot block the scorer.
          await shutdownInspectorBrowser(browser, active);
        } finally {
          try {
            closeSync(requestFile);
          } finally {
            closeSync(responseFile);
          }
        }
      })()),
  };
}
