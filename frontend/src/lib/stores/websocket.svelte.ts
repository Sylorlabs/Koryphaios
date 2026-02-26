// WebSocket connection store — Svelte 5 runes for reactive agent state.
// Handles connection, reconnection, message routing, user messages, and permissions.

import type {
  WSMessage,
  WSEventType,
  AgentIdentity,
  AgentStatus,
  StreamDeltaPayload,
  StreamThinkingPayload,
  StreamToolCallPayload,
  StreamToolResultPayload,
  StreamUsagePayload,
  StreamFileDeltaPayload,
  StreamFileCompletePayload,
  KoryThoughtPayload,
  KoryRoutingPayload,
  ProviderStatusPayload,
  ChangeSummary,
  KorySessionChangesPayload,
  AgentSpawnedPayload,
  AgentStatusPayload,
  PermissionRequest,
  Session,
} from "@koryphaios/shared";
import { sessionStore } from './sessions.svelte';
import { authStore } from './auth.svelte';
import { browser } from '$app/environment';

// ─── Agent State ────────────────────────────────────────────────────────────

interface AgentState {
  identity: AgentIdentity;
  status: AgentStatus;
  content: string;
  thinking: string;
  toolCalls: Array<{ name: string; status: string }>;
  task: string;
  tokensUsed: number;
  contextMax: number;
  contextKnown: boolean;
  hasUsageData: boolean;
  sessionId: string;
}

// ─── Feed Entry ─────────────────────────────────────────────────────────────

const EPHEMERAL_TOOLS = new Set(["ls", "read_file", "grep", "glob"]);

export interface FeedEntry {
  id: string;
  timestamp: number;
  type: "user_message" | "thought" | "content" | "thinking" | "tool_call" | "tool_result" | "routing" | "error" | "system" | "tool_group";
  agentId: string;
  agentName: string;
  glowClass: string;
  text: string;
  durationMs?: number;
  thinkingStartedAt?: number;
  isCollapsed?: boolean;
  entries?: FeedEntry[];
  metadata?: Record<string, unknown>;
}

// ─── Reactive State (Svelte 5 Runes) ─────────────────────────────────────

let wsConnection = $state<WebSocket | null>(null);
let connectionStatus = $state<"connecting" | "connected" | "disconnected" | "error">("disconnected");
let feed = $state<FeedEntry[]>([]);
let providers = $state<ProviderStatusPayload["providers"]>([]);
let koryThought = $state<string>("");
let koryPhase = $state<string>("");
let isYoloMode = $state<boolean>(false);
let pendingPermissions = $state<PermissionRequest[]>([]);
let pendingQuestion = $state<{ question: string; options: string[]; allowOther: boolean } | null>(null);
let sessionChanges = $state<Map<string, ChangeSummary[]>>(new Map());

// Initialize manager agent state
const initialAgents = new Map<string, AgentState>();
initialAgents.set("kory-manager", {
  identity: {
    id: "kory-manager",
    name: "Kory",
    role: "manager",
    model: "Unknown",
    provider: "google",
    domain: "general",
    glowColor: "rgba(255,215,0,0.6)",
  },
  status: "idle",
  content: "",
  thinking: "",
  toolCalls: [],
  task: "Orchestrating...",
  tokensUsed: 0,
  contextMax: 0,
  contextKnown: false,
  hasUsageData: false,
  sessionId: "",
});

let agents = $state<Map<string, AgentState>>(initialAgents);

// File edit streaming state (Cursor-style live preview)
interface ActiveFileEdit {
  path: string;
  content: string;
  operation: "create" | "edit";
  agentId: string;
  startedAt: number;
}
let activeFileEdits = $state<Map<string, ActiveFileEdit>>(new Map());

const MAX_FEED_ENTRIES = 2000;
let feedIdCounter = 0;

// ─── Glow class resolver ───────────────────────────────────────────────────

function providerDisplayName(provider: string): string {
  if (provider === "openai") return "OpenAI";
  if (provider === "codex") return "Codex";
  if (provider === "anthropic") return "Anthropic";
  if (provider === "google") return "Google";
  if (provider === "xai") return "xAI";
  if (provider === "openrouter") return "OpenRouter";
  if (provider === "vertexai") return "Vertex AI";
  if (provider === "copilot") return "Copilot";
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}

