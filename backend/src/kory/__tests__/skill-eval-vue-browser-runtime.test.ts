import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { browserControlTest } from './browser-runtime-test-policy';
import { buildSkillEvalSuiteV3 } from '../../eval/skills/skill-eval-harness';
import { writeFixtureFile } from '../../eval/skills/skill-eval-fixture-helpers';
import { loadV5SkillPackages } from '../skill-packages';
import {
  VUE_NATIVE_BROWSER_EVAL_CONSTANTS,
  VUE_NATIVE_BROWSER_SKILL_EVAL_MATERIALIZERS,
  VUE_NATIVE_BROWSER_SKILL_EVAL_SCORERS,
  vueNativeBrowserReadiness,
  writeVueBrowserFixtureContract,
} from '../../eval/skills/skill-eval-vue-browser-runtime';

const roots: string[] = [];
const browserTest = browserControlTest('Vue/Chromium', vueNativeBrowserReadiness());
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(number: 1 | 2, runtime = false) {
  const root = mkdtempSync(join(tmpdir(), 'kory-vue-native-test-'));
  roots.push(root);
  const pkg = loadV5SkillPackages().packages.find((item) => item.sidecar.name === 'vue-engineering');
  if (!pkg) throw new Error('The real Vue skill package was not loaded');
  const id = VUE_NATIVE_BROWSER_EVAL_CONSTANTS.scenarios[number - 1];
  const scenario = buildSkillEvalSuiteV3(pkg).scenarios.find((item) => item.id === id);
  if (!scenario) throw new Error(`Vue skill scenario ${id} is unavailable`);
  const materializer = VUE_NATIVE_BROWSER_SKILL_EVAL_MATERIALIZERS.find((item) => item.matches(scenario));
  const scorer = VUE_NATIVE_BROWSER_SKILL_EVAL_SCORERS.find((item) => item.scenarioIds.includes(id));
  if (!materializer || !scorer) throw new Error('Vue native sidecar did not match its scenario');
  if (runtime) materializer.materialize(root, scenario);
  else writeVueBrowserFixtureContract(root, number);
  const score = () => scorer.score({
    scenario, experiment: {} as never, workingDirectory: root,
    observation: { output: '', evidence: [], artifacts: [], durationMs: 0 },
  });
  return { root, id, materializer, score };
}

function verified(root: string, number: 1 | 2) {
  writeFixtureFile(root, 'verification/result.json', `${JSON.stringify({
    status: 'verified',
    vueVersion: VUE_NATIVE_BROWSER_EVAL_CONSTANTS.vueVersion,
    broaderSkill: 'frontend-engineering',
    nearNeighbor: number === 1 ? 'angular-engineering' : 'react-engineering',
    recovery: number === 1
      ? 'A delayed request resolves after abort; the watcher invalidates the generation before rendering and retries failed detail requests.'
      : 'Only an ID change or explicit parent reset replaces local edits. Invalid commits focus the name; cancellation restores parent state.',
  }, null, 2)}\n`);
}

