import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright';
import type {
  SkillEvalDeterministicScorer,
  SkillEvalFixtureMaterializer,
} from './skill-eval-execution';
import { readJsonArtifact, writeFixtureFile } from './skill-eval-fixture-helpers';
import {
  chromiumBlockers,
  finishChecks,
  fixedFilesUnmodified,
  installPinnedOffline,
  pinnedPackageBlockers,
  recordCheck,
  runBounded,
  safeCandidateTree,
  tryCheck,
  withRealChromium,
  type RuntimeCheck,
} from './skill-eval-real-web-runtime';

const CACHE = 'nextjs-engineering-full-task-1-individual';
const ACTION = 'nextjs-engineering-full-task-2-individual';
const NEXT = '15.5.12';
const REACT = '19.2.8';
const readinessBlockers = [
  ...pinnedPackageBlockers([
    ['next', NEXT],
    ['react', REACT],
    ['react-dom', REACT],
  ]),
  ...chromiumBlockers(),
];

const PACKAGE = `${JSON.stringify(
  {
    name: 'kory-real-nextjs-production-fixture',
    private: true,
    type: 'module',
    scripts: { build: 'next build', start: 'next start' },
    dependencies: { next: NEXT, react: REACT, 'react-dom': REACT },
  },
  null,
  2,
)}\n`;
const NEXT_CONFIG = `/** The evaluator builds and runs the actual production App Router server. */
export default { reactStrictMode: true, experimental: { cpus: 1 },
  eslint: { ignoreDuringBuilds: true }, typescript: { ignoreBuildErrors: true } };
`;
const LAYOUT = `import React from 'react';
export const metadata = { title: 'Kory real Next.js runtime' };
export default function RootLayout({ children }) { return <html lang="en"><body style={{fontFamily:'system-ui',maxWidth:800,margin:'16px auto',padding:12}}>{children}</body></html>; }
`;
const NAV = `'use client';
import React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
export default function Navigation() {
  const router = useRouter();
  return <nav aria-label="App navigation">
    <Link id="home-link" href="/">Home</Link>{' | '}
    <Link id="details-link" href="/details">Details</Link>{' | '}
    <Link id="history-link" href="/history">History</Link>{' | '}
    <button type="button" id="refresh" onClick={() => router.refresh()}>Refresh</button>
  </nav>;
}
`;
const CACHE_STORE = `import { unstable_cache } from 'next/cache';
import { cookies } from 'next/headers';
const key = Symbol.for('kory.nextjs.cache.v2');
const state = globalThis[key] ||= { catalog: { name: 'Public catalog', revision: 1 }, prices: { alice: 17, bob: 27, anonymous: 99 }, catalogReads: 0, priceReads: {} };
async function catalogSource() {
  state.catalogReads++;
  return { ...state.catalog };
}
export const getCatalog = unstable_cache(catalogSource, ['public-catalog-v2'], { tags: ['public-catalog-v2'], revalidate: 3600 });
export async function getViewer() {
  const jar = await cookies();
  const id = jar.get('viewer')?.value;
  return id === 'alice' || id === 'bob' ? id : 'anonymous';
}
export async function getPrice(id) {
  state.priceReads[id] = (state.priceReads[id] || 0) + 1;
  return state.prices[id] ?? state.prices.anonymous;
}
export function updateFixture(data) {
  if (data.type === 'catalog') { state.catalog = { name: String(data.name), revision: state.catalog.revision + 1 }; return true; }
  if (data.type === 'price' && (data.viewer === 'alice' || data.viewer === 'bob')) {
    if (Number.isInteger(data.value) && data.value > 0) { state.prices[data.viewer] = data.value; return true; }
  }
  return false;
}
export function inspect() { return { ...state, catalog: { ...state.catalog }, prices: { ...state.prices }, priceReads: { ...state.priceReads } }; }
`;
const CACHE_CONTROL = `import { revalidateTag } from 'next/cache';
import { NextResponse } from 'next/server';
import { inspect, updateFixture } from '../../../lib/store.js';
export const dynamic = 'force-dynamic';
export async function GET() { return NextResponse.json(inspect(), { headers: { 'Cache-Control': 'no-store' } }); }
export async function POST(request) {
  const data = await request.json();
  if (!updateFixture(data)) return NextResponse.json({ error: 'invalid change' }, { status: 400 });
  if (data.type === 'catalog') revalidateTag('public-catalog-v2');
  return NextResponse.json(inspect(), { headers: { 'Cache-Control': 'no-store' } });
}
`;
const CACHE_PAGE = `import React from 'react';
import PriceView from './PriceView.jsx';
import Navigation from './navigation.jsx';
export default async function Page() { return <><Navigation/><PriceView page="home"/></>; }
`;
const CACHE_DETAILS = `import React from 'react';
import PriceView from '../PriceView.jsx';
import Navigation from '../navigation.jsx';
export default async function DetailsPage() { return <><Navigation/><PriceView page="details"/></>; }
`;
const CACHE_STARTER = `import React from 'react';
import { getCatalog, getPrice } from '../lib/store.js';
// BUG: shared anonymous price is shown for every authenticated viewer.
export default async function PriceView({ page }) {
  const catalog = await getCatalog();
  const price = await getPrice('anonymous');
  return <main data-page={page} data-viewer="anonymous" data-price={price} data-revision={catalog.revision}>
    <h1>{catalog.name}</h1><p data-personal-price>Price: {price}</p>
    <p data-revision-label>Catalog revision {catalog.revision}</p>
  </main>;
}
`;

