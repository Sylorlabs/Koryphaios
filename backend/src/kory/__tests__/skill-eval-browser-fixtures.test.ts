import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BROWSER_EVAL_CONSTANTS,
  BROWSER_SKILL_EVAL_MATERIALIZERS,
  BROWSER_SKILL_EVAL_SCORERS,
} from '../../eval/skills/skill-eval-browser-fixtures';
import {
  BUILTIN_SKILL_EVAL_MATERIALIZERS,
  BUILTIN_SKILL_EVAL_SCORERS,
} from '../../eval/skills/skill-eval-fixtures';
import { auditSkillEvalExecutionReadiness } from '../../eval/skills/skill-eval-execution';
import { readJsonArtifact, writeFixtureFile } from '../../eval/skills/skill-eval-fixture-helpers';
import { buildSkillEvalSuiteV3 } from '../../eval/skills/skill-eval-harness';
import { loadV5SkillPackages } from '../skill-packages';
import { browserControlTest } from './browser-runtime-test-policy';

const roots: string[] = [];
const browserTest = browserControlTest('Web browser', BROWSER_SKILL_EVAL_MATERIALIZERS[0].readinessBlockers ?? []);
const visualTest = browserControlTest('Dashboard browser', BROWSER_SKILL_EVAL_MATERIALIZERS[2].readinessBlockers ?? []);

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scenarioById(id: string) {
  for (const skill of loadV5SkillPackages().packages) {
    const scenario = buildSkillEvalSuiteV3(skill).scenarios.find((item) => item.id === id);
    if (scenario) return scenario;
  }
  throw new Error(`Scenario ${id} not found`);
}