function resolveGlowClass(agent?: AgentIdentity): string {
  if (!agent) return "";
  switch (agent.domain) {
    case "frontend": return "glow-codex";
    case "backend": return "glow-google";
    case "general": return "glow-claude";
    case "review": return "glow-claude";
    case "test": return "glow-test";
    default: return "";
  }
}

// ─── Feed Management ────────────────────────────────────────────────────────

function addFeedEntry(entry: Omit<FeedEntry, "id">) {
  const newEntry: FeedEntry = { ...entry, id: `fe-${++feedIdCounter}` };
  feed = [...feed, newEntry].slice(-MAX_FEED_ENTRIES);
}

/** Remove the ephemeral "Analyzing request..." thought once analysis is done (next phase, routing, or content). */
function removeAnalyzingThoughtEntries() {
  const isAnalyzingEntry = (e: FeedEntry) =>
    e.type === "thought" &&
    (e.text === "Analyzing request..." || (e.metadata as { phase?: string })?.phase === "analyzing");
  if (!feed.some(isAnalyzingEntry)) return;
  feed = feed.filter((e) => !isAnalyzingEntry(e));
}

// Accumulate streaming text into the last matching feed entry instead of creating one per token
function accumulateFeedEntry(entry: Omit<FeedEntry, "id">) {
  const lastIdx = feed.length - 1;
  const last = lastIdx >= 0 ? feed[lastIdx] : null;
  if (last && last.type === entry.type && last.agentId === entry.agentId) {
    const updates: Partial<FeedEntry> = { 
      text: last.text + entry.text, 
      timestamp: entry.timestamp 
    };
    
    if (last.type === "thinking" && last.thinkingStartedAt) {
      updates.durationMs = entry.timestamp - last.thinkingStartedAt;
    } else if (last.type === "thinking" && !last.thinkingStartedAt) {
      updates.thinkingStartedAt = entry.timestamp;
    }

    const updated = { ...last, ...updates };
    feed = [...feed.slice(0, lastIdx), updated];
  } else {
    addFeedEntry(entry);
  }
}

function addUserMessage(sessionId: string, content: string) {
  const userEntry: FeedEntry = {
    id: `user-${++feedIdCounter}`,
    timestamp: Date.now(),
    type: "user_message",
    agentId: "user",
    agentName: "You",
    glowClass: "",
    text: content,
    metadata: { sessionId },
  };
  feed = [...feed, userEntry].slice(-MAX_FEED_ENTRIES);
}

// ─── Message Handler ───────────────────────────────────────────────────────

