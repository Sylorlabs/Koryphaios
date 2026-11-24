import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import type {
  SkillEvalDeterministicScore,
  SkillEvalDeterministicScorer,
  SkillEvalFixtureMaterializer,
} from './skill-eval-execution';
import { readFixtureText, readJsonArtifact, writeFixtureFile } from './skill-eval-fixture-helpers';

const BRAVE_PATH = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
// From backend/src/eval/skills three levels up lands on `backend/`, which made
// the eval copy look for `backend/frontend` and report the bundled Inter font
// as missing on a host that has it installed. Locate the root by the workspace
// it owns (the same disambiguation the Svelte fixtures use).
const PROJECT_ROOT =
  [resolve(MODULE_DIR, '../../..'), resolve(MODULE_DIR, '../../../..')].find((candidate) =>
    existsSync(join(candidate, 'frontend', 'package.json')),
  ) ?? resolve(MODULE_DIR, '../../..');
const INTER_FONT_SOURCE = join(
  PROJECT_ROOT,
  'frontend/node_modules/@fontsource/inter/files/inter-latin-400-normal.woff2',
);
let sharedBrowser: Browser | null = null;
let sharedBrowserUsers = 0;
let sharedBrowserIdleTimer: ReturnType<typeof setTimeout> | null = null;

const ASYNC_CONSOLE = 'web-interface-full-task-async-operations-console';
const CONTENT_PAGE = 'web-interface-full-task-content-led-product-page';
const VISUAL_DASHBOARD = 'visual-verification-full-task-1';

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
const sha256 = (value: Buffer | string): string => createHash('sha256').update(value).digest('hex');

const JOB_STATES = [
  'queued',
  'running',
  'partial',
  'stale',
  'completed',
  'failed',
  'cancellation-requested',
  'cancellation-failed',
  'retrying',
] as const;

type JobState = (typeof JOB_STATES)[number];

const JOBS: Readonly<Record<string, { state: JobState; title: string }>> = {
  'job-queued': { state: 'queued', title: 'Import customer archive' },
  'job-running': { state: 'running', title: 'Rebuild analytics materializations' },
  'job-partial': {
    state: 'partial',
    title:
      'Reconcile multi-region historical event stream with an intentionally very long operation title that must remain usable',
  },
  'job-stale': { state: 'stale', title: 'Refresh stale account index' },
  'job-completed': { state: 'completed', title: 'Generate weekly reconciliation report' },
  'job-failed': { state: 'failed', title: 'Replay failed webhook batch' },
  'job-cancellation-requested': {
    state: 'cancellation-requested',
    title: 'Archive decommissioned workspace',
  },
  'job-cancellation-failed': {
    state: 'cancellation-failed',
    title: 'Cancel protected export',
  },
  'job-retrying': { state: 'retrying', title: 'Retry source synchronization' },
} as const;

const ASYNC_BACKEND_CONTRACT = {
  version: 'operations-backend-contract@1',
  states: JOB_STATES,
  routes: {
    detail: 'GET /api/jobs/:id',
    cancel: 'POST /api/jobs/:id/cancel',
    retry: 'POST /api/jobs/:id/retry',
  },
  cancellationGuarantee:
    'Cancel acknowledgement means cancellation-requested only; it does not guarantee cancellation completed.',
  retryGuarantee:
    'Retry acknowledgement means retrying only; it does not guarantee the operation will complete.',
} as const;

const CONSOLE_TOKENS = `:root {
  --surface: #f6f7f9;
  --panel: #ffffff;
  --text: #181b20;
  --muted: #5e6673;
  --accent: #2558d8;
  --danger: #b42318;
  --border: #d9dde5;
  --focus: #6f8fff;
  --radius: 8px;
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-6: 24px;
}
* { box-sizing: border-box; }
body { margin: 0; font: 16px/1.5 Inter, ui-sans-serif, system-ui, sans-serif; background: var(--surface); color: var(--text); }
a, button { font: inherit; }
:focus-visible { outline: 3px solid var(--focus); outline-offset: 2px; }
`;

const CONSOLE_INDEX = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Operations console</title>
    <link rel="stylesheet" href="/src/tokens.css" />
    <link rel="stylesheet" href="/src/styles.css" />
  </head>
  <body>
    <main id="app" aria-live="polite">Loading operation…</main>
    <script type="module" src="/src/app.js"></script>
  </body>
