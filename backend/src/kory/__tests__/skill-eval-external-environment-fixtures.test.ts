import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browserControlTest } from './browser-runtime-test-policy';
import { auditSkillEvalExecutionReadiness } from '../skill-eval-execution';
import { buildSkillEvalSuiteV3 } from '../skill-eval-harness';
import { writeFixtureFile } from '../skill-eval-fixture-helpers';
import { VUE_BROWSER_EVAL_CONSTANTS } from '../skill-eval-vue-browser-fixtures';
import { NEXTJS_RUNTIME_EVAL_CONSTANTS } from '../skill-eval-nextjs-runtime-fixtures';
import {
  EXTERNAL_ENVIRONMENT_GATES,
  EXTERNAL_ENVIRONMENT_SKILL_EVAL_MATERIALIZERS,
  EXTERNAL_ENVIRONMENT_SKILL_EVAL_SCORERS,
} from '../skill-eval-external-environment-fixtures';
import {
  BUILTIN_SKILL_EVAL_MATERIALIZERS,
  BUILTIN_SKILL_EVAL_SCORERS,
} from '../skill-eval-fixtures';
import { loadV5SkillPackages } from '../skill-packages';

describe('external full-task environment gates', () => {
  test('resolves materializer and scorer identities without registry collisions', () => {
    const materializerIds = BUILTIN_SKILL_EVAL_MATERIALIZERS.map((item) => item.id);
    const scorerIds = BUILTIN_SKILL_EVAL_SCORERS.map((item) => item.id);
    // Dispatch resolves by ID. A duplicate can silently shadow the current
    // evaluator generation even when both scorers individually work.
    expect(new Set(materializerIds).size).toBe(materializerIds.length);
    expect(new Set(scorerIds).size).toBe(scorerIds.length);
  });

  test('covers every otherwise-unmaterialized full task with a specific fail-closed gate', () => {
    const packages = loadV5SkillPackages().packages;
    const knownScenarios = new Set(
      packages.flatMap((skill) => skill.evaluation.tasks.map((task) => task.id)),
    );
    const gatedScenarioIds = EXTERNAL_ENVIRONMENT_GATES.flatMap((gate) => gate.scenarioIds);
    expect(gatedScenarioIds).toHaveLength(63);
    expect(new Set(gatedScenarioIds).size).toBe(gatedScenarioIds.length);
    for (const scenarioId of gatedScenarioIds)
      expect(knownScenarios.has(scenarioId), scenarioId).toBe(true);

    const promotedBrowserScenarios = [
      'web-interface-full-task-async-operations-console',
      'web-interface-full-task-content-led-product-page',
      'visual-verification-full-task-1',
      'svelte-engineering-full-task-1-individual',
      'svelte-engineering-full-task-2-individual',
    ];
    for (const scenarioId of promotedBrowserScenarios) {
      expect(gatedScenarioIds, scenarioId).not.toContain(scenarioId);
    }

    const rows = auditSkillEvalExecutionReadiness(
      packages,
      BUILTIN_SKILL_EVAL_MATERIALIZERS,
      BUILTIN_SKILL_EVAL_SCORERS,
    );
    // Registration coverage is independent of the host's installed runtimes.
    // Every task must resolve both parts, and only declared prerequisites may
    // prevent execution (missing registrations are never accepted as gates).
    expect(rows).toHaveLength(knownScenarios.size);
    expect(new Set(rows.map((row) => row.scenarioId))).toEqual(knownScenarios);
    for (const row of rows) {
      const materializer = BUILTIN_SKILL_EVAL_MATERIALIZERS.find(
        (item) => item.id === row.materializerId,
      );
      const scorer = BUILTIN_SKILL_EVAL_SCORERS.find(
        (item) => item.id === row.deterministicScorerId,
      );
      expect(materializer, row.scenarioId).toBeDefined();
      expect(scorer?.scenarioIds, row.scenarioId).toContain(row.scenarioId);
      const blockers = materializer!.readinessBlockers ?? [];
      expect(row.reasons, row.scenarioId).toEqual(blockers);
      expect(row.ready, row.scenarioId).toBe(blockers.length === 0);
    }
    const promotedRuntimeIds = [
      'vue-engineering-full-task-1-individual',
      'vue-engineering-full-task-2-individual',
      'nextjs-engineering-full-task-1-individual',
      'nextjs-engineering-full-task-2-individual',
    ];
    // Real native surfaces are executable through the AppKit fixture, not a browser.
    for (const scenarioId of [
      'frontend-engineering-full-task-confirmed-native',
      'visual-verification-full-task-2',
    ]) {
      const row = rows.find((item) => item.scenarioId === scenarioId)!;
      expect(row.materializerId, scenarioId).toContain('native-appkit');
      expect(row.deterministicScorerId, scenarioId).toContain('native-appkit');
    }
    for (const scenarioId of promotedBrowserScenarios) {
      const row = rows.find((item) => item.scenarioId === scenarioId)!;
      expect(row.materializerId, scenarioId).toContain('real-browser');
      expect(row.deterministicScorerId, scenarioId).toContain('real-browser');
    }
    for (const id of promotedRuntimeIds) {
      const row = rows.find((item) => item.scenarioId === id)!;
      const runtimeId = id.startsWith('vue-') ? /native-vue-(history|draft)-browser/ : /production/;
      expect(row.materializerId, id).toMatch(runtimeId);
      expect(row.deterministicScorerId, id).toMatch(runtimeId);
    }
    for (const scenarioId of gatedScenarioIds) {
      const row = rows.find((item) => item.scenarioId === scenarioId)!;
      // Gate entries remain historical fallbacks. A registered real-runtime
      // evaluator may supersede one, but a concept fixture may not certify it.
      // A replacement can itself be blocked on this host. It must still win
      // dispatch over the historical gate, without claiming readiness.
      if (!row.materializerId!.includes('/external-environment-gate/')) {
        const replacement = BUILTIN_SKILL_EVAL_MATERIALIZERS.find(
          (item) => item.id === row.materializerId,
        );
        expect(replacement?.realRuntime, scenarioId).toBe(true);
        expect(row.materializerId, scenarioId).not.toContain('/external-environment-gate/');
        expect(row.deterministicScorerId, scenarioId).not.toContain(
          '/external-environment-gate-scorer/',
        );
        continue;
      }
      expect(row.ready, scenarioId).toBe(false);
      expect(row.materializerId, scenarioId).toContain('/external-environment-gate/');
      expect(row.deterministicScorerId, scenarioId).toContain('/external-environment-gate-scorer/');
      expect(row.reasons, scenarioId).toHaveLength(1);
      expect(row.reasons[0], scenarioId).toBe(
        EXTERNAL_ENVIRONMENT_GATES.find((gate) => gate.scenarioIds.includes(scenarioId))!.blocker,
      );
      expect(row.reasons[0], scenarioId).not.toMatch(
        /no materializer|no registered deterministic scorer/iu,
      );
    }
  }, 60_000);

  test('remaining gate scorers can never turn unavailable environment evidence into a pass', async () => {
    expect(EXTERNAL_ENVIRONMENT_SKILL_EVAL_MATERIALIZERS).toHaveLength(61);
    expect(EXTERNAL_ENVIRONMENT_SKILL_EVAL_SCORERS).toHaveLength(61);
    for (const scorer of EXTERNAL_ENVIRONMENT_SKILL_EVAL_SCORERS) {
      if (!scorer.id.includes('/external-environment-gate-scorer/')) continue;
      const score = await scorer.score({
        scenario: {} as never,
        experiment: {} as never,
        workingDirectory: '',
        observation: { output: '', evidence: [], artifacts: [], durationMs: 0 },
      });
      expect(score.passed, scorer.id).toBe(false);
      expect(score.verification, scorer.id).toBe(0);
    }
  });
});

