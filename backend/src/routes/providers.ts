// Provider routes — handles provider configuration and authentication

import type { WSMessage } from "@koryphaios/shared";
import type { RouteHandler, RouteDependencies } from "./types";
import { json } from "./types";
import { validateProviderName, sanitizeString, encryptApiKey } from "../security";
import { startCopilotDeviceAuth, pollCopilotDeviceAuth } from "../providers/copilot";
import { googleAuth } from "../providers/google-auth";
import { cliAuth } from "../providers/cli-auth";
import { persistEnvVar, clearEnvVar } from "../runtime/env";
import { PROJECT_ROOT } from "../runtime/paths";

export function createProviderRoutes(deps: RouteDependencies): RouteHandler[] {
    const { providers, wsManager } = deps;

    return [
        // GET /api/providers — Get all provider statuses
        {
            path: "/api/providers",
            method: "GET",
            handler: async (_req, _params, ctx) => {
                return json({ ok: true, data: await providers.getStatus() }, 200);
            },
        },

        // PUT /api/providers/:name — Set provider credentials
        {
            path: /^\/api\/providers\/(?<name>[^/]+)$/,
            method: "PUT",
            handler: async (req, params, ctx) => {
                const rawName = params.get("name");
                const providerName = validateProviderName(rawName);
                if (!providerName) {
                    return json({ ok: false, error: "Invalid provider name" }, 400);
                }

                const body = await req.json() as {
                    apiKey?: string;
                    authToken?: string;
                    baseUrl?: string;
                    selectedModels?: string[];
                    hideModelSelector?: boolean;
                    authMode?: string;
                };

                const apiKey = sanitizeString(body.apiKey, 500);
                const authToken = sanitizeString(body.authToken, 1000);
                const baseUrl = sanitizeString(body.baseUrl, 500);
                const authMode = sanitizeString(body.authMode, 50);

                // Handle CLI auth modes
                if (authMode === "codex" || authMode === "cli" || authMode === "antigravity" || authMode === "claude_code") {
                    return handleCliAuth(providerName, authMode, providers, wsManager);
                }

                const isPreferencesOnlyUpdate = !apiKey && !authToken && !baseUrl
                    && (body.selectedModels !== undefined || body.hideModelSelector !== undefined);

                const result = providers.setCredentials(providerName as any, {
                    ...(apiKey && { apiKey }),
                    ...(authToken && { authToken }),
                    ...(baseUrl && { baseUrl }),
                    ...(body.selectedModels && { selectedModels: body.selectedModels }),
                    ...(body.hideModelSelector !== undefined && { hideModelSelector: body.hideModelSelector }),
                });

                if (!result.success) {
                    return json({ ok: false, error: result.error }, 400);
                }

                if (!isPreferencesOnlyUpdate) {
                    const verification = await providers.verifyConnection(providerName as any, {
                        ...(apiKey && { apiKey }),
                        ...(authToken && { authToken }),
                        ...(baseUrl && { baseUrl }),
                    });

                    if (!verification.success) {
                        providers.removeApiKey(providerName as any);
                        return json({ ok: false, error: verification.error ?? "Provider verification failed" }, 400);
                    }
                }

                // Persist credentials
                if (apiKey) {
                    persistEnvVar(PROJECT_ROOT, providers.getExpectedEnvVar(providerName as any, "apiKey"), encryptApiKey(apiKey));
                }
                if (authToken) {
                    persistEnvVar(PROJECT_ROOT, providers.getExpectedEnvVar(providerName as any, "authToken"), encryptApiKey(authToken));
                }
                if (baseUrl) {
                    persistEnvVar(PROJECT_ROOT, providers.getExpectedEnvVar(providerName as any, "baseUrl"), baseUrl);
                }

                wsManager.broadcast({
                    type: "provider.status",
                    payload: { providers: await providers.getStatus() },
                    timestamp: Date.now(),
                } satisfies WSMessage);

                return json({ ok: true, data: { provider: providerName, status: "connected" } }, 200);
            },
        },

        // DELETE /api/providers/:name — Remove provider credentials
        {
            path: /^\/api\/providers\/(?<name>[^/]+)$/,
            method: "DELETE",
            handler: async (req, params, ctx) => {
                const rawName = params.get("name");
                const providerName = validateProviderName(rawName);
                if (!providerName) {
                    return json({ ok: false, error: "Invalid provider name" }, 400);
                }

                providers.removeApiKey(providerName as any);
                clearEnvVar(PROJECT_ROOT, providers.getExpectedEnvVar(providerName as any, "apiKey"));
                clearEnvVar(PROJECT_ROOT, providers.getExpectedEnvVar(providerName as any, "authToken"));
                clearEnvVar(PROJECT_ROOT, providers.getExpectedEnvVar(providerName as any, "baseUrl"));

                wsManager.broadcast({
                    type: "provider.status",
                    payload: { providers: await providers.getStatus() },
                    timestamp: Date.now(),
                } satisfies WSMessage);

                return json({ ok: true }, 200);
            },
        },

        // POST /api/providers/copilot/device/start — Start Copilot device auth
        {
            path: "/api/providers/copilot/device/start",
            method: "POST",
            handler: async (req, _params, ctx) => {
                try {
                    const start = await startCopilotDeviceAuth();
                    return json({ ok: true, data: start }, 200);
                } catch (err: any) {
                    return json({ ok: false, error: err.message ?? "Failed to start Copilot auth" }, 400);
                }
            },
        },

        // POST /api/providers/copilot/device/poll — Poll Copilot device auth
        {
            path: "/api/providers/copilot/device/poll",
            method: "POST",
            handler: async (req, _params, ctx) => {
                const body = await req.json() as { deviceCode?: string };
                const deviceCode = sanitizeString(body.deviceCode, 300);
                if (!deviceCode) {
                    return json({ ok: false, error: "deviceCode is required" }, 400);
                }

                try {
                    const poll = await pollCopilotDeviceAuth(deviceCode);
                    if (poll.error) {
                        return json({ ok: true, data: { status: poll.error, description: poll.errorDescription } }, 200);
                    }
                    if (!poll.accessToken) {
                        return json({ ok: false, error: "No access token returned from GitHub" }, 400);
                    }

                    const result = providers.setCredentials("copilot", { authToken: poll.accessToken });
                    if (!result.success) {
                        return json({ ok: false, error: result.error }, 400);
                    }

                    const verification = await providers.verifyConnection("copilot", { authToken: poll.accessToken });
                    if (!verification.success) {
                        providers.removeApiKey("copilot");
                        return json({ ok: false, error: verification.error ?? "Copilot verification failed" }, 400);
                    }

                    persistEnvVar(PROJECT_ROOT, providers.getExpectedEnvVar("copilot", "authToken"), encryptApiKey(poll.accessToken));
                    providers.refreshProvider("copilot");

                    wsManager.broadcast({
                        type: "provider.status",
                        payload: { providers: await providers.getStatus() },
                        timestamp: Date.now(),
                    } satisfies WSMessage);

                    return json({ ok: true, data: { status: "connected" } }, 200);
                } catch (err: any) {
                    return json({ ok: false, error: err.message ?? "Failed to complete Copilot auth" }, 400);
                }
            },
        },

        // POST /api/providers/google/auth/cli — Google CLI auth
        {
            path: "/api/providers/google/auth/cli",
            method: "POST",
            handler: async (req, _params, ctx) => {
                try {
                    const result = await googleAuth.startGeminiCLIAuth();
                    return json({ ok: true, data: result }, 200);
                } catch (err: any) {
                    return json({ ok: false, error: err.message }, 500);
                }
            },
        },

        // POST /api/providers/anthropic/auth/cli — Anthropic CLI auth
        {
            path: "/api/providers/anthropic/auth/cli",
            method: "POST",
            handler: async (req, _params, ctx) => {
                try {
                    const result = await cliAuth.authenticateClaude();
                    return json({ ok: true, data: result }, 200);
                } catch (err: any) {
                    return json({ ok: false, error: err.message }, 500);
                }
            },
        },

        // POST /api/providers/openai/auth/codex — OpenAI Codex auth
        {
            path: "/api/providers/openai/auth/codex",
            method: "POST",
            handler: async (req, _params, ctx) => {
                try {
                    const result = await cliAuth.authenticateCodex();
                    return json({ ok: true, data: result }, 200);
                } catch (err: any) {
                    return json({ ok: false, error: err.message }, 500);
                }
            },
        },

        // POST /api/providers/disconnect-all — Disconnect all providers
        {
            path: "/api/providers/disconnect-all",
            method: "POST",
            handler: async (req, _params, ctx) => {
                // Get all configured provider names
                const providerNames = Array.from(providers.getAvailable().map((p: any) => p.name));
                for (const name of providerNames) {
                    try {
                        providers.removeApiKey(name as any);
                        clearEnvVar(PROJECT_ROOT, providers.getExpectedEnvVar(name as any, "apiKey"));
                        clearEnvVar(PROJECT_ROOT, providers.getExpectedEnvVar(name as any, "authToken"));
                        clearEnvVar(PROJECT_ROOT, providers.getExpectedEnvVar(name as any, "baseUrl"));
                    } catch { }
                }

                wsManager.broadcast({
                    type: "provider.status",
                    payload: { providers: await providers.getStatus() },
                    timestamp: Date.now(),
                } satisfies WSMessage);

                return json({ ok: true, message: "All providers disconnected" }, 200);
            },
        },
    ];
}