const ACTION_STORE = `import { cookies } from 'next/headers';
const key = Symbol.for('kory.nextjs.server.actions.v2');
const state = globalThis[key] ||= { orders: [], calls: 0, writes: 0, deduped: 0, pending: new Map() };
export async function getViewer() {
  const jar = await cookies();
  const viewer = jar.get('viewer')?.value || 'alice';
  return ['alice','bob','expired','forbidden'].includes(viewer) ? viewer : 'forbidden';
}
export async function listOrders(user) { return state.orders.filter((order) => order.user === user).map((order) => ({ ...order })); }
const delay = () => new Promise((resolve) => setTimeout(resolve, 480));
async function insert(user, id) {
  await delay();
  const order = { id: 'order-' + (state.orders.length + 1), key: id, user };
  state.orders.push(order); state.writes++;
  return { ...order };
}
// Legacy non-idempotent helper is the deliberately tempting implementation shortcut.
export async function insertUnsafe(user, id) { state.calls++; return insert(user, id); }
// Stable request key is committed before the slow write. Concurrent retries share a promise.
export async function insertOnce(user, id) {
  state.calls++;
  const key = user + ':' + id;
  if (state.pending.has(key)) { state.deduped++; return state.pending.get(key); }
  const pending = insert(user, id);
  state.pending.set(key, pending);
  return pending;
}
export function inspect() { return { orders: state.orders.map((order) => ({ ...order })), calls: state.calls, writes: state.writes, deduped: state.deduped }; }
`;
const ACTION_FORM = `'use client';
import React, { useActionState, useEffect, useRef } from 'react';
import { useFormStatus } from 'react-dom';
function Submit() {
  const { pending } = useFormStatus();
  return <><button id="submit" type="submit" disabled={pending}>Submit order</button>
    {pending ? <span data-pending="true" role="status">Submitting…</span> : null}</>;
}
export default function OrderForm({ action }) {
  const [result, formAction] = useActionState(action, { status: 'idle' });
  const failure = useRef(null);
  useEffect(() => {
    if (result.status !== 'idle' && result.status !== 'success') failure.current?.focus();
  }, [result.status]);
  return <section><form action={formAction}>
    <input type="hidden" name="requestId" value="request-42"/>
    <Submit />
  </form>
    {result.status === 'success' ? <p data-success="true">Saved {result.orderId}</p> : null}
    {result.status !== 'idle' && result.status !== 'success' ? <p role="alert" tabIndex={-1} ref={failure} data-failure={result.status}>{result.status}</p> : null}
  </section>;
}
`;
const ACTION_PAGE = `import React from 'react';
import { getViewer, listOrders } from '../lib/store.js';
import { submitOrder } from './actions.js';
import OrderForm from './OrderForm.jsx';
import Navigation from './navigation.jsx';
export default async function Page() {
  const user = await getViewer();
  const orders = await listOrders(user);
  return <><Navigation/><main data-viewer={user} data-route="home"><h1>Orders</h1>
    <OrderForm action={submitOrder}/>
    <ul>{orders.map((order) => <li data-order={order.id} key={order.id}>{order.user}:{order.key}</li>)}</ul>
  </main></>;
}
`;
const ACTION_HISTORY = `import React from 'react';
import { getViewer, listOrders } from '../../lib/store.js';
import Navigation from '../navigation.jsx';
export default async function Page() {
  const user = await getViewer();
  const orders = await listOrders(user);
  return <><Navigation/><main data-route="history" data-viewer={user}><h1>Order history</h1>
    <ul>{orders.map((order) => <li key={order.id} data-order={order.id}>{order.user}:{order.key}</li>)}</ul>
  </main></>;
}
`;
const ACTION_INSPECT = `import { NextResponse } from 'next/server';
import { inspect } from '../../../lib/store.js';
export const dynamic = 'force-dynamic';
export async function GET() { return NextResponse.json(inspect(), { headers: { 'Cache-Control': 'no-store' } }); }
`;
const ACTION_STARTER = `'use server';
import { insertUnsafe } from '../lib/store.js';
// BUG: accepts expired and forbidden sessions, and duplicates concurrent writes.
export async function submitOrder(previous, formData) {
  const order = await insertUnsafe('alice', String(formData.get('requestId')));
  return { status: 'success', orderId: order.id };
}
`;

