// Display vocabulary for agents at work: one place that turns an agent's
// status, current tool call and timing into the words, tone and grouping every
// orchestration surface uses (the tab strip, the Activity lineage view, the
// thread header and the delegation row). Pure functions only — no store reads.

import type { AgentStatus } from '@koryphaios/shared';

/** How a status should read at a glance. The tone drives the glyph colour;
 *  the label is always shown or announced next to it, so colour never
 *  carries the meaning alone. */
export type AgentStatusTone = 'active' | 'waiting' | 'attention' | 'success' | 'error' | 'muted';

/** Coarse buckets the lineage view groups by. */
export type AgentStatusGroup = 'running' | 'waiting' | 'failed' | 'finished';

export interface AgentStatusInfo {
  /** Sentence-case label, e.g. "Running tool", "Waiting on you". */
  label: string;
  tone: AgentStatusTone;
  group: AgentStatusGroup;
  /** Still producing (spinner-worthy). Waiting and terminal are not live. */
  live: boolean;
}

const STATUS_INFO: Record<AgentStatus, AgentStatusInfo> = {
  thinking: { label: 'Thinking', tone: 'active', group: 'running', live: true },
  analyzing: { label: 'Analyzing', tone: 'active', group: 'running', live: true },
  tool_calling: { label: 'Running tool', tone: 'active', group: 'running', live: true },
  streaming: { label: 'Writing reply', tone: 'active', group: 'running', live: true },
  verifying: { label: 'Verifying', tone: 'active', group: 'running', live: true },
  compacting: { label: 'Compacting context', tone: 'active', group: 'running', live: true },
  reading: { label: 'Reading', tone: 'active', group: 'running', live: true },
  writing: { label: 'Editing', tone: 'active', group: 'running', live: true },
  searching: { label: 'Searching', tone: 'active', group: 'running', live: true },
  criticizing: { label: 'Reviewing', tone: 'active', group: 'running', live: true },
  waiting: { label: 'Waiting', tone: 'waiting', group: 'waiting', live: false },
  waiting_user: { label: 'Waiting on you', tone: 'attention', group: 'waiting', live: false },
  error: { label: 'Failed', tone: 'error', group: 'failed', live: false },
  done: { label: 'Done', tone: 'success', group: 'finished', live: false },
  idle: { label: 'Idle', tone: 'muted', group: 'finished', live: false },
};

const UNKNOWN_STATUS: AgentStatusInfo = {
  label: 'Working',
  tone: 'active',
  group: 'running',
  live: true,
};

export function agentStatusInfo(
  status: AgentStatus | string | undefined,
  options: { stopReason?: 'cancelled' } = {},
): AgentStatusInfo {
  const info = (status && STATUS_INFO[status as AgentStatus]) || UNKNOWN_STATUS;
  // A user cancellation lands as `done`; calling it a success would be a lie.
  if (options.stopReason === 'cancelled' && (status === 'done' || status === 'idle')) {
    return { label: 'Stopped', tone: 'muted', group: 'finished', live: false };
  }
  return info;
}

/** Order the lineage groups render in: what needs the user first. */
export const AGENT_GROUP_ORDER: readonly AgentStatusGroup[] = [
  'waiting',
  'failed',
  'running',
  'finished',
];

export const AGENT_GROUP_LABELS: Record<AgentStatusGroup, string> = {
  waiting: 'Waiting',
  failed: 'Failed',
  running: 'Running',
  finished: 'Finished',
};

const PROVIDER_LABELS: Record<string, string> = {
  openai: 'OpenAI',
  codex: 'Codex CLI',
  'codex-auth': 'OpenAI Codex',
  anthropic: 'Anthropic',
  claude: 'Claude Code',
  google: 'Google',
  aistudio: 'Google AI Studio',
  xai: 'xAI',
  openrouter: 'OpenRouter',
  unorouter: 'UnoRouter',
  hundredmillionseek: '100MillionSeek',
  numes: 'Numes',
  coarena: 'Coarena',
  crowllm: 'CrowLLM',
  radeon: 'AMD Radeon Cloud',
  runcrate: 'Runcrate',
  tokenharbor: 'Token Harbor',
  logfare: 'Logfare',
  apinex: 'APInex',
  gwarden: 'Gwarden AI',
  respan: 'Respan',
  vertexai: 'Vertex AI',
  copilot: 'Copilot',
  kimicode: 'Kimi Code',
  opencode: 'OpenCode',
  beam: 'Reflection AI',
};