function handleMessage(msg: WSMessage) {
  const activeSessionId = sessionStore.activeSessionId;
  const isForActiveSession = !msg.sessionId || msg.sessionId === activeSessionId;

  switch (msg.type) {
    case "agent.spawned": {
      const p = msg.payload as AgentSpawnedPayload;
      agents.set(p.agent.id, {
        identity: p.agent,
        status: "thinking",
        content: "",
        thinking: "",
        toolCalls: [],
        task: p.task,
        tokensUsed: 0,
        contextMax: 0,
        contextKnown: false,
        hasUsageData: false,
        sessionId: msg.sessionId ?? "",
      });
      agents = new Map(agents);
      if (isForActiveSession) {
        addFeedEntry({
          timestamp: msg.timestamp,
          type: "system",
          agentId: p.agent.id,
          agentName: p.agent.name,
          glowClass: resolveGlowClass(p.agent),
          text: `Worker spawned: ${p.agent.name} (${providerDisplayName(p.agent.provider)} · ${p.agent.model})`,
          metadata: { domain: p.agent.domain },
        });
      }
      break;
    }

    case "agent.status": {
      const p = msg.payload as AgentStatusPayload;
      const agent = agents.get(p.agentId);
      if (agent) {
        agent.status = p.status;
        if (msg.sessionId) agent.sessionId = msg.sessionId;
        agents = new Map(agents);
      }
      break;
    }

    case "agent.completed":
    case "stream.complete": {
      const p = msg.payload as any;
      const agent = agents.get(p.agentId);
      if (agent) {
        agent.status = "done";
        if (msg.sessionId) agent.sessionId = msg.sessionId;
        agents = new Map(agents);
      }
      break;
    }

    case "agent.error": {
      const p = msg.payload as any;
      if (isForActiveSession) {
        addFeedEntry({
          timestamp: msg.timestamp,
          type: "error",
          agentId: p.agentId ?? "",
          agentName: agents.get(p.agentId)?.identity.name ?? "Unknown",
          glowClass: "",
          text: p.error ?? "Unknown error",
        });
      }
      break;
    }

    case "stream.delta": {
      const p = msg.payload as StreamDeltaPayload;
      const agent = agents.get(p.agentId);
      if (agent) {
        agent.content += p.content;
        agent.status = "streaming";
        if (msg.sessionId) agent.sessionId = msg.sessionId;
        agents = new Map(agents);
      }
      if (isForActiveSession) {
        removeAnalyzingThoughtEntries();
        accumulateFeedEntry({
          timestamp: msg.timestamp,
          type: "content",
          agentId: p.agentId,
          agentName: agents.get(p.agentId)?.identity.name ?? "Worker",
          glowClass: resolveGlowClass(agents.get(p.agentId)?.identity),
          text: p.content,
        });
      }
      break;
    }

    case "stream.thinking": {
      const p = msg.payload as StreamThinkingPayload;
      const agent = agents.get(p.agentId);
      if (agent) {
        agent.thinking += p.thinking;
        if (msg.sessionId) agent.sessionId = msg.sessionId;
        agents = new Map(agents);
      }
      if (isForActiveSession) {
        accumulateFeedEntry({
          timestamp: msg.timestamp,
          type: "thinking",
          agentId: p.agentId,
          agentName: agents.get(p.agentId)?.identity.name ?? "Worker",
          glowClass: resolveGlowClass(agents.get(p.agentId)?.identity),
          text: p.thinking,
          thinkingStartedAt: msg.timestamp,
        });
      }
      break;
    }

    case "stream.tool_call": {
      const p = msg.payload as StreamToolCallPayload;
      const agent = agents.get(p.agentId);
      if (agent) {
        agent.toolCalls.push({ name: p.toolCall.name, status: "running" });
        agent.status = "tool_calling";
        if (msg.sessionId) agent.sessionId = msg.sessionId;
        agents = new Map(agents);
      }
      if (isForActiveSession) {
        addFeedEntry({
          timestamp: msg.timestamp,
          type: "tool_call",
          agentId: p.agentId,
          agentName: agents.get(p.agentId)?.identity.name ?? "Worker",
          glowClass: resolveGlowClass(agents.get(p.agentId)?.identity),
          text: `Calling tool: ${p.toolCall.name}`,
          metadata: { toolCall: p.toolCall },
        });
      }
      break;
    }

    case "stream.tool_result": {
      const p = msg.payload as StreamToolResultPayload;
      if (isForActiveSession) {
        addFeedEntry({
          timestamp: msg.timestamp,
          type: "tool_result",
          agentId: p.agentId,
          agentName: agents.get(p.agentId)?.identity.name ?? "Worker",
          glowClass: resolveGlowClass(agents.get(p.agentId)?.identity),
          text: p.toolResult.isError
            ? `Tool error: ${p.toolResult.output.slice(0, 200)}`
            : `Tool result (${p.toolResult.durationMs.toFixed(0)}ms): ${p.toolResult.output.slice(0, 200)}`,
          metadata: { toolResult: p.toolResult },
        });
      }
      break;
    }

    case "stream.usage": {
      const p = msg.payload as StreamUsagePayload;
      const agent = agents.get(p.agentId);
      if (agent) {
        agent.tokensUsed = Math.max(0, p.tokensUsed || 0);
        if (typeof p.contextWindow === "number") {
          agent.contextMax = p.contextWindow;
        }
        agent.contextKnown = !!p.contextKnown;
        agent.hasUsageData = !!p.usageKnown;
        if (msg.sessionId) agent.sessionId = msg.sessionId;
        agents = new Map(agents);
      }
      break;
    }

    case "stream.file_delta": {
      const p = msg.payload as StreamFileDeltaPayload;
      // File edits are currently handled globally, but we should probably filter them too
      if (isForActiveSession) {
        const existing = activeFileEdits.get(p.path);
        if (existing) {
          existing.content += p.delta;
          activeFileEdits = new Map(activeFileEdits);
        } else {
          activeFileEdits.set(p.path, {
            path: p.path,
            content: p.delta,
            operation: p.operation,
            agentId: p.agentId,
            startedAt: Date.now(),
          });
          activeFileEdits = new Map(activeFileEdits);
        }
      }
      break;
    }

    case "stream.file_complete": {
      const p = msg.payload as StreamFileCompletePayload;
      if (isForActiveSession) {
        // Keep the completed edit visible briefly, then remove
        setTimeout(() => {
          activeFileEdits.delete(p.path);
          activeFileEdits = new Map(activeFileEdits);
        }, 2000);
      }
      break;
    }

    case "kory.thought": {
      const p = msg.payload as KoryThoughtPayload;
      if (msg.sessionId) {
        const manager = agents.get('kory-manager');
        if (manager) {
          manager.sessionId = msg.sessionId;
          agents = new Map(agents);
        }
      }
      if (isForActiveSession) {
        koryThought = p.thought;
        koryPhase = p.phase;
        // When moving past "Analyzing request...", remove it from the feed so it doesn't stay
        const isAnalyzingEntry = p.phase === "analyzing" && p.thought === "Analyzing request...";
        if (!isAnalyzingEntry) removeAnalyzingThoughtEntries();
        addFeedEntry({
          timestamp: msg.timestamp,
          type: "thought",
          agentId: "kory-manager",
          agentName: "Kory",
          glowClass: "glow-kory",
          text: p.thought,
          metadata: { phase: p.phase },
        });
      }
      break;
    }

    case "kory.routing": {
      const p = msg.payload as KoryRoutingPayload;
      if (isForActiveSession) {
        removeAnalyzingThoughtEntries();
        addFeedEntry({
          timestamp: msg.timestamp,
          type: "routing",
          agentId: "kory-manager",
          agentName: "Kory",
          glowClass: "glow-kory",
          text: p.reasoning,
          metadata: { domain: p.domain, model: p.selectedModel, provider: p.selectedProvider },
        });
      }
      break;
    }

    case "kory.ask_user": {
      const p = msg.payload as any;
      if (isForActiveSession) {
        pendingQuestion = {
          question: p.question,
          options: p.options,
          allowOther: p.allowOther,
        };
      }
      break;
    }

    case "provider.status": {
      const p = msg.payload as ProviderStatusPayload;
      providers = Array.isArray((p as any)?.providers) ? (p as any).providers : [];
      break;
    }

    case "session.updated": {
      const p = msg.payload as { session: Session };
      if (p.session) sessionStore.handleSessionUpdate(p.session);
      break;
    }

    case "session.deleted": {
      const p = msg.payload as { sessionId: string };
      if (p.sessionId) sessionStore.handleSessionDeleted(p.sessionId);
      break;
    }

    case "session.changes": {
      const p = msg.payload as KorySessionChangesPayload;
      if (msg.sessionId) {
        sessionChanges.set(msg.sessionId, p.changes);
        sessionChanges = new Map(sessionChanges);
      }
      break;
    }

    case "session.accept_changes": {
      if (msg.sessionId) {
        sessionChanges.delete(msg.sessionId);
        sessionChanges = new Map(sessionChanges);
      }
      break;
    }

    case "permission.request": {
      const p = msg.payload as PermissionRequest;
      if (isForActiveSession) {
        pendingPermissions = [...pendingPermissions, p];
      }
      break;
    }

    case "permission.response": {
      const p = msg.payload as { id: string; response: string };
      pendingPermissions = pendingPermissions.filter(perm => perm.id !== p.id);
      break;
    }

    case "system.error": {
      const p = msg.payload as any;
      if (!isForActiveSession) break;
      const errorText = p.error ?? "Unknown system error";
      // Dedupe: skip if the last entry is the same error within 3s (e.g. no-provider sent twice)
      const last = feed.length > 0 ? feed[feed.length - 1] : null;
      const isDuplicate =
        last?.type === "error" &&
        last.text === errorText &&
        (msg.timestamp - last.timestamp) < 3000;
      if (!isDuplicate) {
        addFeedEntry({
          timestamp: msg.timestamp,
          type: "error",
          agentId: "",
          agentName: "System",
          glowClass: "",
          text: errorText,
        });
      }
      break;
    }
  }
}