function fixed(number: 1 | 2): Record<string, string> {
  const common = {
    'package.json': PACKAGE,
    'next.config.mjs': NEXT_CONFIG,
    'app/layout.jsx': LAYOUT,
    'app/navigation.jsx': NAV,
  };
  return number === 1
    ? {
        ...common,
        'lib/store.js': CACHE_STORE,
        'app/page.jsx': CACHE_PAGE,
        'app/details/page.jsx': CACHE_DETAILS,
        'app/api/control/route.js': CACHE_CONTROL,
      }
    : {
        ...common,
        'lib/store.js': ACTION_STORE,
        'app/page.jsx': ACTION_PAGE,
        'app/OrderForm.jsx': ACTION_FORM,
        'app/history/page.jsx': ACTION_HISTORY,
        'app/api/inspect/route.js': ACTION_INSPECT,
      };
}

function candidatePath(number: 1 | 2): string {
  return number === 1 ? 'app/PriceView.jsx' : 'app/actions.js';
}

export const NEXTJS_RUNTIME_EVAL_CONSTANTS = { nextVersion: NEXT, reactVersion: REACT } as const;

function materialize(root: string, number: 1 | 2): void {
  if (readinessBlockers.length) throw new Error(readinessBlockers.join('; '));
  for (const [name, contents] of Object.entries(fixed(number)))
    writeFixtureFile(root, name, contents);
  writeFixtureFile(root, candidatePath(number), number === 1 ? CACHE_STARTER : ACTION_STARTER);
  writeFixtureFile(
    root,
    'README.md',
    `# Next.js ${NEXT} App Router real production fixture\n\n` +
      (number === 1
        ? 'Edit app/PriceView.jsx. Public catalog is cached through a fixed Next unstable_cache with revalidateTag; user-specific prices must derive from server cookies on each dynamic server render. Test two users and anonymous users, production SSR, client Link transitions, refresh/back, catalog invalidation and price changes.\n'
        : 'Edit app/actions.js. The fixed page invokes a real Server Action through React useActionState; use the stable idempotency key and fixed insertOnce service. Reject expired and forbidden cookies, revalidate the home/history paths, and handle concurrent duplicate submissions.\n') +
      'Run `bun install --offline --ignore-scripts` and `bun run build`, then `bun run start` using the pinned Next/React versions. Fixed files and API controls are immutable. Supply verification/result.json as a JSON object with these required top-level fields: status ("verified" only after successful verification), nextVersion (the pinned Next.js version string), router ("app"), deployment ("production"), broaderSkill ("web-interface"), nearNeighbor (`' +
      (number === 1 ? 'android-compose' : 'angular-engineering') +
      '`, the adjacent discipline for this task), and recovery (a descriptive string longer than 20 characters). Record real negative/recovery evidence; do not mark an unavailable check as performed. The scorer builds a fresh production server and exercises independent Chromium clients.\n',
  );
  writeFixtureFile(root, 'verification/result.json', '{"status":"TODO"}\n');
}

