// Provider routes — handles provider configuration and authentication

import type { WSMessage } from "@koryphaios/shared";
import type { ProviderName } from "@koryphaios/shared";
import type { ProviderRegistry } from "../providers";
import type { WSManager } from "../ws/ws-manager";
import type { RouteHandler, RouteDependencies } from "./types";
import { json } from "./types";
import { validateProviderName, sanitizeString, encryptForStorage } from "../security";
import { startCopilotDeviceAuth, pollCopilotDeviceAuth } from "../providers/copilot";
import { googleAuth } from "../providers/google-auth";
import { cliAuth } from "../providers/cli-auth";
import { persistEnvVar, clearEnvVar } from "../runtime/env";
import { PROJECT_ROOT } from "../runtime/paths";
import { serverLog } from "../logger";

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
                if (authMode === "codex" || authMode === "cli" || authMode === "claude_code") {
                    return handleCliAuth(providerName, authMode, providers, wsManager);
                }

                const isPreferencesOnlyUpdate = !apiKey && !authToken && !baseUrl
                    && (body.selectedModels !== undefined || body.hideModelSelector !== undefined);

                const result = providers.setCredentials(providerName as ProviderName, {
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
                    const verification = await providers.verifyConnection(providerName as ProviderName, {
                        ...(apiKey && { apiKey }),
                        ...(authToken && { authToken }),
                        ...(baseUrl && { baseUrl }),
                    });

                    if (!verification.success) {
                        providers.removeApiKey(providerName as ProviderName);
                        return json({ ok: false, error: verification.error ?? "Provider verification failed" }, 400);
                    }
                }

                // Persist credentials
                if (apiKey) {
                    persistEnvVar(PROJECT_ROOT, providers.getExpectedEnvVar(providerName as ProviderName, "apiKey"), await encryptForStorage(apiKey));
                }
                if (authToken) {
                    persistEnvVar(PROJECT_ROOT, providers.getExpectedEnvVar(providerName as ProviderName, "authToken"), await encryptForStorage(authToken));
                }
                if (baseUrl) {
                    persistEnvVar(PROJECT_ROOT, providers.getExpectedEnvVar(providerName as ProviderName, "baseUrl"), baseUrl);
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

                providers.removeApiKey(providerName as ProviderName);
                clearEnvVar(PROJECT_ROOT, providers.getExpectedEnvVar(providerName as ProviderName, "apiKey"));
                clearEnvVar(PROJECT_ROOT, providers.getExpectedEnvVar(providerName as ProviderName, "authToken"));
                clearEnvVar(PROJECT_ROOT, providers.getExpectedEnvVar(providerName as ProviderName, "baseUrl"));

                wsManager.broadcast({
                    type: "provider.status",
                    payload: { providers: await providers.getStatus() },
                    timestamp: Date.now(),
                } satisfies WSMessage);

                return json({ ok: true }, 200);
            },
        },

        // POST /api/providers/:name/rotate — Rotate provider API key
        {
            path: /^\/api\/providers\/(?<name>[^/]+)\/rotate$/,
            method: "POST",
            handler: async (req, params, ctx) => {
                const rawName = params.get("name");
                const providerName = validateProviderName(rawName);
                if (!providerName) {
                    return json({ ok: false, error: "Invalid provider name" }, 400);
                }

                try {
                    const body = await req.json();
                    const { newApiKey, newAuthToken } = body;

                    // Get the current credentials for comparison
                    const currentStatus = await providers.getStatus();
                    const currentProvider = currentStatus.find(p => p.name === providerName);

                    if (!currentProvider) {
                        return json({ ok: false, error: "Provider not found" }, 404);
                    }

                    // Validate that at least one new credential is provided
                    if (!newApiKey && !newAuthToken) {
                        return json({ ok: false, error: "Either newApiKey or newAuthToken is required" }, 400);
                    }

                    // Set the new credentials
                    if (newApiKey) {
                        providers.setCredentials(providerName as ProviderName, {
                            apiKey: newApiKey,
                        });
                        persistEnvVar(
                            PROJECT_ROOT,
                            providers.getExpectedEnvVar(providerName as ProviderName, "apiKey"),
                            await encryptForStorage(newApiKey)
                        );
                    }

                    if (newAuthToken) {
                        providers.setCredentials(providerName as ProviderName, {
                            authToken: newAuthToken,
                        });
                        persistEnvVar(
                            PROJECT_ROOT,
                            providers.getExpectedEnvVar(providerName as ProviderName, "authToken"),
                            await encryptForStorage(newAuthToken)
                        );
                    }

                    serverLog.info({ provider: providerName }, "Provider API key rotated");

                    wsManager.broadcast({
                        type: "provider.status",
                        payload: { providers: await providers.getStatus() },
                        timestamp: Date.now(),
                    } satisfies WSMessage);

                    return json({
                        ok: true,
                        data: {
                            provider: providerName,
                            message: "API key rotated successfully",
                            timestamp: new Date().toISOString(),
                        },
                    }, 200);
                } catch (err: unknown) {
                    const message = err instanceof Error ? err.message : String(err);
                    return json({ ok: false, error: message ?? "Failed to rotate API key" }, 400);
                }
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
                } catch (err: unknown) {
                    const message = err instanceof Error ? err.message : String(err);
                    return json({ ok: false, error: message ?? "Failed to start Copilot auth" }, 400);
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

                    persistEnvVar(PROJECT_ROOT, providers.getExpectedEnvVar("copilot", "authToken"), await encryptForStorage(poll.accessToken));
                    providers.refreshProvider("copilot");

                    wsManager.broadcast({
                        type: "provider.status",
                        payload: { providers: await providers.getStatus() },
                        timestamp: Date.now(),
                    } satisfies WSMessage);

                    return json({ ok: true, data: { status: "connected" } }, 200);
                } catch (err: unknown) {
                    const message = err instanceof Error ? err.message : String(err);
                    return json({ ok: false, error: message ?? "Failed to complete Copilot auth" }, 400);
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
                } catch (err: unknown) {
                    const message = err instanceof Error ? err.message : String(err);
                    return json({ ok: false, error: message }, 500);
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
                } catch (err: unknown) {
                    const message = err instanceof Error ? err.message : String(err);
                    return json({ ok: false, error: message }, 500);
                }
            },
        },

        // POST /api/providers/disconnect-all — Disconnect all providers
        {
            path: "/api/providers/disconnect-all",
            method: "POST",
            handler: async (req, _params, ctx) => {
                // Get all configured provider names
                const providerNames = Array.from(providers.getAvailable().map((p) => p.name));
                for (const name of providerNames) {
                    try {
                        providers.removeApiKey(name as ProviderName);
                        clearEnvVar(PROJECT_ROOT, providers.getExpectedEnvVar(name as ProviderName, "apiKey"));
                        clearEnvVar(PROJECT_ROOT, providers.getExpectedEnvVar(name as ProviderName, "authToken"));
                        clearEnvVar(PROJECT_ROOT, providers.getExpectedEnvVar(name as ProviderName, "baseUrl"));
                    } catch (err) {
                        serverLog.warn({ provider: name, err }, "Failed to disconnect provider");
                    }
                }

                wsManager.broadcast({
                    type: "provider.status",
                    payload: { providers: await providers.getStatus() },
                    timestamp: Date.now(),
                } satisfies WSMessage);

                return json({ ok: true, message: "All providers disconnected" }, 200);
            },
        },

        // ─── Dynamic Provider Endpoints ─────────────────────────────────────

        // GET /api/providers/presets - List available presets
        {
            path: "/api/providers/presets",
            method: "GET",
            handler: async (_req, _params, ctx) => {
                try {
                    const { DYNAMIC_PROVIDER_PRESETS } = await import("../providers/dynamic");
                    const presetList = Object.values(DYNAMIC_PROVIDER_PRESETS).map(p => ({
                        name: p.name,
                        displayName: p.displayName,
                        description: p.description,
                        baseUrl: p.baseUrl,
                        docsUrl: p.docsUrl,
                        icon: p.icon,
                        defaultModels: p.defaultModels,
                    }));
                    return json({ ok: true, data: presetList }, 200);
                } catch (err: unknown) {
                    const message = err instanceof Error ? err.message : String(err);
                    return json({ ok: false, error: message }, 500);
                }
            },
        },

        // GET /api/providers/dynamic - List all dynamic providers
        {
            path: "/api/providers/dynamic",
            method: "GET",
            handler: async (_req, _params, ctx) => {
                try {
                    const dynamicProviders = providers.getDynamicProviders().map(p => p.toConfig());
                    return json({ ok: true, data: dynamicProviders }, 200);
                } catch (err: unknown) {
                    const message = err instanceof Error ? err.message : String(err);
                    return json({ ok: false, error: message }, 500);
                }
            },
        },

        // POST /api/providers/dynamic - Add a dynamic provider
        {
            path: "/api/providers/dynamic",
            method: "POST",
            handler: async (req, _params, ctx) => {
                try {
                    const body = await req.json() as {
                        name?: string;
                        displayName?: string;
                        preset?: string;
                        baseUrl?: string;
                        apiKey?: string;
                        models?: string[];
                        headers?: Record<string, string>;
                        modelMappings?: Record<string, string>;
                        reasoning?: { mode: string; includeThoughts?: boolean; budgetTokens?: number };
                        supportsTools?: boolean;
                        supportsStreaming?: boolean;
                    };

                    const name = sanitizeString(body.name, 50);
                    if (!name) {
                        return json({ ok: false, error: "Provider name is required" }, 400);
                    }

                    // Check for duplicate name
                    const existingDynamic = providers.getDynamicProviders().find(p => p.name === name);
                    if (existingDynamic) {
                        return json({ ok: false, error: `Provider "${name}" already exists` }, 409);
                    }

                    const { createProviderFromPreset, createCustomProvider } = await import("../providers/dynamic");
                    const { readConfig, writeConfig } = await import("../config/manager");

                    let provider;
                    if (body.preset) {
                        const apiKey = sanitizeString(body.apiKey, 500);
                        if (!apiKey) {
                            return json({ ok: false, error: "API key is required for preset providers" }, 400);
                        }
                        provider = createProviderFromPreset(body.preset, name, apiKey, {
                            displayName: sanitizeString(body.displayName, 100) || undefined,
                            selectedModels: body.models,
                            reasoning: body.reasoning as any,
                        });
                    } else {
                        const baseUrl = sanitizeString(body.baseUrl, 500);
                        const apiKey = sanitizeString(body.apiKey, 500);
                        if (!baseUrl) {
                            return json({ ok: false, error: "Base URL is required for custom providers" }, 400);
                        }
                        provider = createCustomProvider(name, baseUrl, apiKey || "", {
                            displayName: sanitizeString(body.displayName, 100) || undefined,
                            selectedModels: body.models,
                            headers: body.headers,
                            modelMappings: body.modelMappings,
                            reasoning: body.reasoning as any,
                            supportsTools: body.supportsTools,
                            supportsStreaming: body.supportsStreaming,
                        });
                    }

                    const testResult = await provider.testConnection();
                    if (!testResult.success) {
                        return json({ ok: false, error: testResult.error || "Connection test failed" }, 400);
                    }

                    providers.addDynamicProvider(provider.toConfig());

                    // Persist to config
                    const currentConfig = await readConfig();
                    const currentDynamic = currentConfig.dynamicProviders || [];
                    await writeConfig({
                        ...currentConfig,
                        dynamicProviders: [...currentDynamic, provider.toConfig()]
                    });

                    wsManager.broadcast({
                        type: "provider.status",
                        payload: { providers: await providers.getStatus() },
                        timestamp: Date.now(),
                    } satisfies WSMessage);

                    serverLog.info({ provider: name }, "Dynamic provider added");
                    return json({ ok: true, data: { name, models: testResult.models } }, 201);
                } catch (err: unknown) {
                    const message = err instanceof Error ? err.message : String(err);
                    return json({ ok: false, error: message }, 500);
                }
            },
        },

        // GET /api/providers/dynamic/:name - Get a specific dynamic provider
        {
            path: /^\/api\/providers\/dynamic\/(?<name>[^\/]+)$/,
            method: "GET",
            handler: async (_req, params, ctx) => {
                try {
                    const name = sanitizeString(params.get("name"), 50);
                    if (!name) {
                        return json({ ok: false, error: "Invalid provider name" }, 400);
                    }

                    const provider = providers.getDynamicProviders().find(p => p.name === name);
                    if (!provider) {
                        return json({ ok: false, error: "Provider not found" }, 404);
                    }

                    return json({ ok: true, data: provider.toConfig() }, 200);
                } catch (err: unknown) {
                    const message = err instanceof Error ? err.message : String(err);
                    return json({ ok: false, error: message }, 500);
                }
            },
        },

        // PATCH /api/providers/dynamic/:name - Update a dynamic provider
        {
            path: /^\/api\/providers\/dynamic\/(?<name>[^\/]+)$/,
            method: "PATCH",
            handler: async (req, params, ctx) => {
                try {
                    const name = sanitizeString(params.get("name"), 50);
                    if (!name) {
                        return json({ ok: false, error: "Invalid provider name" }, 400);
                    }

                    const body = await req.json();
                    const { readConfig, writeConfig } = await import("../config/manager");

                    const existing = providers.getDynamicProviders().find(p => p.name === name);
                    if (!existing) {
                        return json({ ok: false, error: "Provider not found" }, 404);
                    }

                    const currentConfig = existing.toConfig();
                    const updatedConfig = {
                        ...currentConfig,
                        ...(body.displayName !== undefined && { displayName: sanitizeString(body.displayName, 100) }),
                        ...(body.baseUrl !== undefined && { baseUrl: sanitizeString(body.baseUrl, 500) }),
                        ...(body.apiKey !== undefined && { apiKey: sanitizeString(body.apiKey, 500) }),
                        ...(body.models !== undefined && { selectedModels: body.models }),
                        ...(body.headers !== undefined && { headers: body.headers }),
                        ...(body.modelMappings !== undefined && { modelMappings: body.modelMappings }),
                        ...(body.reasoning !== undefined && { reasoning: body.reasoning }),
                        ...(body.supportsTools !== undefined && { supportsTools: body.supportsTools }),
                        ...(body.supportsStreaming !== undefined && { supportsStreaming: body.supportsStreaming }),
                    };

                    providers.removeDynamicProvider(name);
                    providers.addDynamicProvider(updatedConfig);

                    // Persist to config
                    const config = await readConfig();
                    const allDynamic = config.dynamicProviders || [];
                    const filtered = allDynamic.filter((p: any) => p.name !== name);
                    await writeConfig({
                        ...config,
                        dynamicProviders: [...filtered, updatedConfig]
                    });

                    wsManager.broadcast({
                        type: "provider.status",
                        payload: { providers: await providers.getStatus() },
                        timestamp: Date.now(),
                    } satisfies WSMessage);

                    return json({ ok: true, data: updatedConfig }, 200);
                } catch (err: unknown) {
                    const message = err instanceof Error ? err.message : String(err);
                    return json({ ok: false, error: message }, 500);
                }
            },
        },

        // DELETE /api/providers/dynamic/:name - Remove a dynamic provider
        {
            path: /^\/api\/providers\/dynamic\/(?<name>[^\/]+)$/,
            method: "DELETE",
            handler: async (_req, params, ctx) => {
                try {
                    const name = sanitizeString(params.get("name"), 50);
                    if (!name) {
                        return json({ ok: false, error: "Invalid provider name" }, 400);
                    }

                    const existing = providers.getDynamicProviders().find(p => p.name === name);
                    if (!existing) {
                        return json({ ok: false, error: "Provider not found" }, 404);
                    }

                    providers.removeDynamicProvider(name);

                    // Remove from config
                    const { readConfig, writeConfig } = await import("../config/manager");
                    const config = await readConfig();
                    const filtered = (config.dynamicProviders || []).filter((p: any) => p.name !== name);
                    await writeConfig({
                        ...config,
                        dynamicProviders: filtered
                    });

                    wsManager.broadcast({
                        type: "provider.status",
                        payload: { providers: await providers.getStatus() },
                        timestamp: Date.now(),
                    } satisfies WSMessage);

                    serverLog.info({ provider: name }, "Dynamic provider removed");
                    return json({ ok: true }, 200);
                } catch (err: unknown) {
                    const message = err instanceof Error ? err.message : String(err);
                    return json({ ok: false, error: message }, 500);
                }
            },
        },

        // POST /api/providers/dynamic/:name/test - Test a dynamic provider
        {
            path: /^\/api\/providers\/dynamic\/(?<name>[^\/]+)\/test$/,
            method: "POST",
            handler: async (req, params, ctx) => {
                try {
                    const name = sanitizeString(params.get("name"), 50);
                    if (!name) {
                        return json({ ok: false, error: "Invalid provider name" }, 400);
                    }

                    const body = await req.json() as {
                        preset?: string;
                        baseUrl?: string;
                        apiKey?: string;
                        models?: string[];
                    };

                    const { createProviderFromPreset, createCustomProvider } = await import("../providers/dynamic");

                    let provider;
                    if (body.preset) {
                        const apiKey = sanitizeString(body.apiKey, 500);
                        if (!apiKey) {
                            return json({ ok: false, error: "API key is required" }, 400);
                        }
                        provider = createProviderFromPreset(body.preset, name, apiKey, { selectedModels: body.models });
                    } else {
                        const baseUrl = sanitizeString(body.baseUrl, 500);
                        const apiKey = sanitizeString(body.apiKey, 500);
                        if (!baseUrl) {
                            return json({ ok: false, error: "Base URL is required" }, 400);
                        }
                        provider = createCustomProvider(name, baseUrl, apiKey || "", { selectedModels: body.models });
                    }

                    const result = await provider.testConnection();
                    return json({
                        ok: result.success,
                        error: result.error,
                        models: result.models,
                    }, result.success ? 200 : 400);
                } catch (err: unknown) {
                    const message = err instanceof Error ? err.message : String(err);
                    return json({ ok: false, error: message }, 500);
                }
            },
        },

        // POST /api/providers/dynamic/:name/reasoning - Update reasoning config
        {
            path: /^\/api\/providers\/dynamic\/(?<name>[^\/]+)\/reasoning$/,
            method: "POST",
            handler: async (req, params, ctx) => {
                try {
                    const name = sanitizeString(params.get("name"), 50);
                    if (!name) {
                        return json({ ok: false, error: "Invalid provider name" }, 400);
                    }

                    const body = await req.json() as {
                        mode?: string;
                        includeThoughts?: boolean;
                        budgetTokens?: number;
                    };

                    const validModes = ["disabled", "minimal", "low", "medium", "high", "max"];
                    if (!body.mode || !validModes.includes(body.mode)) {
                        return json({ ok: false, error: "Invalid reasoning mode" }, 400);
                    }

                    const existing = providers.getDynamicProviders().find(p => p.name === name);
                    if (!existing) {
                        return json({ ok: false, error: "Provider not found" }, 404);
                    }

                    const currentConfig = existing.toConfig();
                    const updatedConfig = {
                        ...currentConfig,
                        reasoning: {
                            mode: body.mode as any,
                            includeThoughts: body.includeThoughts ?? true,
                            budgetTokens: body.budgetTokens,
                        },
                    };

                    providers.removeDynamicProvider(name);
                    providers.addDynamicProvider(updatedConfig);

                    // Persist to config
                    const { readConfig, writeConfig } = await import("../config/manager");
                    const config = await readConfig();
                    const allDynamic = config.dynamicProviders || [];
                    const filtered = allDynamic.filter((p: any) => p.name !== name);
                    await writeConfig({
                        ...config,
                        dynamicProviders: [...filtered, updatedConfig]
                    });

                    return json({ ok: true, data: updatedConfig.reasoning }, 200);
                } catch (err: unknown) {
                    const message = err instanceof Error ? err.message : String(err);
                    return json({ ok: false, error: message }, 500);
                }
            },
        },
    ];
}


// Helper to handle CLI-based authentication
async function handleCliAuth(
    providerName: string,
    authMode: string,
    providers: ProviderRegistry,
    wsManager: WSManager
): Promise<Response> {
    const targetProvider = authMode === "codex" ? "codex" : authMode === "claude_code" ? "anthropic" : "google";
    const cliName = authMode === "codex" ? "codex" : authMode === "claude_code" ? "claude" : "gcloud";
    if (!Bun.which(cliName)) {
        return json({ ok: false, error: `${cliName} CLI not found in PATH. Install it first.` }, 400);
    }

    const authValue = `cli:${authMode === "codex" ? "codex" : authMode === "claude_code" ? "claude" : "gcloud"}`;
    const verification = await providers.verifyConnection(targetProvider, { authToken: authValue });
    if (!verification.success) {
        const msg = (authMode === "codex" ? "codex" : authMode === "claude_code" ? "claude" : "gcloud") + " CLI auth failed";
        return json({ ok: false, error: verification.error || msg }, 400);
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