/** Correct independent Vue candidate, run through Bun production bundling and Chromium. */
const ROUTE_FIXED = `import { defineComponent, h, nextTick, ref, watch } from 'vue';
import { fetchDetail } from './service.js';
export default defineComponent({ props: { id: String }, setup(props) {
  const data = ref(null), status = ref('loading'), error = ref(''), retry = ref(0);
  const input = ref(''), retryButton = ref(null), heading = ref(null);
  const favorite = ref(localStorage.getItem('vue-native-favorite') === 'yes');
  let generation = 0;
  watch([() => props.id, retry], ([id], _old, onCleanup) => {
    const own = ++generation;
    const controller = new AbortController();
    let valid = true;
    onCleanup(() => { valid = false; controller.abort(); });
    status.value = 'loading'; data.value = null; error.value = '';
    fetchDetail(id, { signal: controller.signal }).then(async (value) => {
      if (!valid || generation !== own) return;
      data.value = value;
      status.value = value ? 'ready' : 'empty';
      if (id === 'error' && value) {
        await nextTick();
        if (valid && generation === own) heading.value?.focus();
      }
    }).catch(async (problem) => {
      if (!valid || generation !== own || problem.name === 'AbortError') return;
      error.value = problem.message;
      status.value = 'error';
      await nextTick();
      if (valid && generation === own) retryButton.value?.focus();
    });
  }, { immediate: true });
  const navigate = (value) => {
    history.pushState({}, '', '/detail/' + encodeURIComponent(value));
    dispatchEvent(new PopStateEvent('popstate'));
  };
  const toggle = () => {
    favorite.value = !favorite.value;
    localStorage.setItem('vue-native-favorite', favorite.value ? 'yes' : 'no');
  };
  return () => h('section', { class: 'panel', 'data-route-component': '' }, [
    h('h1', 'Detail view'),
    h('label', { class: 'field' }, ['Go to detail', h('input', { id: 'detail-input',
      value: input.value, onInput: (event) => { input.value = event.target.value; },
      onKeydown: (event) => { if (event.key === 'Enter' && input.value.trim()) {
        event.preventDefault(); navigate(input.value.trim());
      } },
    })]),
    h('button', { type: 'button', id: 'favorite', 'aria-pressed': String(favorite.value), onClick: toggle }, 'Favorite'),
    status.value === 'loading' ? h('p', { role: 'status', 'aria-busy': 'true' }, 'Loading') : null,
    status.value === 'error' ? h('div', [h('p', { role: 'alert' }, error.value),
      h('button', { id: 'retry', ref: retryButton, type: 'button', onClick: () => retry.value++ }, 'Retry')]) : null,
    status.value === 'empty' ? h('p', { 'data-empty': '' }, 'No detail found') : null,
    status.value === 'ready' && data.value
      ? h('h2', { ref: heading, tabindex: -1, 'data-detail-id': data.value.id }, data.value.title) : null,
  ]);
}});
`;

/** Keeps local edits in a reactive child-owned draft until one explicit save. */
const DRAFT_FIXED = `import { defineComponent, h, nextTick, reactive, ref, watch } from 'vue';
export default defineComponent({ props: { record: Object, resetEpoch: Number },
  emits: ['update:record'], setup(props, { emit }) {
    const draft = reactive({ id: '', name: '', email: '' });
    const error = ref(''), nameField = ref(null);
    const restore = () => { Object.assign(draft, {
      id: props.record.id, name: props.record.name, email: props.record.email,
    }); error.value = ''; };
    watch([() => props.record.id, () => props.resetEpoch], restore, { immediate: true });
    const save = async () => {
      if (!draft.name.trim()) {
        error.value = 'Name required'; await nextTick(); nameField.value?.focus(); return;
      }
      error.value = '';
      emit('update:record', { id: draft.id, name: draft.name, email: draft.email });
    };
    return () => h('section', { class: 'panel', 'data-form-component': '' }, [
      h('h1', 'Edit ' + props.record.id),
      h('label', { class: 'field' }, ['Name', h('input', { id: 'name', ref: nameField,
        value: draft.name, onInput: (event) => { draft.name = event.target.value; },
      })]),
      h('label', { class: 'field' }, ['Email', h('input', { id: 'email', value: draft.email,
        onInput: (event) => { draft.email = event.target.value; },
      })]),
      error.value ? h('p', { role: 'alert' }, error.value) : null,
      h('button', { type: 'button', id: 'save', onClick: save }, 'Save'),
      h('button', { type: 'button', id: 'cancel', onClick: restore }, 'Cancel'),
    ]);
  },
});
`;

