// Feed Store — handles feed entries and message display
// Split from the monolithic websocket.svelte.ts for better separation of concerns

import type { AgentIdentity } from "@koryphaios/shared";

// ─── Feed Entry Types ───────────────────────────────────────────────────────

export type FeedEntryType = "user_message" | "thought" | "content" | "thinking" | "tool_call" | "tool_result" | "routing" | "error" | "system" | "tool_group";

export interface FeedEntry {
    id: string;
    timestamp: number;
    type: FeedEntryType;
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

// ─── Constants ──────────────────────────────────────────────────────────────

const EPHEMERAL_TOOLS = new Set(["ls", "read_file", "grep", "glob"]);
const MAX_FEED_ENTRIES = 2000;
let feedIdCounter = 0;

// ─── Reactive State ──────────────────────────────────────────────────────────

let feed = $state<FeedEntry[]>([]);

// ─── Glow Class Resolver ────────────────────────────────────────────────────

function resolveGlowClass(agent?: AgentIdentity): string {
    if (!agent) return "";
        switch (agent.domain) {
          case "ui": return "glow-codex";
          case "backend": return "glow-google";        case "general": return "glow-claude";
        case "review": return "glow-claude";
        case "test": return "glow-test";
        default: return "";
    }
}

// ─── Feed Actions ────────────────────────────────────────────────────────────

export function addEntry(entry: Omit<FeedEntry, "id">) {
    const newEntry: FeedEntry = { ...entry, id: `fe-${++feedIdCounter}` };
    feed = [...feed, newEntry].slice(-MAX_FEED_ENTRIES);
}

export function accumulateEntry(entry: Omit<FeedEntry, "id">) {
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
        addEntry(entry);
    }
}

export function addUserMessage(sessionId: string, content: string) {
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

export function removeEntries(ids: Set<string>) {
    feed = feed.filter(e => !ids.has(e.id));
}

export function clearFeed() {
    feed = [];
}

// ─── Grouped Feed (for virtual list) ─────────────────────────────────────────

function getToolName(entry: FeedEntry): string {
    const metadata = entry.metadata as
        | { toolCall?: { name?: string }; toolResult?: { name?: string } }
        | undefined;
    return metadata?.toolCall?.name ?? metadata?.toolResult?.name ?? "";
}

export function getGroupedFeed(): FeedEntry[] {
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

// ─── Session Loading ─────────────────────────────────────────────────────────

export function loadSessionMessages(
    sessionId: string,
    messages: Array<{ id: string; role: string; content: string; createdAt: number; model?: string; cost?: number }>
) {
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

// ─── Exported Store ─────────────────────────────────────────────────────────

export const feedStore = {
    get feed() { return feed; },
    get groupedFeed() { return getGroupedFeed(); },
    get length() { return feed.length; },
    addEntry,
    accumulateEntry,
    addUserMessage,
    removeEntries,
    clearFeed,
    loadSessionMessages,
    resolveGlowClass,
};