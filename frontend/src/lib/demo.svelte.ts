// Demo mode — embedded on koryphaios.com via ?demo=1. Renders the REAL UI and
// plays a scripted session on a loop so the site shows Koryphaios *in action*,
// seeded entirely client-side (no backend, no auth, no dead ends).

import { browser } from '$app/environment';
import { authStore } from '$lib/stores/auth.svelte';
import { sessionStore } from '$lib/stores/sessions.svelte';
import { projectStore } from '$lib/stores/project.svelte';
import { feedStore } from '$lib/stores/feed.svelte';
import { agentStore } from '$lib/stores/agents.svelte';
import { providersStore } from '$lib/stores/providers.svelte';
import type { Session } from '@koryphaios/shared';

export const isDemoMode =
  browser &&
  (new URLSearchParams(location.search).has('demo') || location.hash.includes('demo'));

const now = Date.now();

function mkSession(id: string, title: string, ago: number, cost: number, msgs: number): Session {
  return {
    id,
    title,
    workingDirectory: '/demo/analytics-dashboard',
    messageCount: msgs,
    totalTokensIn: 0,
    totalTokensOut: 0,
    totalCost: cost,
    createdAt: now - ago,
    updatedAt: now - ago,
  };
}

const WORKERS = [
  { id: 'w-fe', name: 'frontend', domain: 'ui', model: 'gpt-5.5', provider: 'codex', glow: 'rgba(0,255,255,0.5)' },
  { id: 'w-be', name: 'backend', domain: 'backend', model: 'gemini-3-pro', provider: 'google', glow: 'rgba(66,133,244,0.5)' },
  { id: 'w-test', name: 'testing', domain: 'test', model: 'claude-sonnet-5', provider: 'anthropic', glow: 'rgba(0,255,128,0.5)' },
];

const DEMO_PROVIDERS = [
  {
    name: 'codex',
    label: 'Codex',
    enabled: true,
    authenticated: true,
    authSource: 'CLI session',
    models: ['gpt-5.5', 'gpt-5.4-mini'],
    selectedModels: ['gpt-5.5', 'gpt-5.4-mini'],
    allAvailableModels: [
      {
        id: 'gpt-5.5',
        name: 'GPT-5.5',
        provider: 'codex',
        contextWindow: 400_000,
        maxOutputTokens: 128_000,
        contextVerified: true,
        canReason: true,
        reasoningLevels: ['low', 'medium', 'high', 'xhigh'],
      },
      {
        id: 'gpt-5.4-mini',
        name: 'GPT-5.4 Mini',
        provider: 'codex',
        contextWindow: 400_000,
        maxOutputTokens: 128_000,
        contextVerified: true,
        canReason: true,
        reasoningLevels: ['low', 'medium', 'high'],
      },
    ],
    hideModelSelector: false,
    authMode: 'auth_only',
    supportsApiKey: false,
    supportsAuthToken: true,
    requiresBaseUrl: false,
  },
  {
    name: 'claude',
    label: 'Claude Code',
    enabled: true,
    authenticated: true,
    authSource: 'CLI session',
    models: ['claude-sonnet-5'],
    selectedModels: ['claude-sonnet-5'],
    allAvailableModels: [
      {
        id: 'claude-sonnet-5',
        name: 'Claude Sonnet 5',
        provider: 'claude',
        contextWindow: 200_000,
        maxOutputTokens: 64_000,
        contextVerified: true,
        canReason: true,
      },
    ],
    hideModelSelector: false,
    authMode: 'auth_only',
    supportsApiKey: false,
    supportsAuthToken: true,
    requiresBaseUrl: false,
  },
  {
    name: 'google-subscription',
    label: 'Gemini CLI',
    enabled: true,
    authenticated: true,
    authSource: 'CLI session',
    models: ['gemini-3-pro'],
    selectedModels: ['gemini-3-pro'],
    allAvailableModels: [
      {
        id: 'gemini-3-pro',
        name: 'Gemini 3 Pro',
        provider: 'google-subscription',
        contextWindow: 1_000_000,
        maxOutputTokens: 64_000,
        contextVerified: true,
        canReason: true,
      },
    ],
    hideModelSelector: false,
    authMode: 'auth_only',
    supportsApiKey: false,
    supportsAuthToken: true,
    requiresBaseUrl: false,
  },
] as const;

const REPLY =
  "I've delegated the three subtasks to specialist workers running in isolated git worktrees. " +
  'The frontend agent is scaffolding the chart components with Recharts, the backend agent is ' +
  'building the API routes and query layer, and the testing agent is writing coverage. Once they ' +
  "report back I'll run the critic gate and synthesize the final result.";

let timers: ReturnType<typeof setTimeout>[] = [];
function at(ms: number, fn: () => void) {
  timers.push(setTimeout(fn, ms));
}
function clearTimers() {
  for (const t of timers) clearTimeout(t);
  timers = [];
}