// ─── Connection Management ──────────────────────────────────────────────────

let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempts = 0;
let wsCandidates: string[] = [];
let wsCandidateIndex = 0;

function ensureWsPath(url: string): string {
  return url.endsWith("/ws") ? url : `${url.replace(/\/?$/, "")}/ws`;
}

function buildWsCandidates(preferredUrl?: string): string[] {
  const scheme = window.location.protocol === "https:" ? "wss" : "ws";
  const currentHost = window.location.host;
  const sameOrigin = `${scheme}://${currentHost}/ws`;
  const rawDirect = typeof import.meta.env !== "undefined" && (import.meta.env as { VITE_BACKEND_WS_URL?: string }).VITE_BACKEND_WS_URL;
  const directWs = rawDirect ? ensureWsPath(rawDirect) : undefined;
  const defaultBackendWs = "ws://127.0.0.1:3001/ws";

  const candidates: string[] = [];
  if (preferredUrl) candidates.push(ensureWsPath(preferredUrl));
  if (sameOrigin && !candidates.includes(sameOrigin)) candidates.push(sameOrigin);
  if (directWs && !candidates.includes(directWs)) candidates.push(directWs);
  if (defaultBackendWs && !candidates.includes(defaultBackendWs)) candidates.push(defaultBackendWs);
  if (candidates.length === 0) candidates.push(sameOrigin);
  return candidates;
}

