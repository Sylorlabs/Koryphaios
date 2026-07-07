// Demo mode — when the app is embedded on koryphaios.com (via ?demo=1), it
// renders the REAL UI seeded with canned data and never touches a backend.
// This gives the marketing site a pixel-exact live preview without a rewrite.

import { browser } from '$app/environment';
import { authStore } from '$lib/stores/auth.svelte';
import { sessionStore } from '$lib/stores/sessions.svelte';
import { projectStore } from '$lib/stores/project.svelte';
import { feedStore } from '$lib/stores/feed.svelte';
import { agentStore } from '$lib/stores/agents.svelte';
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

/** Seed every store the main feed reads so the app shows a realistic session. */
export function seedDemo(): void {
  // Authenticated, no backend.
  authStore.setUser({ id: 'demo', email: 'demo@koryphaios.com', name: 'Demo' } as never);

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

  // Three worker agents (the cards along the top) + manager.
  const workers = [
    { id: 'w-fe', name: 'frontend', domain: 'ui', model: 'gpt-5.5', provider: 'codex', glow: 'rgba(0,255,255,0.5)' },
    { id: 'w-be', name: 'backend', domain: 'backend', model: 'gemini-3-pro', provider: 'google', glow: 'rgba(66,133,244,0.5)' },
    { id: 'w-test', name: 'testing', domain: 'test', model: 'claude-sonnet-5', provider: 'anthropic', glow: 'rgba(0,255,128,0.5)' },
  ];
  for (const w of workers) {
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
    agentStore.updateAgentStatus(w.id, 'thinking', 's1');
  }

  // The manager conversation, using the real feed entry shapes.
  const t = (s: number) => now - (30 - s) * 1000;
  feedStore.addFeedEntry({
    timestamp: t(0),
    type: 'user_message',
    agentId: 'user',
    agentName: 'You',
    glowClass: '',
    text: 'Build a full-stack analytics dashboard with charts, API routes, and tests.',
  });
  feedStore.addFeedEntry({
    timestamp: t(2),
    type: 'thought',
    agentId: 'kory-manager',
    agentName: 'Kory',
    glowClass: 'glow-kory',
    text: 'Classifying domain… decomposing into 3 subtasks.',
    metadata: { phase: 'analyzing' },
  });
  feedStore.addFeedEntry({
    timestamp: t(4),
    type: 'thought',
    agentId: 'kory-manager',
    agentName: 'Kory',
    glowClass: 'glow-kory',
    text: 'Routing: frontend → gpt-5.5 · backend → gemini-3-pro · tests → claude-sonnet-5',
    metadata: { phase: 'routing' },
  });
  feedStore.addFeedEntry({
    timestamp: t(6),
    type: 'content',
    agentId: 'kory-manager',
    agentName: 'Kory',
    glowClass: 'glow-kory',
    text: "I've delegated the three subtasks to specialist workers running in isolated git worktrees. The frontend agent is scaffolding the chart components, the backend agent is building the API routes, and the testing agent is writing coverage. I'll synthesize and run the critic gate once they report back.",
    thinkingFinalized: true,
  });

  agentStore.updateAgentStatus('kory-manager', 'streaming', 's1');
}