function spawnWorkers() {
  for (const w of WORKERS) {
    agentStore.spawnAgent(
      {
        id: w.id,
        name: w.name,
        role: 'coder',
        model: w.model,
        provider: w.provider as never,
        domain: w.domain as never,
        glowColor: w.glow,
      },
      `${w.domain} work`,
      's1',
    );
    agentStore.updateAgentStatus(w.id, 'idle', 's1');
  }
}

/** One pass of the scripted conversation. */
function playScript() {
  clearTimers();
  feedStore.clearFeed();
  // Remove the workers so they visibly fly back in from the top when Kory
  // routes — mirrors the real spawn animation each turn.
  agentStore.clearNonManagerAgents();
  agentStore.updateAgentStatus('kory-manager', 'idle', 's1');

  at(600, () => {
    feedStore.addFeedEntry({
      timestamp: Date.now(),
      type: 'user_message',
      agentId: 'user',
      agentName: 'You',
      glowClass: '',
      text: 'Build a full-stack analytics dashboard with charts, API routes, and tests.',
    });
  });

  at(1600, () => {
    agentStore.updateAgentStatus('kory-manager', 'analyzing', 's1');
    feedStore.addFeedEntry({
      timestamp: Date.now(),
      type: 'thought',
      agentId: 'kory-manager',
      agentName: 'Kory',
      glowClass: 'glow-kory',
      text: 'Analyzing the request — classifying domain and decomposing into subtasks.',
      metadata: { phase: 'analyzing' },
    });
  });

  at(3200, () => {
    agentStore.updateAgentStatus('kory-manager', 'verifying', 's1');
    feedStore.addFeedEntry({
      timestamp: Date.now(),
      type: 'thought',
      agentId: 'kory-manager',
      agentName: 'Kory',
      glowClass: 'glow-kory',
      text: 'Routing: frontend → gpt-5.5 · backend → gemini-3-pro · tests → claude-sonnet-5',
      metadata: { phase: 'routing' },
    });
    // Workers spawn now — they fly in from the top of the agent rail.
    spawnWorkers();
    at(250, () => {
      agentStore.updateAgentStatus('w-fe', 'writing', 's1');
      agentStore.updateAgentStatus('w-be', 'thinking', 's1');
      agentStore.updateAgentStatus('w-test', 'thinking', 's1');
    });
  });

  at(4600, () => {
    feedStore.addFeedEntry({
      timestamp: Date.now(),
      type: 'tool_result',
      agentId: 'kory-manager',
      agentName: 'Kory',
      glowClass: '',
      text: 'Created src/components/RevenueChart.tsx, src/api/metrics.ts',
      metadata: {
        toolResult: {
          callId: 'demo-1',
          name: 'batch_edit',
          output: 'Created src/components/RevenueChart.tsx (+142)\nCreated src/api/metrics.ts (+88)',
          isError: false,
          durationMs: 0,
        },
      },
    });
    agentStore.updateAgentStatus('w-be', 'tool_calling', 's1');
  });

  at(6200, () => {
    agentStore.updateAgentStatus('kory-manager', 'streaming', 's1');
    // Stream the reply word by word.
    const words = REPLY.split(' ');
    words.forEach((word, i) => {
      at(6200 + i * 45, () => {
        feedStore.accumulateFeedEntry({
          timestamp: Date.now(),
          type: 'content',
          agentId: 'kory-manager',
          agentName: 'Kory',
          glowClass: 'glow-kory',
          text: (i === 0 ? '' : ' ') + word,
        });
      });
    });
    const doneAt = 6200 + words.length * 45 + 400;
    at(doneAt, () => {
      agentStore.updateAgentStatus('kory-manager', 'done', 's1');
      for (const w of WORKERS) agentStore.updateAgentStatus(w.id, 'done', 's1');
    });
    // Hold, then loop.
    at(doneAt + 4500, () => playScript());
  });
}

/** Seed static state + start the looping playback. */
export function seedDemo(): void {
  authStore.setUser({ id: 'demo', email: 'demo@koryphaios.com', name: 'Demo' } as never);
  providersStore.setProviderStatusList(DEMO_PROVIDERS as never);
  projectStore.setProject('/demo/analytics-dashboard');
  sessionStore.seedDemoSessions(
    [
      mkSession('s1', 'Analytics Dashboard', 0, 0.08, 12),
      mkSession('s2', 'Auth refactor', 3_600_000, 0.21, 34),
      mkSession('s3', 'CI pipeline fixes', 7_200_000, 0.14, 18),
      mkSession('s4', 'API v2 migration', 90_000_000, 0.37, 45),
    ],
    's1',
  );
  playScript();
}

/** Called when the demo user hits Send — just replays the scripted turn so the
 *  composer feels alive instead of dead-ending on a missing backend. */
export function replayDemo(): void {
  playScript();
}
