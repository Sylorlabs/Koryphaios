// Guided public preview — embedded on koryphaios.com via ?demo=1.
//
// Guided: renders the REAL UI and plays a scripted session on a loop so the
// site shows an example user doing work — Koryphaios *in action*.
//
// It is intentionally read-only: no provider, terminal, local file, or mutable
// browser workspace is exposed from the public site.

import { authStore } from '$lib/stores/auth.svelte';
import { sessionStore } from '$lib/stores/sessions.svelte';
import { projectStore } from '$lib/stores/project.svelte';
import { feedStore } from '$lib/stores/feed.svelte';
import { agentStore } from '$lib/stores/agents.svelte';
import { providersStore } from '$lib/stores/providers.svelte';
import { registerDemoSessions, recordDemoMessage } from '$lib/demo-api';
import { isDemoMode, isGuidedDemo, demoVariant } from '$lib/demo-flags';
import type { Session } from '@koryphaios/shared';

export { isDemoMode, isGuidedDemo, demoVariant };


const now = Date.now();

function mkSession(
  id: string,
  title: string,
  ago: number,
  cost: number,
  msgs: number,
  workingDirectory = '/demo/analytics-dashboard',
): Session {
  return {
    id,
    title,
    workingDirectory,
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
    model: 'gpt-5.3-codex',
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
    model: 'claude-code-sonnet',
    provider: 'claude',
    glow: 'rgba(0,255,128,0.5)',
  },
];

// Snapshot of the provider identities returned by the current Koryphaios
// registry. Models are intentionally not invented for disconnected providers:
// the real app fills those from each provider at runtime.
const AVAILABLE_DEMO_PROVIDERS = [
  ['anthropic', 'Anthropic', 'api_key_or_auth'],
  ['openai', 'OpenAI', 'api_key'],
  ['google', 'Google', 'api_key'],
  ['aistudio', 'Google AI Studio', 'api_key'],
  ['xai', 'xAI', 'api_key'],
  ['openrouter', 'OpenRouter', 'api_key'],
  ['tokenrouter', 'TokenRouter', 'api_key'],
  ['groq', 'Groq', 'api_key'],
  ['digitalocean', 'DigitalOcean Inference', 'api_key'],
  ['copilot', 'GitHub Copilot', 'auth_only'],
  ['codex', 'Codex CLI', 'auth_only'],
  ['codex-auth', 'OpenAI Codex', 'auth_only'],
  ['grok', 'Grok Build', 'auth_only'],
  ['antigravity', 'Antigravity', 'auth_only'],
  ['cursor', 'Cursor', 'auth_only'],
  ['devin', 'Devin', 'auth_only'],
  ['cline', 'Cline', 'auth_only'],
  ['azure', 'Azure OpenAI', 'api_key_or_auth'],
  ['bedrock', 'AWS Bedrock', 'env_auth'],
  ['vertexai', 'Vertex AI', 'env_auth'],
  ['local', 'Local (custom endpoint)', 'base_url_only'],
  ['ollama', 'Ollama', 'base_url_only'],
  ['lmstudio', 'LM Studio', 'base_url_only'],
  ['llamacpp', 'Llama.cpp', 'base_url_only'],
  ['ollamacloud', 'Ollama Cloud', 'api_key'],
  ['deepseek', 'DeepSeek', 'api_key'],
  ['minimax', 'MiniMax', 'api_key'],
  ['kimicode', 'Kimi Code', 'auth_only'],
  ['moonshot', 'Moonshot AI', 'api_key'],
  ['zai', 'ZAI', 'api_key'],
  ['cortecs', 'Cortecs', 'api_key'],
  ['stepfun', 'StepFun', 'api_key'],
  ['qwen', 'Qwen', 'api_key'],
  ['modelscope', 'ModelScope', 'api_key'],
  ['cerebras', 'Cerebras', 'api_key'],
  ['fireworks', 'Fireworks AI', 'api_key'],
  ['deepinfra', 'DeepInfra', 'api_key'],
  ['ionet', 'IO.net', 'api_key'],
  ['hyperbolic', 'Hyperbolic', 'api_key'],
  ['huggingface', 'HuggingFace', 'api_key'],
  ['modal', 'Modal', 'api_key'],
  ['cloudflare', 'Cloudflare', 'api_key'],
  ['vercel', 'Vercel', 'api_key'],
  ['baseten', 'Baseten', 'api_key'],
  ['helicone', 'Helicone', 'api_key'],
  ['portkey', 'Portkey', 'api_key'],
  ['scaleway', 'Scaleway', 'api_key'],
  ['ovhcloud', 'OVHcloud', 'api_key'],
  ['stackit', 'STACKIT', 'api_key'],
  ['nebius', 'Nebius', 'api_key'],
  ['togetherai', 'Together AI', 'api_key'],
  ['venice', 'Venice AI', 'api_key'],
  ['zenmux', 'ZenMux', 'api_key'],
  ['opencodezen', 'OpenCode Zen', 'api_key'],
  ['opencodego', 'OpenCode Go', 'api_key'],
  ['302ai', '302.ai', 'api_key'],
  ['claude', 'Claude Code', 'auth_only'],
  ['mistral', 'Mistral AI', 'api_key'],
  ['cohere', 'Cohere', 'api_key'],
  ['perplexity', 'Perplexity', 'api_key'],
  ['nvidia', 'NVIDIA', 'api_key'],
  ['friendli', 'Friendli', 'api_key'],
  ['novita-ai', 'Novita AI', 'api_key'],
  ['upstage', 'Upstage', 'api_key'],
  ['siliconflow', 'SiliconFlow', 'api_key'],
  ['abacus', 'Abacus', 'api_key'],
  ['llama', 'Meta Llama', 'api_key'],
  ['vultr', 'Vultr', 'api_key'],
  ['wandb', 'Weights & Biases', 'api_key'],
  ['poe', 'Poe', 'api_key'],
  ['requesty', 'Requesty', 'api_key'],
  ['inference', 'Inference.net', 'api_key'],
  ['submodel', 'SubModel', 'api_key'],
  ['synthetic', 'Synthetic', 'api_key'],
  ['moark', 'Moark', 'api_key'],
  ['azurecognitive', 'Azure Cognitive', 'api_key'],
  ['sapai', 'SAP AI', 'api_key'],
] as const;