</html>
`;

const CONSOLE_STARTER_STYLE = `
main { width: 1024px; margin: 40px auto; padding: 24px; background: var(--panel); }
.job-title { white-space: nowrap; }
.actions { display: flex; gap: 8px; }
.fake-button { padding: 8px 12px; background: #ddd; cursor: pointer; }
`;

const CONSOLE_STARTER_APP = `
const app = document.querySelector('#app');
const id = location.pathname.split('/').filter(Boolean).at(-1) || 'job-running';
try {
  const response = await fetch('/api/jobs/' + encodeURIComponent(id) + location.search);
  if (!response.ok) throw new Error('request failed');
  const job = await response.json();
  const display = job.state === 'completed' ? 'Completed' : 'Running';
  app.innerHTML = '<h1>Operations</h1><h2 class="job-title">' + job.title + '</h2>' +
    '<p data-job-state="' + job.state + '">' + display + '</p>' +
    '<div class="actions"><div class="fake-button" onclick="location.reload()">Cancel</div></div>';
} catch {
  app.textContent = 'Something went wrong';
}
`;

const CONTENT_PACKET = {
  version: 'relay-content@1',
  audience: 'platform engineers evaluating event-delivery infrastructure',
  product: 'Relay Mesh',
  eyebrow: 'Event delivery infrastructure',
  headline: 'Trace every delivery. Recover without guessing.',
  summary:
    'Relay Mesh gives platform teams a replayable event ledger, explicit delivery state, and scoped recovery controls for webhook and queue workloads.',
  detail:
    'Inspect attempts, isolate failed destinations, and replay only the work you intend. Relay Mesh keeps delivery evidence attached to the operation so incident review does not depend on transient logs.',
  primaryAction: { label: 'Evaluate Relay Mesh', href: '/evaluation' },
  secondaryAction: { label: 'Read the architecture', href: '/docs' },
  screenshotAlt: 'Relay Mesh delivery inspector showing attempts and recovery controls',
  prohibitedClaims: [
    'guaranteed delivery',
    'zero downtime',
    'exactly once',
    'unlimited scale',
    'AI-powered',
  ],
} as const;

const CONTENT_BRAND = {
  version: 'relay-brand@1',
  ink: '#111827',
  paper: '#f8fafc',
  accent: '#1457d9',
  radius: '10px',
  principle: 'technical evidence before decorative chrome',
} as const;

const CONTENT_LOGO = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 220 48" role="img" aria-labelledby="title">
<title id="title">Relay Mesh</title><rect width="48" height="48" rx="10" fill="#1457d9"/>
<path d="M12 15h24v5H17v6h15v5H17v8h-5z" fill="white"/><text x="62" y="32" font-family="Arial,sans-serif" font-size="24" font-weight="700" fill="#111827">Relay Mesh</text></svg>\n`;

const CONTENT_SCREENSHOT = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 540" role="img" aria-labelledby="title">
<title id="title">Relay Mesh delivery inspector</title><rect width="960" height="540" fill="#0f172a"/><rect x="32" y="32" width="896" height="64" rx="8" fill="#1e293b"/>
<circle cx="64" cy="64" r="10" fill="#22c55e"/><rect x="92" y="52" width="260" height="24" rx="6" fill="#475569"/>
<rect x="32" y="120" width="560" height="380" rx="10" fill="#111827"/><rect x="616" y="120" width="312" height="380" rx="10" fill="#111827"/>
<g fill="#334155"><rect x="56" y="152" width="512" height="54" rx="7"/><rect x="56" y="220" width="512" height="54" rx="7"/><rect x="56" y="288" width="512" height="54" rx="7"/><rect x="56" y="356" width="512" height="54" rx="7"/></g>
<g fill="#64748b"><rect x="640" y="152" width="244" height="24" rx="5"/><rect x="640" y="194" width="196" height="18" rx="5"/><rect x="640" y="244" width="244" height="90" rx="7"/></g><rect x="640" y="438" width="168" height="38" rx="7" fill="#1457d9"/></svg>\n`;

const CONTENT_INDEX = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Relay Mesh</title>
    <link rel="stylesheet" href="/src/tokens.css" />
    <link rel="stylesheet" href="/src/styles.css" />
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/app.js"></script>
  </body>
</html>
`;

const CONTENT_TOKENS = `:root {
  --ink: ${CONTENT_BRAND.ink};
  --paper: ${CONTENT_BRAND.paper};
  --accent: ${CONTENT_BRAND.accent};
  --radius: ${CONTENT_BRAND.radius};
  --space-1: .5rem;
  --space-2: 1rem;
  --space-3: 1.5rem;
  --space-4: 2rem;
  --space-6: 3rem;
}
* { box-sizing: border-box; }
body { margin: 0; color: var(--ink); background: var(--paper); font: 16px/1.55 Inter, ui-sans-serif, system-ui, sans-serif; }
a { color: inherit; }
:focus-visible { outline: 3px solid #6f8fff; outline-offset: 3px; }
`;

const CONTENT_STARTER_STYLE = `
.page { width: 1180px; margin: 0 auto; }
.hero { min-height: 720px; padding: 72px 0; background: linear-gradient(135deg,#eef2ff,#fff); }
.hero h1 { font-size: 64px; white-space: nowrap; }
.actions { display: flex; gap: 12px; }
.action { display: inline-block; padding: 14px 20px; background: var(--accent); color: white; text-decoration: none; border-radius: 999px; }
.action.secondary { background: var(--accent); }
.product-shot { width: 960px; box-shadow: 0 24px 80px #0004; animation: float 2s infinite alternate; }
@keyframes float { to { transform: translateY(-12px); } }
`;

const CONTENT_STARTER_APP = `
const app = document.querySelector('#app');
app.innerHTML = \`<div class="page"><div class="hero"><img src="/assets/logo.svg" width="220" height="48" alt="Relay Mesh logo"><h1>Revolutionary infrastructure for everyone</h1><p>AI-powered delivery that just works.</p><div class="actions"><a class="action" href="/evaluation">Get started</a><a class="action secondary" href="/docs">Learn more</a></div><img class="product-shot" src="/assets/product.svg" alt="Product screenshot"></div></div>\`;
`;

const DASHBOARD_FONT_NAME = 'KoryEvalInter';
// Agents must be given the complete machine-readable artifact contract before the
// independent scorer can fairly evaluate their own rendered captures. The matrix is
// keyed by a capture id the evaluator also computes, so an undocumented id format
// makes the check unpassable rather than demanding.
const VISUAL_DASHBOARD_README = `# Responsive dashboard visual-verification fixture

Do not modify the dashboard, fixed reference, or bundled font. Verify the real rendered application
at 1440x900, 900x900, and 390x844 in light and dark themes across loading, empty, normal, and dense
states. Record the 24-cell matrix, every measurable failed claim, the stabilized environment, and a
grounded verdict under \`verification/\`. The dense state deliberately exercises the narrow support
boundary, so do not assume a happy path.

## Artifact contract (exact field names)

Capture id format: \`<width>x<height>-<theme>-<state>\`, for example \`390x844-dark-dense\`. The matrix
has 3 viewports x 2 themes x 4 states = 24 entries, one per capture id.

\`verification/visual-verification-scenario-1-capture-matrix.json\`

\`\`\`json
{
  "environment": {
    "dpr": 1,
    "font": "Inter",
    "animations": "disabled",
    "dataset": "fixture-v1",
    "browserVersion": "<the version string you observed>"
  },
  "entries": [
    {
      "captureId": "1440x900-light-normal",
      "width": 1440,
      "height": 900,
      "theme": "light",
      "state": "normal",
      "horizontalOverflow": false,
      "chartClipped": false,
      "legendClipped": false,
      "stickyOverlap": false,
      "primaryActionDistinct": true
    }
  ]
}
\`\`\`

Each boolean is your own measurement of that render. \`primaryActionDistinct\` is \`true\` when the
primary action is visually distinct from secondary controls.

\`verification/visual-verification-scenario-1-claim-audit.json\`

\`\`\`json
{
  "renderingNoisePolicy": "<how you neutralized rendering noise: font, dpr, animation, runtime>",
  "failures": ["390x844-dark-dense:horizontal-overflow"]
}
\`\`\`

A failure claim is \`<captureId>:<slug>\` using exactly one of \`horizontal-overflow\`,
\`chart-clipping\`, \`legend-clipping\`, \`sticky-header-overlap\`, \`primary-action-not-distinct\`.
Record a claim only for a defect you actually measured, and record every one you measured.

\`verification/visual-verification-scenario-1-verdict.md\` states the scope and must name the 390px
width, both themes, the dense state, the overflow observation, and your rendering-noise policy.

## How each boolean is measured

Render each cell at \`?theme=<light|dark>&state=<loading|empty|normal|dense>\` with a device scale
factor of 1 and \`prefers-reduced-motion: reduce\`, then measure these exact expressions. The
independent scorer evaluates the same expressions, so a different heuristic will disagree with it.

| Field | Measured as |
| --- | --- |
| \`horizontalOverflow\` | \`document.documentElement.scrollWidth > window.innerWidth + 1\` |
| \`chartClipped\` | \`.chart\` scrollWidth exceeds \`.chart-panel\` clientWidth by more than 1 |
| \`legendClipped\` | \`.legend\` scrollWidth exceeds its own clientWidth by more than 1 |
| \`stickyOverlap\` | \`.content\` top is above \`.topbar\` bottom minus 1 |
| \`primaryActionDistinct\` | the \`background-color|color|border-color\` triple of \`.primary-action\` differs from \`.secondary-action\` |

\`environment\` must record the scale factor (1), the font family actually applied, that animations
were disabled, the fixture dataset marker, and the browser version string you observed.
`;

const DASHBOARD_VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 900, height: 900 },
  { width: 390, height: 844 },
] as const;
const DASHBOARD_THEMES = ['light', 'dark'] as const;
const DASHBOARD_STATES = ['loading', 'empty', 'normal', 'dense'] as const;

const DASHBOARD_INDEX = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Northstar Analytics</title>
    <link rel="stylesheet" href="/src/styles.css" />
  </head>
  <body><div id="app"></div><script type="module" src="/src/app.js"></script></body>