function connect(url?: string) {
  if (!browser) return;
  if (wsConnection?.readyState === WebSocket.OPEN || wsConnection?.readyState === WebSocket.CONNECTING) return;

  // Reset candidates if a new URL is provided or list is empty
  if (url || wsCandidates.length === 0) {
    wsCandidates = buildWsCandidates(url);
    wsCandidateIndex = 0;
  }

  const wsUrl = wsCandidates[wsCandidateIndex];
  if (!wsUrl) {
    wsCandidateIndex = 0;
    scheduleReconnect();
    return;
  }

  connectionStatus = "connecting";
  providers = Array.isArray(providers) ? providers : [];

  try {
    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      connectionStatus = "connected";
      reconnectAttempts = 0;
      wsConnection = ws;
      // Subscribe to the active session so backend can scope messages
      const activeSid = sessionStore.activeSessionId;
      if (activeSid) subscribeToSession(activeSid);
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data) as WSMessage;
        handleMessage(msg);
      } catch { }
    };

    ws.onclose = () => {
      connectionStatus = "disconnected";
      wsConnection = null;

      // Rotate through candidates if we haven't exhausted them
      if (wsCandidateIndex < wsCandidates.length - 1) {
        wsCandidateIndex++;
        setTimeout(() => connect(), 200); // Slightly longer delay for stability
      } else {
        wsCandidateIndex = 0;
        scheduleReconnect();
      }
    };

    ws.onerror = () => {
      connectionStatus = "error";
    };
  } catch {
    connectionStatus = "error";
    scheduleReconnect();
  }
}

function scheduleReconnect(url?: string) {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
  reconnectAttempts++;
  reconnectTimer = setTimeout(() => connect(url), delay);
}

function subscribeToSession(sessionId: string) {
  if (!sessionId || wsConnection?.readyState !== WebSocket.OPEN) return;
  wsConnection.send(JSON.stringify({ type: "subscribe_session", sessionId, timestamp: Date.now() }));
}

function disconnect() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  wsConnection?.close();
  wsConnection = null;
  connectionStatus = "disconnected";
}

/** Fetch provider status from API so providers and API keys show after refresh (before or without WS). */
export async function loadProvidersFromApi(): Promise<void> {
  if (!browser) return;
  try {
    const res = await fetch("/api/providers", { credentials: "include" });
    if (!res.ok) return;
    const json = await res.json();
    const list = json?.data;
    if (Array.isArray(list)) providers = list;
  } catch {
    // ignore
  }
}