/** Human provider name. Unknown ids are capitalised rather than hidden. */
export function providerLabel(provider: string | undefined): string {
  if (!provider) return 'Unknown provider';
  return PROVIDER_LABELS[provider] ?? provider.charAt(0).toUpperCase() + provider.slice(1);
}

/** Collapse whitespace and cut a string to `max` characters with an ellipsis. */
export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, Math.max(1, max - 1)).trimEnd()}…` : flat;
}

// Most telling first: a grep's pattern says more than the folder it searched.
const ARG_KEYS = [
  'command',
  'cmd',
  'pattern',
  'query',
  'file_path',
  'filePath',
  'path',
  'file',
  'url',
  'name',
  'agentName',
  'task',
];

/** The one argument that says what a tool call is doing right now. */
export function toolCallArgument(input: Record<string, unknown> | undefined): string {
  if (!input || typeof input !== 'object') return '';
  for (const key of ARG_KEYS) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  for (const value of Object.values(input)) {
    if (typeof value === 'string' && value.trim()) return value;
  }
  return '';
}

/** "bash · bun run test …" — the current tool plus a short argument. */
export function describeToolActivity(
  call: { name: string; input?: Record<string, unknown> } | undefined,
  maxArg = 48,
): string {
  if (!call?.name) return '';
  const name = call.name.replace(/^mcp__[^_]+__/, '').replace(/^kory__/, '');
  const arg = toolCallArgument(call.input);
  return arg ? `${name} · ${clip(arg, maxArg)}` : name;
}

/** Compact elapsed time: "8s", "4m 05s", "1h 12m". Empty for unknown. */
export function formatElapsed(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return '';
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes}m ${String(totalSeconds % 60).padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`;
}

/** Run time of an agent: frozen at `endedAt`, ticking against `now` while it
 *  runs. Unknown (empty) without a start. */
export function agentElapsedMs(
  timing: { startedAt?: number; endedAt?: number },
  now: number,
): number | undefined {
  if (timing.startedAt === undefined) return undefined;
  const end = timing.endedAt ?? now;
  return Math.max(0, end - timing.startedAt);
}

/** First meaningful line of an agent's output, for a one-line result summary. */
export function resultSummary(content: string | undefined, max = 140): string {
  if (!content) return '';
  const lines = content
    .split('\n')
    .map((part) => part.trim())
    .filter(Boolean);
  // A heading ("## Summary") labels the result rather than stating it.
  const line = lines.find((part) => !part.startsWith('#')) ?? lines[0];
  const text = line?.replace(/^[#>*\-\s`]+/, '').trim();
  return text ? clip(text, max) : '';
}

export interface LineageNode<T> {
  agent: T;
  depth: number;
  children: LineageNode<T>[];
}

/** Build parent → children trees. An agent whose parent is unknown or not in
 *  the list is a root (a direct report of the manager). Cycles are broken by
 *  treating the repeat visit as a root. Input order is preserved. */
export function buildLineage<T extends { identity: { id: string }; parentAgentId?: string }>(
  agents: readonly T[],
): LineageNode<T>[] {
  const byId = new Map(agents.map((agent) => [agent.identity.id, agent]));
  const childrenOf = new Map<string, T[]>();
  const roots: T[] = [];
  for (const agent of agents) {
    const parentId = agent.parentAgentId;
    if (parentId && parentId !== agent.identity.id && byId.has(parentId)) {
      const list = childrenOf.get(parentId) ?? [];
      list.push(agent);
      childrenOf.set(parentId, list);
    } else {
      roots.push(agent);
    }
  }
  const placed = new Set<string>();
  const build = (agent: T, depth: number): LineageNode<T> => {
    placed.add(agent.identity.id);
    const children = (childrenOf.get(agent.identity.id) ?? [])
      .filter((child) => !placed.has(child.identity.id))
      .map((child) => build(child, depth + 1));
    return { agent, depth, children };
  };
  const trees = roots.map((root) => build(root, 0));
  // Anything still unplaced sits in a parent cycle; surface it as a root.
  for (const agent of agents) {
    if (!placed.has(agent.identity.id)) trees.push(build(agent, 0));
  }
  return trees;
}

/** Depth-first flattening for rendering a tree as a list of indented rows. */
export function flattenLineage<T>(nodes: readonly LineageNode<T>[]): LineageNode<T>[] {
  const out: LineageNode<T>[] = [];
  const walk = (list: readonly LineageNode<T>[]) => {
    for (const node of list) {
      out.push(node);
      walk(node.children);
    }
  };
  walk(nodes);
  return out;
}
