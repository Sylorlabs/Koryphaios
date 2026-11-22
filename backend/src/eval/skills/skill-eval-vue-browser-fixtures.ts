import { createServer } from 'node:http';
import { cpSync, existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, extname, join, resolve } from 'node:path';
import type { Page } from 'playwright';
import { isContainedBy } from '../../runtime/platform';
import type { SkillEvalDeterministicScorer, SkillEvalFixtureMaterializer } from './skill-eval-execution';
import { readJsonArtifact, writeFixtureFile } from './skill-eval-fixture-helpers';
import {
  chromiumBlockers, finishChecks, fixedFilesUnmodified, installPinnedOffline,
  pinnedPackageBlockers, recordCheck, safeCandidateTree, tryCheck, withRealChromium,
  type RuntimeCheck,
} from './skill-eval-real-web-runtime';

const ROUTE = 'vue-engineering-full-task-1-individual';
const FORM = 'vue-engineering-full-task-2-individual';
const VUE_VERSION = '3.5.30';
const readinessBlockers = [...pinnedPackageBlockers([['vue', VUE_VERSION]]), ...chromiumBlockers()];

const PACKAGE = `${JSON.stringify({
  name: 'kory-vue-runtime-fixture', private: true, type: 'module',
  dependencies: { vue: VUE_VERSION },
  scripts: { build: 'bun build src/main.js --target browser --outdir dist' },
}, null, 2)}\n`;
const HTML = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script type="module" src="/main.js"></script></body></html>\n';
const STYLE = '*,*::before,*::after{box-sizing:border-box}body{font:16px/1.4 system-ui;margin:0;background:#f5f7fd;color:#182536}.shell{max-width:760px;margin:20px auto;padding:14px}.toolbar{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px}button,input{font:inherit}button{border:1px solid #8296b2;border-radius:5px;padding:7px;background:white;cursor:pointer}input{max-width:100%;padding:7px}input:focus-visible,button:focus-visible{outline:3px solid #456ddf}label{display:block;margin:9px 0}.card{min-width:0;background:white;padding:16px;border:1px solid #bcc9dc;border-radius:9px}h1{font-size:1.4rem}p{overflow-wrap:anywhere}@media(max-width:420px){.shell{padding:6px}.toolbar{gap:4px}}\n';
const MAIN = `import { createApp } from 'vue';
import Harness from './Harness.js';
createApp(Harness).mount('#root');
`;
const SOURCE = `const metrics = { active: 0, started: 0, aborted: 0, lateAfterAbort: 0, attempts: {} };
window.__vueSource = metrics;
export function loadDetail(id, options = {}) {
  const attempt = (metrics.attempts[id] || 0) + 1;
  metrics.attempts[id] = attempt;
  metrics.started++; metrics.active++;
  const slow = id === 'slow' || id === 'slow-unmount';
  return new Promise((resolve, reject) => {
    let settled = false; let aborted = false;
    const end = () => {
      if (settled) return false;
      settled = true; metrics.active--;
      options.signal?.removeEventListener('abort', abort);
      return true;
    };
    const abort = () => {
      if (settled || aborted) return;
      aborted = true; metrics.aborted++;
      if (!slow && end()) { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); }
    };
    const timer = setTimeout(() => {
      if (!end()) return;
      if (aborted) metrics.lateAfterAbort++;
      if (id === 'error' && attempt === 1) reject(new Error('Temporary server error'));
      else resolve(id === 'empty' ? null : { id, title: id + ' detail' });
    }, slow ? 450 : 65);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
  });
}
`;
const ROUTE_HARNESS = `import { defineComponent, h, onMounted, onUnmounted, ref } from 'vue';
import App from './App.js';
export default defineComponent({ setup() {
  const route = ref(new URLSearchParams(location.search).get('id') || 'slow');
  const mounted = ref(true);
  const sync = () => { route.value = new URLSearchParams(location.search).get('id') || 'slow'; };
  onMounted(() => addEventListener('popstate', sync));
  onUnmounted(() => removeEventListener('popstate', sync));
  const navigate = (id) => { history.pushState({}, '', '/?id=' + encodeURIComponent(id)); dispatchEvent(new PopStateEvent('popstate')); };
  return () => h('main', { class: 'shell' }, [
    h('nav', { class: 'toolbar', 'aria-label': 'Detail routes' }, [
      ...['slow','fast','error','empty'].map((id) => h('button', { id: 'route-' + id, onClick: () => navigate(id) }, id)),
      h('button', { id: 'route-unmount', onClick: () => { mounted.value = false; navigate('slow-unmount'); } }, 'Unmount'),
      h('button', { id: 'route-remount', onClick: () => { mounted.value = true; } }, 'Remount'),
    ]),
    mounted.value ? h(App, { id: route.value }) : h('p', { 'data-unmounted': '' }, 'Unmounted'),
  ]);
}});
`;
const ROUTE_STARTER = `import { defineComponent, h, ref, watch } from 'vue';
import { loadDetail } from './source.js';
export default defineComponent({ props: { id: String }, setup(props) {
  const detail = ref(null); const status = ref('loading'); const error = ref('');
  watch(() => props.id, async (id) => {
    status.value = 'loading';
    try { detail.value = await loadDetail(id); status.value = 'done'; }
    catch (e) { error.value = e.message; status.value = 'error'; }
  }, { immediate: true });
  return () => h('section', { class: 'card', 'data-vue-detail': '' }, [
    h('h1', 'Vue detail'),
    status.value === 'loading' ? h('p', { role: 'status', 'aria-busy': 'true' }, 'Loading') : null,
    status.value === 'error' ? h('p', { role: 'alert' }, error.value) : null,
    detail.value && status.value === 'done' ? h('h2', { 'data-detail-id': detail.value.id }, detail.value.title) : null,
  ]);
}});
`;
const FORM_HARNESS = `import { defineComponent, h, ref } from 'vue';
import App from './App.js';
export default defineComponent({ setup() {
  const record = ref({ id: 'alpha', name: 'Alice', email: 'alice@example.test' });
  const epoch = ref(0); const mounted = ref(true); const count = ref(0);
  window.__vueFormOracle = { emits: 0, payloads: [], get current() { return record.value; } };
  const commit = (value) => {
    window.__vueFormOracle.emits++;
    window.__vueFormOracle.payloads.push(structuredClone(value));
    count.value++; record.value = { ...value };
  };
  return () => h('main', { class: 'shell' }, [
    h('nav', { class: 'toolbar' }, [
      h('button', { id: 'refresh-record', onClick: () => record.value = { ...record.value, name: record.value.name + ' server' } }, 'External refresh'),
      h('button', { id: 'switch-beta', onClick: () => record.value = { id: 'beta', name: 'Bob', email: 'bob@example.test' } }, 'Switch beta'),
      h('button', { id: 'switch-alpha', onClick: () => record.value = { id: 'alpha', name: 'Alice', email: 'alice@example.test' } }, 'Switch alpha'),
      h('button', { id: 'reset-record', onClick: () => epoch.value++ }, 'External reset'),
      h('button', { id: 'unmount', onClick: () => mounted.value = false }, 'Unmount'),
      h('button', { id: 'remount', onClick: () => mounted.value = true }, 'Remount'),
    ]),
    h('p', { 'data-parent-record': '' }, record.value.id + ':' + record.value.name),
    h('p', { 'data-emit-count': '' }, 'Emits ' + count.value),
    mounted.value ? h(App, { record: record.value, resetEpoch: epoch.value, 'onUpdate:record': commit }) : h('p', { 'data-unmounted': '' }, 'Unmounted'),
  ]);
}});
`;
const FORM_STARTER = `import { defineComponent, h, reactive, ref, watch } from 'vue';
export default defineComponent({
  props: { record: Object, resetEpoch: Number }, emits: ['update:record'],
  setup(props, { emit }) {
    const draft = reactive({ ...props.record }); const error = ref('');
    watch(() => props.record, (next) => Object.assign(draft, next), { deep: true });
    watch(draft, () => emit('update:record', { ...draft }), { deep: true });
    const save = () => { if (!draft.name.trim()) error.value = 'Name required'; else emit('update:record', { ...draft }); };
    const cancel = () => Object.assign(draft, props.record);
    return () => h('section', { class: 'card', 'data-vue-form': '' }, [
      h('h1', 'Edit ' + props.record.id),
      h('label', { for: 'name' }, ['Name ', h('input', { id: 'name', value: draft.name, onInput: e => draft.name = e.target.value })]),
      h('label', { for: 'email' }, ['Email ', h('input', { id: 'email', value: draft.email, onInput: e => draft.email = e.target.value })]),
      error.value ? h('p', { role: 'alert' }, error.value) : null,
      h('button', { id: 'save', onClick: save }, 'Save'), h('button', { id: 'cancel', onClick: cancel }, 'Cancel'),
    ]);
  },
});
`;