function sendMessage(sessionId: string, content: string, model?: string, reasoningLevel?: string) {
  addUserMessage(sessionId, content);
  fetch("/api/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ sessionId, content, model, reasoningLevel }),
  }).catch(() => { });
}

function respondToPermission(id: string, approved: boolean) {
  if (wsConnection?.readyState === WebSocket.OPEN) {
    wsConnection.send(JSON.stringify({
      type: "permission.response",
      payload: { id, response: approved ? "granted" : "denied" },
      timestamp: Date.now(),
    }));
  }
  pendingPermissions = pendingPermissions.filter(perm => perm.id !== id);
}

// ─── Session Message Loading ────────────────────────────────────────────────

function loadSessionMessages(sessionId: string, messages: Array<{ id: string; role: string; content: string; createdAt: number; model?: string; cost?: number }>) {
  // Clear current feed and populate with historical messages
  koryThought = "";
  koryPhase = "";
  feed = messages.map((m) => ({
    id: `hist-${m.id}`,
    timestamp: m.createdAt,
    type: m.role === "user" ? "user_message" as const : "content" as const,
    agentId: m.role === "user" ? "user" : "kory-manager",
    agentName: m.role === "user" ? "You" : "Kory",
    glowClass: m.role === "user" ? "" : "glow-kory",
    text: m.content,
    metadata: { sessionId, model: m.model, cost: m.cost },
  }));
}

function removeEntries(ids: Set<string>) {
  feed = feed.filter(e => !ids.has(e.id));
}

function getToolName(entry: FeedEntry): string {
  const metadata = entry.metadata as
    | { toolCall?: { name?: string }; toolResult?: { name?: string } }
    | undefined;
  return metadata?.toolCall?.name ?? metadata?.toolResult?.name ?? "";
}

function getGroupedFeed(): FeedEntry[] {
  const result: FeedEntry[] = [];
  let currentGroup: FeedEntry | null = null;

  for (const entry of feed) {
    const toolName = getToolName(entry);
    const isEphemeral =
      (entry.type === "tool_call" || entry.type === "tool_result") &&
      EPHEMERAL_TOOLS.has(toolName);

    if (isEphemeral) {
      if (currentGroup && currentGroup.agentId === entry.agentId) {
        currentGroup.entries!.push(entry);
        currentGroup.timestamp = entry.timestamp; 
        
        const toolNames = new Set(currentGroup.entries!.map(getToolName).filter(Boolean));
        const count = Math.ceil(currentGroup.entries!.length / 2);
        currentGroup.text = `Explored codebase (${count} operation${count !== 1 ? 's' : ''}: ${Array.from(toolNames).join(', ')})`;
      } else {
        currentGroup = {
          id: `group-${entry.id}`,
          timestamp: entry.timestamp,
          type: "tool_group",
          agentId: entry.agentId,
          agentName: entry.agentName,
          glowClass: entry.glowClass,
          text: `Analyzing codebase...`,
          entries: [entry],
          isCollapsed: true
        };
        result.push(currentGroup);
      }
    } else {
      currentGroup = null;
      result.push(entry);
    }
  }
  return result;
}

// ─── Derived helpers ────────────────────────────────────────────────────────

function getManagerStatus(): AgentStatus {
  const activeSessionId = sessionStore.activeSessionId;
  const manager = agents.get('kory-manager');
  
  // Only show manager as active if it's working on the CURRENT session
  if (manager && manager.status !== 'idle' && manager.status !== 'done' && (manager.sessionId === activeSessionId || !manager.sessionId)) {
    return manager.status;
  }

  // Fallback: if any worker for THIS session is active, infer from their states
  for (const a of agents.values()) {
    if (a.sessionId === activeSessionId && a.status !== 'idle' && a.status !== 'done') {
      return a.status;
    }
  }
  return 'idle';
}

