// Connection Store — handles WebSocket connection state only
// Split from the monolithic websocket.svelte.ts for better separation of concerns

import { browser } from '$app/environment';

export type ConnectionStatus = "connecting" | "connected" | "disconnected" | "error";

// ─── Connection State ──────────────────────────────────────────────────────

let wsConnection = $state<WebSocket | null>(null);
let connectionStatus = $state<ConnectionStatus>("disconnected");
let reconnectAttempts = $state(0);
let connectionIdCounter = $state(0);

// ─── Connection Management ──────────────────────────────────────────────────

let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

function buildWsUrl(preferredUrl?: string): string {
    const scheme = window.location.protocol === "https:" ? "wss" : "ws";
    const currentHost = window.location.host;
    const primary = preferredUrl ?? `${scheme}://${currentHost}/ws`;
    return primary;
}

export function connect(url?: string) {
    if (!browser) return;

    if (connectionStatus === "connected" || connectionStatus === "connecting") {
        if (wsConnection && (wsConnection.readyState === WebSocket.CLOSING || wsConnection.readyState === WebSocket.CLOSED)) {
            disconnect();
        } else {
            return;
        }
    }

    const currentAttemptId = ++connectionIdCounter;
    const wsUrl = buildWsUrl(url);

    connectionStatus = "connecting";

    try {
        const ws = new WebSocket(wsUrl);

        ws.onopen = () => {
            if (currentAttemptId !== connectionIdCounter) {
                ws.close();
                return;
            }
            connectionStatus = "connected";
            reconnectAttempts = 0;
            wsConnection = ws;
        };

        ws.onclose = () => {
            if (currentAttemptId !== connectionIdCounter) return;
            connectionStatus = "disconnected";
            wsConnection = null;
            scheduleReconnect();
        };

        ws.onerror = () => {
            if (currentAttemptId !== connectionIdCounter) return;
            connectionStatus = "error";
        };

    } catch {
        if (currentAttemptId === connectionIdCounter) {
            connectionStatus = "error";
            scheduleReconnect();
        }
    }
}

function scheduleReconnect(url?: string) {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    const delay = Math.min(1000 * Math.pow(1.5, reconnectAttempts), 10000);
    reconnectAttempts++;
    reconnectTimer = setTimeout(() => connect(url), delay);
}

export function disconnect() {
    connectionIdCounter++;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (wsConnection) {
        wsConnection.onclose = null;
        wsConnection.onerror = null;
        wsConnection.onmessage = null;
        wsConnection.onopen = null;
        wsConnection.close();
    }
    wsConnection = null;
    connectionStatus = "disconnected";
}

export function sendRaw(data: object) {
    if (wsConnection?.readyState === WebSocket.OPEN) {
        wsConnection.send(JSON.stringify(data));
    }
}

// ─── Exported Store ─────────────────────────────────────────────────────────

export const connectionStore = {
    get connection() { return wsConnection; },
    get status() { return connectionStatus; },
    get reconnectAttempts() { return reconnectAttempts; },
    connect,
    disconnect,
    sendRaw,
};