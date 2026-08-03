// In-memory API shim for demo mode.
//
// In any demo variant there is no backend, so `apiFetch` routes every request
// here instead of the network. Known endpoints answer with hardcoded demo data
// (so every settings tab renders fully populated) and session CRUD works
// against an in-memory map (so the UI behaves like the real app while saving
// nothing). Unknown endpoints get a fast, well-formed "not available" JSON
// response — never a hang, never a network error, never a dead end.

import type { Goal, GoalChecklistItem, GoalScope, Session } from '@koryphaios/shared';
import type { ChangeSummary } from '@koryphaios/shared';

const now = Date.now();

function demoDailyUsage(total: number) {
  const shape = [0.36, 0.48, 0.22, 0.66, 0.54, 0.78, 0.42, 0.6, 0.86, 0.51, 0.72, 0.91, 0.57, 0.69];
  const today = new Date(now);
  const endDay = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return shape.map((weight, index) => ({
    date: new Date(endDay - (shape.length - index - 1) * 86_400_000).toISOString().slice(0, 10),
    tokens: Math.round(total * weight),
  }));
}

// ─── In-memory session table ────────────────────────────────────────────────

const demoSessions = new Map<string, Session>();
let sessionCounter = 0;

// Per-session message history, tab-scoped: everything the user does in the
// full demo lives here until the tab closes — nothing is ever persisted.
type DemoMessage = { id: string; role: string; content: string; createdAt: number; model?: string };
const demoMessages = new Map<string, DemoMessage[]>();
let messageCounter = 0;

// ─── Browser-trial virtual workspace ───────────────────────────────────────
//
// The desktop app owns a real repository. The browser trial owns a deliberately
// small, tab-lifetime-only repository so visitors can inspect files, diffs,
// tests, staging, commits, and review decisions without touching their machine.
// This is stateful simulation, not a claim that browser code can run native
// CLIs or mutate a visitor's disk.
type VirtualFile = { original: string | null; content: string | null; staged: boolean };

const virtualFiles = new Map<string, VirtualFile>([
  ['README.md', {
    original: '# Starter project\n\nA small revenue dashboard used by the Koryphaios browser trial.\n',
    content: '# Starter project\n\nA small revenue dashboard used by the Koryphaios browser trial.\n',
    staged: false,
  }],
  ['src/app.ts', {
    original: "export const appName = 'Starter project';\n",
    content: "export const appName = 'Starter project';\n",
    staged: false,
  }],
  ['src/lib/formatCurrency.ts', {
    original: "export const formatCurrency = (value: number) => `$${value.toFixed(2)}`;\n",
    content: "export const formatCurrency = (value: number) => `$${value.toFixed(2)}`;\n",
    staged: false,
  }],
  ['tests/formatCurrency.test.ts', {
    original: "import { formatCurrency } from '../src/lib/formatCurrency';\n\nexport const smokeTest = () => formatCurrency(12) === '$12.00';\n",
    content: "import { formatCurrency } from '../src/lib/formatCurrency';\n\nexport const smokeTest = () => formatCurrency(12) === '$12.00';\n",
    staged: false,
  }],
]);

let virtualBranch = 'trial/main';
let virtualAhead = 0;
let virtualCommitCount = 0;
const virtualBranches = ['trial/main'];

function changedFiles(): Array<[string, VirtualFile]> {
  return [...virtualFiles.entries()].filter(([, file]) => file.original !== file.content);
}

function lineCount(value: string | null): number {
  return value ? value.split('\n').filter(Boolean).length : 0;
}

function gitStatus() {
  return changedFiles().map(([path, file]) => ({
    path,
    status: file.original === null ? 'added' : file.content === null ? 'deleted' : 'modified',
    staged: file.staged,
    additions: Math.max(0, lineCount(file.content) - lineCount(file.original)),
    deletions: Math.max(0, lineCount(file.original) - lineCount(file.content)),
  }));
}

