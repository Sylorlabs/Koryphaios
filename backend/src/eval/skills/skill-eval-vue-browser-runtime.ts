import { createServer } from 'node:http';
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, extname, join, resolve } from 'node:path';
import { type Page } from 'playwright';
import { isContainedBy } from '../../runtime/platform';
import type {
  SkillEvalDeterministicScorer,
  SkillEvalFixtureMaterializer,
} from './skill-eval-execution';
import { readFixtureText, readJsonArtifact, writeFixtureFile } from './skill-eval-fixture-helpers';
import {
  chromiumBlockers,
  finishChecks,
  fixedFilesUnmodified,
  installPinnedOffline,
  pinnedPackageBlockers,
  recordCheck,
  safeCandidateTree,
  tryCheck,
  withRealChromium,
  type RuntimeCheck,
} from './skill-eval-real-web-runtime';

/**
 * Independent, evaluator-owned Vue 3 + Chromium sidecar. Neither an agent's
 * verification JSON nor a source inspection can substitute for the real render.
 * Importing this module does not register it or write an evaluation ledger.
 * The registry owner can explicitly select these exports after qualification.
 *
 * The first fixture uses actual browser History API navigation with Vue-owned
 * route state; it does not assert coverage of the separate vue-router package.
 */
const ROUTE_SCENARIO = 'vue-engineering-full-task-1-individual';
const DRAFT_SCENARIO = 'vue-engineering-full-task-2-individual';
const VUE_VERSION = '3.5.30';

export const VUE_NATIVE_BROWSER_EVAL_CONSTANTS = {
  vueVersion: VUE_VERSION,
  scenarios: [ROUTE_SCENARIO, DRAFT_SCENARIO],
  router: 'Vue component route state + browser History API (vue-router not installed)',
} as const;

export function vueNativeBrowserReadiness(): string[] {
  return [...pinnedPackageBlockers([['vue', VUE_VERSION]]), ...chromiumBlockers()];
}