// These are clearly marked demo connections. Their model IDs and display
// names mirror current provider-emitted evidence from the app, including the
// deliberately separate Codex CLI and managed OpenAI Codex identities.
const CONNECTED_DEMO_PROVIDERS = [
  {
    name: 'codex',
    label: 'Codex CLI',
    enabled: true,
    authenticated: true,
    authSource: 'Demo CLI session',
    models: ['gpt-5.3-codex'],
    selectedModels: ['gpt-5.3-codex'],
    allAvailableModels: [
      {
        id: 'gpt-5.3-codex',
        name: 'GPT-5.3-Codex',
        provider: 'codex',
        contextWindow: 400_000,
        maxOutputTokens: 128_000,
        contextVerified: true,
        canReason: true,
        reasoningLevels: ['low', 'medium', 'high', 'xhigh'],
      },
    ],
    hideModelSelector: false,
    authMode: 'auth_only',
    supportsApiKey: false,
    supportsAuthToken: true,
    requiresBaseUrl: false,
  },
  {
    name: 'codex-auth',
    label: 'OpenAI Codex',
    enabled: true,
    authenticated: true,
    authSource: 'Demo ChatGPT subscription sign-in',
    models: ['gpt-5.3-codex'],
    selectedModels: ['gpt-5.3-codex'],
    allAvailableModels: [
      ['gpt-5.3-codex', 'GPT-5.3-Codex'],
    ].map(([id, name]) => ({
      id,
      name,
      provider: 'codex-auth',
      contextWindow: 400_000,
      maxOutputTokens: 128_000,
      contextVerified: true,
      canReason: true,
      reasoningLevels: ['low', 'medium', 'high', 'xhigh'],
    })),
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
    authSource: 'Demo CLI session',
    models: ['claude-code-fable', 'claude-code-opus', 'claude-code-sonnet', 'claude-code-haiku'],
    selectedModels: ['claude-code-fable', 'claude-code-opus', 'claude-code-sonnet', 'claude-code-haiku'],
    allAvailableModels: [
      ['claude-code-fable', 'Claude Fable 5'],
      ['claude-code-opus', 'Claude Opus 5'],
      ['claude-code-sonnet', 'Claude Sonnet 5'],
      ['claude-code-haiku', 'Claude Haiku 4.5'],
    ].map(([id, name]) => ({
      id,
      name,
      provider: 'claude',
      contextWindow: 1_000_000,
      maxOutputTokens: 32_000,
      contextVerified: true,
      canReason: true,
      reasoningLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    })),
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
    authSource: 'Demo Gemini API connection',
    models: ['gemini-3.6-flash', 'gemini-3.1-pro'],
    selectedModels: ['gemini-3.6-flash', 'gemini-3.1-pro'],
    allAvailableModels: [
      {
        id: 'gemini-3.6-flash',
        name: 'Gemini 3.6 Flash',
        provider: 'google',
        contextWindow: 1_000_000,
        maxOutputTokens: 64_000,
        contextVerified: true,
        canReason: true,
        reasoningLevels: ['low', 'medium', 'high'],
      },
      {
        id: 'gemini-3.1-pro',
        name: 'Gemini 3.1 Pro',
        provider: 'google',
        contextWindow: 1_000_000,
        maxOutputTokens: 64_000,
        contextVerified: true,
        canReason: true,
        reasoningLevels: ['low', 'medium', 'high', 'xhigh'],
      },
    ],
    hideModelSelector: false,
    authMode: 'api_key',
    supportsApiKey: true,
    supportsAuthToken: false,
    requiresBaseUrl: false,
  },
] as const;

