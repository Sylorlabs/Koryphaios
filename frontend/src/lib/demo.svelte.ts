// Demo mode — embedded on koryphaios.com via ?demo=1 (guided) or ?demo=full.
//
// Guided: renders the REAL UI and plays a scripted session on a loop so the
// site shows an example user doing work — Koryphaios *in action*.
//
// Full: the real app frontend with a stateful, tab-scoped virtual workspace.
// Core browser-safe workflows (sessions, settings, notes, goals, files, diffs,
// and review) run against demo-api.ts; agent execution is explicitly simulated.
// Nothing is saved anywhere and native/provider operations stay desktop-only.

import { authStore } from '$lib/stores/auth.svelte';
import { sessionStore } from '$lib/stores/sessions.svelte';
import { projectStore } from '$lib/stores/project.svelte';
import { feedStore } from '$lib/stores/feed.svelte';
import { agentStore } from '$lib/stores/agents.svelte';
import { providersStore } from '$lib/stores/providers.svelte';
import { wsStore } from '$lib/stores/websocket.svelte';
import { applyDemoRunArtifacts, getDemoSession, registerDemoSessions, recordDemoMessage } from '$lib/demo-api';
import { isDemoMode, isGuidedDemo, isFullDemo, demoVariant } from '$lib/demo-flags';
import type { Session } from '@koryphaios/shared';

