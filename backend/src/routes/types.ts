// Route types and interfaces

import type { WSMessage, APIResponse } from "@koryphaios/shared";
import type { ProviderRegistry } from "../providers/registry";
import type { ToolRegistry } from "../tools/registry";
import type { KoryManager } from "../kory/manager";
import type { ISessionStore } from "../stores/session-store";
import type { IMessageStore } from "../stores/message-store";
import type { WSManager } from "../ws/ws-manager";
import type { TelegramBridge } from "../telegram/bot";
import type { MCPManager } from "../mcp/client";

export interface RouteContext {
    requestId: string;
    sessionId: string;
    origin: string | null;
    clientIp: string;
}

export interface RouteHandler {
    path: string | RegExp;
    method: string | string[];
    handler: (
        req: Request,
        params: Map<string, string>,
        ctx: RouteContext
    ) => Promise<Response> | Response;
}

export interface RouteDependencies {
    providers: ProviderRegistry;
    tools: ToolRegistry;
    kory: KoryManager;
    sessions: ISessionStore;
    messages: IMessageStore;
    wsManager: WSManager;
    telegram: TelegramBridge | undefined;
    mcpManager: MCPManager;
}

export interface MiddlewareContext {
    req: Request;
    url: URL;
    method: string;
    origin: string | null;
    clientIp: string;
    requestId: string;
}

export type Middleware = (
    ctx: MiddlewareContext,
    next: () => Promise<Response>
) => Promise<Response>;

// Helper to create JSON responses
export function json(
    data: APIResponse,
    status: number,
    headers: Record<string, string> = {}
): Response {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            "Content-Type": "application/json",
            ...headers,
        },
    });
}

// Helper to extract path parameters
export function extractParams(
    pattern: RegExp,
    pathname: string
): Map<string, string> {
    const params = new Map<string, string>();
    const match = pattern.exec(pathname);
    if (match?.groups) {
        for (const [key, value] of Object.entries(match.groups)) {
            if (value) params.set(key, value);
        }
    }
    return params;
}