function workspace(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

const GREEN_CONSOLE_APP = `
const app = document.querySelector('#app');
const labels = {
  queued: 'Queued', running: 'Running', partial: 'Partial results', stale: 'Stale data',
  completed: 'Completed', failed: 'Failed', 'cancellation-requested': 'Cancellation requested',
  'cancellation-failed': 'Cancellation failed', retrying: 'Retrying'
};
let currentJob = null;
let restoreFocus = null;

const routeId = () => location.pathname.split('/').filter(Boolean).at(-1) || 'job-running';
const apiSuffix = () => location.search;

function shell(content) {
  app.innerHTML = \`<nav aria-label="Operation examples"><a data-nav href="/jobs/job-running">Running job</a><a data-nav href="/jobs/job-failed">Failed job</a></nav><section class="panel">\${content}</section>\`;
  for (const link of app.querySelectorAll('a[data-nav]')) {
    link.addEventListener('click', (event) => {
      event.preventDefault();
      history.pushState({}, '', link.getAttribute('href'));
      void load();
    });
  }
}

function renderJob(job) {
  currentJob = job;
  const cancel = ['running','partial','stale'].includes(job.state) ? '<button id="cancel-job" type="button">Cancel job</button>' : '';
  const retry = ['failed','cancellation-failed'].includes(job.state) ? '<button id="retry-job" type="button">Retry job</button>' : '';
  shell(\`<h1>Operations</h1><h2 class="job-title">\${job.title}</h2><p class="state" data-job-state="\${job.state}">\${labels[job.state]}</p><div class="actions">\${cancel}\${retry}</div><dialog id="cancel-dialog" role="dialog" aria-labelledby="cancel-title"><h3 id="cancel-title">Cancel this job?</h3><p>Cancellation can be requested but is not guaranteed complete.</p><button id="confirm-cancel" type="button">Request cancellation</button><button id="dismiss-cancel" type="button">Keep running</button></dialog>\`);
  const cancelButton = document.querySelector('#cancel-job');
  const dialog = document.querySelector('#cancel-dialog');
  if (cancelButton && dialog) {
    cancelButton.addEventListener('click', () => { restoreFocus = cancelButton; dialog.showModal(); });
    dialog.addEventListener('close', () => restoreFocus?.focus());
    document.querySelector('#dismiss-cancel').addEventListener('click', () => dialog.close());
    document.querySelector('#confirm-cancel').addEventListener('click', async () => {
      dialog.close();
      const response = await fetch('/api/jobs/' + encodeURIComponent(currentJob.id) + '/cancel', { method: 'POST' });
      if (!response.ok) return renderFailure('Cancellation request failed');
      renderJob(await response.json());
    });
  }
  document.querySelector('#retry-job')?.addEventListener('click', async () => {
    const response = await fetch('/api/jobs/' + encodeURIComponent(currentJob.id) + '/retry', { method: 'POST' });
    if (!response.ok) return renderFailure('Retry request failed');
    renderJob(await response.json());
  });
}

function renderFailure(message) {
  shell(\`<h1>Operations</h1><div role="alert"><p>\${message}</p><button id="reload-job" type="button">Try again</button></div>\`);
  document.querySelector('#reload-job').addEventListener('click', () => void load());
}

async function load() {
  shell('<h1>Operations</h1><div aria-busy="true">Loading job…</div>');
  try {
    const response = await fetch('/api/jobs/' + encodeURIComponent(routeId()) + apiSuffix());
    if (!response.ok) return renderFailure('Unable to load job');
    renderJob(await response.json());
  } catch {
    renderFailure('Unable to load job');
  }
}

addEventListener('popstate', () => void load());
void load();
`;

const GREEN_CONSOLE_STYLE = `
main { width:min(1040px,calc(100% - 28px)); margin:24px auto; min-width:0; }
nav { display:flex; flex-wrap:wrap; gap:var(--space-3); margin-bottom:var(--space-4); }
.panel { min-width:0; padding:var(--space-6); background:var(--panel); border:1px solid var(--border); border-radius:var(--radius); }
.job-title { max-width:100%; overflow-wrap:anywhere; }
.state { font-weight:700; color:var(--muted); }
.actions { display:flex; flex-wrap:wrap; gap:var(--space-2); }
button { min-height:42px; border:1px solid var(--border); border-radius:var(--radius); background:var(--panel); color:var(--text); padding:8px 12px; }
#cancel-job,#confirm-cancel,#retry-job { background:var(--accent); color:white; border-color:var(--accent); }
dialog { width:min(460px,calc(100% - 32px)); border:1px solid var(--border); border-radius:var(--radius); color:var(--text); background:var(--panel); }
dialog::backdrop { background:#0007; }
@media (max-width:500px) { .panel { padding:var(--space-4); } }
`;

const GREEN_CONTENT_APP = `
const app = document.querySelector('#app');
app.innerHTML = \`
<header class="site-header"><nav aria-label="Primary"><a href="/">Relay Mesh</a><a href="/docs">Architecture</a></nav></header>
<main>
  <section class="hero" aria-labelledby="hero-title">
    <div class="hero-copy"><p class="eyebrow">Event delivery infrastructure</p><img class="logo" src="/assets/logo.svg" alt="Relay Mesh" width="220" height="48"><h1 id="hero-title">Trace every delivery. Recover without guessing.</h1><p data-product-summary>Relay Mesh gives platform teams a replayable event ledger, explicit delivery state, and scoped recovery controls for webhook and queue workloads.</p><div class="actions"><a class="primary" href="/evaluation">Evaluate Relay Mesh</a><a class="secondary" href="/docs">Read the architecture</a></div></div>
    <img class="product-shot" src="/assets/product.svg" alt="Relay Mesh delivery inspector showing attempts and recovery controls">
  </section>
  <section class="evidence" aria-labelledby="evidence-title"><h2 id="evidence-title">Recovery evidence stays with the operation</h2><p data-product-detail>Inspect attempts, isolate failed destinations, and replay only the work you intend. Relay Mesh keeps delivery evidence attached to the operation so incident review does not depend on transient logs.</p></section>
</main>
<footer><p>Relay Mesh evaluation fixture</p></footer>\`;
`;

const GREEN_CONTENT_STYLE = `
.site-header,main,footer { width:min(1120px,calc(100% - 32px)); margin-inline:auto; }
.site-header { padding:20px 0; }
nav { display:flex; flex-wrap:wrap; justify-content:space-between; gap:var(--space-2); }
.hero { display:grid; grid-template-columns:minmax(0,1fr) minmax(280px,.85fr); gap:clamp(24px,5vw,64px); align-items:center; padding:clamp(36px,8vw,88px) 0; }
.hero-copy,.evidence { min-width:0; }
.eyebrow { color:var(--accent); font-weight:700; }
.logo { max-width:100%; height:auto; }
h1 { max-width:15ch; font-size:clamp(2.25rem,6vw,4.75rem); line-height:1; letter-spacing:-.045em; overflow-wrap:anywhere; }
p { max-width:68ch; overflow-wrap:anywhere; }
.actions { display:flex; flex-wrap:wrap; gap:var(--space-2); margin-top:var(--space-3); }
.primary,.secondary { display:inline-flex; align-items:center; min-height:44px; padding:.75rem 1rem; border-radius:var(--radius); text-decoration:none; }
.primary { color:white; background:var(--accent); border:1px solid var(--accent); font-weight:700; }
.secondary { color:var(--ink); background:transparent; border:1px solid #94a3b8; }
.product-shot { display:block; width:100%; max-width:100%; height:auto; border-radius:var(--radius); }
.evidence { border-top:1px solid #cbd5e1; padding:var(--space-6) 0; }
footer { padding:var(--space-4) 0; border-top:1px solid #cbd5e1; }
@media (max-width:720px) { .hero { grid-template-columns:1fr; } h1 { max-width:none; } }
@media (prefers-reduced-motion: reduce) { *,*::before,*::after { animation:none !important; transition:none !important; scroll-behavior:auto !important; } }
`;

async function scoreScenario(id: string, root: string) {
  const scenario = scenarioById(id);
  const materializer = BROWSER_SKILL_EVAL_MATERIALIZERS.find((item) => item.matches(scenario))!;
  const scorer = BROWSER_SKILL_EVAL_SCORERS.find((item) => item.scenarioIds.includes(id))!;
  await materializer.materialize(root, scenario);
  return {
    scenario,
    scorer,
    input: {
      scenario,
      experiment: {} as never,
      workingDirectory: root,
      observation: { output: '', evidence: [], artifacts: [], durationMs: 0 },
    },
  };
}

describe('real browser V5 fixtures', () => {
  browserTest('async operations console starts red then passes real URL/history/focus/network/viewport checks', async () => {
    const root = workspace('kory-browser-console-');
    const { scorer, input } = await scoreScenario(
      'web-interface-full-task-async-operations-console',
      root,
    );
    const red = await scorer.score(input);
    expect(red.passed).toBe(false);
    expect(red.integrityFailure).toBe(false);

    writeFixtureFile(root, 'src/app.js', GREEN_CONSOLE_APP);
    writeFixtureFile(root, 'src/styles.css', GREEN_CONSOLE_STYLE);
    writeFixtureFile(
      root,
      'verification/web-interface-implementation-contract.json',
      `${JSON.stringify(
        {
          backendContractVersion: BROWSER_EVAL_CONSTANTS.asyncBackendContractVersion,
          states: BROWSER_EVAL_CONSTANTS.jobStates,
          routing: { deepLinks: true, history: true, refresh: true },
          focus: { dialogRestore: true, keyboardActions: true },
          network: { slow: true, failed: true, stale: true },
          cancellationSemantics: 'Backend acknowledgement records cancellation-requested only.',
          retrySemantics: 'Backend acknowledgement records retrying only.',
          designSystem: BROWSER_EVAL_CONSTANTS.consoleDesignSystem,
        },
        null,
        2,
      )}\n`,
    );
    writeFixtureFile(
      root,
      'verification/browser-state-and-viewport-matrix.json',
      `${JSON.stringify(
        {
          viewports: ['1440x900', '390x844'],
          states: BROWSER_EVAL_CONSTANTS.jobStates,
          networkStates: ['slow', 'failed', 'stale'],
          evidenceType: 'real-browser',
        },
        null,
        2,
      )}\n`,
    );

    const green = await scorer.score(input);
    expect(green.passed, green.evidence.join('\n')).toBe(true);
    expect(green.integrityFailure).toBe(false);
    expect(green.quality).toBe(1);
    expect(green.verification).toBe(1);
  }, 60_000);

  browserTest('content-led page starts red then passes supplied-content, semantic, accessibility, responsive, and reduced-motion checks', async () => {
    const root = workspace('kory-browser-content-');
    const { scorer, input } = await scoreScenario(
      'web-interface-full-task-content-led-product-page',
      root,
    );
    const red = await scorer.score(input);
    expect(red.passed).toBe(false);
    expect(red.integrityFailure).toBe(false);

    writeFixtureFile(root, 'src/app.js', GREEN_CONTENT_APP);
    writeFixtureFile(root, 'src/styles.css', GREEN_CONTENT_STYLE);
    writeFixtureFile(
      root,
      'verification/content-led-web-interface-plan.json',
      `${JSON.stringify(
        {
          contentVersion: BROWSER_EVAL_CONSTANTS.contentVersion,
          audience: BROWSER_EVAL_CONSTANTS.contentAudience,
          primaryAction: BROWSER_EVAL_CONSTANTS.contentPrimaryAction,
          secondaryAction: BROWSER_EVAL_CONSTANTS.contentSecondaryAction,
          assetUse: ['logo.svg', 'product.svg'],
          unsupportedClaimsAdded: false,
          designSystem: BROWSER_EVAL_CONSTANTS.contentBrandVersion,
        },
        null,
        2,
      )}\n`,
    );
    writeFixtureFile(
      root,
      'verification/responsive-browser-verification-contract.json',
      `${JSON.stringify(
        {
          viewports: ['1440x900', '390x844'],
          longContent: true,
          largeText: true,
          reducedMotion: true,
          keyboard: true,
          semanticStructure: true,
          runtimeConsole: true,
          evidenceType: 'real-browser',
        },
        null,
        2,
      )}\n`,
    );

    const green = await scorer.score(input);
    expect(green.passed, green.evidence.join('\n')).toBe(true);
    expect(green.integrityFailure).toBe(false);
    expect(green.quality).toBe(1);
  }, 60_000);

  visualTest('visual verification starts red and only passes when the candidate audit matches the real 24-capture browser matrix', async () => {
    const root = workspace('kory-browser-visual-');
    const { scorer, input } = await scoreScenario('visual-verification-full-task-1', root);
    const red = await scorer.score(input);
    expect(red.passed).toBe(false);
    expect(red.integrityFailure).toBe(false);

    const independent = readJsonArtifact<{
      browserVersion: string;
      metrics: Array<{
        captureId: string;
        width: number;
        height: number;
        theme: 'light' | 'dark';
        state: 'loading' | 'empty' | 'normal' | 'dense';
        horizontalOverflow: boolean;
        chartClipped: boolean;
        legendClipped: boolean;
        stickyOverlap: boolean;
        primaryActionDistinct: boolean;
      }>;
    }>(root, 'evaluation/visual-verification/independent-matrix.json')!;
    expect(independent.metrics).toHaveLength(24);
    const failures = independent.metrics.flatMap((metric) => {
      const result: string[] = [];
      if (metric.horizontalOverflow) result.push(`${metric.captureId}:horizontal-overflow`);
      if (metric.chartClipped) result.push(`${metric.captureId}:chart-clipping`);
      if (metric.legendClipped) result.push(`${metric.captureId}:legend-clipping`);
      if (metric.stickyOverlap) result.push(`${metric.captureId}:sticky-header-overlap`);
      if (!metric.primaryActionDistinct)
        result.push(`${metric.captureId}:primary-action-not-distinct`);
      return result;
    });
    expect(
      failures.some((failure) => failure.includes('390x844') && failure.includes('dense')),
    ).toBe(true);

    writeFixtureFile(
      root,
      'verification/visual-verification-scenario-1-capture-matrix.json',
      `${JSON.stringify(
        {
          environment: {
            dpr: 1,
            font: BROWSER_EVAL_CONSTANTS.dashboardFont,
            animations: 'disabled',
            dataset: 'fixture-v1',
            browserVersion: independent.browserVersion,
          },
          entries: independent.metrics,
        },
        null,
        2,
      )}\n`,
    );
    writeFixtureFile(
      root,
      'verification/visual-verification-scenario-1-claim-audit.json',
      `${JSON.stringify(
        {
          failures,
          renderingNoisePolicy:
            'Treat differences as rendering noise until DPR, font, animation, dataset, and browser runtime are held constant.',
        },
        null,
        2,
      )}\n`,
    );
    writeFixtureFile(
      root,
      'verification/visual-verification-scenario-1-verdict.md',
      '# Visual verification verdict\n\nThe 390px dense state has meaningful horizontal overflow in both light and dark themes. Other measured claims are judged only after holding DPR, font, animation state, dataset, and browser runtime constant so rendering noise is not mislabeled as product drift.\n',
    );

    const green = await scorer.score(input);
    expect(green.passed, green.evidence.join('\n')).toBe(true);
    expect(green.integrityFailure).toBe(false);
    expect(green.quality).toBe(1);
  }, 90_000);

  test('browser fixtures supersede the generic external gates in readiness', () => {
    const rows = auditSkillEvalExecutionReadiness(
      loadV5SkillPackages().packages,
      BUILTIN_SKILL_EVAL_MATERIALIZERS,
      BUILTIN_SKILL_EVAL_SCORERS,
    );
    for (const id of [
      'web-interface-full-task-async-operations-console',
      'web-interface-full-task-content-led-product-page',
      'visual-verification-full-task-1',
    ]) {
      const row = rows.find((item) => item.scenarioId === id)!;
      const materializer = BROWSER_SKILL_EVAL_MATERIALIZERS.find((item) => item.id === row.materializerId)!;
      expect(materializer, id).toBeDefined();
      const blockers = materializer.readinessBlockers ?? [];
      expect(row.ready, id).toBe(blockers.length === 0);
      expect(row.reasons, id).toEqual(blockers);
      expect(row.materializerId, id).toContain('real-browser');
      expect(row.deterministicScorerId, id).toContain('real-browser');
    }
  });

  test('fixed browser evidence fails integrity when the candidate tampers with it', async () => {
    const root = workspace('kory-browser-tamper-');
    const { scorer, input } = await scoreScenario(
      'web-interface-full-task-async-operations-console',
      root,
    );
    writeFixtureFile(root, 'evidence/backend-contract.json', '{}\n');
    const score = await scorer.score(input);
    expect(score.passed).toBe(false);
    expect(score.integrityFailure).toBe(true);
  });
});