export const NEXTJS_RUNTIME_SKILL_EVAL_MATERIALIZERS: readonly SkillEvalFixtureMaterializer[] = [
  {
    id: 'nextjs-engineering/public-private-production-app-router@3',
    realRuntime: true,
    readinessBlockers: readinessBlockers.length ? readinessBlockers : undefined,
    matches: (scenario) => scenario.id === CACHE,
    materialize: (root) => materialize(root, 1),
  },
  {
    id: 'nextjs-engineering/server-action-idempotency-production@3',
    realRuntime: true,
    readinessBlockers: readinessBlockers.length ? readinessBlockers : undefined,
    matches: (scenario) => scenario.id === ACTION,
    materialize: (root) => materialize(root, 2),
  },
];

function candidateEvidence(root: string, number: 1 | 2): boolean {
  const doc = readJsonArtifact<Record<string, unknown>>(root, 'verification/result.json');
  return (
    doc?.status === 'verified' &&
    doc?.nextVersion === NEXT &&
    doc?.router === 'app' &&
    doc?.deployment === 'production' &&
    doc?.broaderSkill === 'web-interface' &&
    doc?.nearNeighbor === (number === 1 ? 'android-compose' : 'angular-engineering') &&
    typeof doc?.recovery === 'string' &&
    doc.recovery.length > 20
  );
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((ok, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', ok);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Ephemeral Next port unavailable');
  const port = address.port;
  await new Promise<void>((ok) => server.close(() => ok()));
  return port;
}

async function productionServer<T>(root: string, test: (url: string) => Promise<T>): Promise<T> {
  const port = await availablePort();
  const url = `http://127.0.0.1:${port}`;
  const child: ChildProcessWithoutNullStreams = spawn(
    'node',
    [
      join(root, 'node_modules/next/dist/bin/next'),
      'start',
      '--hostname',
      '127.0.0.1',
      '--port',
      String(port),
    ],
    {
      cwd: root,
      env: { ...process.env, CI: '1', NEXT_TELEMETRY_DISABLED: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  let log = '';
  const collect = (buffer: Buffer) => {
    log = (log + buffer.toString()).slice(-3500);
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  let failure: string | null = null;
  child.once('error', (error) => {
    failure = error.message;
  });
  try {
    let ready = false;
    for (let i = 0; i < 85; i++) {
      if (failure || child.exitCode !== null) break;
      try {
        const controller = AbortSignal.timeout(700);
        const response = await fetch(
          `${url}/api/${existsSync(join(root, 'app/api/control')) ? 'control' : 'inspect'}`,
          { signal: controller },
        );
        if (response.ok) {
          ready = true;
          break;
        }
      } catch {
        /* The real Next production server is still starting. */
      }
      await new Promise((ok) => setTimeout(ok, 300));
    }
    if (!ready)
      throw new Error(
        `Next production server failed to start: ${failure || child.exitCode || log || 'readiness timed out'}`,
      );
    return await test(url);
  } finally {
    child.kill('SIGTERM');
    const exited = new Promise<void>((ok) => {
      if (child.exitCode !== null) {
        ok();
        return;
      }
      child.once('exit', () => ok());
    });
    const timeout = new Promise<void>((ok) => setTimeout(ok, 2500));
    await Promise.race([exited, timeout]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
}

async function openViewer(
  browser: Browser,
  url: string,
  viewer?: string,
): Promise<{
  context: BrowserContext;
  page: Page;
  errorMessages: string[];
}> {
  const context = await browser.newContext({ viewport: { width: 1000, height: 720 } });
  try {
    if (viewer) await context.addCookies([{ name: 'viewer', value: viewer, url }]);
    const page = await context.newPage();
    page.setDefaultTimeout(6_000);
    page.setDefaultNavigationTimeout(12_000);
    const errorMessages: string[] = [];
    page.on('pageerror', (error) => errorMessages.push(error.message));
    // Next's production prefetch/streaming can keep networkidle from settling
    // even when the document and hydrated controls are already usable.
    await page.goto(url, { waitUntil: 'load' });
    return { context, page, errorMessages };
  } catch (error) {
    await context.close();
    throw error;
  }
}

async function readInspection(url: string): Promise<any> {
  const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(6_000) });
  if (!response.ok) throw new Error(`Fixed inspection service failed: ${response.status}`);
  return response.json();
}

async function exerciseCache(browser: Browser, url: string, checks: RuntimeCheck[]): Promise<void> {
  const sessions = await Promise.all([
    openViewer(browser, url, 'alice'),
    openViewer(browser, url, 'bob'),
    openViewer(browser, url),
  ]);
  const [alice, bob, anonymous] = sessions;
  try {
    await tryCheck(
      checks,
      'real Next App Router SSR isolates two cookies and anonymous requests',
      async () => {
        const values = await Promise.all(
          sessions.map(async ({ context, page }) => {
            const html = await (
              await context.request.get(url, { headers: { 'Cache-Control': 'no-cache' } })
            ).text();
            return {
              price: await page.locator('[data-price]').getAttribute('data-price'),
              viewer: await page.locator('[data-viewer]').getAttribute('data-viewer'),
              htmlPrice: /data-price="(\d+)"/u.exec(html)?.[1],
              htmlViewer: /data-viewer="([^"]+)"/u.exec(html)?.[1],
            };
          }),
        );
        const expected = [
          ['alice', '17'],
          ['bob', '27'],
          ['anonymous', '99'],
        ];
        return [
          values.every(
            (v, i) =>
              v.viewer === expected[i]?.[0] &&
              v.price === expected[i]?.[1] &&
              v.htmlViewer === expected[i]?.[0] &&
              v.htmlPrice === expected[i]?.[1],
          ),
          JSON.stringify(values),
        ];
      },
    );
    await tryCheck(checks, 'public data uses the real Next server cache across users', async () => {
      const before = await readInspection(url + '/api/control');
      // Concurrent cold SSR requests can each populate the cache before the
      // first write completes. Probe sequential warm requests for a stable hit.
      await alice.context.request.get(url);
      const afterFirst = await readInspection(url + '/api/control');
      await alice.context.request.get(url);
      const afterSecond = await readInspection(url + '/api/control');
      // `next build` can seed the Next incremental cache before the production
      // server starts. In that valid case the first runtime reads are cache hits
      // and `catalogReads` remains zero until tag invalidation. The invalidation
      // check below proves that the source is actually wired to the cache.
      return [
        afterSecond.catalogReads === afterFirst.catalogReads,
        `initial loads=${before.catalogReads}; warm SSR=${afterFirst.catalogReads}->${afterSecond.catalogReads}`,
      ];
    });
    await tryCheck(checks, 'real hydrated client Link navigation and browser back', async () => {
      await alice.page.locator('#details-link').click();
      await alice.page.locator('[data-page="details"][data-price="17"]').waitFor();
      await alice.page.goBack();
      await alice.page.locator('[data-page="home"][data-price="17"]').waitFor();
      return [
        new URL(alice.page.url()).pathname === '/',
        `client navigation + browser history: ${alice.page.url()}`,
      ];
    });
    await tryCheck(checks, 'catalog mutation triggers genuine Next tag invalidation', async () => {
      const old = await readInspection(url + '/api/control');
      const response = await fetch(url + '/api/control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'catalog', name: 'Updated public catalog' }),
      });
      if (!response.ok) throw new Error(`Next route handler catalog update ${response.status}`);
      await alice.page.locator('#refresh').click();
      await alice.page.locator('[data-revision="2"]').waitFor();
      await bob.page.reload({ waitUntil: 'load' });
      await bob.page.locator('[data-revision="2"]').waitFor();
      const current = await readInspection(url + '/api/control');
      return [
        current.catalogReads > old.catalogReads &&
          (await alice.page.locator('h1').textContent()) === 'Updated public catalog',
        `loads=${old.catalogReads}->${current.catalogReads}; revision=${current.catalog.revision}`,
      ];
    });
    await tryCheck(
      checks,
      'server update and client refresh cannot leak private price across users',
      async () => {
        const response = await fetch(url + '/api/control', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'price', viewer: 'alice', value: 19 }),
        });
        if (!response.ok) throw new Error(`Next private price update ${response.status}`);
        await alice.page.locator('#refresh').click();
        await alice.page.locator('[data-price="19"]').waitFor();
        await bob.page.locator('#refresh').click();
        await bob.page.locator('[data-price="27"]').waitFor();
        await anonymous.page.locator('#refresh').click();
        await anonymous.page.locator('[data-price="99"]').waitFor();
        const prices = await Promise.all(
          sessions.map((s) => s.page.locator('[data-price]').getAttribute('data-price')),
        );
        return [prices.join(',') === '19,27,99', `private client prices=${prices.join(',')}`];
      },
    );
    await tryCheck(
      checks,
      'direct refresh/deep link SSR retains isolation after revalidation',
      async () => {
        await alice.page.goto(url + '/details', { waitUntil: 'load' });
        await bob.page.reload({ waitUntil: 'load' });
        const [price, bobPrice] = await Promise.all([
          alice.page.locator('[data-page="details"]').getAttribute('data-price'),
          bob.page.locator('[data-page="home"]').getAttribute('data-price'),
        ]);
        const markup = await (await alice.context.request.get(url + '/details')).text();
        return [
          price === '19' && bobPrice === '27' && markup.includes('data-price="19"'),
          `SSR deep link=${price}; bob reload=${bobPrice}; server markup=${markup.includes('data-price="19"')}`,
        ];
      },
    );
    await tryCheck(
      checks,
      'hydrated Next client renders at narrow viewport without overflow',
      async () => {
        await alice.page.setViewportSize({ width: 390, height: 720 });
        const [scrollWidth, width] = await alice.page.evaluate(() => [
          document.documentElement.scrollWidth,
          innerWidth,
        ]);
        return [scrollWidth <= width, `scrollWidth=${scrollWidth} viewport=${width}`];
      },
    );
    recordCheck(
      checks,
      'Chromium rendered client runtimes without uncaught JS errors',
      sessions.every((s) => s.errorMessages.length === 0),
      sessions.map((s) => s.errorMessages.join(' | ')).join(' || ') ||
        `Next ${NEXT} production; Chromium ${browser.version()}`,
    );
  } finally {
    await Promise.all(sessions.map((s) => s.context.close()));
  }
}