function demoDiff(path: string): string {
  const file = virtualFiles.get(path);
  if (!file || file.original === file.content) return '';
  const before = file.original?.trimEnd().split('\n') ?? [];
  const after = file.content?.trimEnd().split('\n') ?? [];
  return [
    `diff --git a/${path} b/${path}`,
    file.original === null ? 'new file mode 100644' : '',
    `--- ${file.original === null ? '/dev/null' : `a/${path}`}`,
    `+++ ${file.content === null ? '/dev/null' : `b/${path}`}`,
    '@@ browser-trial simulated diff @@',
    ...before.map((line) => `-${line}`),
    ...after.map((line) => `+${line}`),
  ].filter(Boolean).join('\n') + '\n';
}

function reviewChanges(): ChangeSummary[] {
  return gitStatus().map((file) => ({
    path: file.path,
    operation: file.status === 'added' ? 'create' : file.status === 'deleted' ? 'delete' : 'edit',
    linesAdded: file.additions ?? 0,
    linesDeleted: file.deletions ?? 0,
  }));
}

export function getDemoReviewChanges(): ChangeSummary[] {
  return reviewChanges();
}

/** Make a reproducible, inspectable change-set for a simulated manager run. */
export function applyDemoRunArtifacts(prompt: string, sessionId?: string): ChangeSummary[] {
  const request = prompt.trim() || 'Improve the starter project';
  virtualFiles.set('src/lib/trialPlan.ts', {
    original: null,
    staged: false,
    content: [
      `export const trialPlan = ${JSON.stringify(request)};`,
      '',
      'export const reviewChecklist = [',
      "  'Inspect the diff',",
      "  'Run the simulated test suite',",
      "  'Accept or reject the changes',",
      '];',
      '',
    ].join('\n'),
  });
  virtualFiles.set('tests/trialPlan.test.ts', {
    original: null,
    staged: false,
    content: [
      "import { trialPlan, reviewChecklist } from '../src/lib/trialPlan';",
      '',
      "export const trialPlanTest = () => trialPlan.length > 0 && reviewChecklist.length === 3;",
      '',
    ].join('\n'),
  });
  const readme = virtualFiles.get('README.md');
  if (readme?.content) {
    const baseReadme = readme.content.replace(/\n\nLatest browser-trial request:.*\n?$/, '');
    virtualFiles.set('README.md', {
      ...readme,
      staged: false,
      content: `${baseReadme.trimEnd()}\n\nLatest browser-trial request: ${request}\n`,
    });
  }
  if (sessionId) {
    const session = demoSessions.get(sessionId);
    if (session) {
      demoSessions.set(sessionId, {
        ...session,
        totalTokensIn: session.totalTokensIn + 940,
        totalTokensOut: session.totalTokensOut + 760,
        totalCost: Number((session.totalCost + 0.0124).toFixed(4)),
        updatedAt: Date.now(),
      });
    }
  }
  return reviewChanges();
}

export function resolveDemoReview(accepted: boolean): void {
  for (const [, file] of changedFiles()) {
    if (accepted) file.staged = true;
    else {
      file.content = file.original;
      file.staged = false;
    }
  }
}

// ─── Browser-trial goals ───────────────────────────────────────────────────
const demoGoals = new Map<string, Goal>();
let goalCounter = 0;

function goalItems(): GoalChecklistItem[] {
  const timestamp = Date.now();
  return [
    { id: `trial-check-${goalCounter}-1`, title: 'Inspect the virtual workspace', status: 'running', order: 0, dependsOn: [], evidence: [], startedAt: timestamp },
    { id: `trial-check-${goalCounter}-2`, title: 'Review the proposed diff', status: 'pending', order: 1, dependsOn: [], evidence: [] },
    { id: `trial-check-${goalCounter}-3`, title: 'Record test evidence', status: 'pending', order: 2, dependsOn: [], evidence: [] },
  ];
}

