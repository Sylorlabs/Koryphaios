import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSkillEvalSuiteV3 } from '../skill-eval-harness';
import { writeFixtureFile } from '../skill-eval-fixture-helpers';
import { loadV5SkillPackages } from '../skill-packages';
import {
  SVELTE_BROWSER_EVAL_CONSTANTS,
  SVELTE_BROWSER_SKILL_EVAL_MATERIALIZERS,
  SVELTE_BROWSER_SKILL_EVAL_SCORERS,
} from '../skill-eval-svelte-browser-fixtures';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scenario(id: string) {
  const skill = loadV5SkillPackages().packages.find(
    (item) => item.sidecar.name === 'svelte-engineering',
  )!;
  return buildSkillEvalSuiteV3(skill).scenarios.find((item) => item.id === id)!;
}

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'kory-svelte-browser-'));
  roots.push(root);
  return root;
}

function input(id: string, root: string) {
  const evalScenario = scenario(id);
  const materializer = SVELTE_BROWSER_SKILL_EVAL_MATERIALIZERS.find((item) =>
    item.matches(evalScenario),
  )!;
  const scorer = SVELTE_BROWSER_SKILL_EVAL_SCORERS.find((item) => item.scenarioIds.includes(id))!;
  return {
    evalScenario,
    materializer,
    scorer,
    scoreInput: {
      scenario: evalScenario,
      experiment: {} as never,
      workingDirectory: root,
      observation: { output: '', evidence: [], artifacts: [], durationMs: 0 },
    },
  };
}

const GREEN_STATE_APP = `<script>
  import KorySelect from './KorySelect.svelte';
  let { items, filter, loading = false, error = '' } = $props();
  let selectedId = $state('');
  let visible = $derived(items.filter((item) => item.label.toLowerCase().includes(filter.toLowerCase())));

  $effect(() => {
    if (!visible.some((item) => item.id === selectedId)) selectedId = visible[0]?.id ?? '';
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

const GREEN_ROUTE_APP = `<script>
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
    const unsubscribe = subscribeDetail(id, {
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
    return unsubscribe;
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

function writeArtifacts(root: string, number: 1 | 2): void {
  writeFixtureFile(
    root,
    `verification/scenario-${number}-result.json`,
    `${JSON.stringify(
      {
        svelteVersion: SVELTE_BROWSER_EVAL_CONSTANTS.version,
        reactivityGeneration: 'runes',
        executionBoundary: 'browser-only',
        broaderSkill: 'frontend-engineering',
        nearNeighbor: number === 1 ? 'angular-engineering' : 'react-engineering',
        ...(number === 1 ? { sharedControl: 'KorySelect.svelte' } : {}),
      },
      null,
      2,
    )}\n`,
  );
  const checks =
    number === 1
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
  writeFixtureFile(
    root,
    `verification/scenario-${number}-verification.json`,
    `${JSON.stringify(
      {
        evidenceType: 'real-browser',
        checks,
        negativeRecovery:
          number === 1
            ? ['selection removal falls back to a remaining option']
            : ['failed detail retries and restores focus after recovery'],
      },
      null,
      2,
    )}\n`,
  );
}

describe('Svelte 5 real-browser V5 fixtures', () => {
  test('derived-state scenario starts red then passes real runes, shared-control, state, focus, and destruction checks', async () => {
    const root = workspace();
    const { materializer, scorer, scoreInput } = input(
      SVELTE_BROWSER_EVAL_CONSTANTS.stateScenario,
      root,
    );
    await materializer.materialize(root, scoreInput.scenario);
    const red = await scorer.score(scoreInput);
    expect(red.passed).toBe(false);
    expect(red.integrityFailure).toBe(false);

    writeFixtureFile(root, 'src/App.svelte', GREEN_STATE_APP);
    writeArtifacts(root, 1);
    const green = await scorer.score(scoreInput);
    expect(green.passed, green.evidence.join('\n')).toBe(true);
    expect(green.integrityFailure).toBe(false);
    expect(green.quality).toBe(1);
    expect(green.verification).toBe(1);
  }, 30_000);

  test('route-race scenario starts red then passes real async teardown, history, retry/focus, and destruction checks', async () => {
    const root = workspace();
    const { materializer, scorer, scoreInput } = input(
      SVELTE_BROWSER_EVAL_CONSTANTS.routeScenario,
      root,
    );
    await materializer.materialize(root, scoreInput.scenario);
    const red = await scorer.score(scoreInput);
    expect(red.passed).toBe(false);
    expect(red.integrityFailure).toBe(false);

    writeFixtureFile(root, 'src/App.svelte', GREEN_ROUTE_APP);
    writeArtifacts(root, 2);
    const green = await scorer.score(scoreInput);
    expect(green.passed, green.evidence.join('\n')).toBe(true);
    expect(green.integrityFailure).toBe(false);
    expect(green.quality).toBe(1);
    expect(green.verification).toBe(1);
  }, 30_000);

  test('tampering with the fixed shared control fails integrity', async () => {
    const root = workspace();
    const { materializer, scorer, scoreInput } = input(
      SVELTE_BROWSER_EVAL_CONSTANTS.stateScenario,
      root,
    );
    await materializer.materialize(root, scoreInput.scenario);
    writeFixtureFile(root, 'src/KorySelect.svelte', '<select></select>\n');
    const result = await scorer.score(scoreInput);
    expect(result.passed).toBe(false);
    expect(result.integrityFailure).toBe(true);
  });
});