const VUE_SEARCH_GREEN = `import { defineComponent, h, ref, watch, nextTick } from 'vue';
import { loadDetail } from './source.js';
export default defineComponent({ props: { id: String }, setup(props) {
  const input = ref(props.id), state = ref({ status: 'loading', detail: null, error: '' });
  const retry = ref(0), favorite = ref(localStorage.getItem('vue-fixture-favorite') === 'yes');
  const retryNode = ref(null), heading = ref(null), focusHeading = ref(false);
  watch(() => props.id, (id) => { input.value = id; retry.value = 0; focusHeading.value = false; });
  watch([() => props.id, retry], ([id], _, onCleanup) => {
    let active = true;
    const controller = new AbortController();
    state.value = { status: 'loading', detail: null, error: '' };
    onCleanup(() => { active = false; controller.abort(); });
    loadDetail(id, { signal: controller.signal }).then(async (detail) => {
      if (!active) return;
      state.value = { status: 'done', detail, error: '' };
      if (detail && focusHeading.value) { await nextTick(); heading.value?.focus(); }
    }).catch(async (error) => {
      if (!active || error.name === 'AbortError') return;
      state.value = { status: 'error', detail: null, error: error.message };
      await nextTick(); retryNode.value?.focus();
    });
  }, { immediate: true });
  const submit = (event) => {
    event.preventDefault();
    history.pushState({}, '', '/?id=' + encodeURIComponent(input.value));
    dispatchEvent(new PopStateEvent('popstate'));
  };
  const toggle = () => {
    favorite.value = !favorite.value;
    localStorage.setItem('vue-fixture-favorite', favorite.value ? 'yes' : 'no');
  };
  return () => h('section', { class: 'card', 'data-vue-detail': '' }, [
    h('h1', 'Vue details'),
    h('form', { onSubmit: submit }, [
      h('label', { for: 'detail-input' }, 'Detail ID'),
      h('input', { id: 'detail-input', value: input.value, onInput: (e) => input.value = e.target.value }),
      h('button', { type: 'submit' }, 'Find'),
    ]),
    h('button', { id: 'favorite', type: 'button', 'aria-pressed': favorite.value, onClick: toggle }, 'Saved preference'),
    state.value.status === 'loading' ? h('p', { role: 'status', 'aria-busy': 'true' }, 'Loading detail') : null,
    state.value.status === 'error' ? h('div', { role: 'alert' }, [
      h('p', state.value.error),
      h('button', { id: 'retry', type: 'button', ref: retryNode, onClick: () => { focusHeading.value = true; retry.value++; } }, 'Retry'),
    ]) : null,
    state.value.status === 'done' && !state.value.detail ? h('p', { 'data-empty': '' }, 'No detail') : null,
    state.value.status === 'done' && state.value.detail ? h('h2', {
      'data-detail-id': state.value.detail.id, ref: heading, tabindex: -1,
    }, state.value.detail.title) : null,
  ]);
}});
`;

