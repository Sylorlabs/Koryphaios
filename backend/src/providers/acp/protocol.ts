// ACP (Agent Client Protocol) wire types, permission policy and session-update
// mapping shared by every ACP-driven provider (opencode, generic `acp:<id>`).
//
// Transport lives in ./client.ts. Nothing in this module touches processes,
// credentials or configuration.

// ─── Types ───────────────────────────────────────────────────────────────────

export interface AcpStdioMcpServer {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export type AcpPromptBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; data: string };

export interface AcpConfigOption {
  id: string;
  name: string;
  category?: string;
  type: string;
  currentValue?: string;
  options?: Array<{ value: string; name?: string; description?: string }>;
  description?: string;
}

export interface AcpInitializeResult {
  protocolVersion: number;
  agentCapabilities?: {
    loadSession?: boolean;
    mcpCapabilities?: { http?: boolean; sse?: boolean };
    promptCapabilities?: { image?: boolean; embeddedContext?: boolean };
    sessionCapabilities?: Record<string, unknown>;
  };
  authMethods?: Array<{ id?: string; name?: string }>;
  agentInfo?: { name?: string; version?: string };
}

export interface AcpNewSessionResult {
  sessionId: string;
  configOptions?: AcpConfigOption[];
}

export interface AcpPromptResult {
  stopReason?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    thoughtTokens?: number;
  };
}

export type AcpSessionEvent =
  | { type: 'agent_message_chunk'; text: string }
  | { type: 'agent_thought_chunk'; text: string }
  | {
      type: 'tool_call';
      toolCallId: string;
      name: string;
      title?: string;
      kind?: string;
      status?: string;
      rawInput?: Record<string, unknown>;
      locations?: Array<{ path?: string }>;
    }
  | {
      type: 'tool_call_update';
      toolCallId: string;
      name?: string;
      title?: string;
      kind?: string;
      status?: string;
      rawInput?: Record<string, unknown>;
      content?: Array<{ type: string; content?: { type: string; text?: string } }>;
      rawOutput?: unknown;
      locations?: Array<{ path?: string }>;
    }
  | {
      type: 'usage_update';
      used?: number;
      size?: number;
      cost?: { amount?: number; currency?: string };
    }
  | { type: 'available_commands_update' }
  | { type: 'unknown'; sessionUpdate: string };

export interface AcpPermissionRequest {
  sessionId: string;
  toolCall?: {
    toolCallId?: string;
    name?: string;
    title?: string;
    kind?: string;
    status?: string;
    rawInput?: Record<string, unknown>;
  };
  options?: Array<{ optionId: string; name?: string; kind?: string }>;
}

export type AcpPermissionDecision =
  /** Select the first allow option; fall back to approving once by kind. */
  | { action: 'allow' }
  /** Select the first reject option; fall back to cancelled. */
  | { action: 'reject' };

/**
 * Per-agent permission profile. Every profile answers `session/request_permission`
 * fail-closed: anything that is not explicitly read-like is rejected, because the
 * Kory MCP bridge is the only mutation path Kory can enforce.
 *
 * - `bridge-only` (default): read / search / fetch / think / other / switch_mode
 *   are allowed. native edit / delete / move / execute are rejected.
 * - `read-only`: read / search / think only. Fetch and other kinds are rejected
 *   too, so a turn cannot reach the network or dispatch untyped native tools.
 */
export type AcpPermissionProfile = 'bridge-only' | 'read-only';

export const ACP_PERMISSION_PROFILES: readonly AcpPermissionProfile[] = [
  'bridge-only',
  'read-only',
] as const;

const BRIDGE_ONLY_KINDS = new Set(['read', 'search', 'fetch', 'think', 'other', 'switch_mode']);
const READ_ONLY_KINDS = new Set(['read', 'search', 'think']);

export function decideAcpPermission(
  request: AcpPermissionRequest,
  profile: AcpPermissionProfile = 'bridge-only',
): AcpPermissionDecision {
  const kind = (request.toolCall?.kind ?? 'other').toLowerCase();
  const allowed = profile === 'read-only' ? READ_ONLY_KINDS : BRIDGE_ONLY_KINDS;
  return allowed.has(kind) ? { action: 'allow' } : { action: 'reject' };
}