const PACKAGE = `${JSON.stringify(
  {
    name: 'kory-native-vue3-browser-eval',
    private: true,
    type: 'module',
    dependencies: { vue: VUE_VERSION },
    scripts: { build: 'bun build src/main.js --target browser --outdir dist' },
  },
  null,
  2,
)}\n`;
const INDEX = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Vue browser evaluation</title><link rel="stylesheet" href="/theme.css"></head><body><div id="app"></div><script type="module" src="/main.js"></script></body></html>\n`;
const STYLE = `*{box-sizing:border-box}body{margin:0;background:#f0f4fb;color:#1c2737;font:16px/1.45 system-ui,sans-serif}.shell{margin:16px auto;padding:12px;max-width:760px;min-width:0}.panel{background:white;border:1px solid #9fb0c9;border-radius:8px;padding:16px;min-width:0}.nav{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px}h1{font-size:1.35rem}button,input{font:inherit;max-width:100%}button{background:white;border:1px solid #8398b7;padding:6px 10px;border-radius:5px;cursor:pointer}input{min-width:0;padding:7px;border:1px solid #8398b7;border-radius:5px}button:focus-visible,input:focus-visible,[tabindex]:focus-visible{outline:3px solid #376ac8;outline-offset:2px}.field{display:grid;gap:5px;max-width:450px;margin:10px 0}.status{overflow-wrap:anywhere}@media(max-width:400px){.shell{padding:6px}.panel{padding:8px}.nav{gap:3px}}\n`;
const MAIN = `import { createApp, version } from 'vue';
import Harness from './Harness.js';
window.__vueNativeVersion = version;
createApp(Harness).mount('#app');
`;

// A slow request deliberately resolves after abort. An AbortController alone is
// insufficient; the component must also reject an obsolete completion.
const ROUTE_SERVICE = `const state = { active: 0, started: 0, aborted: 0, lateAfterAbort: 0, attempts: {} };
window.__vueNativeSource = state;
export function fetchDetail(id, { signal } = {}) {
  const key = String(id);
  const attempt = (state.attempts[key] || 0) + 1;
  state.attempts[key] = attempt;
  state.started++;
  state.active++;
  return new Promise((resolve, reject) => {
    let settled = false;
    let aborted = false;
    const slow = key === 'slow' || key === 'slow-unmount';
    const complete = () => {
      if (settled) return false;
      settled = true;
      state.active--;
      signal?.removeEventListener('abort', onAbort);
      return true;
    };
    const onAbort = () => {
      if (settled || aborted) return;
      aborted = true;
      state.aborted++;
      if (!slow && complete()) { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); }
    };
    const timer = setTimeout(() => {
      if (!complete()) return;
      if (aborted) state.lateAfterAbort++;
      if (key === 'error' && attempt === 1) reject(new Error('Temporary detail error'));
      else resolve(key === 'empty' ? null : { id: key, title: 'Detail ' + key });
    }, slow ? 340 : 45);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}
`;

// The harness is fixed. In particular, the agent cannot invent the source
// counts or the real component-scope effect counts observed in the browser.
const ROUTE_HARNESS = `import { defineComponent, h, onMounted, onUnmounted, ref } from 'vue';
import App from './App.js';
const currentRoute = () => decodeURIComponent(location.pathname.split('/').filter(Boolean).at(-1) || 'slow');
export default defineComponent({ setup() {
  const route = ref(currentRoute());
  const visible = ref(true);
  const child = ref(null);
  let lastEffectScope = null;
  const proof = {
    navigationEvents: 0, routeListeners: 0, mounts: 0, unmounts: 0,
    get watcherEffects() {
      lastEffectScope = child.value?.$?.scope ?? lastEffectScope;
      return lastEffectScope?.effects?.filter(effect => (effect.flags & 1) !== 0).length ?? 0;
    },
    get route() { return route.value; },
  };
  window.__vueNativeLifecycle = proof;
  const sync = () => { proof.navigationEvents++; route.value = currentRoute(); };
  const navigate = (id) => { history.pushState({}, '', '/detail/' + encodeURIComponent(id)); sync(); };
  onMounted(() => { addEventListener('popstate', sync); proof.routeListeners++; });
  onUnmounted(() => { removeEventListener('popstate', sync); proof.routeListeners--; });
  return () => h('main', { class: 'shell' }, [
    h('nav', { class: 'nav', 'aria-label': 'Detail navigation' }, [
      ...['slow','fast','error','empty'].map(id => h('button', { type: 'button', id: 'nav-' + id, onClick: () => navigate(id) }, id)),
      h('button', { type: 'button', id: 'hide', onClick: () => { visible.value = false; } }, 'Unmount'),
      h('button', { type: 'button', id: 'show', onClick: () => { visible.value = true; } }, 'Remount'),
    ]),
    visible.value ? h(App, { id: route.value, ref: child,
      onVnodeMounted: () => { proof.mounts++; },
      onVnodeUnmounted: () => { proof.unmounts++; },
    }) : h('p', { 'data-unmounted': '' }, 'Detail unmounted'),
  ]);
}});
`;

// Plausible but deliberately wrong: stale responses render, no abort/cleanup,
// no error retry, and no keyboard navigation or focus recovery.
const ROUTE_STARTER = `import { defineComponent, h, ref, watch } from 'vue';
import { fetchDetail } from './service.js';
export default defineComponent({ props: { id: String }, setup(props) {
  const result = ref(null), status = ref('loading'), message = ref('');
  watch(() => props.id, async id => {
    status.value = 'loading';
    try { result.value = await fetchDetail(id); status.value = 'ready'; }
    catch (error) { message.value = error.message; status.value = 'error'; }
  }, { immediate: true });
  return () => h('section', { class: 'panel', 'data-route-component': '' }, [
    h('h1', 'Detail view'),
    status.value === 'loading' ? h('p', { role: 'status', 'aria-busy': 'true' }, 'Loading') : null,
    status.value === 'error' ? h('p', { role: 'alert' }, message.value) : null,
    result.value ? h('h2', { 'data-detail-id': result.value.id }, result.value.title) : null,
  ]);
}});
`;

const DRAFT_HARNESS = `import { defineComponent, h, ref } from 'vue';
import App from './App.js';
export default defineComponent({ setup() {
  const record = ref({ id: 'alpha', name: 'Alice', email: 'alice@example.test' });
  const resetEpoch = ref(0);
  const show = ref(true);
  const child = ref(null);
  let lastEffectScope = null;
  const ledger = { emits: 0, payloads: [], mounts: 0, unmounts: 0,
    get record() { return JSON.parse(JSON.stringify(record.value)); },
    get watcherEffects() {
      lastEffectScope = child.value?.$?.scope ?? lastEffectScope;
      return lastEffectScope?.effects?.filter(effect => (effect.flags & 1) !== 0).length ?? 0;
    },
  };
  window.__vueNativeDraft = ledger;
  const commit = next => {
    ledger.emits++;
    ledger.payloads.push(structuredClone(next));
    record.value = structuredClone(next);
  };
  return () => h('main', { class: 'shell' }, [
    h('nav', { class: 'nav', 'aria-label': 'Parent record controls' }, [
      h('button', { type: 'button', id: 'external-refresh', onClick: () => { record.value = { ...record.value, name: record.value.name + ' server' }; } }, 'Refresh same ID'),
      h('button', { type: 'button', id: 'switch-beta', onClick: () => { record.value = { id: 'beta', name: 'Bob', email: 'bob@example.test' }; } }, 'Switch ID'),
      h('button', { type: 'button', id: 'switch-alpha', onClick: () => { record.value = { id: 'alpha', name: 'Alice', email: 'alice@example.test' }; } }, 'Reuse ID'),
      h('button', { type: 'button', id: 'external-reset', onClick: () => { resetEpoch.value++; } }, 'External reset'),
      h('button', { type: 'button', id: 'hide', onClick: () => { show.value = false; } }, 'Unmount'),
      h('button', { type: 'button', id: 'show', onClick: () => { show.value = true; } }, 'Remount'),
    ]),
    h('p', { 'data-parent': '' }, record.value.id + ':' + record.value.name),
    h('p', { 'data-emits': '' }, String(ledger.emits)),
    show.value ? h(App, { record: record.value, resetEpoch: resetEpoch.value, ref: child,
      'onUpdate:record': commit,
      onVnodeMounted: () => { ledger.mounts++; },
      onVnodeUnmounted: () => { ledger.unmounts++; },
    }) : h('p', { 'data-unmounted': '' }, 'Form unmounted'),
  ]);
}});
`;

// Two deep watchers produce a feedback loop and lose dirty same-ID drafts.
const DRAFT_STARTER = `import { defineComponent, h, reactive, ref, watch } from 'vue';
export default defineComponent({ props: { record: Object, resetEpoch: Number }, emits: ['update:record'], setup(props, { emit }) {
  const draft = reactive({ ...props.record }), error = ref('');
  watch(() => props.record, value => Object.assign(draft, value), { deep: true });
  watch(draft, () => emit('update:record', { ...draft }), { deep: true });
  const save = () => {
    if (!draft.name.trim()) error.value = 'Name required';
    else emit('update:record', { ...draft });
  };
  return () => h('section', { class: 'panel', 'data-form-component': '' }, [
    h('h1', 'Edit ' + props.record.id),
    h('label', { class: 'field', for: 'name' }, ['Name', h('input', { id: 'name', value: draft.name, onInput: e => { draft.name = e.target.value; } })]),
    h('label', { class: 'field', for: 'email' }, ['Email', h('input', { id: 'email', value: draft.email, onInput: e => { draft.email = e.target.value; } })]),
    error.value ? h('p', { role: 'alert' }, error.value) : null,
    h('button', { type: 'button', id: 'save', onClick: save }, 'Save'),
    h('button', { type: 'button', id: 'cancel', onClick: () => Object.assign(draft, props.record) }, 'Cancel'),
  ]);
}});
`;

type Scenario = 1 | 2;

function fixedFiles(number: Scenario): Record<string, string> {
  return {
    'package.json': PACKAGE,
    'index.html': INDEX,
    'theme.css': STYLE,
    'src/main.js': MAIN,
    'src/Harness.js': number === 1 ? ROUTE_HARNESS : DRAFT_HARNESS,
    ...(number === 1 ? { 'src/service.js': ROUTE_SERVICE } : {}),
  };
}

function materialize(root: string, number: Scenario): void {
  const blockers = vueNativeBrowserReadiness();
  if (blockers.length)
    throw new Error(`Native Vue 3 browser fixture unavailable: ${blockers.join('; ')}`);
  writeVueBrowserFixtureContract(root, number);
}

/** Contract-only authoring for integrity checks; no runtime availability or browser evidence. */
export function writeVueBrowserFixtureContract(root: string, number: Scenario): void {
  for (const [path, content] of Object.entries(fixedFiles(number)))
    writeFixtureFile(root, path, content);
  writeFixtureFile(root, 'src/App.js', number === 1 ? ROUTE_STARTER : DRAFT_STARTER);
  writeFixtureFile(root, 'verification/result.json', '{"status":"not-run"}\n');
  writeFixtureFile(
    root,
    'README.md',
    `# Native Vue ${VUE_VERSION} browser task ${number}\n\n` +
      (number === 1
        ? 'Repair the route watcher, request abortion, stale completion, unmount, browser history, keyboard navigation, focus recovery, empty/error/retry, and persisted preference in src/App.js.\n' +
          'Provide these stable, accessible interfaces so browser automation can exercise the finished behavior:\n' +
          '- Show an [aria-busy="true"] loading status inside [data-route-component] during the initial request.\n' +
          '- Provide #detail-input; Enter navigates with browser history to /detail/<entered-id>, updates the rendered route, and keeps the input focused.\n' +
          '- For failed loads focus a #retry button; after a successful retry transfer focus to the heading marked [data-detail-id].\n' +
          '- Show [data-empty] for a successful empty result.\n' +
          '- Provide a #favorite toggle with aria-pressed that persists the selected state across unmount, remount, and page reload.\n' +
          'Preserve the fixed harness, real browser history, request lifecycle, and cleanup behavior; the service intentionally delivers late completions after abort.\n'
        : 'Repair child draft ownership, same-ID refresh, entity-ID reuse, explicit reset, cancellation, validation/focus, and exactly one commit emit in src/App.js.\n') +
      'The harness and service are evaluator-owned. Do not modify them. Run `bun install --offline --ignore-scripts` and `bun run build` with the pinned Vue runtime. Provide verification/result.json with status=verified, vueVersion, broaderSkill=frontend-engineering, nearNeighbor (angular-engineering for task 1, react-engineering for task 2), and a specific recovery explanation. The independent scorer checks actual Chromium behavior. Client-side routing here uses browser history, not the vue-router library; SSR/hydration is not part of this fixture.\n',
  );
}

export const VUE_NATIVE_BROWSER_SKILL_EVAL_MATERIALIZERS: readonly SkillEvalFixtureMaterializer[] =
  [
    {
      id: 'vue-engineering/native-vue-history-browser@2',
      realRuntime: true,
      get readinessBlockers() {
        return vueNativeBrowserReadiness();
      },
      matches: (scenario) => scenario.id === ROUTE_SCENARIO,
      materialize: (root) => materialize(root, 1),
    },
    {
      id: 'vue-engineering/native-vue-draft-browser@1',
      realRuntime: true,
      get readinessBlockers() {
        return vueNativeBrowserReadiness();
      },
      matches: (scenario) => scenario.id === DRAFT_SCENARIO,
      materialize: (root) => materialize(root, 2),
    },
  ];

function claimedEvidence(root: string, number: Scenario): boolean {
  const candidate = readJsonArtifact<Record<string, unknown>>(root, 'verification/result.json');
  return (
    candidate?.status === 'verified' &&
    candidate.vueVersion === VUE_VERSION &&
    candidate.broaderSkill === 'frontend-engineering' &&
    candidate.nearNeighbor === (number === 1 ? 'angular-engineering' : 'react-engineering') &&
    typeof candidate.recovery === 'string' &&
    candidate.recovery.trim().length >= 32
  );
}

async function exerciseRoute(page: Page, checks: RuntimeCheck[]): Promise<void> {
  await tryCheck(checks, 'Vue version, initial loading and active watcher', async () => {
    await page.locator('[data-route-component] [aria-busy="true"]').waitFor();
    const metrics = await page.evaluate(() => ({
      vue: (window as any).__vueNativeVersion,
      watcherEffects: (window as any).__vueNativeLifecycle.watcherEffects,
      active: (window as any).__vueNativeSource.active,
    }));
    return [
      metrics.vue === VUE_VERSION && metrics.watcherEffects >= 1 && metrics.active === 1,
      JSON.stringify(metrics),
    ];
  });
  await tryCheck(checks, 'out-of-order response cannot overwrite latest route', async () => {
    await page.locator('#nav-fast').click();
    await page.locator('[data-detail-id="fast"]').waitFor();
    await page.waitForTimeout(430);
    const value = await page
      .locator('[data-detail-id]')
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-detail-id')));
    const source = await page.evaluate(() => (window as any).__vueNativeSource);
    return [
      value.join(',') === 'fast' &&
        source.active === 0 &&
        source.aborted >= 1 &&
        source.lateAfterAbort >= 1,
      `visible=${value.join(',')}; source=${JSON.stringify(source)}`,
    ];
  });
  await tryCheck(checks, 'history back/forward updates rendered Vue route', async () => {
    await page.goBack();
    await page.locator('[data-detail-id="slow"]').waitFor();
    await page.goForward();
    await page.locator('[data-detail-id="fast"]').waitFor();
    const route = await page.evaluate(() => (window as any).__vueNativeLifecycle.route);
    return [
      route === 'fast' && new URL(page.url()).pathname === '/detail/fast',
      `route=${route}; url=${page.url()}`,
    ];
  });
  await tryCheck(checks, 'keyboard route navigation and input focus', async () => {
    const input = page.locator('#detail-input');
    await input.fill('keyboard');
    await input.press('Enter');
    await page.locator('[data-detail-id="keyboard"]').waitFor();
    const focused = await input.evaluate((element) => document.activeElement === element);
    return [
      focused && new URL(page.url()).pathname === '/detail/keyboard',
      `focused=${focused}; url=${page.url()}`,
    ];
  });
  await tryCheck(checks, 'error retry recovers and restores keyboard focus', async () => {
    await page.locator('#nav-error').click();
    const retry = page.locator('#retry');
    await retry.waitFor();
    const focused = await retry.evaluate((element) => document.activeElement === element);
    await retry.click();
    const result = page.locator('[data-detail-id="error"]');
    await result.waitFor();
    const restored = await result.evaluate((element) => document.activeElement === element);
    const attempts = await page.evaluate(() => (window as any).__vueNativeSource.attempts.error);
    return [
      focused && restored && attempts >= 2,
      `retryFocused=${focused}; detailFocused=${restored}; attempts=${attempts}`,
    ];
  });
  await tryCheck(checks, 'empty state and mobile viewport', async () => {
    await page.locator('#nav-empty').click();
    await page.locator('[data-empty]').waitFor();
    await page.setViewportSize({ width: 390, height: 710 });
    const dimensions = await page.evaluate(() => [
      document.documentElement.scrollWidth,
      innerWidth,
    ]);
    return [dimensions[0] <= dimensions[1], `document/viewport=${dimensions.join('/')}`];
  });
  await tryCheck(
    checks,
    'unmount disposes watchers and aborted work, remount retains preference',
    async () => {
      await page.locator('#favorite').click();
      await page.locator('#nav-slow').click();
      await page.waitForFunction(() => (window as any).__vueNativeSource.active > 0);
      await page.locator('#hide').click();
      await page.locator('[data-unmounted]').waitFor();
      const watchers = await page.evaluate(
        () => (window as any).__vueNativeLifecycle.watcherEffects,
      );
      await page.waitForTimeout(420);
      const source = await page.evaluate(() => (window as any).__vueNativeSource);
      const lifecycle = await page.evaluate(() => ({
        mounts: (window as any).__vueNativeLifecycle.mounts,
        unmounts: (window as any).__vueNativeLifecycle.unmounts,
        routeListeners: (window as any).__vueNativeLifecycle.routeListeners,
      }));
      await page.locator('#show').click();
      await page.locator('#favorite[aria-pressed="true"]').waitFor();
      await page.reload();
      await page.locator('#favorite[aria-pressed="true"]').waitFor();
      return [
        watchers === 0 &&
          source.active === 0 &&
          source.aborted >= 2 &&
          source.lateAfterAbort >= 2 &&
          lifecycle.mounts >= 1 &&
          lifecycle.unmounts >= 1 &&
          lifecycle.routeListeners === 1,
        `watchers=${watchers}; lifecycle=${JSON.stringify(lifecycle)}; service=${JSON.stringify(source)}`,
      ];
    },
  );
}

async function exerciseDraft(page: Page, checks: RuntimeCheck[]): Promise<void> {
  await tryCheck(checks, 'real Vue parent/child and live component watcher', async () => {
    await page.locator('#name').waitFor();
    const metrics = await page.evaluate(() => ({
      vue: (window as any).__vueNativeVersion,
      watcherEffects: (window as any).__vueNativeDraft.watcherEffects,
    }));
    return [
      metrics.vue === VUE_VERSION &&
        metrics.watcherEffects >= 1 &&
        (await page.locator('#name').inputValue()) === 'Alice',
      JSON.stringify(metrics),
    ];
  });
  await tryCheck(checks, 'dirty child draft does not mutate props or emit', async () => {
    await page.locator('#name').fill('Unsaved Alice');
    await page.locator('#email').fill('draft@example.test');
    const ledger = await page.evaluate(() => (window as any).__vueNativeDraft);
    return [
      ledger.emits === 0 &&
        ledger.record.name === 'Alice' &&
        ledger.record.email === 'alice@example.test',
      JSON.stringify({ emits: ledger.emits, record: ledger.record }),
    ];
  });
  await tryCheck(checks, 'same entity refresh preserves dirty draft and focus', async () => {
    const field = page.locator('#name');
    await field.focus();
    await page.locator('#external-refresh').evaluate((el) => (el as HTMLButtonElement).click());
    const current = await field.inputValue();
    const focused = await field.evaluate((el) => document.activeElement === el);
    const ledger = await page.evaluate(() => ({
      emits: (window as any).__vueNativeDraft.emits,
      name: (window as any).__vueNativeDraft.record.name,
    }));
    return [
      current === 'Unsaved Alice' &&
        focused &&
        ledger.emits === 0 &&
        ledger.name === 'Alice server',
      JSON.stringify({ current, focused, ledger }),
    ];
  });
  await tryCheck(
    checks,
    'entity switch and ID reuse discard stale draft without emitting',
    async () => {
      await page.locator('#switch-beta').click();
      const beta = await page.locator('#name').inputValue();
      await page.locator('#name').fill('dirty Bob');
      await page.locator('#switch-alpha').click();
      const alpha = await page.locator('#name').inputValue();
      await page.locator('#switch-beta').click();
      const repeat = await page.locator('#name').inputValue();
      const count = await page.evaluate(() => (window as any).__vueNativeDraft.emits);
      return [
        beta === 'Bob' && alpha === 'Alice' && repeat === 'Bob' && count === 0,
        `beta=${beta}, alpha=${alpha}, betaReused=${repeat}, emits=${count}`,
      ];
    },
  );
  await tryCheck(checks, 'invalid commit blocks emit and focuses first invalid input', async () => {
    await page.locator('#name').fill('  ');
    await page.locator('#save').click();
    await page.locator('[role="alert"]').waitFor();
    const focused = await page.locator('#name').evaluate((el) => document.activeElement === el);
    const count = await page.evaluate(() => (window as any).__vueNativeDraft.emits);
    return [focused && count === 0, `focused=${focused}; emits=${count}`];
  });
  await tryCheck(checks, 'explicit reset and cancel recover parent-owned values', async () => {
    await page.locator('#name').fill('dirty again');
    await page.locator('#external-reset').click();
    const reset = await page.locator('#name').inputValue();
    await page.locator('#name').fill('cancel this');
    await page.locator('#cancel').click();
    const cancelled = await page.locator('#name').inputValue();
    return [
      reset === 'Bob' &&
        cancelled === 'Bob' &&
        (await page.locator('[role="alert"]').count()) === 0,
      `reset=${reset}; cancelled=${cancelled}`,
    ];
  });
  await tryCheck(checks, 'single explicit commit without watcher feedback', async () => {
    await page.locator('#name').fill('Bob saved');
    await page.locator('#save').click();
    await page.locator('[data-parent]').filter({ hasText: 'beta:Bob saved' }).waitFor();
    await page.waitForTimeout(120);
    const ledger = await page.evaluate(() => ({
      emits: (window as any).__vueNativeDraft.emits,
      payloads: (window as any).__vueNativeDraft.payloads,
      record: (window as any).__vueNativeDraft.record,
    }));
    return [
      ledger.emits === 1 &&
        ledger.payloads.length === 1 &&
        ledger.payloads[0].id === 'beta' &&
        ledger.payloads[0].name === 'Bob saved' &&
        ledger.record.name === 'Bob saved',
      JSON.stringify(ledger),
    ];
  });
  await tryCheck(
    checks,
    'unmount ends child watcher scope; responsive remount preserves parent',
    async () => {
      await page.setViewportSize({ width: 390, height: 690 });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
      await page.locator('#hide').click();
      await page.locator('[data-unmounted]').waitFor();
      const inactive = await page.evaluate(() => ({
        watcherEffects: (window as any).__vueNativeDraft.watcherEffects,
        unmounts: (window as any).__vueNativeDraft.unmounts,
      }));
      await page.locator('#show').click();
      await page.locator('#name').waitFor();
      const remounted = await page.locator('#name').inputValue();
      return [
        !overflow &&
          inactive.watcherEffects === 0 &&
          inactive.unmounts >= 1 &&
          remounted === 'Bob saved',
        `overflow=${overflow}; ${JSON.stringify(inactive)}; remounted=${remounted}`,
      ];
    },
  );
}

async function runNativeBrowser(
  root: string,
  number: Scenario,
  checks: RuntimeCheck[],
): Promise<void> {
  const sandbox = mkdtempSync(join(tmpdir(), 'kory-vue3-native-browser-'));
  try {
    for (const [path, content] of Object.entries(fixedFiles(number)))
      writeFixtureFile(sandbox, path, content);
    // Only this bounded candidate source is copied. No candidate scripts, build
    // config, node_modules, auxiliary files, or symlinks enter the runtime.
    writeFixtureFile(sandbox, 'src/App.js', readFixtureText(root, 'src/App.js'));
    await installPinnedOffline(sandbox);
    const build = await Bun.build({
      entrypoints: [join(sandbox, 'src/main.js')],
      target: 'browser',
      outdir: join(sandbox, 'dist'),
      minify: true,
    });
    if (!build.success)
      throw new Error(
        `Vue production build failed: ${build.logs.map((log) => log.message).join(' | ')}`,
      );
    const entry = build.outputs.find((output) => output.kind === 'entry-point');
    if (!entry) throw new Error('Vue production build generated no browser entry');
    writeFileSync(
      join(sandbox, 'index.html'),
      INDEX.replace('/main.js', `/dist/${basename(entry.path)}`),
    );
    recordCheck(
      checks,
      'actual pinned Vue production browser bundle',
      true,
      `Vue ${VUE_VERSION}, ${build.outputs.length} bundled outputs`,
      false,
    );

    const server = createServer((request, response) => {
      try {
        const uri = new URL(request.url || '/', 'http://127.0.0.1');
        const route =
          uri.pathname.startsWith('/detail/') || uri.pathname === '/'
            ? '/index.html'
            : uri.pathname;
        const path = resolve(sandbox, `.${route}`);
        if (!isContainedBy(sandbox, path) || !existsSync(path) || !lstatSync(path).isFile()) {
          response.writeHead(404).end('Not found');
          return;
        }
        const type =
          extname(path) === '.js'
            ? 'text/javascript'
            : extname(path) === '.css'
              ? 'text/css'
              : 'text/html';
        response.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
        response.end(readFileSync(path));
      } catch {
        response.writeHead(500).end('Fixture server error');
      }
    });
    await new Promise<void>((ok, fail) => {
      server.once('error', fail);
      server.listen(0, '127.0.0.1', ok);
    });
    try {
      const bound = server.address();
      if (!bound || typeof bound === 'string')
        throw new Error('Vue browser server has no bound port');
      await withRealChromium(async (browser) => {
        const context = await browser.newContext({ viewport: { width: 830, height: 720 } });
        try {
          const page = await context.newPage();
          page.setDefaultTimeout(2_500);
          const pageErrors: string[] = [];
          page.on('pageerror', (error) => {
            pageErrors.push(error.message);
          });
          await page.goto(`http://127.0.0.1:${bound.port}${number === 1 ? '/detail/slow' : '/'}`, {
            waitUntil: 'load',
          });
          if (number === 1) await exerciseRoute(page, checks);
          else await exerciseDraft(page, checks);
          recordCheck(
            checks,
            'Chromium Vue execution without uncaught page exceptions',
            pageErrors.length === 0,
            pageErrors.join(' | ') || `Chromium ${browser.version()}, Vue ${VUE_VERSION}`,
          );
        } finally {
          await context.close();
        }
      });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((ok) => server.close(() => ok()));
    }
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

async function score(root: string, number: Scenario) {
  const checks: RuntimeCheck[] = [];
  const fixed = fixedFiles(number);
  const untampered = fixedFilesUnmodified(root, fixed);
  const bounded = safeCandidateTree(root, ['src']);
  recordCheck(
    checks,
    'immutable evaluator harness and bounded candidate input',
    untampered && bounded,
    `immutable=${untampered}; safe candidate=${bounded}`,
    false,
  );
  if (!untampered || !bounded) return finishChecks(checks, true);
  const blockers = vueNativeBrowserReadiness();
  if (blockers.length)
    return finishChecks(
      blockers.map((reason) => ({
        name: 'native Vue/Chromium runtime unavailable',
        passed: false,
        detail: reason,
        browser: false,
      })),
    );
  recordCheck(
    checks,
    'candidate provided Vue/version/scope/recovery declaration',
    claimedEvidence(root, number),
    `Vue ${VUE_VERSION}; near-neighbor=${number === 1 ? 'angular-engineering' : 'react-engineering'}`,
    false,
  );
  try {
    await runNativeBrowser(root, number, checks);
  } catch (error) {
    recordCheck(
      checks,
      'native Vue production server/browser execution',
      false,
      error instanceof Error ? error.message.slice(0, 900) : String(error),
      true,
    );
  }
  return finishChecks(checks);
}

export const VUE_NATIVE_BROWSER_SKILL_EVAL_SCORERS: readonly SkillEvalDeterministicScorer[] = [
  {
    id: 'vue-engineering/native-vue-history-browser-scorer@1',
    scenarioIds: [ROUTE_SCENARIO],
    score: ({ workingDirectory }) => score(workingDirectory, 1),
  },
  {
    id: 'vue-engineering/native-vue-draft-browser-scorer@1',
    scenarioIds: [DRAFT_SCENARIO],
    score: ({ workingDirectory }) => score(workingDirectory, 2),
  },
];
