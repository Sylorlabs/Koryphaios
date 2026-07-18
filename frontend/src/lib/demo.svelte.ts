// Demo mode — embedded on koryphaios.com via ?demo=1 (guided) or ?demo=full.
//
// Guided: renders the REAL UI and plays a scripted session on a loop so the
// site shows an example user doing work — Koryphaios *in action*.
//
// Full: the exact app, fully interactive. Every surface works (sessions,
// settings, notes, palette) against the in-memory API shim in demo-api.ts;
// sending a prompt simulates a manager turn. Nothing is saved anywhere.

import { authStore } from '$lib/stores/auth.svelte';
import { sessionStore } from '$lib/stores/sessions.svelte';
import { projectStore } from '$lib/stores/project.svelte';
import { feedStore } from '$lib/stores/feed.svelte';
import { agentStore } from '$lib/stores/agents.svelte';
import { providersStore } from '$lib/stores/providers.svelte';
import { registerDemoSessions, recordDemoMessage } from '$lib/demo-api';
import { isDemoMode, isGuidedDemo, isFullDemo, demoVariant } from '$lib/demo-flags';
import type { Session } from '@koryphaios/shared';

export { isDemoMode, isGuidedDemo, isFullDemo, demoVariant };

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
  {
    id: 'w-fe',
    name: 'frontend',
    domain: 'ui',
    model: 'gpt-5.6-sol',
    provider: 'codex',
    glow: 'rgba(0,255,255,0.5)',
  },
  {
    id: 'w-be',
    name: 'backend',
    domain: 'backend',
    model: 'gemini-3.1-pro',
    provider: 'google',
    glow: 'rgba(66,133,244,0.5)',
  },
  {
    id: 'w-test',
    name: 'testing',
    domain: 'test',
    model: 'claude-sonnet-4-6',
    provider: 'anthropic',
    glow: 'rgba(0,255,128,0.5)',
  },
];