async function exerciseAction(
  browser: Browser,
  url: string,
  checks: RuntimeCheck[],
): Promise<void> {
  const sessions = await Promise.all([
    openViewer(browser, url, 'alice'),
    openViewer(browser, url, 'alice'),
  ]);
  try {
    await tryCheck(
      checks,
      'real Server Actions have visible optimistic pending state',
      async () => {
        const [first, second] = sessions;
        await Promise.all([
          first.page.locator('#submit').click(),
          second.page.locator('#submit').click(),
        ]);
        await Promise.all(
          sessions.map(({ page }) => page.locator('[data-pending="true"]').waitFor()),
        );
        return [true, 'two browser clients issued independent concurrent POST Server Actions'];
      },
    );
    await tryCheck(
      checks,
      'concurrent same-key submissions produce exactly one database write',
      async () => {
        await Promise.all(
          sessions.map(({ page }) =>
            page.locator('[data-success="true"]').waitFor({ timeout: 15_000 }),
          ),
        );
        const state = await readInspection(url + '/api/inspect');
        return [
          state.calls >= 2 &&
            state.deduped >= 1 &&
            state.writes === 1 &&
            state.orders.length === 1 &&
            state.orders[0].user === 'alice',
          JSON.stringify(state),
        ];
      },
    );
    await tryCheck(
      checks,
      'Server Action revalidates path and client history/refresh',
      async () => {
        const page = sessions[0]!.page;
        await page.locator('#refresh').click();
        await page.locator('[data-order="order-1"]').waitFor();
        await page.locator('#history-link').click();
        await page.locator('[data-route="history"] [data-order="order-1"]').waitFor();
        await page.goBack();
        await page.locator('[data-route="home"] [data-order="order-1"]').waitFor();
        const html = await (await sessions[0]!.context.request.get(url + '/history')).text();
        return [
          html.includes('data-order="order-1"'),
          `Next production SSR history contains committed Server Action order`,
        ];
      },
    );
    await tryCheck(checks, 'idempotency key scoped to authenticated user', async () => {
      const bob = await openViewer(browser, url, 'bob');
      try {
        await bob.page.locator('#submit').click();
        await bob.page.locator('[data-success="true"]').waitFor({ timeout: 15_000 });
        await bob.page.locator('#refresh').click();
        await bob.page.locator('[data-order="order-2"]').waitFor();
        const state = await readInspection(url + '/api/inspect');
        const visible = await bob.page.locator('[data-order]').count();
        return [
          state.writes === 2 &&
            state.orders.length === 2 &&
            state.orders[1].user === 'bob' &&
            visible === 1,
          `user records=${state.orders.map((x: any) => x.user)}; Bob-visible=${visible}`,
        ];
      } finally {
        await bob.context.close();
      }
    });
    await tryCheck(
      checks,
      'expired and forbidden sessions rejected without database effects',
      async () => {
        const denied = await Promise.all([
          openViewer(browser, url, 'expired'),
          openViewer(browser, url, 'forbidden'),
        ]);
        try {
          await Promise.all(
            denied.map(async ({ page }) => {
              await page.locator('#submit').click();
              await page.locator('[data-failure][role="alert"]').waitFor({ timeout: 15_000 });
            }),
          );
          const statuses = await Promise.all(
            denied.map((s) => s.page.locator('[data-failure]').getAttribute('data-failure')),
          );
          const focus = await Promise.all(
            denied.map((s) =>
              s.page
                .locator('[data-failure][role="alert"]')
                .evaluate((el) => document.activeElement === el),
            ),
          );
          const state = await readInspection(url + '/api/inspect');
          return [
            statuses.join(',') === 'expired,forbidden' &&
              focus.every(Boolean) &&
              state.writes === 2,
            `status=${statuses}; alert focus=${focus}; writes=${state.writes}`,
          ];
        } finally {
          await Promise.all(denied.map((s) => s.context.close()));
        }
      },
    );
    await tryCheck(checks, 'Server Action form and history remain usable on mobile', async () => {
      const page = sessions[0]!.page;
      await page.setViewportSize({ width: 390, height: 720 });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
      await page.locator('#history-link').click();
      await page.locator('[data-route="history"] [data-order="order-1"]').waitFor();
      return [!overflow, `390px overflow=${overflow}; hydrated history accessible`];
    });
    recordCheck(
      checks,
      'real hydrated Next pages without JavaScript errors',
      sessions.every((s) => !s.errorMessages.length),
      sessions.map((s) => s.errorMessages.join(' | ')).join(' || ') ||
        `Next ${NEXT} production; Chromium ${browser.version()}`,
    );
  } finally {
    await Promise.all(sessions.map((s) => s.context.close()));
  }
}

