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

// Gemini the MODEL is fine — it's served by Google's API (`google` provider).
// The Gemini CLI is a different, retired thing and must never appear.
const WORKERS = [
  { id: 'w-fe', name: 'frontend', domain: 'ui', model: 'gpt-5.6-sol', provider: 'codex', glow: 'rgba(0,255,255,0.5)' },
  { id: 'w-be', name: 'backend', domain: 'backend', model: 'gemini-3.1-pro', provider: 'google', glow: 'rgba(66,133,244,0.5)' },
  { id: 'w-test', name: 'testing', domain: 'test', model: 'claude-sonnet-5', provider: 'anthropic', glow: 'rgba(0,255,128,0.5)' },
];

const DEMO_PROVIDERS = [
  {
    name: 'codex',
    label: 'Codex',
    enabled: true,
    authenticated: true,
    authSource: 'CLI session',
    models: ['gpt-5.6-sol', 'gpt-5.4-mini'],
    selectedModels: ['gpt-5.6-sol', 'gpt-5.4-mini'],
    allAvailableModels: [
      {
        id: 'gpt-5.6-sol',
        name: 'GPT 5.6 Sol',
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
    // Gemini models come from Google's API — never from the retired Gemini CLI.
    name: 'google',
    label: 'Google',
    enabled: true,
    authenticated: true,
    authSource: 'API key',
    models: ['gemini-3.1-pro'],
    selectedModels: ['gemini-3.1-pro'],
    allAvailableModels: [
      {
        id: 'gemini-3.1-pro',
        name: 'Gemini 3.1 Pro',
        provider: 'google',
        contextWindow: 1_000_000,
        maxOutputTokens: 64_000,
        contextVerified: true,
        canReason: true,
      },
    ],
    hideModelSelector: false,
    authMode: 'api_key',
    supportsApiKey: true,
    supportsAuthToken: false,
    requiresBaseUrl: false,
  },
] as const;

const SCRIPT_PROMPT =
  'Build a full-stack analytics dashboard with charts, API routes, and tests.';

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
      text: 'Routing: frontend → gpt-5.6-sol · backend → gemini-3.1-pro · tests → claude-sonnet-5',
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
          output: 'Created src/components/RevenueChart.tsx (+142)\nCreated src/api/metrics.ts (+88)',
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
  if (isGuidedDemo) {
    // Guided demo only: canned example sessions + the scripted loop.
    const sessions = [
      mkSession('s1', 'Analytics Dashboard', 0, 0.08, 12),
      mkSession('s2', 'Auth refactor', 3_600_000, 0.21, 34),
      mkSession('s3', 'CI pipeline fixes', 7_200_000, 0.14, 18),
      mkSession('s4', 'API v2 migration', 90_000_000, 0.37, 45),
    ];
    registerDemoSessions(sessions);
    sessionStore.seedDemoSessions(sessions, 's1');
    playTurn(SCRIPT_PROMPT, { loop: true, clear: true });
  }
  // Full demo: NO canned content. The workspace starts fresh, exactly like
  // regular Koryphaios — sessions and messages the user creates live in the
  // in-memory shim for the lifetime of the tab, then vanish.
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
  if (!isFullDemo || !pendingReplySid) return;
  if (sessionStore.activeSessionId === pendingReplySid) return;
  clearTimers();
  recordDemoMessage(pendingReplySid, 'assistant', REPLY, 'gpt-5.6-sol');
  agentStore.updateAgentStatus('kory-manager', 'done', pendingReplySid);
  for (const w of WORKERS) agentStore.updateAgentStatus(w.id, 'done', pendingReplySid);
  pendingReplySid = null;
}