export { isDemoMode, isGuidedDemo, isFullDemo, demoVariant };

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
    model: 'gpt-5.6-sol',
    provider: 'codex',
    glow: 'rgba(0,255,255,0.5)',
  },
  {
    id: 'w-be',
    name: 'backend',
    domain: 'backend',
    model: 'jules-gemini-3.1-pro',
    provider: 'jules',
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
  ['jules', 'Google Jules', 'api_key'],
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
  ['replicate', 'Replicate', 'api_key'],
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
  ['luma', 'Luma', 'api_key'],
  ['fal', 'Fal', 'api_key'],
  ['elevenlabs', 'ElevenLabs', 'api_key'],
  ['deepgram', 'Deepgram', 'api_key'],
  ['gladia', 'Gladia', 'api_key'],
  ['assemblyai', 'AssemblyAI', 'api_key'],
  ['lmnt', 'LMNT', 'api_key'],
  ['nvidia', 'NVIDIA', 'api_key'],
  ['friendli', 'Friendli', 'api_key'],
  ['voyageai', 'Voyage AI', 'api_key'],
  ['mixedbread', 'Mixedbread', 'api_key'],
  ['mem0', 'Mem0', 'api_key'],
  ['letta', 'Letta', 'api_key'],
  ['blackforestlabs', 'Black Forest Labs', 'api_key'],
  ['klingai', 'Kling AI', 'api_key'],
  ['prodia', 'Prodia', 'api_key'],
  ['novita-ai', 'Novita AI', 'api_key'],
  ['upstage', 'Upstage', 'api_key'],
  ['siliconflow', 'SiliconFlow', 'api_key'],
  ['abacus', 'Abacus', 'api_key'],
  ['llama', 'Meta Llama', 'api_key'],
  ['vultr', 'Vultr', 'api_key'],
  ['wandb', 'Weights & Biases', 'api_key'],
  ['poe', 'Poe', 'api_key'],
  ['github-models', 'GitHub Models', 'api_key'],
  ['requesty', 'Requesty', 'api_key'],
  ['inference', 'Inference.net', 'api_key'],
  ['submodel', 'SubModel', 'api_key'],
  ['synthetic', 'Synthetic', 'api_key'],
  ['moark', 'Moark', 'api_key'],
  ['azurecognitive', 'Azure Cognitive', 'api_key'],
  ['sapai', 'SAP AI', 'api_key'],
  ['gitlab', 'GitLab', 'api_key'],
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
    models: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini'],
    selectedModels: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini'],
    allAvailableModels: [
      {
        id: 'gpt-5.6-sol',
        name: 'GPT-5.6-Sol',
        provider: 'codex',
        contextWindow: 1_050_000,
        maxOutputTokens: 128_000,
        contextVerified: true,
        canReason: true,
        reasoningLevels: ['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      },
      {
        id: 'gpt-5.6-terra',
        name: 'GPT-5.6-Terra',
        provider: 'codex',
        contextWindow: 1_050_000,
        maxOutputTokens: 128_000,
        contextVerified: true,
        canReason: true,
        reasoningLevels: ['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      },
      {
        id: 'gpt-5.6-luna',
        name: 'GPT-5.6-Luna',
        provider: 'codex',
        contextWindow: 1_050_000,
        maxOutputTokens: 128_000,
        contextVerified: true,
        canReason: true,
        reasoningLevels: ['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      },
      ...['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini'].map((id) => ({
        id,
        name: id.replace('gpt-', 'GPT-').replace('-mini', '-Mini'),
        provider: 'codex',
        contextWindow: 400_000,
        maxOutputTokens: 128_000,
        contextVerified: true,
        canReason: true,
        reasoningLevels: ['none', 'low', 'medium', 'high', 'xhigh'],
      })),
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
    authSource: 'Demo ChatGPT sign-in',
    models: ['gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4-mini'],
    selectedModels: ['gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4-mini'],
    allAvailableModels: [
      ['gpt-5.6-terra', 'GPT-5.6-Terra'],
      ['gpt-5.6-luna', 'GPT-5.6-Luna'],
      ['gpt-5.5', 'GPT-5.5'],
      ['gpt-5.4-mini', 'GPT-5.4-Mini'],
    ].map(([id, name]) => ({
      id,
      name,
      provider: 'codex-auth',
      contextWindow: 400_000,
      maxOutputTokens: 128_000,
      contextVerified: true,
      canReason: true,
      reasoningLevels: ['none', 'low', 'medium', 'high', 'xhigh'],
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
      ['claude-code-opus', 'Claude Opus 4.8'],
      ['claude-code-sonnet', 'Claude Sonnet 5'],
      ['claude-code-haiku', 'Claude Haiku 4.5'],
    ].map(([id, name]) => ({
      id,
      name,
      provider: 'claude',
      contextWindow: 200_000,
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
    name: 'jules',
    label: 'Google Jules',
    enabled: true,
    authenticated: true,
    authSource: 'Demo cloud connection',
    models: ['jules-gemini-3-flash', 'jules-gemini-3.1-pro'],
    selectedModels: ['jules-gemini-3-flash', 'jules-gemini-3.1-pro'],
    allAvailableModels: [
      {
        id: 'jules-gemini-3-flash',
        name: 'Jules · Gemini 3 Flash (cloud)',
        provider: 'jules',
        contextWindow: 1_000_000,
        maxOutputTokens: 64_000,
        contextVerified: true,
        canReason: true,
        reasoningLevels: [],
      },
      {
        id: 'jules-gemini-3.1-pro',
        name: 'Jules · Gemini 3.1 Pro (cloud)',
        provider: 'jules',
        contextWindow: 1_000_000,
        maxOutputTokens: 128_000,
        contextVerified: true,
        canReason: true,
        reasoningLevels: [],
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

function trialReply(prompt: string): string {
  const request = prompt.trim().replace(/\s+/g, ' ');
  return `I turned “${request}” into a tab-scoped trial plan. The manager routed frontend, backend, and test work; the critic simulated the matching test and marked it passed. The virtual workspace now contains an inspectable implementation plan, a matching test, and a README note. Review the generated diff, keep or reject it, then record evidence in Goal Mode. This is a simulated browser run—no provider, terminal, or local project was contacted.`;
}

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
let pendingReplyContent: string | null = null;
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
  const reply = isFullDemo ? trialReply(prompt) : REPLY;
  if (isFullDemo) {
    pendingReplySid = sid;
    pendingReplyContent = reply;
  }
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
      text: 'Routing: frontend → Codex CLI / GPT-5.6-Sol · backend → Google Jules / Gemini 3.1 Pro · tests → Claude Code / Claude Sonnet 5',
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
    const changes = isFullDemo ? applyDemoRunArtifacts(prompt, sid) : [];
    if (isFullDemo) {
      wsStore.setDemoSessionChanges(sid, changes);
      const updatedSession = getDemoSession(sid);
      if (updatedSession) sessionStore.handleSessionUpdate(updatedSession);
    }
    feedStore.addFeedEntry({
      timestamp: Date.now(),
      type: 'tool_result',
      agentId: 'kory-manager',
      agentName: 'Kory',
      glowClass: '',
      text: isFullDemo
        ? 'Prepared an inspectable browser-trial change set: plan, test, and README update.'
        : 'Created src/components/RevenueChart.tsx, src/api/metrics.ts',
      metadata: {
        toolResult: {
          callId: 'demo-1',
          name: 'batch_edit',
          output: isFullDemo
            ? 'Created src/lib/trialPlan.ts\nCreated tests/trialPlan.test.ts\nUpdated README.md\n\nOpen the review tray to inspect, keep, or reject these tab-scoped changes.'
            : 'Created src/components/RevenueChart.tsx (+142)\nCreated src/api/metrics.ts (+88)',
          isError: false,
          durationMs: 0,
        },
      },
    });
    agentStore.updateAgentStatus('w-be', 'tool_calling', sid);
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
      // Full demo: persist the finished turn in the tab-scoped shim so
      // switching sessions and back restores the conversation.
      if (isFullDemo && pendingReplySid === sid) {
        recordDemoMessage(sid, 'assistant', reply, 'gpt-5.6-sol');
        const completedSession = getDemoSession(sid);
        if (completedSession) sessionStore.handleSessionUpdate(completedSession);
        pendingReplySid = null;
        pendingReplyContent = null;
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
  projectStore.setProject(isFullDemo ? '/demo/starter-project' : '/demo/analytics-dashboard');
  // Guided mode is a repeatable story. Full mode is a genuinely fresh
  // tab-scoped instance: one empty chat, no canned history, no inherited cost.
  const sessions = isFullDemo
    ? [mkSession('s1', 'New session', 0, 0, 0, '/demo/starter-project')]
    : [
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
  // prompts and generated virtual-repository changes remain tab-scoped.
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
  pendingReplyContent = null;
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
  recordDemoMessage(pendingReplySid, 'assistant', pendingReplyContent ?? REPLY, 'gpt-5.6-sol');
  const completedSession = getDemoSession(pendingReplySid);
  if (completedSession) sessionStore.handleSessionUpdate(completedSession);
  agentStore.updateAgentStatus('kory-manager', 'done', pendingReplySid);
  for (const w of WORKERS) agentStore.updateAgentStatus(w.id, 'done', pendingReplySid);
  pendingReplySid = null;
  pendingReplyContent = null;
}