</html>
`;

const DASHBOARD_STYLE = `
@font-face { font-family: '${DASHBOARD_FONT_NAME}'; src: url('/assets/inter.woff2') format('woff2'); font-weight: 400; font-style: normal; font-display: block; }
:root { --bg:#f5f7fb; --panel:#fff; --text:#172033; --muted:#667085; --accent:#2459d3; --border:#dce2ec; }
:root[data-theme='dark'] { --bg:#101521; --panel:#171e2d; --text:#f2f5fb; --muted:#a9b4c6; --accent:#7ea2ff; --border:#2b3548; }
* { box-sizing: border-box; animation: none !important; transition: none !important; }
html,body { margin:0; min-width:0; background:var(--bg); color:var(--text); font-family:'${DASHBOARD_FONT_NAME}', sans-serif; }
.shell { min-height:100vh; }
.topbar { position:sticky; top:0; z-index:5; display:flex; align-items:center; justify-content:space-between; min-height:64px; padding:12px 24px; background:var(--panel); border-bottom:1px solid var(--border); }
.brand { font-weight:700; letter-spacing:-.02em; }
.top-actions { display:flex; gap:10px; align-items:center; }
.primary-action,.secondary-action { min-height:40px; padding:9px 14px; border-radius:8px; border:1px solid var(--border); font:inherit; }
.primary-action { color:white; background:var(--accent); border-color:var(--accent); font-weight:700; }
.secondary-action { color:var(--text); background:var(--panel); }
.content { width:min(1180px,100%); margin:0 auto; padding:28px 24px 48px; }
.intro { display:flex; align-items:end; justify-content:space-between; gap:24px; margin-bottom:20px; }
.intro h1 { margin:0; font-size:clamp(28px,4vw,42px); line-height:1.08; }
.intro p { color:var(--muted); max-width:52ch; }
.grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:16px; }
.card,.chart-panel,.state-panel { min-width:0; background:var(--panel); border:1px solid var(--border); border-radius:12px; padding:18px; }
.card h2 { margin:0 0 8px; font-size:15px; line-height:1.3; overflow-wrap:anywhere; }
.metric { font-size:30px; font-weight:700; }
.badges { display:flex; flex-wrap:wrap; gap:6px; margin-top:12px; }
.badge { max-width:100%; padding:3px 7px; border-radius:999px; background:color-mix(in srgb,var(--accent) 12%,var(--panel)); border:1px solid color-mix(in srgb,var(--accent) 30%,var(--border)); white-space:nowrap; }
.chart-panel { grid-column:1/-1; overflow:hidden; }
.chart { height:220px; display:grid; grid-template-rows:1fr auto; min-width:0; }
.plot { display:flex; align-items:end; gap:10px; min-width:0; border-bottom:1px solid var(--border); padding:10px; }
.bar { flex:1; min-width:8px; background:var(--accent); border-radius:5px 5px 0 0; }
.legend { display:flex; flex-wrap:wrap; gap:8px 14px; padding-top:12px; color:var(--muted); }
.state-panel { grid-column:1/-1; min-height:220px; display:grid; place-items:center; text-align:center; }
.skeleton { width:min(720px,100%); height:18px; border-radius:6px; background:var(--border); margin:10px auto; }
.dense .chart-panel { min-width:0; }
@media (max-width:700px) {
  .topbar { padding:10px 14px; }
  .secondary-action { display:none; }
  .content { padding:20px 14px 36px; }
  .intro { align-items:start; flex-direction:column; gap:8px; }
  .grid { grid-template-columns:1fr; }
  /* Deliberate regression for verification: dense mobile chart exceeds the declared 390px support boundary. */
  .dense .chart-panel { min-width:520px; }
  .dense .legend { flex-wrap:nowrap; min-width:470px; }
}
`;

const DASHBOARD_APP = `
const params = new URLSearchParams(location.search);
const theme = params.get('theme') === 'dark' ? 'dark' : 'light';
const state = ['loading','empty','normal','dense'].includes(params.get('state')) ? params.get('state') : 'normal';
document.documentElement.dataset.theme = theme;
const app = document.querySelector('#app');
const denseTitle = 'Regional delivery success across all active zones';
const cards = state === 'dense'
  ? [
      [denseTitle,'99.984%',['North America','Europe','Asia Pacific','4 incidents','12 monitors']],
      ['Replay queue saturation at the ninety-fifth percentile','184 ms',['p95','worker-7','worker-12','high volume']],
      ['Recovery work awaiting explicit operator approval','27',['manual review','5 destinations','stale evidence','policy hold']],
    ]
  : [
      ['Successful deliveries','99.98%',['7d window']],
      ['Median recovery time','3m 24s',['down 18%']],
      ['Open interventions','4',['2 urgent']],
    ];
const bars = [44,68,53,78,61,84,72,90,76,88,81,93];
const header = \`<header class="topbar"><strong class="brand">Northstar Analytics</strong><div class="top-actions"><button class="secondary-action">Export</button><button class="primary-action">Investigate</button></div></header>\`;
let body = '';
if (state === 'loading') {
  body = \`<section class="state-panel" aria-busy="true"><div><h2>Loading analytics</h2><div class="skeleton"></div><div class="skeleton"></div></div></section>\`;
} else if (state === 'empty') {
  body = \`<section class="state-panel"><div><h2>No delivery data yet</h2><p>Choose a wider date range or connect a source.</p></div></section>\`;
} else {
  body = \`<section class="grid \${state === 'dense' ? 'dense' : ''}">\${cards.map(([title,value,badges])=>\`<article class="card"><h2 title="\${title}">\${title}</h2><div class="metric">\${value}</div><div class="badges">\${badges.map(b=>\`<span class="badge">\${b}</span>\`).join('')}</div></article>\`).join('')}<article class="chart-panel"><h2>Delivery success trend</h2><div class="chart"><div class="plot">\${bars.map(v=>\`<span class="bar" style="height:\${v}%"></span>\`).join('')}</div><div class="legend"><span>Successful</span><span>Delayed</span><span>Recovered</span><span>Operator action</span></div></div></article></section>\`;
}
app.innerHTML = \`<div class="shell">\${header}<main class="content"><section class="intro"><div><h1>Delivery health</h1><p>Fixed dataset for comparable browser verification.</p></div><span>Dataset: fixture-v1</span></section>\${body}</main></div>\`;
`;

const VISUAL_REFERENCE = {
  version: 'visual-dashboard-reference@1',
  defaultCapture: {
    viewport: '1440x900',
    theme: 'light',
    state: 'normal',
  },
  declaredMinimumWidth: 390,
  denseTitleCharacters: 48,
  maximumSupportedBadgeCount: 5,
  dataset: 'fixture-v1',
  font: DASHBOARD_FONT_NAME,
  animationState: 'disabled',
  dpr: 1,
} as const;

interface BrowserCheck {
  name: string;
  passed: boolean;
  detail: string;
}

interface VisualMetric {
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
  screenshot: string;
}

interface VisualCaptureMatrix {
  environment?: {
    dpr?: number;
    font?: string;
    animations?: string;
    dataset?: string;
    browserVersion?: string;
  };
  entries?: Array<Partial<VisualMetric> & { captureId?: string }>;
}

interface VisualClaimAudit {
  failures?: string[];
  renderingNoisePolicy?: string;
}

interface VisualBrowserResult {
  browserVersion: string;
  metrics: VisualMetric[];
  runtimeErrors: string[];
  environmentStable: boolean;
}

const visualBrowserCache = new Map<string, VisualBrowserResult>();

interface WebConsoleContract {
  backendContractVersion?: string;
  states?: string[];
  routing?: { deepLinks?: boolean; history?: boolean; refresh?: boolean };
  focus?: { dialogRestore?: boolean; keyboardActions?: boolean };
  network?: { slow?: boolean; failed?: boolean; stale?: boolean };
  cancellationSemantics?: string;
  retrySemantics?: string;
  designSystem?: string;
}

interface WebConsoleMatrix {
  viewports?: string[];
  states?: string[];
  networkStates?: string[];
  evidenceType?: string;
}

interface ContentPlan {
  contentVersion?: string;
  audience?: string;
  primaryAction?: string;
  secondaryAction?: string;
  assetUse?: string[];
  unsupportedClaimsAdded?: boolean;
  designSystem?: string;
}

interface ContentBrowserContract {
  viewports?: string[];
  longContent?: boolean;
  largeText?: boolean;
  reducedMotion?: boolean;
  keyboard?: boolean;
  semanticStructure?: boolean;
  runtimeConsole?: boolean;
  evidenceType?: string;
}

function fixedText(root: string, path: string, expected: string): boolean {
  try {
    return readFixtureText(root, path) === expected;
  } catch {
    return false;
  }
}

function fixedBinary(root: string, path: string, expectedPath: string): boolean {
  try {
    const expected = readFileSync(expectedPath);
    const actualPath = join(root, path);
    const stat = lstatSync(actualPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2_000_000) return false;
    return sha256(readFileSync(actualPath)) === sha256(expected);
  } catch {
    return false;
  }
}

function safeStaticFile(root: string, requestPath: string): string | null {
  const decoded = decodeURIComponent(requestPath).replace(/^\/+/, '');
  const candidate = resolve(root, decoded || 'index.html');
  const rel = relative(root, candidate);
  if (!rel || rel === '.') return null;
  if (rel.startsWith('..') || rel.split(/[\\/]/u).some((part) => part === '..')) return null;
  let current = resolve(root);
  for (const part of rel.split(/[\\/]/u)) {
    current = join(current, part);
    if (!existsSync(current)) return null;
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) return null;
  }
  const stat = lstatSync(candidate);
  if (!stat.isFile() || stat.size > 3_000_000) return null;
  return candidate;
}

function contentType(path: string): string {
  switch (extname(path)) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
    case '.mjs':
      return 'text/javascript; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.svg':
      return 'image/svg+xml; charset=utf-8';
    case '.woff2':
      return 'font/woff2';
    default:
      return 'application/octet-stream';
  }
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(body));
}

async function operationsApi(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
): Promise<boolean> {
  if (!url.pathname.startsWith('/api/jobs/')) return false;
  if (url.searchParams.get('network') === 'slow') {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 350));
  }
  if (url.searchParams.get('network') === 'fail') {
    sendJson(response, 503, { error: 'fixture network failure' });
    return true;
  }
  const parts = url.pathname.split('/').filter(Boolean);
  const id = parts[2] ?? '';
  const action = parts[3] ?? null;
  const job = JOBS[id];
  if (!job) {
    sendJson(response, 404, { error: 'job not found' });
    return true;
  }
  if (request.method === 'POST' && action === 'cancel') {
    sendJson(response, 202, { ...job, state: 'cancellation-requested' });
    return true;
  }
  if (request.method === 'POST' && action === 'retry') {
    sendJson(response, 202, { ...job, state: 'retrying' });
    return true;
  }
  if (request.method !== 'GET' || action) {
    sendJson(response, 405, { error: 'method not allowed' });
    return true;
  }
  sendJson(response, 200, { id, ...job });
  return true;
}