function fixed(number: 1 | 2): Record<string, string> {
  return {
    'package.json': PACKAGE, 'index.html': HTML, 'style.css': STYLE,
    'src/main.js': MAIN,
    'src/Harness.js': number === 1 ? ROUTE_HARNESS : FORM_HARNESS,
    ...(number === 1 ? { 'src/source.js': SOURCE } : {}),
  };
}

export const VUE_BROWSER_EVAL_CONSTANTS = { version: VUE_VERSION } as const;

function materialize(root: string, number: 1 | 2): void {
  if (readinessBlockers.length) throw new Error(readinessBlockers.join('; '));
  for (const [file, content] of Object.entries(fixed(number))) writeFixtureFile(root, file, content);
  writeFixtureFile(root, 'src/App.js', number === 1 ? ROUTE_STARTER : FORM_STARTER);
  writeFixtureFile(root, 'README.md', `# Vue ${VUE_VERSION} real browser exercise\n\n` +
    (number === 1
      ? 'Repair the watcher race, abort and unmount cleanup, URL back/forward state, keyboard search, loading/error/empty, retry focus, mobile layout and durable preference in src/App.js. Services and harness are fixed.\n'
      : 'Repair prop/draft ownership, dirty same-ID refresh, entity ID reuse, explicit reset, validation and focus, cancel, and single update emit in src/App.js. Harness and parent record are fixed.\n') +
    'Run `bun install --offline --ignore-scripts`, then `bun run build` with the pinned Vue runtime. Provide verification/result.json identifying Vue, frontend-engineering, the relevant adjacent skill, recovery evidence and real browser checks. The scorer independently compiles and drives Chromium.\n');
  writeFixtureFile(root, 'verification/result.json', '{"status":"TODO"}\n');
}