function getContextUsage(): { used: number; max: number; percent: number; isReliable: boolean; reason?: string } {
  const activeSessionId = sessionStore.activeSessionId;
  const candidates = [...agents.values()].filter((a) => a.sessionId === activeSessionId && a.hasUsageData);

  // Exact session context is only reliable when we have one authoritative usage source.
  if (candidates.length === 0) {
    return { used: 0, max: 0, percent: 0, isReliable: false, reason: "usage_unknown" };
  }
  if (candidates.length > 1) {
    return { used: 0, max: 0, percent: 0, isReliable: false, reason: "multi_agent_usage" };
  }

  const agent = candidates[0];
  if (!agent.contextKnown || agent.contextMax <= 0) {
    return { used: 0, max: 0, percent: 0, isReliable: false, reason: "context_unknown" };
  }

  const used = Math.max(0, agent.tokensUsed);
  const max = agent.contextMax;
  const percent = Math.min(100, Math.round((used / max) * 100));
  return { used, max, percent, isReliable: true };
}

function isSessionRunning(sessionId: string): boolean {
  for (const a of agents.values()) {
    if (a.sessionId === sessionId && a.status !== 'idle' && a.status !== 'done') {
      return true;
    }
  }
  return false;
}

/** Mark all agents for this session as done (optimistic UI when user clicks Stop). */
function markSessionAgentsStopped(sessionId: string) {
  let changed = false;
  for (const a of agents.values()) {
    if (a.sessionId === sessionId && a.status !== 'idle' && a.status !== 'done') {
      a.status = 'done';
      changed = true;
    }
  }
  if (changed) agents = new Map(agents);
}

/** Mark a single agent as done (optimistic UI when user cancels one worker). */
function markAgentStopped(agentId: string) {
  const agent = agents.get(agentId);
  if (agent && agent.status !== 'idle' && agent.status !== 'done') {
    agent.status = 'done';
    agents = new Map(agents);
  }
}

function sendUserInput(sessionId: string, selection: string, text?: string) {
  if (wsConnection?.readyState === WebSocket.OPEN) {
    wsConnection.send(JSON.stringify({
      type: "user_input",
      sessionId,
      selection,
      text,
      timestamp: Date.now(),
    }));
  }
  pendingQuestion = null;
}

function respondToChanges(sessionId: string, accepted: boolean) {
  if (wsConnection?.readyState === WebSocket.OPEN) {
    wsConnection.send(JSON.stringify({
      type: accepted ? "session.accept_changes" : "session.reject_changes",
      sessionId,
      timestamp: Date.now(),
    }));
  }
  sessionChanges.delete(sessionId);
  sessionChanges = new Map(sessionChanges);
}

function clearFeed() {
  feed = [];
  activeFileEdits = new Map();
  // Clear non-essential agent states but keep kory-manager
  const manager = agents.get('kory-manager');
  agents = new Map();
  if (manager) agents.set('kory-manager', { ...manager, content: '', thinking: '', toolCalls: [] });
}

function toggleYolo() {
  setYoloMode(!isYoloMode);
}

function setYoloMode(enabled: boolean) {
  if (isYoloMode === enabled) return;
  isYoloMode = enabled;
  if (wsConnection?.readyState === WebSocket.OPEN) {
    wsConnection.send(JSON.stringify({
      type: "toggle_yolo",
      enabled: isYoloMode,
      timestamp: Date.now(),
    }));
  }
}

// ─── Exported Store ─────────────────────────────────────────────────────────

export const wsStore = {
  get connection() { return wsConnection; },
  get status() { return connectionStatus; },
  get agents() { return agents; },
  get feed() { return feed; },
  get groupedFeed() { return getGroupedFeed(); },
  get providers() { return providers; },
  get koryThought() { return koryThought; },
  get koryPhase() { return koryPhase; },
  get isYoloMode() { return isYoloMode; },
  get pendingPermissions() { return pendingPermissions; },
  get pendingQuestion() { return pendingQuestion; },
  get sessionChanges() { return sessionChanges; },
  get activeFileEdits() { return activeFileEdits; },
  get managerStatus() { return getManagerStatus(); },
  get contextUsage() { return getContextUsage(); },
  isSessionRunning,
  markSessionAgentsStopped,
  markAgentStopped,
  connect,
  disconnect,
  sendMessage,
  sendUserInput,
  respondToChanges,
  loadSessionMessages,
  removeEntries,
  respondToPermission,
  subscribeToSession,
  clearFeed,
  toggleYolo,
  setYoloMode,
  loadProvidersFromApi,
};