const DEMO_PROVIDERS = [
  {
    name: 'codex',
    label: 'Codex',
    enabled: true,
    authenticated: true,
    authSource: 'CLI session',
    // Keep the picker in the same capability order people see in Codex:
    // flagship first, then the quality/cost balance, then the fast tier.
    models: ['gpt-5.6-sol-pro', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'],
    selectedModels: ['gpt-5.6-sol-pro', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'],
    allAvailableModels: [
      {
        id: 'gpt-5.6-sol-pro',
        name: 'GPT 5.6 Sol Pro',
        provider: 'codex',
        contextWindow: 1_050_000,
        maxOutputTokens: 128_000,
        contextVerified: true,
        canReason: true,
        reasoningLevels: ['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      },
      {
        id: 'gpt-5.6-sol',
        name: 'GPT 5.6 Sol',
        provider: 'codex',
        contextWindow: 1_050_000,
        maxOutputTokens: 128_000,
        contextVerified: true,
        canReason: true,
        reasoningLevels: ['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      },
      {
        id: 'gpt-5.6-terra',
        name: 'GPT 5.6 Terra',
        provider: 'codex',
        contextWindow: 1_050_000,
        maxOutputTokens: 128_000,
        contextVerified: true,
        canReason: true,
        reasoningLevels: ['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      },
      {
        id: 'gpt-5.6-luna',
        name: 'GPT 5.6 Luna',
        provider: 'codex',
        contextWindow: 1_050_000,
        maxOutputTokens: 128_000,
        contextVerified: true,
        canReason: true,
        reasoningLevels: ['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
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
    models: ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5'],
    selectedModels: ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5'],
    allAvailableModels: [
      {
        id: 'claude-opus-4-6',
        name: 'Claude Opus 4.6',
        provider: 'claude',
        contextWindow: 200_000,
        maxOutputTokens: 64_000,
        contextVerified: true,
        canReason: true,
        reasoningLevels: ['low', 'medium', 'high', 'max'],
      },
      {
        id: 'claude-sonnet-4-6',
        name: 'Claude Sonnet 4.6',
        provider: 'claude',
        contextWindow: 200_000,
        maxOutputTokens: 64_000,
        contextVerified: true,
        canReason: true,
        reasoningLevels: ['low', 'medium', 'high'],
      },
      {
        id: 'claude-haiku-4-5',
        name: 'Claude Haiku 4.5',
        provider: 'claude',
        contextWindow: 200_000,
        maxOutputTokens: 64_000,
        contextVerified: true,
        canReason: true,
        reasoningLevels: ['0', '1024', '8192', '24576'],
      },
    ],
    hideModelSelector: false,
    authMode: 'auth_only',
    supportsApiKey: false,
    supportsAuthToken: true,
    requiresBaseUrl: false,
  },
  {
    name: 'google',
    label: 'Google',
    enabled: true,
    authenticated: true,
    authSource: 'Google account',
    models: ['gemini-3.1-pro', 'gemini-3-flash'],
    selectedModels: ['gemini-3.1-pro', 'gemini-3-flash'],
    allAvailableModels: [
      {
        id: 'gemini-3.1-pro',
        name: 'Gemini 3.1 Pro',
        provider: 'google',
        contextWindow: 1_000_000,
        maxOutputTokens: 64_000,
        contextVerified: true,
        canReason: true,
        reasoningLevels: ['low', 'medium', 'high'],
      },
      {
        id: 'gemini-3-flash',
        name: 'Gemini 3 Flash',
        provider: 'google',
        contextWindow: 1_000_000,
        maxOutputTokens: 64_000,
        contextVerified: true,
        canReason: true,
        reasoningLevels: ['low', 'medium', 'high'],
      },
    ],
    hideModelSelector: false,
    authMode: 'api_key',
    supportsApiKey: true,
    supportsAuthToken: false,
    requiresBaseUrl: false,
  },
] as const;

const SCRIPT_PROMPT = 'Build a full-stack analytics dashboard with charts, API routes, and tests.';

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

// Full demo: session the current simulated turn belongs to, until its reply
// has been recorded. Lets a mid-turn session switch finalize the turn instead
// of leaking streamed text into the newly opened session.
let pendingReplySid: string | null = null;
let guidedPlaybackSessionId: string | null = null;

function activeSessionId(): string {
  return sessionStore.activeSessionId || 's1';
}

function spawnWorkers(sessionId: string) {
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
      sessionId,
    );
    agentStore.updateAgentStatus(w.id, 'idle', sessionId);
  }
}

/** One simulated manager turn. In the guided demo it loops forever; in the
 *  full demo it plays once per user prompt (and echoes the user's own text). */
function playTurn(prompt: string, opts: { loop: boolean; clear: boolean }) {
  clearTimers();
  const sid = activeSessionId();
  if (opts.loop) guidedPlaybackSessionId = sid;
  if (isFullDemo) pendingReplySid = sid;
  if (opts.clear) feedStore.clearFeed();
  // Remove the workers so they visibly fly back in from the top when Kory
  // routes — mirrors the real spawn animation each turn.
  agentStore.clearNonManagerAgents();
  agentStore.updateAgentStatus('kory-manager', 'idle', sid);

  at(600, () => {
    feedStore.addFeedEntry({
      timestamp: Date.now(),
      type: 'user_message',
      agentId: 'user',
      agentName: 'You',
      glowClass: '',
      text: prompt,
    });
    // Recorded at the same moment it's echoed so the session-switch history
    // fetch can never race it into a duplicate.
    if (isFullDemo) recordDemoMessage(sid, 'user', prompt);
  });

  at(1600, () => {
    agentStore.updateAgentStatus('kory-manager', 'analyzing', sid);
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
    agentStore.updateAgentStatus('kory-manager', 'verifying', sid);
    feedStore.addFeedEntry({
      timestamp: Date.now(),
      type: 'thought',
      agentId: 'kory-manager',
      agentName: 'Kory',
      glowClass: 'glow-kory',
      text: 'Routing: frontend → gpt-5.6-sol · backend → gemini-3.1-pro · tests → claude-sonnet-4-6',
      metadata: { phase: 'routing' },
    });
    // Workers spawn now — they fly in from the top of the agent rail.
    spawnWorkers(sid);
    at(250, () => {
      agentStore.updateAgentStatus('w-fe', 'writing', sid);
      agentStore.updateAgentStatus('w-be', 'thinking', sid);
      agentStore.updateAgentStatus('w-test', 'thinking', sid);
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
          output:
            'Created src/components/RevenueChart.tsx (+142)\nCreated src/api/metrics.ts (+88)',
          isError: false,
          durationMs: 0,
        },
      },
    });
    agentStore.updateAgentStatus('w-be', 'tool_calling', sid);
  });

  at(6200, () => {
    agentStore.updateAgentStatus('kory-manager', 'streaming', sid);
    // Stream the reply word by word. Offsets here are relative to THIS
    // callback (at() schedules from now), not to turn start.
    const words = REPLY.split(' ');
    words.forEach((word, i) => {
      at(i * 45, () => {
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
    const doneAt = words.length * 45 + 400;
    at(doneAt, () => {
      agentStore.updateAgentStatus('kory-manager', 'done', sid);
      for (const w of WORKERS) agentStore.updateAgentStatus(w.id, 'done', sid);
      // Full demo: persist the finished turn in the tab-scoped shim so
      // switching sessions and back restores the conversation.
      if (isFullDemo && pendingReplySid === sid) {
        recordDemoMessage(sid, 'assistant', REPLY, 'gpt-5.6-sol');
        pendingReplySid = null;
      }
    });
    // Hold, then loop (guided demo only).
    if (opts.loop) {
      at(doneAt + 4500, () => playTurn(SCRIPT_PROMPT, { loop: true, clear: true }));
    }
  });
}

/** Seed static state + start playback (guided) or hand control over (full). */
export function seedDemo(): void {
  authStore.setUser({ id: 'demo', email: 'demo@koryphaios.com', name: 'Demo' } as never);
  providersStore.setProviderStatusList(DEMO_PROVIDERS as never);
  projectStore.setProject('/demo/analytics-dashboard');
  // Both demos start with the same protected workspace. The guided embed
  // animates it; the full-screen demo leaves it ready for hands-on prompts.
  const sessions = [
    mkSession('s1', 'Analytics Dashboard', 0, 0.08, 12),
    mkSession('s2', 'Auth refactor', 3_600_000, 0.21, 34),
    mkSession('s3', 'CI pipeline fixes', 7_200_000, 0.14, 18),
    mkSession('s4', 'API v2 migration', 90_000_000, 0.37, 45),
  ];
  registerDemoSessions(sessions);
  sessionStore.seedDemoSessions(sessions, 's1');
  if (isGuidedDemo) {
    // Guided demo only: canned example conversations + the scripted loop.
    // Each visible chat is a real, independently seeded workflow. Selecting a
    // session loads its own conversation instead of reusing the analytics run.
    const seededChats = {
      s1: [
        ['user', SCRIPT_PROMPT],
        ['assistant', REPLY],
      ],
      s2: [
        ['user', 'Refactor authentication to support passkeys and preserve existing OAuth sessions.'],
        ['assistant', 'I mapped the current session boundary, added a passkey enrollment flow, and kept the OAuth callback contract stable. The migration includes rollback-safe session invalidation tests.'],
      ],
      s3: [
        ['user', 'Fix the CI pipeline failures and make preview deployments deterministic.'],
        ['assistant', 'The pipeline now caches Bun dependencies by lockfile, runs the typecheck before the test fan-out, and publishes one immutable preview artifact per commit.'],
      ],
      s4: [
        ['user', 'Migrate the public API to v2 without breaking existing integrations.'],
        ['assistant', 'The v2 routes use explicit versioned schemas, translate v1 payloads during the deprecation window, and include contract tests for both response shapes.'],
      ],
    } as const;
    for (const [sessionId, messages] of Object.entries(seededChats)) {
      for (const [role, content] of messages) {
        recordDemoMessage(sessionId, role, content, role === 'assistant' ? 'gpt-5.6-sol' : undefined);
      }
    }
    playTurn(SCRIPT_PROMPT, { loop: true, clear: true });
  }
  // Full demo: the protected workspace starts without canned feed content;
  // prompts remain tab-scoped and are never saved anywhere.
}

/** Guided demo: replay the scripted turn when the user hits Send. */
export function replayDemo(): void {
  playTurn(SCRIPT_PROMPT, { loop: true, clear: true });
}

/** Full demo: simulate one manager turn for the user's own prompt. */
export async function demoSend(message: string): Promise<void> {
  const text = message.trim();
  if (!text) return;
  // Like the real app: sending without a session starts one.
  if (!sessionStore.activeSessionId) {
    await sessionStore.createSession({ workingDirectory: '/demo/analytics-dashboard' });
  }
  playTurn(text, { loop: false, clear: false });
}

/** Stop the current simulated run without dead-ending the UI. */
export function demoStop(): void {
  clearTimers();
  pendingReplySid = null; // user cancelled — the unfinished reply is not saved
  const sid = activeSessionId();
  agentStore.updateAgentStatus('kory-manager', 'done', sid);
  for (const w of WORKERS) agentStore.updateAgentStatus(w.id, 'done', sid);
}

/** Full demo: switching AWAY from a session mid-run finalizes the in-flight
 *  turn — the reply persists in its own session instead of streaming into the
 *  newly opened one. A turn running in the still-active session is left alone
 *  (this also fires right after demoSend auto-creates a session). */
export function demoOnSessionSwitch(): void {
  // Guided mode has four independent canned chats. Stop the animated run
  // before its stale timers can write analytics events into the newly selected
  // workflow; session sync then atomically swaps in that chat's own history.
  if (isGuidedDemo && guidedPlaybackSessionId && sessionStore.activeSessionId !== guidedPlaybackSessionId) {
    const previousSessionId = guidedPlaybackSessionId;
    clearTimers();
    guidedPlaybackSessionId = null;
    agentStore.updateAgentStatus('kory-manager', 'done', previousSessionId);
    return;
  }
  if (!isFullDemo || !pendingReplySid) return;
  if (sessionStore.activeSessionId === pendingReplySid) return;
  clearTimers();
  recordDemoMessage(pendingReplySid, 'assistant', REPLY, 'gpt-5.6-sol');
  agentStore.updateAgentStatus('kory-manager', 'done', pendingReplySid);
  for (const w of WORKERS) agentStore.updateAgentStatus(w.id, 'done', pendingReplySid);
  pendingReplySid = null;
}