export const VUE_BROWSER_SKILL_EVAL_MATERIALIZERS: readonly SkillEvalFixtureMaterializer[] = [
  { id: 'vue-engineering/route-real-vue-chromium@2', realRuntime: true,
    readinessBlockers: readinessBlockers.length ? readinessBlockers : undefined,
    matches: (scenario) => scenario.id === ROUTE, materialize: (root) => materialize(root, 1) },
  { id: 'vue-engineering/draft-real-vue-chromium@2', realRuntime: true,
    readinessBlockers: readinessBlockers.length ? readinessBlockers : undefined,
    matches: (scenario) => scenario.id === FORM, materialize: (root) => materialize(root, 2) },
];

function candidateEvidence(root: string, number: 1 | 2): boolean {
  const json = readJsonArtifact<Record<string, unknown>>(root, 'verification/result.json');
  return json?.status === 'verified' && json?.vueVersion === VUE_VERSION &&
    json?.broaderSkill === 'frontend-engineering' &&
    json?.nearNeighbor === (number === 1 ? 'angular-engineering' : 'react-engineering') &&
    typeof json?.recovery === 'string' && json.recovery.length > 20;
}

async function runtime(root: string, number: 1 | 2, checks: RuntimeCheck[]): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), 'kory-vue-real-chromium-'));
  try {
    for (const [file, content] of Object.entries(fixed(number))) writeFixtureFile(tmp, file, content);
    const candidate = join(root, 'src/App.js');
    const stat = lstatSync(candidate);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 300_000)
      throw new Error('Candidate must be a bounded regular src/App.js file');
    writeFixtureFile(tmp, 'src/App.js', readFileSync(candidate, 'utf8'));
    await installPinnedOffline(tmp);
    const build = await Bun.build({
      entrypoints: [join(tmp, 'src/main.js')], target: 'browser', outdir: join(tmp, 'dist'),
    });
    if (!build.success) throw new Error('Vue production bundle: ' + build.logs.map((x) => x.message).join('; '));
    const entry = build.outputs.find((item) => item.kind === 'entry-point');
    if (!entry) throw new Error('Vue bundle missing entry');
    writeFileSync(join(tmp, 'index.html'), HTML.replace('/main.js', '/dist/' + basename(entry.path)));
    const server = createServer((request, response) => {
      const pathname = new URL(request.url || '/', 'http://127.0.0.1').pathname;
      const path = resolve(tmp, '.' + (pathname === '/' ? '/index.html' : pathname));
      if (!isContainedBy(tmp, path) || !existsSync(path) || !lstatSync(path).isFile()) {
        response.writeHead(404).end(); return;
      }
      response.writeHead(200, { 'Content-Type': extname(path) === '.js' ? 'text/javascript' : extname(path) === '.css' ? 'text/css' : 'text/html', 'Cache-Control': 'no-store' });
      response.end(readFileSync(path));
    });
    await new Promise<void>((ok, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', ok); });
    try {
      const bound = server.address();
      if (!bound || typeof bound === 'string') throw new Error('Vue server missing port');
      await withRealChromium(async (browser) => {
        const context = await browser.newContext({ viewport: { width: 820, height: 700 } });
        try {
          const page = await context.newPage();
          page.setDefaultTimeout(3_000);
          const errors: string[] = [];
          page.on('pageerror', (err) => errors.push(err.message));
          await page.goto(`http://127.0.0.1:${bound.port}/`, { waitUntil: 'load' });
          if (number === 1) await exerciseRoute(page, checks);
          else await exerciseForm(page, checks);
          recordCheck(checks, 'Chromium Vue mount without uncaught errors', !errors.length,
            errors.join(' | ') || `Vue ${VUE_VERSION}; Chromium ${browser.version()}`);
        } finally { await context.close(); }
      });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((ok) => server.close(() => ok()));
    }
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

async function exerciseRoute(page: Page, checks: RuntimeCheck[]): Promise<void> {
  await tryCheck(checks, 'initial Vue async loading state', async () => {
    await page.locator('[aria-busy="true"]').waitFor(); return [true, 'Vue watcher pending request rendered'];
  });
  await tryCheck(checks, 'out-of-order watcher cleanup and late response', async () => {
    await page.locator('#route-fast').click();
    await page.locator('[data-detail-id="fast"]').waitFor();
    await page.waitForTimeout(510);
    const source = await page.evaluate(() => (window as any).__vueSource);
    const ids = await page.locator('[data-detail-id]').evaluateAll((nodes) => nodes.map((n) => n.getAttribute('data-detail-id')));
    return [ids.join(',') === 'fast' && source.aborted > 0 && source.lateAfterAbort > 0 && source.active === 0,
      `visible=${ids}; source=${JSON.stringify(source)}`];
  });
  await tryCheck(checks, 'real history back and forward sync reactive prop', async () => {
    await page.goBack(); await page.locator('[data-detail-id="slow"]').waitFor();
    await page.goForward(); await page.locator('[data-detail-id="fast"]').waitFor();
    return [new URL(page.url()).searchParams.get('id') === 'fast', page.url()];
  });
  await tryCheck(checks, 'keyboard URL route and focus', async () => {
    const input = page.locator('#detail-input');
    await input.fill('keyboard'); await input.press('Enter');
    await page.locator('[data-detail-id="keyboard"]').waitFor();
    const focus = await input.evaluate((el) => document.activeElement === el);
    return [focus && new URL(page.url()).searchParams.get('id') === 'keyboard', `focus=${focus} URL=${page.url()}`];
  });
  await tryCheck(checks, 'error, retry, and focus recovery', async () => {
    await page.locator('#route-error').click();
    await page.locator('[role="alert"]').waitFor();
    const retry = page.locator('#retry'); await retry.waitFor();
    const errorFocus = await retry.evaluate((el) => document.activeElement === el);
    await retry.click(); await page.locator('[data-detail-id="error"]').waitFor();
    const restored = await page.locator('[data-detail-id="error"]').evaluate((el) => document.activeElement === el);
    const source = await page.evaluate(() => (window as any).__vueSource);
    return [errorFocus && restored && source.attempts.error >= 2, `retry=${errorFocus} heading=${restored} attempts=${source.attempts.error}`];
  });
  await tryCheck(checks, 'empty result and narrow viewport', async () => {
    await page.locator('#route-empty').click();
    await page.locator('[data-empty]').waitFor();
    await page.setViewportSize({ width: 390, height: 740 });
    const sizes = await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
    return [sizes[0] <= sizes[1], `viewport=${sizes.join('/')}`];
  });
  await tryCheck(checks, 'unmount, aborted watcher and durable local preference', async () => {
    await page.locator('#favorite').click();
    await page.locator('#route-slow').click();
    await page.locator('#route-unmount').click();
    await page.locator('[data-unmounted]').waitFor();
    await page.waitForTimeout(510);
    const source = await page.evaluate(() => (window as any).__vueSource);
    await page.locator('#route-remount').click();
    await page.locator('#favorite[aria-pressed="true"]').waitFor();
    await page.reload();
    await page.locator('#favorite[aria-pressed="true"]').waitFor();
    return [source.active === 0 && source.aborted >= 2 && source.lateAfterAbort >= 2,
      `abort=${source.aborted} late=${source.lateAfterAbort} active=${source.active}`];
  });
}

async function exerciseForm(page: Page, checks: RuntimeCheck[]): Promise<void> {
  await tryCheck(checks, 'real Vue parent and editable child mounted', async () => {
    await page.locator('#name').waitFor();
    const name = await page.locator('#name').inputValue();
    return [name === 'Alice', `rendered=${name}`];
  });
  await tryCheck(checks, 'draft writes do not emit or mutate object prop', async () => {
    await page.locator('#name').fill('Local unsaved');
    await page.locator('#email').fill('new@example.test');
    const oracle = await page.evaluate(() => ({ emits: (window as any).__vueFormOracle.emits, parent: (window as any).__vueFormOracle.current }));
    return [oracle.emits === 0 && oracle.parent.name === 'Alice', JSON.stringify(oracle)];
  });
  await tryCheck(checks, 'same-ID prop refresh preserves dirty draft and focus', async () => {
    const field = page.locator('#name');
    await field.focus();
    await page.locator('#refresh-record').evaluate((el) => (el as HTMLButtonElement).click());
    const draft = await field.inputValue();
    const focused = await field.evaluate((el) => document.activeElement === el);
    const oracle = await page.evaluate(() => ({ emits: (window as any).__vueFormOracle.emits, parent: (window as any).__vueFormOracle.current }));
    return [draft === 'Local unsaved' && focused && oracle.emits === 0 && oracle.parent.name === 'Alice server',
      `draft=${draft}, focused=${focused}, ${JSON.stringify(oracle)}`];
  });
  await tryCheck(checks, 'entity-ID reuse resets draft without feedback emits', async () => {
    await page.locator('#switch-beta').click();
    const name = await page.locator('#name').inputValue();
    const email = await page.locator('#email').inputValue();
    const emits = await page.evaluate(() => (window as any).__vueFormOracle.emits);
    return [name === 'Bob' && email === 'bob@example.test' && emits === 0, `name=${name}; email=${email}; emits=${emits}`];
  });
  await tryCheck(checks, 'validation blocks invalid submit and focuses input', async () => {
    await page.locator('#name').fill('');
    await page.locator('#save').click();
    await page.locator('[role="alert"]').waitFor();
    const focus = await page.locator('#name').evaluate((el) => document.activeElement === el);
    const emits = await page.evaluate(() => (window as any).__vueFormOracle.emits);
    return [focus && emits === 0, `focused=${focus}; emits=${emits}`];
  });
  await tryCheck(checks, 'explicit external reset and cancel discard local draft', async () => {
    await page.locator('#name').fill('dirty');
    await page.locator('#reset-record').click();
    const reset = await page.locator('#name').inputValue();
    await page.locator('#name').fill('discard me'); await page.locator('#cancel').click();
    const canceled = await page.locator('#name').inputValue();
    return [reset === 'Bob' && canceled === 'Bob', `reset=${reset}; canceled=${canceled}`];
  });
  await tryCheck(checks, 'single commit emit with owned payload and no watcher feedback', async () => {
    await page.locator('#name').fill('Bob edited'); await page.locator('#save').click();
    await page.locator('[data-parent-record]').getByText('beta:Bob edited').waitFor();
    await page.waitForTimeout(100);
    const oracle = await page.evaluate(() => ({ emits: (window as any).__vueFormOracle.emits, payloads: (window as any).__vueFormOracle.payloads }));
    return [oracle.emits === 1 && oracle.payloads[0]?.id === 'beta' && oracle.payloads[0]?.name === 'Bob edited', JSON.stringify(oracle)];
  });
  await tryCheck(checks, 'mobile and unmount/remount lifecycle', async () => {
    await page.setViewportSize({ width: 390, height: 700 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    await page.locator('#unmount').click(); await page.locator('[data-unmounted]').waitFor();
    await page.locator('#remount').click(); await page.locator('#name').waitFor();
    return [!overflow && (await page.locator('#name').inputValue()) === 'Bob edited', `overflow=${overflow}`];
  });
}

async function score(root: string, number: 1 | 2) {
  const checks: RuntimeCheck[] = [];
  if (readinessBlockers.length) return finishChecks(readinessBlockers.map((reason) => ({ name: 'runtime readiness', detail: reason, passed: false, browser: false })));
  const immutable = fixedFilesUnmodified(root, fixed(number));
  const safe = safeCandidateTree(root, ['src']);
  recordCheck(checks, 'unaltered fixed harness and bounded regular candidate source', immutable && safe,
    `fixed files=${immutable}; candidate source safe=${safe}`, false);
  if (!immutable || !safe) return finishChecks(checks, true);
  recordCheck(checks, 'reported framework boundary and recovery evidence', candidateEvidence(root, number),
    `Vue ${VUE_VERSION} source evidence`, false);
  try {
    await runtime(root, number, checks);
  } catch (error) {
    recordCheck(checks, 'production Vue bundle/server/browser execution', false,
      error instanceof Error ? error.message.slice(0, 650) : error);
  }
  return finishChecks(checks);
}

export const VUE_BROWSER_SKILL_EVAL_SCORERS: readonly SkillEvalDeterministicScorer[] = [
  { id: 'vue-engineering/route-real-vue-chromium-scorer@2', scenarioIds: [ROUTE],
    score: ({ workingDirectory }) => score(workingDirectory, 1) },
  { id: 'vue-engineering/draft-real-vue-chromium-scorer@2', scenarioIds: [FORM],
    score: ({ workingDirectory }) => score(workingDirectory, 2) },
];