async function withFixtureServer<T>(
  root: string,
  api: ((request: IncomingMessage, response: ServerResponse, url: URL) => Promise<boolean>) | null,
  run: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const server = createServer((request, response) => {
    void (async () => {
      try {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1');
        if (api && (await api(request, response, url))) return;
        if (url.pathname === '/favicon.ico') {
          response.writeHead(204, { 'cache-control': 'no-store' });
          response.end();
          return;
        }
        let requestedPath = url.pathname;
        let file = safeStaticFile(root, requestedPath);
        if (!file && !extname(requestedPath)) {
          requestedPath = '/index.html';
          file = safeStaticFile(root, requestedPath);
        }
        if (!file) {
          response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
          response.end('not found');
          return;
        }
        response.writeHead(200, {
          'content-type': contentType(file),
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        });
        response.end(readFileSync(file));
      } catch (error) {
        response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        response.end(error instanceof Error ? error.message : String(error));
      }
    })();
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', () => resolveListen());
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('fixture server did not bind a TCP port');
  try {
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }
}

async function withBrave<T>(run: (browser: Browser) => Promise<T>): Promise<T> {
  if (!existsSync(BRAVE_PATH)) throw new Error(`Brave executable unavailable at ${BRAVE_PATH}`);
  if (sharedBrowserIdleTimer) {
    clearTimeout(sharedBrowserIdleTimer);
    sharedBrowserIdleTimer = null;
  }
  if (!sharedBrowser?.isConnected()) {
    sharedBrowser = await chromium.launch({
      executablePath: BRAVE_PATH,
      headless: true,
      args: ['--disable-background-networking'],
      timeout: 8_000,
    });
  }
  const browser = sharedBrowser;
  sharedBrowserUsers += 1;
  try {
    return await run(browser);
  } finally {
    sharedBrowserUsers = Math.max(0, sharedBrowserUsers - 1);
    if (sharedBrowserUsers === 0) {
      sharedBrowserIdleTimer = setTimeout(() => {
        const closing = sharedBrowser;
        sharedBrowser = null;
        sharedBrowserIdleTimer = null;
        void closing?.close().catch(() => undefined);
      }, 1_000);
    }
  }
}

function passCountScore(
  checks: readonly BrowserCheck[],
  integrityFailure = false,
): SkillEvalDeterministicScore {
  const passedCount = checks.filter((check) => check.passed).length;
  const allPassed = checks.length > 0 && passedCount === checks.length && !integrityFailure;
  return {
    passed: allPassed,
    quality: checks.length ? passedCount / checks.length : 0,
    verification: allPassed ? 1 : 0,
    integrityFailure,
    evidence: checks.map(
      (check) => `${check.name}: ${check.passed ? 'pass' : 'fail'} — ${check.detail}`,
    ),
  };
}

function addCheck(checks: BrowserCheck[], name: string, passed: boolean, detail: string): void {
  checks.push({ name, passed, detail });
}

async function documentHasNoHorizontalOverflow(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
}

async function scoreAsyncConsole(root: string): Promise<SkillEvalDeterministicScore> {
  const checks: BrowserCheck[] = [];
  const integrityFailure =
    !fixedText(root, 'evidence/backend-contract.json', json(ASYNC_BACKEND_CONTRACT)) ||
    !fixedText(root, 'src/tokens.css', CONSOLE_TOKENS) ||
    !fixedText(root, 'index.html', CONSOLE_INDEX);
  addCheck(
    checks,
    'sealed backend/design-system inputs',
    !integrityFailure,
    integrityFailure ? 'fixture inputs changed' : 'unchanged',
  );

  const contract = readJsonArtifact<WebConsoleContract>(
    root,
    'verification/web-interface-implementation-contract.json',
  );
  const matrix = readJsonArtifact<WebConsoleMatrix>(
    root,
    'verification/browser-state-and-viewport-matrix.json',
  );
  const contractPass =
    contract?.backendContractVersion === ASYNC_BACKEND_CONTRACT.version &&
    JOB_STATES.every((state) => contract.states?.includes(state)) &&
    contract.routing?.deepLinks === true &&
    contract.routing.history === true &&
    contract.routing.refresh === true &&
    contract.focus?.dialogRestore === true &&
    contract.focus.keyboardActions === true &&
    contract.network?.slow === true &&
    contract.network.failed === true &&
    contract.network.stale === true &&
    /requested|acknowledg/iu.test(contract.cancellationSemantics ?? '') &&
    /retrying|acknowledg/iu.test(contract.retrySemantics ?? '') &&
    contract.designSystem === 'kory-console-tokens@1';
  addCheck(
    checks,
    'implementation contract artifact',
    contractPass,
    contractPass ? 'complete' : 'missing or incomplete',
  );
  const matrixPass =
    matrix?.evidenceType === 'real-browser' &&
    ['1440x900', '390x844'].every((viewport) => matrix.viewports?.includes(viewport)) &&
    JOB_STATES.every((state) => matrix.states?.includes(state)) &&
    ['slow', 'failed', 'stale'].every((state) => matrix.networkStates?.includes(state));
  addCheck(
    checks,
    'state/viewport matrix artifact',
    matrixPass,
    matrixPass ? 'complete' : 'missing or incomplete',
  );

  if (integrityFailure) return passCountScore(checks, true);
  if (!contractPass || !matrixPass) return passCountScore(checks, false);
  try {
    await withFixtureServer(root, operationsApi, async (baseUrl) => {
      await withBrave(async (browser) => {
        const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
        const page = await context.newPage();
        page.setDefaultTimeout(2_500);
        page.setDefaultNavigationTimeout(5_000);
        const runtimeErrors: string[] = [];
        page.on('pageerror', (error) => runtimeErrors.push(`pageerror:${error.message}`));
        page.on('console', (message) => {
          if (
            message.type() === 'error' &&
            !/Failed to load resource: the server responded with a status of 503/iu.test(
              message.text(),
            )
          ) {
            runtimeErrors.push(`console:${message.text()}`);
          }
        });

        await page.goto(`${baseUrl}/jobs/job-running`, { waitUntil: 'domcontentloaded' });
        await page
          .locator('[data-job-state="running"]')
          .waitFor({ state: 'visible', timeout: 2_000 });
        addCheck(
          checks,
          'deep link renders supplied state',
          (await page.locator('[data-job-state="running"]').count()) === 1,
          page.url(),
        );
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page
          .locator('[data-job-state="running"]')
          .waitFor({ state: 'visible', timeout: 2_000 });
        addCheck(checks, 'refresh preserves deep-linked state', true, page.url());

        let allStates = true;
        for (const [id, job] of Object.entries(JOBS)) {
          await page.goto(`${baseUrl}/jobs/${id}`, { waitUntil: 'domcontentloaded' });
          try {
            await page
              .locator(`[data-job-state="${job.state}"]`)
              .waitFor({ state: 'visible', timeout: 1_500 });
            const label = (
              await page.locator(`[data-job-state="${job.state}"]`).innerText()
            ).trim();
            allStates = allStates && label.length > 2;
          } catch {
            allStates = false;
          }
        }
        addCheck(
          checks,
          'all async/cancellation states distinguishable',
          allStates,
          JOB_STATES.join(', '),
        );

        await page.goto(`${baseUrl}/jobs/job-running`, { waitUntil: 'domcontentloaded' });
        const failedLink = page.locator('a[href="/jobs/job-failed"]');
        let historyPass = (await failedLink.count()) === 1;
        if (historyPass) {
          await failedLink.click();
          await page
            .locator('[data-job-state="failed"]')
            .waitFor({ state: 'visible', timeout: 1_500 });
          await page.goBack({ timeout: 2_000 });
          await page
            .locator('[data-job-state="running"]')
            .waitFor({ state: 'visible', timeout: 1_500 });
          await page.goForward({ timeout: 2_000 });
          await page
            .locator('[data-job-state="failed"]')
            .waitFor({ state: 'visible', timeout: 1_500 });
        }
        addCheck(checks, 'browser history/back-forward behavior', historyPass, page.url());

        await page.goto(`${baseUrl}/jobs/job-running`, { waitUntil: 'domcontentloaded' });
        const cancel = page.locator('#cancel-job');
        let focusPass =
          (await cancel.count()) === 1 &&
          (await cancel.evaluate((node) => node.tagName)) === 'BUTTON';
        if (focusPass) {
          await cancel.focus();
          await cancel.click();
          const dialog = page.getByRole('dialog');
          focusPass = focusPass && (await dialog.count()) === 1;
          await page.keyboard.press('Escape');
          focusPass =
            focusPass &&
            (await page.evaluate(
              () => (document.activeElement as HTMLElement | null)?.id === 'cancel-job',
            ));
          await cancel.click();
          await page.locator('#confirm-cancel').click();
          await page
            .locator('[data-job-state="cancellation-requested"]')
            .waitFor({ state: 'visible', timeout: 1_500 });
        }
        addCheck(
          checks,
          'semantic cancel dialog and focus restoration',
          focusPass,
          'Escape returns focus to #cancel-job and confirm uses backend acknowledgement',
        );

        await page.goto(`${baseUrl}/jobs/job-failed`, { waitUntil: 'domcontentloaded' });
        const retry = page.locator('#retry-job');
        let retryPass =
          (await retry.count()) === 1 &&
          (await retry.evaluate((node) => node.tagName)) === 'BUTTON';
        if (retryPass) {
          await retry.click();
          await page
            .locator('[data-job-state="retrying"]')
            .waitFor({ state: 'visible', timeout: 1_500 });
        }
        addCheck(checks, 'retry preserves backend semantics', retryPass, 'failed -> retrying only');

        await page.goto(`${baseUrl}/jobs/job-running?network=slow`, {
          waitUntil: 'domcontentloaded',
        });
        let slowPass = false;
        try {
          await page.locator('[aria-busy="true"]').waitFor({ state: 'visible', timeout: 180 });
          slowPass = true;
        } catch {
          slowPass = false;
        }
        await page
          .locator('[data-job-state="running"]')
          .waitFor({ state: 'visible', timeout: 1_500 });
        addCheck(checks, 'slow network exposes loading state', slowPass, '350ms fixture delay');

        await page.goto(`${baseUrl}/jobs/job-running?network=fail`, {
          waitUntil: 'domcontentloaded',
        });
        let failurePass = false;
        try {
          const alert = page.getByRole('alert');
          await alert.waitFor({ state: 'visible', timeout: 1_500 });
          failurePass =
            (await alert.innerText()).trim().length > 4 &&
            (await page
              .locator('button')
              .filter({ hasText: /retry|reload|try again/iu })
              .count()) > 0;
        } catch {
          failurePass = false;
        }
        addCheck(
          checks,
          'failed network exposes semantic recovery',
          failurePass,
          '503 fixture path',
        );

        await page.setViewportSize({ width: 390, height: 844 });
        await page.goto(`${baseUrl}/jobs/job-partial`, { waitUntil: 'domcontentloaded' });
        await page
          .locator('[data-job-state="partial"]')
          .waitFor({ state: 'visible', timeout: 1_500 });
        const narrowPass =
          (await documentHasNoHorizontalOverflow(page)) &&
          (await page
            .locator('h1,h2')
            .filter({ hasText: /intentionally very long operation title/iu })
            .count()) > 0;
        addCheck(checks, 'narrow viewport and long content remain usable', narrowPass, '390x844');

        addCheck(
          checks,
          'real browser runtime has no application errors',
          runtimeErrors.length === 0,
          runtimeErrors.length
            ? runtimeErrors.join(' | ').slice(0, 500)
            : `${browser.version()} / DPR 1`,
        );
        await context.close();
      });
    });
  } catch (error) {
    addCheck(
      checks,
      'real browser execution',
      false,
      error instanceof Error ? error.message : String(error),
    );
  }
  writeFixtureFile(
    root,
    'evaluation/web-interface-browser-evidence.json',
    json({ scenarioId: ASYNC_CONSOLE, browser: 'Brave/Chromium via Playwright', checks }),
  );
  return passCountScore(checks, false);
}

async function scoreContentPage(root: string): Promise<SkillEvalDeterministicScore> {
  const checks: BrowserCheck[] = [];
  const integrityFailure =
    !fixedText(root, 'evidence/content.json', json(CONTENT_PACKET)) ||
    !fixedText(root, 'evidence/brand.json', json(CONTENT_BRAND)) ||
    !fixedText(root, 'assets/logo.svg', CONTENT_LOGO) ||
    !fixedText(root, 'assets/product.svg', CONTENT_SCREENSHOT) ||
    !fixedText(root, 'src/tokens.css', CONTENT_TOKENS) ||
    !fixedText(root, 'index.html', CONTENT_INDEX);
  addCheck(
    checks,
    'supplied content/assets/brand integrity',
    !integrityFailure,
    integrityFailure ? 'fixture inputs changed' : 'unchanged',
  );

  const plan = readJsonArtifact<ContentPlan>(
    root,
    'verification/content-led-web-interface-plan.json',
  );
  const contract = readJsonArtifact<ContentBrowserContract>(
    root,
    'verification/responsive-browser-verification-contract.json',
  );
  const planPass =
    plan?.contentVersion === CONTENT_PACKET.version &&
    plan.audience === CONTENT_PACKET.audience &&
    plan.primaryAction === CONTENT_PACKET.primaryAction.label &&
    plan.secondaryAction === CONTENT_PACKET.secondaryAction.label &&
    ['logo.svg', 'product.svg'].every((asset) => plan.assetUse?.includes(asset)) &&
    plan.unsupportedClaimsAdded === false &&
    plan.designSystem === CONTENT_BRAND.version;
  addCheck(
    checks,
    'content-led plan artifact',
    planPass,
    planPass ? 'complete' : 'missing or incomplete',
  );
  const contractPass =
    contract?.evidenceType === 'real-browser' &&
    ['1440x900', '390x844'].every((viewport) => contract.viewports?.includes(viewport)) &&
    contract.longContent === true &&
    contract.largeText === true &&
    contract.reducedMotion === true &&
    contract.keyboard === true &&
    contract.semanticStructure === true &&
    contract.runtimeConsole === true;
  addCheck(
    checks,
    'responsive verification contract artifact',
    contractPass,
    contractPass ? 'complete' : 'missing or incomplete',
  );
  if (integrityFailure) return passCountScore(checks, true);
  if (!planPass || !contractPass) return passCountScore(checks, false);

  try {
    await withFixtureServer(root, null, async (baseUrl) => {
      await withBrave(async (browser) => {
        const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
        const page = await context.newPage();
        const runtimeErrors: string[] = [];
        page.on('pageerror', (error) => runtimeErrors.push(`pageerror:${error.message}`));
        page.on('console', (message) => {
          if (message.type() === 'error') runtimeErrors.push(`console:${message.text()}`);
        });
        await page.goto(baseUrl, { waitUntil: 'networkidle' });

        // Each clause is reported, because the packet version alone said nothing about which of
        // seven clauses failed a check named "supplied copy/assets/actions used exactly".
        const headingCount = await page
          .getByRole('heading', { level: 1, name: CONTENT_PACKET.headline })
          .count();
        const summaryCount = await page.getByText(CONTENT_PACKET.summary, { exact: true }).count();
        const detailCount = await page.getByText(CONTENT_PACKET.detail, { exact: true }).count();
        const primaryCount = await page
          .locator(`a[href="${CONTENT_PACKET.primaryAction.href}"]`)
          .filter({ hasText: CONTENT_PACKET.primaryAction.label })
          .count();
        const secondaryCount = await page
          .locator(`a[href="${CONTENT_PACKET.secondaryAction.href}"]`)
          .filter({ hasText: CONTENT_PACKET.secondaryAction.label })
          .count();
        const logoCount = await page.locator('img[src="/assets/logo.svg"]').count();
        const productCount = await page.locator('img[src="/assets/product.svg"]').count();
        const contentPass =
          headingCount === 1 &&
          summaryCount >= 1 &&
          detailCount >= 1 &&
          primaryCount === 1 &&
          secondaryCount === 1 &&
          logoCount === 1 &&
          productCount === 1;
        addCheck(
          checks,
          'supplied copy/assets/actions used exactly',
          contentPass,
          `relay-content@${CONTENT_PACKET.version} h1=${headingCount} summary=${summaryCount} ` +
            `detail=${detailCount} primary=${primaryCount} secondary=${secondaryCount} ` +
            `logo=${logoCount} product=${productCount}`,
        );

        const pageText = (await page.locator('body').innerText()).toLowerCase();
        const unsupported = CONTENT_PACKET.prohibitedClaims.filter((claim) =>
          pageText.includes(claim.toLowerCase()),
        );
        addCheck(
          checks,
          'no unsupported product claims added',
          unsupported.length === 0,
          unsupported.join(', ') || 'none',
        );

        const semanticPass =
          (await page.locator('header nav').count()) >= 1 &&
          (await page.locator('main').count()) === 1 &&
          (await page.locator('main section').count()) >= 2 &&
          (await page.locator('footer').count()) === 1;
        addCheck(
          checks,
          'semantic document structure',
          semanticPass,
          'header/nav/main/sections/footer',
        );

        // The labeled CTA, not every link to the destination. An unscoped locator made this check
        // throw "strict mode violation: resolved to 4 elements" on a page that legitimately links
        // `/evaluation` from a hero button, a nav item and a footer, so a correct page failed a
        // check named "action styling". The instruction asks for one primary action, not one link.
        const primary = page
          .locator(`a[href="${CONTENT_PACKET.primaryAction.href}"]`)
          .filter({ hasText: CONTENT_PACKET.primaryAction.label })
          .first();
        const secondary = page
          .locator(`a[href="${CONTENT_PACKET.secondaryAction.href}"]`)
          .filter({ hasText: CONTENT_PACKET.secondaryAction.label });
        let actionPass = (await primary.isVisible()) && (await secondary.isVisible());
        if (actionPass) {
          const [primaryStyle, secondaryStyle] = await Promise.all([
            primary.evaluate((node) => {
              const style = getComputedStyle(node);
              return `${style.backgroundColor}|${style.color}|${style.borderColor}`;
            }),
            secondary.evaluate((node) => {
              const style = getComputedStyle(node);
              return `${style.backgroundColor}|${style.color}|${style.borderColor}`;
            }),
          ]);
          actionPass = primaryStyle !== secondaryStyle;
        }
        addCheck(
          checks,
          'primary and secondary actions are distinct',
          actionPass,
          'rendered computed styles',
        );

        await page.evaluate(() => (document.body as HTMLElement).focus());
        let keyboardPass = false;
        for (let index = 0; index < 12; index += 1) {
          await page.keyboard.press('Tab');
          const href = await page.evaluate(() =>
            (document.activeElement as HTMLAnchorElement | null)?.getAttribute?.('href'),
          );
          if (href === '/evaluation') {
            keyboardPass = true;
            break;
          }
        }
        addCheck(checks, 'primary action reachable by keyboard', keyboardPass, 'Tab navigation');

        let responsivePass = true;
        for (const viewport of [
          { width: 1440, height: 900 },
          { width: 390, height: 844 },
        ]) {
          await page.setViewportSize(viewport);
          await page.goto(baseUrl, { waitUntil: 'networkidle' });
          responsivePass =
            responsivePass &&
            (await documentHasNoHorizontalOverflow(page)) &&
            (await primary.isVisible()) &&
            (await secondary.isVisible());
        }
        addCheck(checks, 'wide/narrow responsive behavior', responsivePass, '1440x900 and 390x844');

        await page.setViewportSize({ width: 390, height: 844 });
        await page.goto(baseUrl, { waitUntil: 'networkidle' });
        await page.evaluate((longText) => {
          const summary = document.querySelector('[data-product-summary]');
          const detail = document.querySelector('[data-product-detail]');
          if (summary) summary.textContent = `${longText} ${longText}`;
          if (detail) detail.textContent = `${longText} ${longText} ${longText}`;
        }, CONTENT_PACKET.detail);
        const longContentPass = await documentHasNoHorizontalOverflow(page);
        await page.evaluate(() => {
          document.documentElement.style.fontSize = '200%';
        });
        const largeTextPass =
          (await documentHasNoHorizontalOverflow(page)) &&
          (await primary.isVisible()) &&
          (await secondary.isVisible());
        addCheck(
          checks,
          'long supplied content does not force overflow',
          longContentPass,
          'runtime-expanded copy',
        );
        addCheck(
          checks,
          '200% text remains usable',
          largeTextPass,
          '390x844 with root font-size doubled',
        );

        const reduced = await browser.newContext({
          viewport: { width: 900, height: 900 },
          reducedMotion: 'reduce',
        });
        const reducedPage = await reduced.newPage();
        await reducedPage.goto(baseUrl, { waitUntil: 'networkidle' });
        const reducedMotionPass = await reducedPage.evaluate(
          () => document.getAnimations().length === 0,
        );
        addCheck(
          checks,
          'reduced motion is respected',
          reducedMotionPass,
          'prefers-reduced-motion: reduce',
        );
        await reduced.close();

        addCheck(
          checks,
          'real browser runtime has no application errors',
          runtimeErrors.length === 0,
          runtimeErrors.length
            ? runtimeErrors.join(' | ').slice(0, 500)
            : `${browser.version()} / real page`,
        );
        await context.close();
      });
    });
  } catch (error) {
    addCheck(
      checks,
      'real browser execution',
      false,
      error instanceof Error ? error.message : String(error),
    );
  }
  writeFixtureFile(
    root,
    'evaluation/content-page-browser-evidence.json',
    json({ scenarioId: CONTENT_PAGE, browser: 'Brave/Chromium via Playwright', checks }),
  );
  return passCountScore(checks, false);
}

function metricFailures(metric: VisualMetric): string[] {
  const failures: string[] = [];
  if (metric.horizontalOverflow) failures.push(`${metric.captureId}:horizontal-overflow`);
  if (metric.chartClipped) failures.push(`${metric.captureId}:chart-clipping`);
  if (metric.legendClipped) failures.push(`${metric.captureId}:legend-clipping`);
  if (metric.stickyOverlap) failures.push(`${metric.captureId}:sticky-header-overlap`);
  if (!metric.primaryActionDistinct)
    failures.push(`${metric.captureId}:primary-action-not-distinct`);
  return failures;
}

async function browserVisualMetrics(root: string): Promise<VisualBrowserResult> {
  const cached = visualBrowserCache.get(root);
  if (cached) return cached;
  const result = await withFixtureServer(root, null, async (baseUrl) =>
    withBrave(async (browser) => {
      const viewportResults = await Promise.all(
        DASHBOARD_VIEWPORTS.map(async (viewport) => {
          const context = await browser.newContext({
            viewport,
            deviceScaleFactor: 1,
            reducedMotion: 'reduce',
          });
          const page = await context.newPage();
          page.setDefaultTimeout(3_000);
          const viewportMetrics: VisualMetric[] = [];
          const viewportErrors: string[] = [];
          let viewportStable = true;
          let currentCaptureId = `${viewport.width}x${viewport.height}-initial`;
          page.on('pageerror', (error) =>
            viewportErrors.push(`${currentCaptureId}:pageerror:${error.message}`),
          );
          page.on('console', (message) => {
            if (message.type() === 'error')
              viewportErrors.push(`${currentCaptureId}:console:${message.text()}`);
          });
          for (const theme of DASHBOARD_THEMES) {
            for (const state of DASHBOARD_STATES) {
              const captureId = `${viewport.width}x${viewport.height}-${theme}-${state}`;
              currentCaptureId = captureId;
              await page.goto(`${baseUrl}/?theme=${theme}&state=${state}`, { waitUntil: 'load' });
              await page.evaluate(() => document.fonts.ready);
              const environment = await page.evaluate(
                (fontName) => ({
                  dpr: window.devicePixelRatio,
                  fontLoaded: document.fonts.check(`16px "${fontName}"`),
                  fontFamily: getComputedStyle(document.body).fontFamily,
                  animations: document.getAnimations().length,
                  dataset: document.body.innerText.includes('Dataset: fixture-v1'),
                }),
                DASHBOARD_FONT_NAME,
              );
              const environmentStable =
                environment.dpr === 1 &&
                environment.fontLoaded &&
                environment.fontFamily.includes(DASHBOARD_FONT_NAME) &&
                environment.animations === 0 &&
                environment.dataset;
              viewportStable = viewportStable && environmentStable;
              const layout = await page.evaluate(() => {
                const header = document.querySelector('.topbar')?.getBoundingClientRect();
                const content = document.querySelector('.content')?.getBoundingClientRect();
                const chartPanel = document.querySelector('.chart-panel') as HTMLElement | null;
                const chart = document.querySelector('.chart') as HTMLElement | null;
                const legend = document.querySelector('.legend') as HTMLElement | null;
                const primary = document.querySelector('.primary-action') as HTMLElement | null;
                const secondary = document.querySelector('.secondary-action') as HTMLElement | null;
                const primaryStyle = primary ? getComputedStyle(primary) : null;
                const secondaryStyle = secondary ? getComputedStyle(secondary) : null;
                return {
                  horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
                  chartClipped:
                    !!chartPanel && !!chart && chart.scrollWidth > chartPanel.clientWidth + 1,
                  legendClipped: !!legend && legend.scrollWidth > legend.clientWidth + 1,
                  stickyOverlap: !!header && !!content && content.top < header.bottom - 1,
                  primaryActionDistinct:
                    !!primaryStyle &&
                    !!secondaryStyle &&
                    `${primaryStyle.backgroundColor}|${primaryStyle.color}|${primaryStyle.borderColor}` !==
                      `${secondaryStyle.backgroundColor}|${secondaryStyle.color}|${secondaryStyle.borderColor}`,
                };
              });
              const screenshotRelative = `evaluation/visual-verification/captures/${captureId}.jpg`;
              const screenshotAbsolute = join(root, screenshotRelative);
              mkdirSync(dirname(screenshotAbsolute), { recursive: true });
              await page.screenshot({
                path: screenshotAbsolute,
                type: 'jpeg',
                quality: 72,
                fullPage: false,
                animations: 'disabled',
                timeout: 3_000,
              });
              viewportMetrics.push({
                captureId,
                ...viewport,
                theme,
                state,
                ...layout,
                screenshot: screenshotRelative,
              });
            }
          }
          await page.close();
          await context.close();
          return {
            metrics: viewportMetrics,
            runtimeErrors: viewportErrors,
            environmentStable: viewportStable,
          };
        }),
      );
      return {
        browserVersion: browser.version(),
        metrics: viewportResults.flatMap((result) => result.metrics),
        runtimeErrors: viewportResults.flatMap((result) => result.runtimeErrors),
        environmentStable: viewportResults.every((result) => result.environmentStable),
      };
    }),
  );
  visualBrowserCache.set(root, result);
  if (visualBrowserCache.size > 8) {
    const oldest = visualBrowserCache.keys().next().value;
    if (oldest) visualBrowserCache.delete(oldest);
  }
  return result;
}

function visualEntryMatches(
  expected: VisualMetric,
  actual: Partial<VisualMetric> | undefined,
): boolean {
  return (
    !!actual &&
    actual.captureId === expected.captureId &&
    actual.width === expected.width &&
    actual.height === expected.height &&
    actual.theme === expected.theme &&
    actual.state === expected.state &&
    actual.horizontalOverflow === expected.horizontalOverflow &&
    actual.chartClipped === expected.chartClipped &&
    actual.legendClipped === expected.legendClipped &&
    actual.stickyOverlap === expected.stickyOverlap &&
    actual.primaryActionDistinct === expected.primaryActionDistinct
  );
}

async function scoreVisualDashboard(root: string): Promise<SkillEvalDeterministicScore> {
  const checks: BrowserCheck[] = [];
  const integrityFailure =
    !fixedText(root, 'evidence/reference.json', json(VISUAL_REFERENCE)) ||
    !fixedText(root, 'index.html', DASHBOARD_INDEX) ||
    !fixedText(root, 'src/styles.css', DASHBOARD_STYLE) ||
    !fixedText(root, 'src/app.js', DASHBOARD_APP) ||
    !fixedBinary(root, 'assets/inter.woff2', INTER_FONT_SOURCE);
  addCheck(
    checks,
    'dashboard/reference/font integrity',
    !integrityFailure,
    integrityFailure ? 'fixed input changed' : 'unchanged',
  );
  if (integrityFailure) return passCountScore(checks, true);

  try {
    const independent = await browserVisualMetrics(root);
    writeFixtureFile(
      root,
      'evaluation/visual-verification/independent-matrix.json',
      json({
        browserVersion: independent.browserVersion,
        dpr: 1,
        font: DASHBOARD_FONT_NAME,
        animations: 'disabled',
        dataset: 'fixture-v1',
        metrics: independent.metrics,
        runtimeErrors: independent.runtimeErrors,
      }),
    );
    addCheck(
      checks,
      'stabilized browser environment',
      independent.environmentStable,
      `${independent.browserVersion}; DPR 1; ${DASHBOARD_FONT_NAME}; animations disabled; fixture-v1`,
    );
    addCheck(
      checks,
      'real browser runtime has no application errors',
      independent.runtimeErrors.length === 0,
      independent.runtimeErrors.join(' | ').slice(0, 500) || 'none',
    );

    const matrix = readJsonArtifact<VisualCaptureMatrix>(
      root,
      'verification/visual-verification-scenario-1-capture-matrix.json',
    );
    const entries = matrix?.entries ?? [];
    const matrixPass =
      entries.length === independent.metrics.length &&
      independent.metrics.every((metric) =>
        visualEntryMatches(
          metric,
          entries.find((entry) => entry.captureId === metric.captureId),
        ),
      ) &&
      matrix?.environment?.dpr === 1 &&
      matrix.environment.font === DASHBOARD_FONT_NAME &&
      matrix.environment.animations === 'disabled' &&
      matrix.environment.dataset === 'fixture-v1' &&
      typeof matrix.environment.browserVersion === 'string' &&
      matrix.environment.browserVersion.length > 0;
    addCheck(
      checks,
      '24-entry viewport/theme/state capture matrix matches rendered evidence',
      matrixPass,
      `${entries.length}/${independent.metrics.length} candidate entries`,
    );

    const expectedFailures = independent.metrics.flatMap(metricFailures).sort();
    const audit = readJsonArtifact<VisualClaimAudit>(
      root,
      'verification/visual-verification-scenario-1-claim-audit.json',
    );
    const candidateFailures = [...(audit?.failures ?? [])].sort();
    const auditPass =
      JSON.stringify(candidateFailures) === JSON.stringify(expectedFailures) &&
      /noise|font|dpr|animation|runtime/iu.test(audit?.renderingNoisePolicy ?? '');
    addCheck(
      checks,
      'claim audit records every measurable rendered failure',
      auditPass,
      `${candidateFailures.length}/${expectedFailures.length} failure claims`,
    );

    let verdict = '';
    try {
      verdict = readFixtureText(root, 'verification/visual-verification-scenario-1-verdict.md');
    } catch {
      verdict = '';
    }
    const verdictPass =
      /390/iu.test(verdict) &&
      /dense/iu.test(verdict) &&
      /horizontal overflow|overflow/iu.test(verdict) &&
      /rendering noise|noise/iu.test(verdict) &&
      /light/iu.test(verdict) &&
      /dark/iu.test(verdict);
    addCheck(
      checks,
      'claim-level verdict artifact',
      verdictPass,
      verdictPass ? 'grounded verdict present' : 'missing required verdict boundaries',
    );

    const screenshotsPass = independent.metrics.every((metric) => {
      try {
        const stat = lstatSync(join(root, metric.screenshot));
        return stat.isFile() && !stat.isSymbolicLink() && stat.size > 1_000;
      } catch {
        return false;
      }
    });
    addCheck(
      checks,
      'browser screenshots materialized for every matrix cell',
      screenshotsPass,
      `${independent.metrics.length} evaluator captures`,
    );
  } catch (error) {
    addCheck(
      checks,
      'real browser capture execution',
      false,
      error instanceof Error ? error.message : String(error),
    );
  }
  return passCountScore(checks, false);
}

const browserUnavailable = existsSync(BRAVE_PATH)
  ? undefined
  : [`Requires system Brave at ${BRAVE_PATH} for real-browser evidence.`];
export function dashboardAssetBlockers(): string[] {
  return existsSync(INTER_FONT_SOURCE)
    ? []
    : [`Requires the bundled Inter evaluation font at ${INTER_FONT_SOURCE}.`];
}
const visualUnavailable = [...(browserUnavailable ?? []), ...dashboardAssetBlockers()];

export const BROWSER_SKILL_EVAL_MATERIALIZERS: readonly SkillEvalFixtureMaterializer[] = [
  {
    id: 'web-interface/async-console-real-browser@1',
    readinessBlockers: browserUnavailable,
    matches: (scenario) => scenario.id === ASYNC_CONSOLE,
    materialize: (root) => {
      writeFixtureFile(root, 'index.html', CONSOLE_INDEX);
      writeFixtureFile(root, 'src/tokens.css', CONSOLE_TOKENS);
      writeFixtureFile(root, 'src/styles.css', CONSOLE_STARTER_STYLE);
      writeFixtureFile(root, 'src/app.js', CONSOLE_STARTER_APP);
      writeFixtureFile(root, 'evidence/backend-contract.json', json(ASYNC_BACKEND_CONTRACT));
      writeFixtureFile(
        root,
        'verification/web-interface-implementation-contract.json',
        json({ status: 'TODO' }),
      );
      writeFixtureFile(
        root,
        'verification/browser-state-and-viewport-matrix.json',
        json({ status: 'TODO' }),
      );
      writeFixtureFile(
        root,
        'README.md',
        `# Operations console browser fixture\n\nImprove the existing browser-native module application without changing \`index.html\`, \`src/tokens.css\`, or \`evidence/backend-contract.json\`. The fixed backend contract is authoritative. Preserve deep URLs and history, expose every supplied operation state, keep cancel/retry acknowledgements honest, restore focus around dialogs, handle slow/failed requests, and support 1440x900 plus 390x844.\n\n### Evidence artifact contract (exact JSON field names)\n\nThe scorer reads two candidate-authored JSON files. They are claims; the evaluator separately drives real Chromium against your code. Do not claim a browser check you did not perform.\n\n\`verification/web-interface-implementation-contract.json\`:\n\n\`\`\`json\n{\n  "backendContractVersion": "${ASYNC_BACKEND_CONTRACT.version}",\n  "designSystem": "kory-console-tokens@1",\n  "states": ${JSON.stringify(JOB_STATES)},\n  "routing": { "deepLinks": true, "history": true, "refresh": true },\n  "focus": { "dialogRestore": true, "keyboardActions": true },\n  "network": { "slow": true, "failed": true, "stale": true },\n  "cancellationSemantics": "describe how a cancellation request is acknowledged, in one sentence",\n  "retrySemantics": "describe how a retry is acknowledged, in one sentence"\n}\n\`\`\`\n\nThe booleans must be true only where the behavior exists in your code; \`states\` must contain every job state listed above.\n\n\`verification/browser-state-and-viewport-matrix.json\`:\n\n\`\`\`json\n{\n  "evidenceType": "real-browser",\n  "viewports": ${JSON.stringify(['1440x900', '390x844'])},\n  "states": ${JSON.stringify(JOB_STATES)},\n  "networkStates": ${JSON.stringify(['slow', 'failed', 'stale'])}\n}\n\`\`\`\n`,
      );
    },
  },
  {
    id: 'web-interface/content-led-real-browser@1',
    readinessBlockers: browserUnavailable,
    matches: (scenario) => scenario.id === CONTENT_PAGE,
    materialize: (root) => {
      writeFixtureFile(root, 'index.html', CONTENT_INDEX);
      writeFixtureFile(root, 'src/tokens.css', CONTENT_TOKENS);
      writeFixtureFile(root, 'src/styles.css', CONTENT_STARTER_STYLE);
      writeFixtureFile(root, 'src/app.js', CONTENT_STARTER_APP);
      writeFixtureFile(root, 'evidence/content.json', json(CONTENT_PACKET));
      writeFixtureFile(root, 'evidence/brand.json', json(CONTENT_BRAND));
      writeFixtureFile(root, 'assets/logo.svg', CONTENT_LOGO);
      writeFixtureFile(root, 'assets/product.svg', CONTENT_SCREENSHOT);
      writeFixtureFile(
        root,
        'verification/content-led-web-interface-plan.json',
        json({ status: 'TODO' }),
      );
      writeFixtureFile(
        root,
        'verification/responsive-browser-verification-contract.json',
        json({ status: 'TODO' }),
      );
      writeFixtureFile(
        root,
        'README.md',
        `# Content-led product page browser fixture\n\nBuild the page from the supplied content, brand packet, logo, and product screenshot. \`index.html\`, \`src/tokens.css\`, \`evidence/*\`, and \`assets/*\` are fixed inputs. Keep the primary evaluation action distinct from documentation, use semantic browser structure, survive 390px width, long copy and 200% text, and respect reduced motion. Do not add product guarantees that are absent from the supplied content.\n\n### Evidence artifact contract (exact JSON field names)\n\nThe scorer reads two candidate-authored JSON files. They are claims; the evaluator separately drives real Chromium against your code. Do not claim a browser check you did not perform.\n\n\`verification/content-led-web-interface-plan.json\`:\n\n\`\`\`json\n{\n  "contentVersion": "${CONTENT_PACKET.version}",\n  "designSystem": "${CONTENT_BRAND.version}",\n  "audience": ${JSON.stringify(CONTENT_PACKET.audience)},\n  "primaryAction": ${JSON.stringify(CONTENT_PACKET.primaryAction.label)},\n  "secondaryAction": ${JSON.stringify(CONTENT_PACKET.secondaryAction.label)},\n  "assetUse": ${JSON.stringify(['logo.svg', 'product.svg'])},\n  "unsupportedClaimsAdded": false\n}\n\`\`\`\n\n\`verification/responsive-browser-verification-contract.json\`:\n\n\`\`\`json\n{\n  "evidenceType": "real-browser",\n  "viewports": ${JSON.stringify(['1440x900', '390x844'])},\n  "longContent": true,\n  "largeText": true,\n  "reducedMotion": true,\n  "keyboard": true,\n  "semanticStructure": true,\n  "runtimeConsole": true\n}\n\`\`\`\n`,
      );
    },
  },
  {
    id: 'visual-verification/responsive-dashboard-real-browser@1',
    readinessBlockers: visualUnavailable.length ? visualUnavailable : undefined,
    matches: (scenario) => scenario.id === VISUAL_DASHBOARD,
    materialize: (root) => {
      writeFixtureFile(root, 'index.html', DASHBOARD_INDEX);
      writeFixtureFile(root, 'src/styles.css', DASHBOARD_STYLE);
      writeFixtureFile(root, 'src/app.js', DASHBOARD_APP);
      writeFixtureFile(root, 'evidence/reference.json', json(VISUAL_REFERENCE));
      mkdirSync(join(root, 'assets'), { recursive: true });
      if (existsSync(INTER_FONT_SOURCE))
        copyFileSync(INTER_FONT_SOURCE, join(root, 'assets/inter.woff2'));
      writeFixtureFile(
        root,
        'verification/visual-verification-scenario-1-capture-matrix.json',
        json({ status: 'TODO' }),
      );
      writeFixtureFile(
        root,
        'verification/visual-verification-scenario-1-claim-audit.json',
        json({ status: 'TODO' }),
      );
      writeFixtureFile(
        root,
        'verification/visual-verification-scenario-1-verdict.md',
        '# Visual verification verdict\n\nTODO\n',
      );
      writeFixtureFile(root, 'README.md', VISUAL_DASHBOARD_README);
    },
  },
] as const;

export const BROWSER_SKILL_EVAL_SCORERS: readonly SkillEvalDeterministicScorer[] = [
  {
    id: 'web-interface/async-console-real-browser-scorer@1',
    scenarioIds: [ASYNC_CONSOLE],
    score: ({ workingDirectory }) => scoreAsyncConsole(workingDirectory),
  },
  {
    id: 'web-interface/content-led-real-browser-scorer@1',
    scenarioIds: [CONTENT_PAGE],
    score: ({ workingDirectory }) => scoreContentPage(workingDirectory),
  },
  {
    id: 'visual-verification/responsive-dashboard-real-browser-scorer@1',
    scenarioIds: [VISUAL_DASHBOARD],
    score: ({ workingDirectory }) => scoreVisualDashboard(workingDirectory),
  },
] as const;

export const BROWSER_EVAL_CONSTANTS = {
  bravePath: BRAVE_PATH,
  jobStates: JOB_STATES,
  asyncBackendContractVersion: ASYNC_BACKEND_CONTRACT.version,
  consoleDesignSystem: 'kory-console-tokens@1',
  contentVersion: CONTENT_PACKET.version,
  contentAudience: CONTENT_PACKET.audience,
  contentPrimaryAction: CONTENT_PACKET.primaryAction.label,
  contentSecondaryAction: CONTENT_PACKET.secondaryAction.label,
  contentBrandVersion: CONTENT_BRAND.version,
  dashboardFont: DASHBOARD_FONT_NAME,
  dashboardViewports: DASHBOARD_VIEWPORTS,
  dashboardThemes: DASHBOARD_THEMES,
  dashboardStates: DASHBOARD_STATES,
} as const;