/** Pick the option id the client should answer with for a decision. */
export function pickAcpPermissionOption(
  decision: AcpPermissionDecision,
  options: AcpPermissionRequest['options'] | undefined,
): { optionId?: string; cancelled?: boolean } {
  const list = options ?? [];
  const isAllow = (kind: string) => kind.startsWith('allow');
  const isReject = (kind: string) => kind.startsWith('reject');
  if (decision.action === 'allow') {
    const allow = list.find((o) => o.kind && isAllow(o.kind.toLowerCase()));
    return allow ? { optionId: allow.optionId } : { cancelled: true };
  }
  const reject = list.find((o) => o.kind && isReject(o.kind.toLowerCase()));
  return reject ? { optionId: reject.optionId } : { cancelled: true };
}

// ─── session/update mapping ──────────────────────────────────────────────────

/** Translate one `session/update` into a typed event. Returns null for kinds the
 *  adapter does not consume. */
export function mapSessionUpdate(update: Record<string, unknown>): AcpSessionEvent | null {
  const kind = typeof update.sessionUpdate === 'string' ? update.sessionUpdate : '';
  const record = update as Record<string, unknown>;
  switch (kind) {
    case 'agent_message_chunk': {
      const content = record.content as { text?: string } | undefined;
      const text = typeof content?.text === 'string' ? content.text : '';
      return text ? { type: 'agent_message_chunk', text } : null;
    }
    case 'agent_thought_chunk': {
      const content = record.content as { text?: string } | undefined;
      const text = typeof content?.text === 'string' ? content.text : '';
      return text ? { type: 'agent_thought_chunk', text } : null;
    }
    case 'tool_call': {
      const toolCallId = typeof record.toolCallId === 'string' ? record.toolCallId : '';
      if (!toolCallId) return null;
      return {
        type: 'tool_call',
        toolCallId,
        name: typeof record.name === 'string' ? record.name : '',
        title: typeof record.title === 'string' ? record.title : undefined,
        kind: typeof record.kind === 'string' ? record.kind : undefined,
        status: typeof record.status === 'string' ? record.status : undefined,
        rawInput: isRecord(record.rawInput) ? record.rawInput : undefined,
        locations: normalizeLocations(record.locations),
      };
    }
    case 'tool_call_update': {
      const toolCallId = typeof record.toolCallId === 'string' ? record.toolCallId : '';
      if (!toolCallId) return null;
      return {
        type: 'tool_call_update',
        toolCallId,
        name: typeof record.name === 'string' ? record.name : undefined,
        title: typeof record.title === 'string' ? record.title : undefined,
        kind: typeof record.kind === 'string' ? record.kind : undefined,
        status: typeof record.status === 'string' ? record.status : undefined,
        rawInput: isRecord(record.rawInput) ? record.rawInput : undefined,
        content: normalizeContent(record.content),
        rawOutput: record.rawOutput,
        locations: normalizeLocations(record.locations),
      };
    }
    case 'usage_update': {
      const cost = isRecord(record.cost) ? record.cost : undefined;
      return {
        type: 'usage_update',
        used: typeof record.used === 'number' ? record.used : undefined,
        size: typeof record.size === 'number' ? record.size : undefined,
        cost: cost
          ? {
              amount: typeof cost.amount === 'number' ? cost.amount : undefined,
              currency: typeof cost.currency === 'string' ? cost.currency : undefined,
            }
          : undefined,
      };
    }
    case 'available_commands_update':
      return { type: 'available_commands_update' };
    default:
      return { type: 'unknown', sessionUpdate: kind };
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeLocations(value: unknown): Array<{ path?: string }> | undefined {
  if (!Array.isArray(value)) return undefined;
  const locations = value
    .map((entry) => (isRecord(entry) && typeof entry.path === 'string' ? { path: entry.path } : null))
    .filter((entry): entry is { path: string } => !!entry);
  return locations.length > 0 ? locations : undefined;
}

function normalizeContent(
  value: unknown,
): Array<{ type: string; content?: { type: string; text?: string } }> | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: Array<{ type: string; content?: { type: string; text?: string } }> = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const content = isRecord(entry.content) ? entry.content : undefined;
    out.push({
      type: typeof entry.type === 'string' ? entry.type : 'content',
      content: content
        ? {
            type: typeof content.type === 'string' ? content.type : 'text',
            text: typeof content.text === 'string' ? content.text : undefined,
          }
        : undefined,
    });
  }
  return out;
}