function createDemoGoal(body: Record<string, unknown>): Goal {
  const createdAt = Date.now();
  const id = `trial-goal-${++goalCounter}`;
  const scope = (body.scope === 'project' || body.scope === 'session' ? body.scope : 'workspace') as GoalScope;
  const goal: Goal = {
    id,
    objective: typeof body.objective === 'string' ? body.objective : 'Improve the starter project',
    scope,
    projectPath: typeof body.projectPath === 'string' ? body.projectPath : undefined,
    sessionId: typeof body.sessionId === 'string' ? body.sessionId : undefined,
    priority: 0,
    sortOrder: demoGoals.size,
    status: 'running',
    checklist: goalItems(),
    linkedSessionIds: typeof body.sessionId === 'string' ? [body.sessionId] : [],
    activity: [{ id: `${id}-created`, type: 'created', message: 'Browser trial goal created with an inspectable checklist.', createdAt }],
    activeDurationMs: 0,
    activeStartedAt: createdAt,
    createdAt,
    updatedAt: createdAt,
  };
  demoGoals.set(id, goal);
  return goal;
}

export function recordDemoMessage(
  sessionId: string,
  role: 'user' | 'assistant',
  content: string,
  model?: string,
): void {
  const list = demoMessages.get(sessionId) ?? [];
  list.push({
    id: `demo-m${++messageCounter}`,
    role,
    content,
    createdAt: Date.now(),
    ...(model ? { model } : {}),
  });
  demoMessages.set(sessionId, list);
  const session = demoSessions.get(sessionId);
  if (session) {
    demoSessions.set(sessionId, {
      ...session,
      messageCount: list.length,
      updatedAt: Date.now(),
    });
  }
}

export function registerDemoSessions(list: Session[]): void {
  for (const s of list) demoSessions.set(s.id, s);
}

export function getDemoSession(id: string): Session | undefined {
  return demoSessions.get(id);
}