describe('isolated native Vue 3 + Chromium skill evaluation sidecar', () => {
  test('matches both authentic V5 scenarios and explicitly reports runtime availability', () => {
    expect(VUE_NATIVE_BROWSER_SKILL_EVAL_MATERIALIZERS).toHaveLength(2);
    expect(VUE_NATIVE_BROWSER_SKILL_EVAL_SCORERS).toHaveLength(2);
    expect(VUE_NATIVE_BROWSER_EVAL_CONSTANTS.vueVersion).toBe('3.5.30');
    const blockers = vueNativeBrowserReadiness();
    for (const materializer of VUE_NATIVE_BROWSER_SKILL_EVAL_MATERIALIZERS) {
      expect(materializer.realRuntime).toBe(true);
      expect(materializer.readinessBlockers).toEqual(blockers);
    }
    if (blockers.length) {
      expect(blockers.every((blocker) => typeof blocker === 'string' && blocker.length > 10)).toBe(true);
    } else {
      expect(blockers).toEqual([]);
    }
  });

  test('missing Vue assets remain unavailable and cannot produce browser verification', async () => {
    const emptyCache = mkdtempSync(join(tmpdir(), 'kory-vue-empty-cache-'));
    roots.push(emptyCache);
    const previousCache = process.env.BUN_INSTALL_CACHE_DIR;
    const launch = spyOn(chromium, 'launch').mockRejectedValue(new Error('Unexpected browser launch'));
    try {
      process.env.BUN_INSTALL_CACHE_DIR = emptyCache;
      expect(vueNativeBrowserReadiness().join('\n')).toContain('Missing pinned vue@3.5.30');
      expect(() => fixture(1, true)).toThrow('Native Vue 3 browser fixture unavailable');
      const { score } = fixture(1);
      const result = await score();
      expect(result.passed).toBe(false);
      expect(result.integrityFailure).toBe(false);
      expect(result.verification).toBe(0);
      expect(result.evidence.join('\n')).toContain('native Vue/Chromium runtime unavailable');
      expect(launch).not.toHaveBeenCalled();
    } finally {
      if (previousCache === undefined) delete process.env.BUN_INSTALL_CACHE_DIR;
      else process.env.BUN_INSTALL_CACHE_DIR = previousCache;
      launch.mockRestore();
    }
  });

  test('both Vue contracts reject tampered harnesses before runtime preparation', async () => {
    const launch = spyOn(chromium, 'launch').mockRejectedValue(new Error('Unexpected browser launch'));
    try {
      for (const number of [1, 2] as const) {
        const { root, score } = fixture(number);
        const original = readFileSync(join(root, 'src', 'Harness.js'), 'utf8');
        writeFixtureFile(root, 'src/Harness.js', original + '\n// candidate tamper\n');
        const result = await score();
        expect(result.passed).toBe(false);
        expect(result.integrityFailure).toBe(true);
        expect(result.verification).toBe(0);
      }
      expect(launch).not.toHaveBeenCalled();
    } finally {
      launch.mockRestore();
    }
  });

  browserTest('scenario 1: broken watcher is red; fixed candidate proves real race, history, focus and unmount', async () => {
    const { root, score } = fixture(1, true);
    const red = await score();
    expect(red.passed).toBe(false);
    expect(red.integrityFailure).toBe(false);
    expect(red.evidence.some((line) => /out-of-order response cannot overwrite latest route: fail/.test(line)), red.evidence.join('\n')).toBe(true);

    writeFixtureFile(root, 'src/App.js', ROUTE_FIXED);
    verified(root, 1);
    const green = await score();
    expect(green.passed, green.evidence.join('\n')).toBe(true);
    expect(green.integrityFailure).toBe(false);
    expect(green.quality).toBe(1);
    expect(green.verification).toBe(1);
    expect(green.evidence.some((line) => line.includes('Chromium Vue execution without uncaught page exceptions: pass'))).toBe(true);

  }, 90_000);

  browserTest('scenario 2: broken deep watchers are red; fixed child proves draft ownership and single emit', async () => {
    const { root, score } = fixture(2, true);
    const red = await score();
    expect(red.passed).toBe(false);
    expect(red.integrityFailure).toBe(false);

    writeFixtureFile(root, 'src/App.js', DRAFT_FIXED);
    verified(root, 2);
    const green = await score();
    expect(green.passed, green.evidence.join('\n')).toBe(true);
    expect(green.integrityFailure).toBe(false);
    expect(green.quality).toBe(1);
    expect(green.verification).toBe(1);
    expect(green.evidence.some((line) => line.includes('single explicit commit without watcher feedback: pass'))).toBe(true);

    writeFixtureFile(root, 'verification/result.json', '{"status":"not-run"}\n');
    const unsupportedClaim = await score();
    expect(unsupportedClaim.passed).toBe(false);
    expect(unsupportedClaim.evidence.some((line) => line.includes('candidate provided Vue/version/scope/recovery declaration: fail'))).toBe(true);
  }, 90_000);
});