const connectedDemoProviders = new Map<string, (typeof CONNECTED_DEMO_PROVIDERS)[number]>(
  CONNECTED_DEMO_PROVIDERS.map((provider) => [provider.name, provider]),
);

const DEMO_PROVIDERS = AVAILABLE_DEMO_PROVIDERS.map(([name, label, authMode]) => {
  const connected = connectedDemoProviders.get(name);
  if (connected) return connected;
  return {
    name,
    label,
    enabled: false,
    authenticated: false,
    authSource: 'Not connected in this demo',
    models: [],
    selectedModels: [],
    allAvailableModels: [],
    hideModelSelector: false,
    authMode,
    supportsApiKey: authMode === 'api_key' || authMode === 'api_key_or_auth',
    supportsAuthToken: authMode === 'auth_only' || authMode === 'api_key_or_auth',
    requiresBaseUrl: authMode === 'base_url_only',
  };
});

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
    const usage = w.id === 'w-fe'
      ? { tokensUsed: 84_200, contextWindow: 400_000, breakdown: { system: 8_400, memory: 6_800, tools: 41_100, chat: 27_900 } }
      : w.id === 'w-be'
        ? { tokensUsed: 112_600, contextWindow: 400_000, breakdown: { system: 7_900, memory: 9_200, tools: 63_500, chat: 32_000 } }
        : { tokensUsed: 46_800, contextWindow: 400_000, breakdown: { system: 6_100, memory: 4_700, tools: 18_600, chat: 17_400 } };
    agentStore.updateUsage(w.id, { ...usage, agentId: w.id, model: w.model, provider: w.provider as never, tokensIn: usage.tokensUsed, tokensOut: 0, usageKnown: true, contextKnown: true }, sessionId);
    agentStore.setAgentThreadFeed(sessionId, w.id, [
      {
        id: `demo-${w.id}-request`,
        timestamp: Date.now() - 1_800,
        type: 'user_message',
        agentId: 'user',
        agentName: 'You',
        glowClass: '',
        text: SCRIPT_PROMPT,
      },
      {
        id: `demo-${w.id}-brief`,
        timestamp: Date.now() - 1_400,
        type: 'content',
        agentId: 'kory-manager',
        agentName: 'Manager',
        glowClass: 'glow-kory',
        text: w.id === 'w-fe'
          ? 'Build the responsive analytics chart and preserve the existing visual language.'
          : w.id === 'w-be'
            ? 'Implement the metrics query route, cache results, and return typed errors.'
            : 'Add coverage for the dashboard data states and verify the main workflow.',
      },
      {
        id: `demo-${w.id}-activity`,
        timestamp: Date.now() - 700,
        type: 'tool_result',
        agentId: w.id,
        agentName: w.name,
        glowClass: w.id === 'w-fe' ? 'glow-codex' : w.id === 'w-be' ? 'glow-google' : 'glow-test',
        text: w.id === 'w-fe'
          ? 'Editing src/components/RevenueChart.tsx · inspecting the chart data contract.'
          : w.id === 'w-be'
            ? 'Editing src/api/metrics.ts · tracing the cache and query boundary.'
            : 'Running dashboard.integration.test.ts · checking empty, loading, and error states.',
      },
    ]);
  }
}