const VUE_FORM_GREEN = `import { defineComponent, h, reactive, ref, watch, nextTick } from 'vue';
export default defineComponent({
  props: { record: Object, resetEpoch: Number }, emits: ['update:record'],
  setup(props, { emit }) {
    const draft = reactive({ id: '', name: '', email: '' });
    const error = ref(''), field = ref(null);
    const restore = () => {
      Object.assign(draft, { id: props.record.id, name: props.record.name, email: props.record.email });
      error.value = '';
    };
    watch([() => props.record.id, () => props.resetEpoch], restore, { immediate: true });
    const save = async () => {
      if (!draft.name.trim()) { error.value = 'Name required'; await nextTick(); field.value?.focus(); return; }
      error.value = '';
      emit('update:record', { ...draft });
    };
    return () => h('section', { class: 'card', 'data-vue-form': '' }, [
      h('h1', 'Edit ' + props.record.id),
      h('label', { for: 'name' }, ['Name ', h('input', { id: 'name', ref: field, value: draft.name, onInput: e => draft.name = e.target.value })]),
      h('label', { for: 'email' }, ['Email ', h('input', { id: 'email', value: draft.email, onInput: e => draft.email = e.target.value })]),
      error.value ? h('p', { role: 'alert' }, error.value) : null,
      h('button', { id: 'save', onClick: save }, 'Save'), h('button', { id: 'cancel', onClick: restore }, 'Cancel'),
    ]);
  },
});
`;

