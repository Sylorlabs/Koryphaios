// Agent Store — handles agent state and identity
// Split from the monolithic websocket.svelte.ts for better separation of concerns

import type { AgentIdentity, AgentStatus, StreamUsagePayload, ProviderName } from "@koryphaios/shared";

// ─── Agent State ────────────────────────────────────────────────────────────

export interface AgentState {
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

// ─── Reactive State ──────────────────────────────────────────────────────────

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

// ─── Agent Actions ──────────────────────────────────────────────────────────

export function spawnAgent(identity: AgentIdentity, task: string, sessionId: string) {
    agents.set(identity.id, {
        identity,
        status: "thinking",
        content: "",
        thinking: "",
        toolCalls: [],
        task,
        tokensUsed: 0,
        contextMax: 0,
        contextKnown: false,
        hasUsageData: false,
        sessionId,
    });
    agents = new Map(agents);
}

export function updateAgentStatus(agentId: string, status: AgentStatus) {
    const agent = agents.get(agentId);
    if (agent) {
        agent.status = status;
        agents = new Map(agents);
    }
}

export function appendAgentContent(agentId: string, content: string) {
    const agent = agents.get(agentId);
    if (agent) {
        agent.content += content;
        agent.status = "streaming";
        agents = new Map(agents);
    }
}

export function appendAgentThinking(agentId: string, thinking: string) {
    const agent = agents.get(agentId);
    if (agent) {
        agent.thinking += thinking;
        agents = new Map(agents);
    }
}

export function addToolCall(agentId: string, name: string) {
    const agent = agents.get(agentId);
    if (agent) {
        agent.toolCalls.push({ name, status: "running" });
        agent.status = "tool_calling";
        agents = new Map(agents);
    }
}

export function updateUsage(agentId: string, payload: StreamUsagePayload) {
    const agent = agents.get(agentId);
    if (agent) {
        agent.tokensUsed = Math.max(0, payload.tokensUsed || 0);
        if (typeof payload.contextWindow === "number") {
            agent.contextMax = payload.contextWindow;
        }
        agent.contextKnown = !!payload.contextKnown;
        agent.hasUsageData = !!payload.usageKnown;
        agents = new Map(agents);
    }
}

export function completeAgent(agentId: string) {
    const agent = agents.get(agentId);
    if (agent) {
        agent.status = "done";
        agents = new Map(agents);
    }
}

export function clearAgentContent(agentId: string) {
    const agent = agents.get(agentId);
    if (agent) {
        agent.content = "";
        agent.thinking = "";
        agent.toolCalls = [];
        agents = new Map(agents);
    }
}

export function removeAgent(agentId: string) {
    if (agentId === "kory-manager") return; // Never remove manager
    agents.delete(agentId);
    agents = new Map(agents);
}

export function clearNonManagerAgents() {
    const manager = agents.get("kory-manager");
    agents = new Map();
    if (manager) {
        agents.set("kory-manager", { ...manager, content: "", thinking: "", toolCalls: [] });
    }
}

// ─── Derived State ───────────────────────────────────────────────────────────

export function getManagerStatus(activeSessionId?: string): AgentStatus {
    const manager = agents.get("kory-manager");

    if (manager && manager.status !== 'idle' && manager.status !== 'done') {
        if (manager.sessionId === activeSessionId || !manager.sessionId) {
            return manager.status;
        }
    }

    if (activeSessionId) {
        for (const a of agents.values()) {
            if (a.sessionId === activeSessionId && a.status !== 'idle' && a.status !== 'done') {
                return a.status;
            }
        }
    }

    return 'idle';
}

export function isSessionRunning(sessionId: string): boolean {
    for (const a of agents.values()) {
        if (a.sessionId === sessionId && a.status !== 'idle' && a.status !== 'done') {
            return true;
        }
    }
    return false;
}

export function getContextUsage(activeSessionId?: string): {
    used: number;
    max: number;
    percent: number;
    status: 'reliable' | 'estimating' | 'unknown' | 'multi_agent';
    label: string;
} {
    if (!activeSessionId) {
        return { used: 0, max: 0, percent: 0, status: 'unknown', label: 'Context usage unknown' };
    }

    const sessionAgents = [...agents.values()].filter((a) => a.sessionId === activeSessionId);
    const candidates = sessionAgents.filter(a => a.hasUsageData);

    if (candidates.length === 0) {
        return { used: 0, max: 0, percent: 0, status: 'unknown', label: 'Context usage unknown' };
    }

    if (candidates.length > 1) {
        const highest = candidates.reduce((prev, curr) => (curr.tokensUsed > prev.tokensUsed) ? curr : prev);
        const used = highest.tokensUsed;
        const max = highest.contextMax || 128000;
        const percent = Math.min(100, Math.round((used / max) * 100));
        return { used, max, percent, status: 'multi_agent', label: `Estimated Usage (Max of ${candidates.length} agents)` };
    }

    const agent = candidates[0];
    if (!agent.contextKnown || agent.contextMax <= 0) {
        return { used: agent.tokensUsed, max: 0, percent: 0, status: 'estimating', label: 'Calculating context window...' };
    }

    const used = Math.max(0, agent.tokensUsed);
    const max = agent.contextMax;
    const percent = Math.min(100, Math.round((used / max) * 100));
    return { used, max, percent, status: 'reliable', label: 'Context Window' };
}

// ─── Exported Store ─────────────────────────────────────────────────────────

export const agentStore = {
    get agents() { return agents; },
    get agentList() { return [...agents.values()]; },
    getManagerStatus,
    isSessionRunning,
    getContextUsage,
    spawnAgent,
    updateAgentStatus,
    appendAgentContent,
    appendAgentThinking,
    addToolCall,
    updateUsage,
    completeAgent,
    clearAgentContent,
    removeAgent,
    clearNonManagerAgents,
};