function createDemoSession(title: string, workingDirectory?: string | null): Session {
  const id = `demo-s${++sessionCounter}-${now}`;
  const session: Session = {
    id,
    title: title || 'New Session',
    workingDirectory: workingDirectory ?? '/demo/analytics-dashboard',
    messageCount: 0,
    totalTokensIn: 0,
    totalTokensOut: 0,
    totalCost: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  demoSessions.set(id, session);
  return session;
}

// ─── Hardcoded settings data ────────────────────────────────────────────────

const DEMO_MEMORY_FILE = (path: string, content: string) => ({
  path,
  content,
  exists: true,
  lastModified: now - 3_600_000,
  size: content.length,
});

const UNIVERSAL_MEMORY = `# Universal Memory

- Prefers TypeScript with strict mode everywhere
- Uses Bun as the package manager and test runner
- Commit style: conventional commits (feat/fix/chore)
`;

const PROJECT_MEMORY = `# Project Memory — analytics-dashboard

- Charts are built with Recharts; keep new charts consistent
- API routes live in src/api and return { ok, data } envelopes
- Coverage target is 80% on the query layer
`;

const PROJECT_RULES = `# Project Rules

1. Never commit directly to main — always branch.
2. All API changes require a matching test.
3. Keep bundle size under 400 kB gzipped.
`;

let demoMemorySettings = {
  universalMemoryEnabled: true,
  projectMemoryEnabled: true,
  sessionMemoryEnabled: true,
  agentMemoryEnabled: true,
  rulesEnabled: true,
  autoIncludeInContext: true,
  maxContextTokens: 2000,
};

let demoAgentSettings = {
  ruleEnforcementLevel: 'strict',
  agentExecutionMode: 'auto',
  preferencesEnabled: true,
  criticGateEnabled: true,
  gateStrictness: 'strict',
  intentInterview: 'adaptive',
  designDiscovery: true,
  planApproval: 'material',
  modelQualification: 'enforce',
  feedbackSharing: 'local',
  skillLearningMode: 'propose-then-verify',
  criticEnforcesPreferences: true,
  autoApplySafeFixes: false,
  confirmRuleViolations: true,
  autoRunTools: true,
  allowExternalPaths: false,
  managerModelAccess: {},
  managerNotes: {},
  agentMemoryEnabled: true,
  agentCanUpdatePreferences: false,
  maxCriticIterations: 3,
  approvalThresholdFiles: 5,
  approvalThresholdLines: 100,
  localWebSearch: 'fallback',
  multiSourceResearch: true,
  contextPruningEnabled: true,
  contextKeepRecentTurns: 3,
  contextPruneMinChars: 600,
  contextSelfAwareness: true,
  reasoningExpandedByDefault: false,
};

const AGENT_PREFERENCES = {
  exists: true,
  path: '/demo/analytics-dashboard/.koryphaios/preferences.md',
  content: `# Preferences

- Explain non-obvious decisions in one sentence.
- Prefer small, reviewable diffs over sweeping rewrites.
- Ask before adding new dependencies.
`,
};

const BILLING_CREDITS = {
  ok: true,
  totalSpendCents: 412,
  remainingCents: 1888,
  cliUsage: [
    {
      provider: 'claude',
      planType: 'Max',
      quotas: [
        { label: 'Session', usedPercent: 34, resetsAt: now + 3 * 3_600_000 },
        { label: 'Weekly', usedPercent: 58, resetsAt: now + 4 * 86_400_000 },
      ],
      windows: [
        { period: '1h', tokensIn: 42_000, tokensOut: 9_800 },
        { period: '24h', tokensIn: 512_000, tokensOut: 118_000 },
        { period: '7d', tokensIn: 2_940_000, tokensOut: 655_000 },
        { period: '30d', tokensIn: 9_100_000, tokensOut: 2_020_000 },
      ],
      dailyUsage: demoDailyUsage(142_000),
      byModel: [
        {
          model: 'claude-code-sonnet',
          tokensIn: 7_800_000,
          tokensOut: 1_700_000,
        },
        {
          model: 'claude-haiku-4-5',
          tokensIn: 1_300_000,
          tokensOut: 320_000,
        },
      ],
    },
    {
      provider: 'codex',
      planType: 'Pro',
      quotas: [{ label: 'Weekly', usedPercent: 22, resetsAt: now + 5 * 86_400_000 }],
      windows: [
        { period: '1h', tokensIn: 12_000, tokensOut: 3_100 },
        { period: '24h', tokensIn: 210_000, tokensOut: 44_000 },
        { period: '7d', tokensIn: 1_120_000, tokensOut: 260_000 },
        { period: '30d', tokensIn: 3_400_000, tokensOut: 810_000 },
      ],
      dailyUsage: demoDailyUsage(61_000),
      byModel: [
        { model: 'gpt-5.6-terra', tokensIn: 850_000, tokensOut: 180_000 },
        { model: 'gpt-5.6-sol', tokensIn: 2_100_000, tokensOut: 510_000 },
        { model: 'gpt-5.6-luna', tokensIn: 450_000, tokensOut: 120_000 },
      ],
    },
  ],
  balances: [
    { provider: 'google', availableUsd: 6.48 },
  ],
  byProvider: [
    {
      name: 'google',
      tokensIn: 1_150_000,
      tokensOut: 240_000,
      spendCents: 200,
      subscription: false,
    },
  ],
};

// ─── Response helpers ───────────────────────────────────────────────────────

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function ok(data: unknown): Response {
  return json({ ok: true, data });
}

function parseBody(init: RequestInit): Record<string, unknown> {
  try {
    if (typeof init.body === 'string') return JSON.parse(init.body);
  } catch {
    /* ignore */
  }
  return {};
}

// ─── Router ─────────────────────────────────────────────────────────────────

/** Answer an API request entirely in memory. Always returns a Response. */
function isReadOnlyDemoRequest(method: string): boolean {
  return method === 'GET';
}

export function demoFetch(url: string, init: RequestInit = {}): Response {
  const method = (init.method ?? 'GET').toUpperCase();
  let path: string;
  try {
    path = new URL(url, 'http://demo.local').pathname;
  } catch {
    path = url;
  }

  // This public preview is inspectable, never a mutable workspace. Keeping
  // this in the API shim prevents DevTools from turning it into a stuck state.
  if (!isReadOnlyDemoRequest(method)) {
    return json({ ok: false, error: 'The guided demo is read-only. Download Koryphaios to run a workspace.' }, 403);
  }

  // Health: always green so no sentinel/overlay can ever fire in the demo.
  if (path === '/api/health') {
    return json({ ok: true, data: { version: 'demo', pid: 0, uptime: 1 } });
  }

  // Sessions CRUD — in-memory, nothing persisted.
  if (path === '/api/sessions') {
    if (method === 'POST') {
      const body = parseBody(init);
      return ok(
        createDemoSession(
          typeof body.title === 'string' ? body.title : 'New Session',
          typeof body.workingDirectory === 'string' ? body.workingDirectory : null,
        ),
      );
    }
    return ok([...demoSessions.values()].sort((a, b) => b.updatedAt - a.updatedAt));
  }
  const sessionMatch = path.match(/^\/api\/sessions\/([^/]+)$/);
  if (sessionMatch) {
    const id = sessionMatch[1];
    const existing = demoSessions.get(id);
    if (method === 'PATCH') {
      const body = parseBody(init);
      const updated: Session = {
        ...(existing ?? createDemoSession('Session')),
        id,
        title: typeof body.title === 'string' ? body.title : (existing?.title ?? 'Session'),
        updatedAt: Date.now(),
      };
      demoSessions.set(id, updated);
      return ok(updated);
    }
    if (method === 'DELETE') {
      demoSessions.delete(id);
      demoMessages.delete(id);
      return ok(true);
    }
    if (existing) return ok(existing);
  }
  if (path.startsWith('/api/messages/')) {
    const sessionId = path.slice('/api/messages/'.length);
    return ok(demoMessages.get(sessionId) ?? []);
  }
  if (/^\/api\/sessions\/[^/]+\/(cancel|compact)$/.test(path)) return ok(true);
  if (/^\/api\/sessions\/[^/]+\/timetravel$/.test(path)) return ok({ checkpoints: [] });
  if (/^\/api\/sessions\/[^/]+\/context$/.test(path)) return json({ ok: true, lastUsage: null });

  // Memory tab.
  if (path === '/api/memory/documents') {
    if (method === 'POST') return ok(true);
    return ok([
      { name: 'MEMORY.md', path: '.koryphaios/MEMORY.md', kind: 'memory' },
      { name: 'rules.md', path: '.koryphaios/rules.md', kind: 'rules' },
    ]);
  }
  if (path.startsWith('/api/memory/universal')) {
    if (method !== 'GET') return ok(true);
    return ok(DEMO_MEMORY_FILE('~/.koryphaios/universal.md', UNIVERSAL_MEMORY));
  }
  if (path.startsWith('/api/memory/project')) {
    if (method !== 'GET') return ok(true);
    return ok(DEMO_MEMORY_FILE('/demo/analytics-dashboard/.koryphaios/MEMORY.md', PROJECT_MEMORY));
  }
  if (path.startsWith('/api/memory/rules')) {
    if (method !== 'GET') return ok(true);
    return ok(DEMO_MEMORY_FILE('/demo/analytics-dashboard/.koryphaios/rules.md', PROJECT_RULES));
  }
  if (path.startsWith('/api/memory/sessions/')) {
    if (method !== 'GET') return ok(true);
    return ok(
      DEMO_MEMORY_FILE(
        '.koryphaios/sessions/demo.md',
        '# Session memory\n\n- Working on the analytics dashboard.',
      ),
    );
  }
  if (path === '/api/memory/settings' || path === '/api/memory/settings/reset') {
    if (path.endsWith('/reset')) {
      demoMemorySettings = { ...demoMemorySettings, universalMemoryEnabled: true, projectMemoryEnabled: true, sessionMemoryEnabled: true, agentMemoryEnabled: true, rulesEnabled: true, autoIncludeInContext: true, maxContextTokens: 2000 };
    } else if (method === 'PUT') {
      demoMemorySettings = { ...demoMemorySettings, ...parseBody(init) };
    }
    return ok(demoMemorySettings);
  }

  // Agent tab.
  if (path === '/api/agent/settings' || path === '/api/agent/settings/reset') {
    if (path.endsWith('/reset')) {
      demoAgentSettings = { ...demoAgentSettings, ruleEnforcementLevel: 'strict', agentExecutionMode: 'auto', criticGateEnabled: true, autoRunTools: true };
    } else if (method === 'PUT') {
      demoAgentSettings = { ...demoAgentSettings, ...parseBody(init) };
    }
    return ok(demoAgentSettings);
  }
  if (path.startsWith('/api/agent/preferences')) {
    if (method !== 'GET') return ok(true);
    return ok(AGENT_PREFERENCES);
  }
  if (path === '/api/agent/context') {
    return ok({
      settings: demoAgentSettings,
      preferences: AGENT_PREFERENCES.content,
      rules: PROJECT_RULES,
      enforcementMessage: 'Rules are enforced by the critic gate.',
    });
  }

  // Billing tab (flat shape consumed directly by the drawer).
  if (path.startsWith('/api/billing/credits')) return json(BILLING_CREDITS);

  // Providers (the seeded provider list lives in the store; these cover the
  // drawer's secondary lookups).
  if (path === '/api/providers/available') return ok([]);
  if (path === '/api/providers/detect') return ok([]);
  if (path.startsWith('/api/providers/') && path.endsWith('/accounts')) return ok([]);

  // Virtual project browser. The actual desktop backend reads a repository;
  // the trial exposes a small in-memory repository with the same response
  // shapes so mentions and file previews are meaningful.
  if (path === '/api/workspace/files') {
    const query = new URL(url, 'http://demo.local').searchParams.get('q')?.toLowerCase() ?? '';
    return ok([...virtualFiles.entries()]
      .filter(([file, value]) => value.content !== null && file.toLowerCase().includes(query))
      .map(([file]) => file)
      .sort());
  }
  if (path === '/api/workspace/raw') {
    const file = new URL(url, 'http://demo.local').searchParams.get('path') ?? '';
    const value = virtualFiles.get(file)?.content;
    return value === null || value === undefined
      ? json({ ok: false, error: 'Virtual file not found' }, 404)
      : new Response(value, { status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
  if (path === '/api/workspace/register') return ok({ path: '/demo/starter-project', trial: true });

  // Virtual Git review. Changes are real state transitions inside this tab:
  // inspect, stage, restore, commit, and branch operations all mutate only the
  // browser-trial repository.
  if (path === '/api/git/status') {
    return ok({ isRepo: true, status: gitStatus(), branch: virtualBranch, ahead: virtualAhead, behind: 0 });
  }
  if (path === '/api/git/branches') return ok({ branches: virtualBranches });
  if (path === '/api/git/diff') {
    const file = new URL(url, 'http://demo.local').searchParams.get('file') ?? '';
    return ok({ diff: demoDiff(file) });
  }
  if (path === '/api/git/file') {
    const file = new URL(url, 'http://demo.local').searchParams.get('path') ?? '';
    const content = virtualFiles.get(file)?.content;
    return content === null || content === undefined
      ? json({ ok: false, error: 'Virtual file not found' }, 404)
      : ok({ content });
  }
  if (path === '/api/git/stage' && method === 'POST') {
    const file = typeof parseBody(init).file === 'string' ? parseBody(init).file as string : '';
    const entry = virtualFiles.get(file);
    if (entry) entry.staged = !parseBody(init).unstage;
    return ok(true);
  }
  if (path === '/api/git/restore' && method === 'POST') {
    const file = typeof parseBody(init).file === 'string' ? parseBody(init).file as string : '';
    const entry = virtualFiles.get(file);
    if (entry) { entry.content = entry.original; entry.staged = false; }
    return ok(true);
  }
  if (path === '/api/git/commit' && method === 'POST') {
    const staged = changedFiles().filter(([, file]) => file.staged);
    if (!staged.length) return json({ ok: false, error: 'Stage a browser-trial change before committing.' }, 400);
    for (const [, file] of staged) { file.original = file.content; file.staged = false; }
    virtualAhead += 1;
    virtualCommitCount += 1;
    return ok({ id: `trial-${virtualCommitCount}`, branch: virtualBranch });
  }
  if (path === '/api/git/checkout' && method === 'POST') {
    const body = parseBody(init);
    const branch = typeof body.branch === 'string' ? body.branch : virtualBranch;
    if (body.create && !virtualBranches.includes(branch)) virtualBranches.push(branch);
    virtualBranch = branch;
    return ok({ branch });
  }
  if (path === '/api/git/merge' || path === '/api/git/push' || path === '/api/git/pull') return ok({ hasConflicts: false });

  // Durable trial goals are deliberately small but fully stateful: visitors
  // can create, drive, attach evidence to, pause, and finalize them.
  if (path === '/api/goals') {
    if (method === 'POST') return ok(createDemoGoal(parseBody(init)));
    return ok([...demoGoals.values()].sort((a, b) => a.sortOrder - b.sortOrder));
  }
  const goalMatch = path.match(/^\/api\/goals\/([^/]+)(?:\/(.*))?$/);
  if (goalMatch) {
    const [, id, action] = goalMatch;
    const goal = demoGoals.get(id);
    if (!goal) return json({ ok: false, error: 'Trial goal not found.' }, 404);
    const body = parseBody(init);
    if (!action && method === 'PATCH') {
      Object.assign(goal, body, { updatedAt: Date.now() });
      return ok(goal);
    }
    if (action === 'drive' && method === 'POST') {
      const next = goal.checklist.find((item) => item.status === 'pending');
      if (next) { next.status = 'running'; next.startedAt = Date.now(); }
      goal.status = 'running';
      goal.activity.push({ id: `${id}-drive-${Date.now()}`, type: 'drive', message: 'Manager simulated the next checklist step in the browser trial.', createdAt: Date.now(), sessionId: typeof body.sessionId === 'string' ? body.sessionId : undefined });
      goal.updatedAt = Date.now();
      return ok(goal);
    }
    const checkMatch = action?.match(/^checklist\/([^/]+)\/complete$/);
    if (checkMatch && method === 'POST') {
      const item = goal.checklist.find((entry) => entry.id === checkMatch[1]);
      if (!item) return json({ ok: false, error: 'Checklist item not found.' }, 404);
      const value = typeof body.value === 'string' ? body.value.trim() : '';
      if (!value) return json({ ok: false, error: 'Verification evidence is required.' }, 400);
      item.status = 'completed'; item.completedAt = Date.now();
      item.evidence.push({ id: `${item.id}-e${item.evidence.length + 1}`, kind: 'check', value, verified: true, createdAt: Date.now() });
      const next = goal.checklist.find((entry) => entry.status === 'pending');
      if (next) { next.status = 'running'; next.startedAt = Date.now(); }
      goal.updatedAt = Date.now();
      return ok(goal);
    }
    if (action === 'finalize' && method === 'POST') {
      if (goal.checklist.some((item) => item.status !== 'completed')) return json({ ok: false, error: 'Complete each checklist item with evidence first.' }, 400);
      goal.status = 'completed'; goal.updatedAt = Date.now();
      goal.activity.push({ id: `${id}-finalized`, type: 'finalized', message: 'Goal finalized with visitor-supplied verification evidence.', createdAt: Date.now() });
      return ok(goal);
    }
  }

  // The skills surface has enough state to explore qualification and selection
  // without pretending that a browser can execute a local SKILL.md toolchain.
  if (path === '/api/agent/skills') return ok([
    { name: 'code-review', description: 'Review a diff in the virtual workspace.', enabled: true, source: 'browser-trial' },
    { name: 'test-plan', description: 'Plan and record test evidence for a trial change.', enabled: true, source: 'browser-trial' },
  ]);
  if (path === '/api/agent/skills/qualifications') return ok({ verified: ['code-review', 'test-plan'], note: 'Browser-trial skills are simulated and cannot access local executables.' });

  // Notes endpoints the notes store doesn't already demo-guard.
  if (path.startsWith('/api/notes')) return ok([]);

  // Collaboration: no team backend in the demo.
  if (path.startsWith('/api/collab/')) {
    return json({ ok: false, error: 'Team hosting is not available in the demo' });
  }

  if (path === '/api/workspace/home') return ok('/demo/starter-project');

  // Default: fast, well-formed failure — callers show a toast at worst,
  // and nothing ever hangs waiting on a dead backend.
  return json({ ok: false, error: 'Not available in the demo' });
}
