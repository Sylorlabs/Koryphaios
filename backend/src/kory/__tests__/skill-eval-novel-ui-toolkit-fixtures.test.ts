import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, lstatSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSkillEvalSuiteV3 } from '../skill-eval-harness';
import { readJsonArtifact, writeFixtureFile } from '../skill-eval-fixture-helpers';
import {
  createNovelUiToolkitFixtureEvaluators,
  NOVEL_UI_TOOLKIT_EVAL_CONSTANTS,
  NOVEL_UI_TOOLKIT_SKILL_EVAL_MATERIALIZERS,
  NOVEL_UI_TOOLKIT_SKILL_EVAL_SCORERS,
} from '../skill-eval-novel-ui-toolkit-fixtures';
import { loadV5SkillPackages } from '../skill-packages';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function workspace(prefix = 'kory-novel-ui-'): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function scenario(id: string) {
  const skill = loadV5SkillPackages().packages.find(
    (item) => item.sidecar.name === 'novel-ui-toolkit',
  )!;
  return buildSkillEvalSuiteV3(skill).scenarios.find((item) => item.id === id)!;
}

function fixture(
  id: string,
  root: string,
  evaluators = {
    materializers: NOVEL_UI_TOOLKIT_SKILL_EVAL_MATERIALIZERS,
    scorers: NOVEL_UI_TOOLKIT_SKILL_EVAL_SCORERS,
  },
) {
  const evalScenario = scenario(id);
  const materializer = evaluators.materializers.find((item) => item.matches(evalScenario))!;
  const scorer = evaluators.scorers.find((item) => item.scenarioIds.includes(id))!;
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

const VALID_CANVAS_TOOLKIT = `export function createNodeEditor({ canvas, semanticRoot, status, dataset }) {
  canvas.width = dataset.canvas.width;
  canvas.height = dataset.canvas.height;
  const context = canvas.getContext('2d');
  const nodes = dataset.nodes.map((node) => ({ ...node }));
  let edges = dataset.edges.map((edge) => ({ ...edge }));
  let selected = nodes[0].id;
  let connecting = null;
  let zoom = dataset.transform.zoom;
  let highContrast = false;
  let frame = 0;

  const currentIndex = () => Math.max(0, nodes.findIndex((node) => node.id === selected));
  const screen = (node) => ({
    left: node.x * zoom + dataset.transform.offsetX,
    top: node.y * zoom + dataset.transform.offsetY,
    width: dataset.nodeSize.width * zoom,
    height: dataset.nodeSize.height * zoom,
  });

  function project() {
    status.dataset.nodes = String(nodes.length);
    status.dataset.edges = String(edges.length);
    status.dataset.selected = selected;
    status.dataset.zoom = String(zoom);
    status.dataset.theme = highContrast ? 'high-contrast' : 'default';
    status.textContent = 'Selected ' + selected + '; ' + nodes.length + ' nodes; ' + edges.length + ' edges';
    semanticRoot.replaceChildren();
    const tree = document.createElement('div');
    tree.setAttribute('role', 'tree');
    tree.setAttribute('aria-label', 'Node graph');
    for (const node of nodes) {
      const item = document.createElement('div');
      item.setAttribute('role', 'treeitem');
      item.dataset.nodeId = node.id;
      item.setAttribute('aria-current', String(node.id === selected));
      item.textContent = node.label + (node.id === selected ? ', selected' : '');
      tree.append(item);
    }
    semanticRoot.append(tree);
  }

  function draw() {
    frame = 0;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = highContrast ? dataset.highContrast.background : '#f7f9fc';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.lineWidth = highContrast ? 4 : 3;
    context.strokeStyle = highContrast ? '#ffffff' : '#41506a';
    for (const edge of edges) {
      const from = nodes.find((node) => node.id === edge.from);
      const to = nodes.find((node) => node.id === edge.to);
      if (!from || !to) continue;
      const a = screen(from);
      const b = screen(to);
      context.beginPath();
      context.moveTo(a.left + a.width, a.top + a.height / 2);
      context.lineTo(b.left, b.top + b.height / 2);
      context.stroke();
    }
    for (const node of nodes) {
      const box = screen(node);
      context.fillStyle = highContrast
        ? node.id === selected ? dataset.highContrast.selected : dataset.highContrast.node
        : node.id === selected ? '#315fd6' : '#dce5f5';
      context.fillRect(box.left, box.top, box.width, box.height);
      context.fillStyle = highContrast ? '#000000' : node.id === selected ? '#ffffff' : '#172033';
      context.font = '16px system-ui';
      context.fillText(node.label, box.left + 14, box.top + 28);
      context.beginPath();
      context.arc(box.left, box.top + box.height / 2, 7, 0, Math.PI * 2);
      context.arc(box.left + box.width, box.top + box.height / 2, 7, 0, Math.PI * 2);
      context.fill();
    }
  }

  function invalidate() {
    project();
    if (!frame) frame = requestAnimationFrame(draw);
  }

  function selectOffset(offset) {
    if (!nodes.length) return;
    const index = (currentIndex() + offset + nodes.length) % nodes.length;
    selected = nodes[index].id;
  }

  function pointer(event) {
    canvas.focus();
    const rect = canvas.getBoundingClientRect();
    const x = (event.clientX - rect.left) * canvas.width / rect.width;
    const y = (event.clientY - rect.top) * canvas.height / rect.height;
    for (const node of nodes) {
      const box = screen(node);
      const nearInput = Math.hypot(x - box.left, y - (box.top + box.height / 2)) <= 14;
      const nearOutput = Math.hypot(x - (box.left + box.width), y - (box.top + box.height / 2)) <= 14;
      if (nearOutput) {
        selected = node.id;
        connecting = node.id;
        invalidate();
        return;
      }
      if (nearInput && connecting && connecting !== node.id) {
        if (!edges.some((edge) => edge.from === connecting && edge.to === node.id)) {
          edges.push({ from: connecting, to: node.id });
        }
        selected = node.id;
        connecting = null;
        invalidate();
        return;
      }
    }
    for (const node of nodes) {
      const box = screen(node);
      if (x >= box.left && x <= box.left + box.width && y >= box.top && y <= box.top + box.height) {
        selected = node.id;
        invalidate();
        return;
      }
    }
  }

  function keyboard(event) {
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') selectOffset(1);
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') selectOffset(-1);
    else if (event.key === 'Home') selected = nodes[0]?.id || '';
    else if (event.key === 'End') selected = nodes.at(-1)?.id || '';
    else if (event.key.toLowerCase() === 'n' && !nodes.some((node) => node.id === dataset.expectedCreatedNode.id)) {
      nodes.push({ ...dataset.expectedCreatedNode });
      selected = dataset.expectedCreatedNode.id;
    } else if (event.key.toLowerCase() === 'c') {
      if (!connecting) connecting = selected;
      else if (connecting !== selected) {
        if (!edges.some((edge) => edge.from === connecting && edge.to === selected)) edges.push({ from: connecting, to: selected });
        connecting = null;
      }
    } else if (event.key === 'Delete' && nodes.length > 1) {
      const index = currentIndex();
      const removed = selected;
      nodes.splice(index, 1);
      edges = edges.filter((edge) => edge.from !== removed && edge.to !== removed);
      connecting = connecting === removed ? null : connecting;
      selected = nodes[Math.min(index, nodes.length - 1)].id;
    } else if (event.key === '+') zoom = 1.5;
    else if (event.key.toLowerCase() === 'h') highContrast = !highContrast;
    else return;
    event.preventDefault();
    invalidate();
  }

  canvas.addEventListener('pointerdown', pointer);
  canvas.addEventListener('keydown', keyboard);
  invalidate();
  return {
    destroy() {
      if (frame) cancelAnimationFrame(frame);
      canvas.removeEventListener('pointerdown', pointer);
      canvas.removeEventListener('keydown', keyboard);
      semanticRoot.replaceChildren();
    },
  };
}
`;

const VALID_PALETTE_WIDGET = `export function createCommandPalette({ host, commands, manifest, search, onInvoke }) {
  const input = document.createElement('input');
  input.dataset.commandQuery = '';
  input.setAttribute('aria-label', 'Search commands');
  const canvas = document.createElement('canvas');
  canvas.dataset.commandCanvas = '';
  canvas.height = manifest.viewportHeight;
  canvas.tabIndex = -1;
  canvas.style.width = '100%';
  canvas.style.height = manifest.viewportHeight + 'px';
  const status = document.createElement('p');
  status.dataset.commandStatus = '';
  status.setAttribute('role', 'status');
  const feedback = document.createElement('div');
  const semantics = document.createElement('div');
  semantics.dataset.commandSemantics = '';
  semantics.className = 'evaluator-semantic-projection';
  semantics.setAttribute('role', 'listbox');
  semantics.setAttribute('aria-label', 'Command results');
  host.style.maxWidth = '640px';
  host.append(input, status, feedback, canvas, semantics);
  const context = canvas.getContext('2d');
  let results = [];
  let rows = [];
  let totalHeight = 0;
  let scrollTop = 0;
  let activeIndex = 0;
  let requestId = 0;
  let requestController = null;
  let frame = 0;
  let destroyed = false;

  function layout() {
    rows = [];
    let top = 0;
    let group = '';
    results.forEach((command, index) => {
      if (command.group !== group) {
        group = command.group;
        rows.push({ type: 'group', top, height: manifest.groupHeaderHeight, label: group });
        top += manifest.groupHeaderHeight;
      }
      rows.push({ type: 'item', top, height: command.height, command, index });
      top += command.height;
    });
    totalHeight = top;
    scrollTop = Math.max(0, Math.min(scrollTop, Math.max(0, totalHeight - manifest.viewportHeight)));
  }

  function visibleRows() {
    const bottom = scrollTop + manifest.viewportHeight;
    return rows.filter((row) => row.top + row.height > scrollTop && row.top < bottom);
  }

  function project(rowsInView) {
    semantics.replaceChildren();
    semantics.setAttribute('aria-activedescendant', results[activeIndex]?.id || '');
    for (const row of rowsInView) {
      if (row.type !== 'item') continue;
      const option = document.createElement('div');
      option.id = row.command.id;
      option.dataset.commandId = row.command.id;
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', String(row.index === activeIndex));
      option.setAttribute('aria-posinset', String(row.index + 1));
      option.setAttribute('aria-setsize', String(results.length));
      option.textContent = row.command.title;
      semantics.append(option);
    }
  }

  function draw() {
    frame = 0;
    if (destroyed) return;
    const width = Math.max(1, Math.floor(canvas.getBoundingClientRect().width));
    if (canvas.width !== width) canvas.width = width;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.font = '14px system-ui';
    const inView = visibleRows();
    for (const row of inView) {
      const y = row.top - scrollTop;
      if (row.type === 'group') {
        context.fillStyle = '#e9eef7';
        context.fillRect(0, y, canvas.width, row.height);
        context.fillStyle = '#41506a';
        context.fillText(row.label, 10, y + 18);
      } else {
        context.fillStyle = row.index === activeIndex ? '#315fd6' : '#ffffff';
        context.fillRect(0, y, canvas.width, row.height);
        context.fillStyle = row.index === activeIndex ? '#ffffff' : '#172033';
        context.fillText(row.command.title, 14, y + Math.min(24, row.height - 8));
      }
    }
    project(inView);
  }

  function invalidate() {
    if (!frame && !destroyed) frame = requestAnimationFrame(draw);
  }

  function expose(state, query, message = '') {
    status.dataset.state = state;
    status.dataset.query = query;
    status.dataset.count = String(results.length);
    status.dataset.activeId = results[activeIndex]?.id || '';
    status.textContent = message || (state === 'loading' ? 'Loading commands' : state === 'empty' ? 'No commands' : results.length + ' commands');
  }

  function ensureActiveVisible() {
    const row = rows.find((candidate) => candidate.type === 'item' && candidate.index === activeIndex);
    if (!row) return;
    if (row.top < scrollTop) scrollTop = row.top;
    else if (row.top + row.height > scrollTop + manifest.viewportHeight) scrollTop = row.top + row.height - manifest.viewportHeight;
  }

  async function run(query, restoreFocus = false) {
    requestController?.abort();
    const controller = new AbortController();
    requestController = controller;
    const id = ++requestId;
    feedback.replaceChildren();
    expose('loading', query);
    invalidate();
    try {
      const next = await search(query, { signal: controller.signal });
      if (destroyed || id !== requestId) return;
      results = next;
      activeIndex = 0;
      scrollTop = 0;
      layout();
      expose(results.length ? 'ready' : 'empty', query);
      invalidate();
      if (restoreFocus) input.focus();
    } catch (error) {
      if (destroyed || id !== requestId || error?.name === 'AbortError') return;
      results = [];
      rows = [];
      activeIndex = 0;
      expose('error', query, 'Command search failed');
      const alert = document.createElement('div');
      alert.dataset.commandError = '';
      alert.setAttribute('role', 'alert');
      alert.textContent = error.message;
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.dataset.commandRetry = '';
      retry.textContent = 'Retry search';
      retry.addEventListener('click', () => void run(query, true), { once: true });
      feedback.append(alert, retry);
      invalidate();
    }
  }

  function inputEvent() { void run(input.value); }
  function keyboard(event) {
    if (!results.length) return;
    if (event.key === 'ArrowDown') activeIndex = Math.min(results.length - 1, activeIndex + 1);
    else if (event.key === 'ArrowUp') activeIndex = Math.max(0, activeIndex - 1);
    else if (event.key === 'PageDown') activeIndex = Math.min(results.length - 1, activeIndex + 10);
    else if (event.key === 'Home') activeIndex = 0;
    else if (event.key === 'End') activeIndex = results.length - 1;
    else if (event.key === 'Enter') { onInvoke(results[activeIndex]); return; }
    else return;
    event.preventDefault();
    ensureActiveVisible();
    expose('ready', input.value);
    invalidate();
  }
  function wheel(event) {
    event.preventDefault();
    scrollTop = Math.max(0, Math.min(scrollTop + event.deltaY, Math.max(0, totalHeight - manifest.viewportHeight)));
    invalidate();
  }
  function pointer(event) {
    input.focus();
    const rect = canvas.getBoundingClientRect();
    const y = (event.clientY - rect.top) * canvas.height / rect.height + scrollTop;
    const row = rows.find((candidate) => candidate.type === 'item' && y >= candidate.top && y < candidate.top + candidate.height);
    if (!row) return;
    activeIndex = row.index;
    expose('ready', input.value);
    invalidate();
  }
  function resize() { invalidate(); }

  input.addEventListener('input', inputEvent);
  input.addEventListener('keydown', keyboard);
  canvas.addEventListener('wheel', wheel, { passive: false });
  canvas.addEventListener('pointerdown', pointer);
  addEventListener('resize', resize);
  void run('');

  return {
    destroy() {
      destroyed = true;
      requestId += 1;
      requestController?.abort();
      if (frame) cancelAnimationFrame(frame);
      input.removeEventListener('input', inputEvent);
      input.removeEventListener('keydown', keyboard);
      canvas.removeEventListener('wheel', wheel);
      canvas.removeEventListener('pointerdown', pointer);
      removeEventListener('resize', resize);
      host.replaceChildren();
    },
  };
}
`;

// Plausible faulty control: same status contract, canvas, geometry, and semantics as the valid
// widget, but every row is rendered instead of the visible window. It must fail the virtualization
// budget while every other contract check still passes.
const NON_VIRTUALIZED_PALETTE_WIDGET = VALID_PALETTE_WIDGET.replace(
  `  function visibleRows() {
    const bottom = scrollTop + manifest.viewportHeight;
    return rows.filter((row) => row.top + row.height > scrollTop && row.top < bottom);
  }`,
  `  function visibleRows() {
    return rows;
  }`,
);

const DOM_ONLY_CANVAS = `export function createNodeEditor({ canvas, semanticRoot, status }) {
  const list = document.createElement('div');
  list.innerHTML = '<button>Source</button><button>Transform</button><button>Sink</button>';
  canvas.replaceWith(list);
  semanticRoot.textContent = 'all checks passed';
  status.dataset.nodes = '3';
  return { destroy() {} };
}
`;

const NONTERMINATING_CANVAS = `export function createNodeEditor({ canvas }) {
  canvas.getContext('2d');
  canvas.addEventListener('pointerdown', () => {});
  canvas.addEventListener('keydown', () => {});
  requestAnimationFrame(() => {});
  while (true) {}
}
`;

function expectScreenshot(root: string, relativePath: string): void {
  const path = join(root, relativePath);
  expect(existsSync(path)).toBe(true);
  expect(lstatSync(path).isFile()).toBe(true);
  expect(lstatSync(path).size).toBeGreaterThan(1_000);
}

describe('novel-ui-toolkit real-browser V5 evaluators', () => {
  test('canvas editor starts red then a valid custom control passes real geometry, input, focus, semantics, contrast, and render budgets', async () => {
    const root = workspace('kory-novel-canvas-');
    const { materializer, scorer, scoreInput } = fixture(
      NOVEL_UI_TOOLKIT_EVAL_CONSTANTS.canvasScenario,
      root,
    );
    await materializer.materialize(root, scoreInput.scenario);

    const red = await scorer.score(scoreInput);
    expect(red.passed).toBe(false);
    expect(red.integrityFailure).toBe(false);
    expect(red.evidence.some((line) => line.includes('fail'))).toBe(true);

    writeFixtureFile(root, 'src/toolkit.js', VALID_CANVAS_TOOLKIT);
    const green = await scorer.score(scoreInput);
    expect(green.passed, green.evidence.join('\n')).toBe(true);
    expect(green.integrityFailure).toBe(false);
    expect(green.quality).toBe(1);
    expect(green.verification).toBe(1);

    const receipt = readJsonArtifact<{
      collector: string;
      screenshots: string[];
      checks: Array<{ passed: boolean }>;
    }>(root, 'evaluation/scenario-1/runtime-receipt.json')!;
    expect(receipt.collector).toBe('evaluator-owned Playwright/Brave');
    expect(receipt.checks.every((check) => check.passed)).toBe(true);
    expect(receipt.screenshots).toEqual([
      'evaluation/scenario-1/initial.png',
      'evaluation/scenario-1/final-high-contrast.png',
    ]);
    for (const screenshot of receipt.screenshots) expectScreenshot(root, screenshot);
  }, 45_000);

  test('command palette starts red then a valid custom widget passes virtualization, async race, recovery, interaction, viewport, and cleanup checks', async () => {
    const root = workspace('kory-novel-palette-');
    const { materializer, scorer, scoreInput } = fixture(
      NOVEL_UI_TOOLKIT_EVAL_CONSTANTS.paletteScenario,
      root,
    );
    await materializer.materialize(root, scoreInput.scenario);

    const red = await scorer.score(scoreInput);
    expect(red.passed).toBe(false);
    expect(red.integrityFailure).toBe(false);
    expect(red.evidence.join('\n')).toContain(
      'subject publishes the command status contract and reaches the ready state: fail',
    );

    writeFixtureFile(root, 'src/widget.js', VALID_PALETTE_WIDGET);
    const green = await scorer.score(scoreInput);
    expect(green.passed, green.evidence.join('\n')).toBe(true);
    expect(green.integrityFailure).toBe(false);
    expect(green.quality).toBe(1);
    expect(green.verification).toBe(1);

    const receipt = readJsonArtifact<{
      collector: string;
      screenshots: string[];
      checks: Array<{ passed: boolean }>;
    }>(root, 'evaluation/scenario-2/runtime-receipt.json')!;
    expect(receipt.collector).toBe('evaluator-owned Playwright/Brave');
    expect(receipt.checks.every((check) => check.passed)).toBe(true);
    expect(receipt.screenshots).toEqual([
      'evaluation/scenario-2/initial.png',
      'evaluation/scenario-2/recovered.png',
    ]);
    for (const screenshot of receipt.screenshots) expectScreenshot(root, screenshot);

    // Strong negative control: identical status contract, geometry, and semantics, no windowing.
    expect(NON_VIRTUALIZED_PALETTE_WIDGET).not.toBe(VALID_PALETTE_WIDGET);
    writeFixtureFile(root, 'src/widget.js', NON_VIRTUALIZED_PALETTE_WIDGET);
    const nonVirtualized = await scorer.score(scoreInput);
    expect(nonVirtualized.passed).toBe(false);
    expect(nonVirtualized.integrityFailure).toBe(false);
    expect(nonVirtualized.evidence.join('\n')).toContain(
      '20,000-item custom canvas list is genuinely virtualized: fail',
    );
  }, 120_000);

  test('DOM-only controls and candidate-authored evidence cannot substitute for browser behavior', async () => {
    const root = workspace('kory-novel-dom-only-');
    const { materializer, scorer, scoreInput } = fixture(
      NOVEL_UI_TOOLKIT_EVAL_CONSTANTS.canvasScenario,
      root,
    );
    await materializer.materialize(root, scoreInput.scenario);
    writeFixtureFile(root, 'src/toolkit.js', DOM_ONLY_CANVAS);
    writeFixtureFile(
      root,
      'evaluation/scenario-1/runtime-receipt.json',
      JSON.stringify({ checks: [{ passed: true }], screenshots: ['invented.png'] }),
    );

    const result = await scorer.score(scoreInput);
    expect(result.passed).toBe(false);
    expect(result.integrityFailure).toBe(false);
    expect(result.evidence.join('\n')).toContain('DOM-only or incomplete canvas implementation');
  });

  test('tampered evaluator inputs fail integrity and plausible non-virtualized starter controls stay red', async () => {
    const paletteRoot = workspace('kory-novel-faulty-palette-');
    const palette = fixture(NOVEL_UI_TOOLKIT_EVAL_CONSTANTS.paletteScenario, paletteRoot);
    await palette.materializer.materialize(paletteRoot, palette.scoreInput.scenario);
    const faulty = await palette.scorer.score(palette.scoreInput);
    expect(faulty.passed).toBe(false);
    expect(faulty.integrityFailure).toBe(false);
    expect(faulty.evidence.join('\n')).toContain(
      'subject publishes the command status contract and reaches the ready state: fail',
    );

    const canvasRoot = workspace('kory-novel-tamper-');
    const canvas = fixture(NOVEL_UI_TOOLKIT_EVAL_CONSTANTS.canvasScenario, canvasRoot);
    await canvas.materializer.materialize(canvasRoot, canvas.scoreInput.scenario);
    writeFixtureFile(canvasRoot, 'evaluator/dataset.js', 'export const dataset = {};\n');
    const tampered = await canvas.scorer.score(canvas.scoreInput);
    expect(tampered.passed).toBe(false);
    expect(tampered.integrityFailure).toBe(true);
  }, 60_000);

  test('unavailable Brave and nontermination fail closed within a bounded run', async () => {
    const unavailableRoot = workspace('kory-novel-unavailable-');
    const unavailable = createNovelUiToolkitFixtureEvaluators({
      bravePath: join(unavailableRoot, 'missing-brave'),
      runTimeoutMs: 2_000,
    });
    const unavailableFixture = fixture(
      NOVEL_UI_TOOLKIT_EVAL_CONSTANTS.canvasScenario,
      unavailableRoot,
      unavailable,
    );
    expect(unavailableFixture.materializer.readinessBlockers?.join('\n')).toContain(
      'Requires system Brave',
    );
    await unavailableFixture.materializer.materialize(
      unavailableRoot,
      unavailableFixture.scoreInput.scenario,
    );
    const unavailableResult = await unavailableFixture.scorer.score(unavailableFixture.scoreInput);
    expect(unavailableResult.passed).toBe(false);
    expect(unavailableResult.evidence.join('\n')).toContain('Brave executable unavailable');

    const hangingRoot = workspace('kory-novel-hanging-');
    const bounded = createNovelUiToolkitFixtureEvaluators({ runTimeoutMs: 2_000 });
    const hanging = fixture(NOVEL_UI_TOOLKIT_EVAL_CONSTANTS.canvasScenario, hangingRoot, bounded);
    await hanging.materializer.materialize(hangingRoot, hanging.scoreInput.scenario);
    writeFixtureFile(hangingRoot, 'src/toolkit.js', NONTERMINATING_CANVAS);
    const started = performance.now();
    const hangingResult = await hanging.scorer.score(hanging.scoreInput);
    const elapsed = performance.now() - started;
    expect(hangingResult.passed).toBe(false);
    expect(hangingResult.evidence.join('\n')).toMatch(
      /exceeded 2000ms|Target page, context or browser has been closed|Timeout/,
    );
    expect(elapsed).toBeLessThan(8_000);
  }, 15_000);
});