async function runtime(root: string, number: 1 | 2, checks: RuntimeCheck[]): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), 'kory-next-real-production-'));
  try {
    for (const [file, source] of Object.entries(fixed(number))) writeFixtureFile(tmp, file, source);
    const candidate = join(root, candidatePath(number));
    const stat = lstatSync(candidate);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 300_000)
      throw new Error('Candidate must be a bounded regular editable file');
    writeFixtureFile(tmp, candidatePath(number), readFileSync(candidate, 'utf8'));
    await installPinnedOffline(tmp);
    // A Chromium process must survive the slow Next production build. Launching a
    // second Chromium under Bun after an idle close can hang on macOS.
    await withRealChromium(async (browser) => {
      const build = await runBounded(
        'node',
        [join(tmp, 'node_modules/next/dist/bin/next'), 'build'],
        tmp,
        150_000,
        { ...process.env, CI: '1', NEXT_TELEMETRY_DISABLED: '1' },
      );
      recordCheck(
        checks,
        'actual Next production compiler builds App Router and Server Actions',
        build.includes('Route (app)'),
        build.slice(-750),
        false,
      );
      await productionServer(tmp, async (url) => {
        if (number === 1) await exerciseCache(browser, url, checks);
        else await exerciseAction(browser, url, checks);
      });
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

async function score(root: string, number: 1 | 2) {
  if (readinessBlockers.length)
    return finishChecks(
      readinessBlockers.map((reason) => ({
        name: 'runtime readiness',
        detail: reason,
        passed: false,
        browser: false,
      })),
    );
  const checks: RuntimeCheck[] = [];
  const untouched = fixedFilesUnmodified(root, fixed(number));
  const safe = safeCandidateTree(root, ['app', 'lib']);
  recordCheck(
    checks,
    'immutable Next service/routes and safe candidate source',
    untouched && safe,
    `fixed=${untouched}; safe=${safe}`,
    false,
  );
  if (!untouched || !safe) return finishChecks(checks, true);
  recordCheck(
    checks,
    'App Router, production target and recovery evidence',
    candidateEvidence(root, number),
    `Next ${NEXT}; App Router; real production`,
    false,
  );
  try {
    await runtime(root, number, checks);
  } catch (error) {
    recordCheck(
      checks,
      'actual Next production build/server/browser',
      false,
      error instanceof Error ? error.message.slice(0, 1_000) : error,
    );
  }
  return finishChecks(checks);
}

export const NEXTJS_RUNTIME_SKILL_EVAL_SCORERS: readonly SkillEvalDeterministicScorer[] = [
  {
    id: 'nextjs-engineering/public-private-production-scorer@2',
    scenarioIds: [CACHE],
    score: ({ workingDirectory }) => score(workingDirectory, 1),
  },
  {
    id: 'nextjs-engineering/server-action-production-scorer@2',
    scenarioIds: [ACTION],
    score: ({ workingDirectory }) => score(workingDirectory, 2),
  },
];