const NEXT_CACHE_GREEN = `import React from 'react';
import { getCatalog, getPrice, getViewer } from '../lib/store.js';
export default async function PriceView({ page }) {
  const viewer = await getViewer();
  const catalog = await getCatalog();
  const price = await getPrice(viewer);
  return <main data-page={page} data-viewer={viewer} data-price={price} data-revision={catalog.revision}>
    <h1>{catalog.name}</h1><p data-personal-price>Price: {price}</p>
    <p data-revision-label>Catalog revision {catalog.revision}</p>
  </main>;
}
`;

const NEXT_ACTION_GREEN = `'use server';
import { revalidatePath } from 'next/cache';
import { getViewer, insertOnce } from '../lib/store.js';
export async function submitOrder(previous, formData) {
  const viewer = await getViewer();
  if (viewer === 'expired' || viewer === 'forbidden') return { status: viewer };
  const requestId = String(formData.get('requestId') || '');
  if (!/^request-[a-z0-9-]+$/u.test(requestId)) return { status: 'invalid' };
  const order = await insertOnce(viewer, requestId);
  revalidatePath('/');
  revalidatePath('/history');
  return { status: 'success', orderId: order.id };
}
`;

const tmpRoots: string[] = [];
afterEach(() => {
  for (const root of tmpRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function runtimeReadinessBlockers(scenarioId: string): readonly string[] {
  const materializer = EXTERNAL_ENVIRONMENT_SKILL_EVAL_MATERIALIZERS.find((item) =>
    item.matches({ id: scenarioId } as never),
  );
  if (!materializer) throw new Error(`Real runtime materializer is not registered for ${scenarioId}`);
  return materializer.readinessBlockers ?? [];
}

const vueRouteRuntimeTest = browserControlTest(
  'Vue route/Chromium',
  runtimeReadinessBlockers('vue-engineering-full-task-1-individual'),
);
const vueFormRuntimeTest = browserControlTest(
  'Vue form/Chromium',
  runtimeReadinessBlockers('vue-engineering-full-task-2-individual'),
);
const nextCacheRuntimeTest = browserControlTest(
  'Next cache/Chromium',
  runtimeReadinessBlockers('nextjs-engineering-full-task-1-individual'),
);
const nextActionRuntimeTest = browserControlTest(
  'Next Server Action/Chromium',
  runtimeReadinessBlockers('nextjs-engineering-full-task-2-individual'),
);

function realFixture(skill: string, scenarioId: string) {
  const pkg = loadV5SkillPackages().packages.find((candidate) => candidate.sidecar.name === skill)!;
  const scenario = buildSkillEvalSuiteV3(pkg).scenarios.find((candidate) => candidate.id === scenarioId)!;
  const materializer = EXTERNAL_ENVIRONMENT_SKILL_EVAL_MATERIALIZERS.find((item) => item.matches(scenario))!;
  const scorer = EXTERNAL_ENVIRONMENT_SKILL_EVAL_SCORERS.find((item) => item.scenarioIds.includes(scenarioId))!;
  const root = mkdtempSync(join(tmpdir(), 'kory-vue-next-eval-test-'));
  tmpRoots.push(root);
  materializer.materialize(root, scenario);
  const score = () => scorer.score({ scenario, experiment: {} as never, workingDirectory: root,
    observation: { output: '', evidence: [], artifacts: [], durationMs: 0 } });
  return { root, materializer, scorer, score };
}

function evidence(root: string, skill: 'vue-engineering' | 'nextjs-engineering', number: 1 | 2) {
  const isVue = skill === 'vue-engineering';
  writeFixtureFile(root, 'verification/result.json', JSON.stringify({
    status: 'verified',
    ...(isVue
      ? { vueVersion: VUE_BROWSER_EVAL_CONSTANTS.version, broaderSkill: 'frontend-engineering',
          nearNeighbor: number === 1 ? 'angular-engineering' : 'react-engineering' }
      : { nextVersion: NEXTJS_RUNTIME_EVAL_CONSTANTS.nextVersion, router: 'app', deployment: 'production',
          broaderSkill: 'web-interface', nearNeighbor: number === 1 ? 'android-compose' : 'angular-engineering' }),
    recovery: 'Verified a real runtime recovery after delayed data, navigation, authentication or reset.',
  }));
}

describe('Vue and Next full-task real runtime qualification', () => {
  vueRouteRuntimeTest('real Vue 3 browser watcher race fails red and succeeds with cleanup, history and recovery', async () => {
    const fixture = realFixture('vue-engineering', 'vue-engineering-full-task-1-individual');
    expect(fixture.materializer.realRuntime).toBe(true);
    evidence(fixture.root, 'vue-engineering', 1);
    const red = await fixture.score();
    expect(red.passed, red.evidence.join('\n')).toBe(false);
    writeFixtureFile(fixture.root, 'src/App.js', VUE_SEARCH_GREEN);
    const green = await fixture.score();
    expect(green.passed, green.evidence.join('\n')).toBe(true);
    expect(green.verification).toBe(1);
  }, 65_000);

  vueFormRuntimeTest('real Vue 3 form rejects watcher feedback and verifies single commit', async () => {
    const fixture = realFixture('vue-engineering', 'vue-engineering-full-task-2-individual');
    evidence(fixture.root, 'vue-engineering', 2);
    const red = await fixture.score();
    expect(red.passed, red.evidence.join('\n')).toBe(false);
    writeFixtureFile(fixture.root, 'src/App.js', VUE_FORM_GREEN);
    const green = await fixture.score();
    expect(green.passed, green.evidence.join('\n')).toBe(true);
    writeFixtureFile(fixture.root, 'src/Harness.js', 'export default {}');
    const tampered = await fixture.score();
    expect(tampered.integrityFailure).toBe(true);
  }, 65_000);

  nextCacheRuntimeTest('actual production Next App Router isolates SSR/client cache across sessions', async () => {
    const fixture = realFixture('nextjs-engineering', 'nextjs-engineering-full-task-1-individual');
    evidence(fixture.root, 'nextjs-engineering', 1);
    writeFixtureFile(fixture.root, 'app/PriceView.jsx', NEXT_CACHE_GREEN);
    const green = await fixture.score();
    expect(green.passed, green.evidence.join('\n')).toBe(true);
    writeFixtureFile(fixture.root, 'app/PriceView.jsx', readFileSync(join(fixture.root, 'app/PriceView.jsx'), 'utf8').replace('getPrice(viewer)', 'getPrice(\'anonymous\')'));
    const red = await fixture.score();
    expect(red.passed).toBe(false);
  }, 290_000);

  nextActionRuntimeTest('actual production Next Server Action deduplicates concurrent requests and rejects invalid sessions', async () => {
    const fixture = realFixture('nextjs-engineering', 'nextjs-engineering-full-task-2-individual');
    evidence(fixture.root, 'nextjs-engineering', 2);
    writeFixtureFile(fixture.root, 'app/actions.js', NEXT_ACTION_GREEN);
    const green = await fixture.score();
    expect(green.passed, green.evidence.join('\n')).toBe(true);
    writeFixtureFile(fixture.root, 'app/actions.js', `'use server';\nimport { insertUnsafe } from '../lib/store.js';\nexport async function submitOrder(_p, data) { const o = await insertUnsafe('alice', String(data.get('requestId'))); return { status: 'success', orderId: o.id }; }\n`);
    const red = await fixture.score();
    expect(red.passed).toBe(false);
  }, 290_000);
});