// Helper to handle CLI-based authentication
async function handleCliAuth(
    providerName: string,
    authMode: string,
    providers: any,
    wsManager: any
): Promise<Response> {
    const cliName = authMode === "codex" ? "codex" : authMode === "claude_code" ? "claude" : "gcloud";
    const targetProvider = authMode === "codex" ? "codex" : authMode === "claude_code" ? "anthropic" : "google";

    const whichProc = Bun.spawnSync(["which", cliName], { stdout: "pipe", stderr: "pipe" });
    if (whichProc.exitCode !== 0) {
        return json({ ok: false, error: `${cliName} CLI not found in PATH. Install it first.` }, 400);
    }

    const authValue = authMode === "antigravity" ? "cli:antigravity" : `cli:${cliName}`;
    const verification = await providers.verifyConnection(targetProvider, { authToken: authValue });
    if (!verification.success) {
        return json({ ok: false, error: verification.error || `${cliName} CLI auth failed` }, 400);
    }

    const result = providers.setCredentials(targetProvider, { authToken: authValue });
    if (!result.success) {
        return json({ ok: false, error: result.error }, 400);
    }

    persistEnvVar(PROJECT_ROOT, providers.getExpectedEnvVar(targetProvider, "authToken"), authValue);

    wsManager.broadcast({
        type: "provider.status",
        payload: { providers: await providers.getStatus() },
        timestamp: Date.now(),
    } satisfies WSMessage);

    return json({ ok: true, data: { provider: targetProvider, status: "connected", authMode } }, 200);
}