/** One read-only, looping sample manager turn. */
function playTurn(prompt: string, opts: { loop: boolean; clear: boolean }) {
  clearTimers();
  const sid = activeSessionId();
  if (opts.loop) guidedPlaybackSessionId = sid;
  const reply = REPLY;
  // Only reset on the first pass. Clearing before a delayed first event made
  // the embedded demo visibly empty between loops, which looked frozen.
  if (opts.clear) {
    feedStore.clearFeed();
    agentStore.clearNonManagerAgents();
  }
  agentStore.updateAgentStatus('kory-manager', 'idle', sid);

  // Always keep a visible event on screen. The rest of the playback still
  // stages in, but a loop transition is never a blank workspace.
  feedStore.addFeedEntry({
    timestamp: Date.now(),
    type: 'user_message',
    agentId: 'user',
    agentName: 'You',
    glowClass: '',
    text: prompt,
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
      text: 'Routing: frontend → Codex CLI / GPT-5.6-Sol · backend → Google / Gemini 3.1 Pro · tests → Claude Code / Claude Sonnet 5',
      metadata: { phase: 'routing' },
    });
    // Workers spawn now — they fly in from the top of the agent rail.
    spawnWorkers(sid);
    at(250, () => {
      agentStore.updateAgentStatus('w-fe', 'writing', sid);
      agentStore.updateAgentStatus('w-be', 'writing', sid);
      agentStore.updateAgentStatus('w-test', 'verifying', sid);
      agentStore.addToolCall('w-fe', 'demo-edit-file', 'edit_file', sid);
      agentStore.addToolCall('w-be', 'demo-read-file', 'read_file', sid);
      agentStore.addToolCall('w-test', 'demo-run-tests', 'run_tests', sid);
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
    agentStore.updateAgentStatus('w-be', 'writing', sid);
  });

  at(5400, () => {
    feedStore.addFeedEntry({
      timestamp: Date.now(),
      type: 'tool_result',
      agentId: 'trial-critic',
      agentName: 'Critic',
      glowClass: '',
      text: 'Critic verified the browser-trial test result before review.',
      metadata: {
        toolResult: {
          callId: 'demo-critic-1',
          name: 'bun test tests/trialPlan.test.ts',
          output: 'PASS tests/trialPlan.test.ts · 1 passed · simulated browser-trial verifier',
          isError: false,
          durationMs: 184,
        },
      },
    });
  });

  at(6200, () => {
    agentStore.updateAgentStatus('kory-manager', 'streaming', sid);
    // Stream the reply word by word. Offsets here are relative to THIS
    // callback (at() schedules from now), not to turn start.
    const words = reply.split(' ');
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
    });
    // Hold, then loop (guided demo only).
    if (opts.loop) {
      at(doneAt + 4500, () => playTurn(SCRIPT_PROMPT, { loop: true, clear: false }));
    }
  });
}

/** Seed the public preview and start its repeatable playback. */
export function seedDemo(): void {
  authStore.setUser({ id: 'demo', email: 'demo@koryphaios.com', name: 'Demo' } as never);
  providersStore.setProviderStatusList(DEMO_PROVIDERS as never);
  projectStore.setProject('/demo/analytics-dashboard');
  agentStore.spawnAgent(
    {
      id: 'kory-manager',
      name: 'Kory',
      role: 'manager',
      model: 'gpt-5.3-codex',
      provider: 'codex',
      domain: 'general',
      glowColor: 'rgba(255,215,0,0.6)',
    },
    'Decomposing the dashboard request and reviewing worker results.',
    's1',
  );
  agentStore.updateUsage('kory-manager', {
    agentId: 'kory-manager',
    model: 'gpt-5.3-codex',
    provider: 'codex',
    tokensIn: 156_400,
    tokensOut: 8_600,
    tokensUsed: 165_000,
    usageKnown: true,
    contextWindow: 400_000,
    contextKnown: true,
    breakdown: { system: 9_600, memory: 15_200, tools: 74_400, chat: 65_800 },
  }, 's1');
  const sessions = [
    mkSession('s1', 'Analytics Dashboard', 0, 0.08, 12),
    mkSession('s2', 'Auth refactor', 3_600_000, 0.21, 34),
    mkSession('s3', 'CI pipeline fixes', 7_200_000, 0.14, 18),
    mkSession('s4', 'API v2 migration', 90_000_000, 0.37, 45),
  ];
  registerDemoSessions(sessions);
  sessionStore.seedDemoSessions(sessions, 's1');
  // Each sample session has its own canned conversation.
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
      recordDemoMessage(sessionId, role, content, role === 'assistant' ? 'gpt-5.3-codex' : undefined);
    }
  }
  playTurn(SCRIPT_PROMPT, { loop: true, clear: true });
}

/** Guided demo: replay the scripted turn when the user hits Send. */
export function replayDemo(): void {
  playTurn(SCRIPT_PROMPT, { loop: true, clear: true });
}

/** Recover the fixed sample immediately if a stale UI control calls stop. */
export function demoStop(): void {
  playTurn(SCRIPT_PROMPT, { loop: true, clear: true });
}

/** Keep a session switch from leaking the previous sample's timers. */
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
}
