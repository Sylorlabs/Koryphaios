// In-memory API shim for demo mode.
//
// In any demo variant there is no backend, so `apiFetch` routes every request
// here instead of the network. Known endpoints answer with hardcoded demo data
// (so every settings tab renders fully populated) and session CRUD works
// against an in-memory map (so the UI behaves like the real app while saving
// nothing). Unknown endpoints get a fast, well-formed "not available" JSON
// response — never a hang, never a network error, never a dead end.

import type { Session } from '@koryphaios/shared';

const now = Date.now();

// ─── In-memory session table ────────────────────────────────────────────────

const demoSessions = new Map<string, Session>();
let sessionCounter = 0;

// Per-session message history, tab-scoped: everything the user does in the
// full demo lives here until the tab closes — nothing is ever persisted.
type DemoMessage = { id: string; role: string; content: string; createdAt: number; model?: string };
const demoMessages = new Map<string, DemoMessage[]>();
let messageCounter = 0;

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

const MEMORY_SETTINGS = {
  universalMemoryEnabled: true,
  projectMemoryEnabled: true,
  sessionMemoryEnabled: true,
  agentMemoryEnabled: true,
  rulesEnabled: true,
  autoIncludeInContext: true,
  maxContextTokens: 2000,
};

const AGENT_SETTINGS = {
  ruleEnforcementLevel: 'strict',
  agentExecutionMode: 'auto',
  preferencesEnabled: true,
  criticGateEnabled: true,
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
  reasoningExpandedByDefault: true,
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

const MODE_CONFIG = {
  hideGitPanel: false,
  autoCommit: false,
  simplifiedPrompts: false,
  maxWorkers: 8,
  requireConfirmations: true,
  toolAccess: 'full',
  explanations: 'minimal',
  enableShadowLoggerUI: true,
  enableWorktrees: true,
  enableCriticGate: true,
  showAgentDetails: true,
  showCostTracking: true,
};

const BILLING_CREDITS = {
  ok: true,
  totalSpendCents: 412,
  subscriptionInferenceCents: 2350,
  allSpendCents: 2762,
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
        { period: '1h', tokensIn: 42_000, tokensOut: 9_800, inferenceValueUsd: 0.62 },
        { period: '24h', tokensIn: 512_000, tokensOut: 118_000, inferenceValueUsd: 7.4 },
        { period: '7d', tokensIn: 2_940_000, tokensOut: 655_000, inferenceValueUsd: 41.2 },
        { period: '30d', tokensIn: 9_100_000, tokensOut: 2_020_000, inferenceValueUsd: 128.5 },
      ],
      byModel: [
        {
          model: 'claude-sonnet-5',
          tokensIn: 7_800_000,
          tokensOut: 1_700_000,
          inferenceValueUsd: 96.1,
        },
        {
          model: 'claude-haiku-4-5',
          tokensIn: 1_300_000,
          tokensOut: 320_000,
          inferenceValueUsd: 12.4,
        },
      ],
    },
    {
      provider: 'codex',
      planType: 'Pro',
      quotas: [{ label: 'Weekly', usedPercent: 22, resetsAt: now + 5 * 86_400_000 }],
      windows: [
        { period: '1h', tokensIn: 12_000, tokensOut: 3_100, inferenceValueUsd: 0.21 },
        { period: '24h', tokensIn: 210_000, tokensOut: 44_000, inferenceValueUsd: 2.9 },
        { period: '7d', tokensIn: 1_120_000, tokensOut: 260_000, inferenceValueUsd: 15.8 },
        { period: '30d', tokensIn: 3_400_000, tokensOut: 810_000, inferenceValueUsd: 47.3 },
      ],
      byModel: [
        { model: 'gpt-5.6-terra', tokensIn: 850_000, tokensOut: 180_000, inferenceValueUsd: 13.2 },
        { model: 'gpt-5.6-sol', tokensIn: 2_100_000, tokensOut: 510_000, inferenceValueUsd: 30.6 },
        { model: 'gpt-5.6-luna', tokensIn: 450_000, tokensOut: 120_000, inferenceValueUsd: 5.1 },
      ],
    },
  ],
  balances: [
    { provider: 'codex', availableUsd: 12.4 },
    { provider: 'google', availableUsd: 6.48 },
  ],
  byProvider: [
    {
      name: 'codex',
      tokensIn: 3_400_000,
      tokensOut: 810_000,
      spendCents: 212,
      subscription: false,
    },
    {
      name: 'claude',
      tokensIn: 9_100_000,
      tokensOut: 2_020_000,
      spendCents: 0,
      subscription: true,
    },
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
export function demoFetch(url: string, init: RequestInit = {}): Response {
  const method = (init.method ?? 'GET').toUpperCase();
  let path: string;
  try {
    path = new URL(url, 'http://demo.local').pathname;
  } catch {
    path = url;
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

  // Mode (flat response shape, matching the mode store's expectations).
  if (path === '/api/mode') {
    const mode = method === 'PUT' ? (parseBody(init).mode ?? 'advanced') : 'advanced';
    return json({
      ok: true,
      mode,
      config: MODE_CONFIG,
      context: { mode, config: MODE_CONFIG },
      shouldWarnNoGit: false,
      noGitWarning: '',
    });
  }

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
    return ok(MEMORY_SETTINGS);
  }

  // Agent tab.
  if (path === '/api/agent/settings' || path === '/api/agent/settings/reset') {
    if (method === 'PUT') return ok({ ...AGENT_SETTINGS, ...parseBody(init) });
    return ok(AGENT_SETTINGS);
  }
  if (path.startsWith('/api/agent/preferences')) {
    if (method !== 'GET') return ok(true);
    return ok(AGENT_PREFERENCES);
  }
  if (path === '/api/agent/context') {
    return ok({
      settings: AGENT_SETTINGS,
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

  // Notes endpoints the notes store doesn't already demo-guard.
  if (path.startsWith('/api/notes')) return ok([]);

  // Collaboration: no team backend in the demo.
  if (path.startsWith('/api/collab/')) {
    return json({ ok: false, error: 'Team hosting is not available in the demo' });
  }

  if (path === '/api/workspace/home') return ok('/demo');

  // Default: fast, well-formed failure — callers show a toast at worst,
  // and nothing ever hangs waiting on a dead backend.
  return json({ ok: false, error: 'Not available in the demo' });
}
