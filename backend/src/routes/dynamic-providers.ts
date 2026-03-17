// Dynamic Provider Routes
// REST API endpoints for managing dynamic OpenAI-compatible providers

import type { WSMessage, DynamicProviderConfig, ReasoningConfig } from "@koryphaios/shared";
import type { ProviderRegistry } from "../providers";
import type { WSManager } from "../ws/ws-manager";
import type { RouteHandler, RouteDependencies } from "./types";
import { json } from "./types";
import { 
  validateProviderName, 
  sanitizeString, 
  encryptForStorage,
  validateUrl,
} from "../security";
import { 
  DynamicOpenAIProvider, 
  DYNAMIC_PROVIDER_PRESETS,
  validateDynamicConfig,
  getProviderPresets,
  getPreset,
} from "../providers/dynamic";
import { 
  validateReasoningConfig, 
  supportsReasoning,
  ALL_REASONING_MODES,
} from "@koryphaios/shared";
import { persistEnvVar } from "../runtime/env";
import { PROJECT_ROOT } from "../runtime/paths";
import { serverLog } from "../logger";
import { readConfig, writeConfig } from "../config/manager";

export function createDynamicProviderRoutes(deps: RouteDependencies): RouteHandler[] {
  const { providers, wsManager } = deps;

  return [
    // GET /api/providers/presets - List available dynamic provider presets
    {
      path: "/api/providers/presets",
      method: "GET",
      handler: async (_req, _params, _ctx) => {
        const presets = getProviderPresets().map(preset => ({
          name: preset.name,
          displayName: preset.displayName,
          description: preset.description,
          docsUrl: preset.docsUrl,
          defaultModels: preset.defaultModels,
          envVar: preset.envVar,
        }));

        return json({ ok: true, data: presets }, 200);
      },
    },

    // GET /api/providers/dynamic - List all dynamic providers
    {
      path: "/api/providers/dynamic",
      method: "GET",
      handler: async (_req, _params, _ctx) => {
        const dynamicProviders = providers.getDynamicProviders().map(p => ({
          name: p.name,
          displayName: p.getDisplayName(),
          description: p.getDescription(),
          docsUrl: p.getDocsUrl(),
          isAvailable: p.isAvailable(),
          models: p.listModels().map(m => m.id),
          config: p.toConfig(),
        }));

        return json({ ok: true, data: dynamicProviders }, 200);
      },
    },

    // POST /api/providers/dynamic - Add a new dynamic provider
    {
      path: "/api/providers/dynamic",
      method: "POST",
      handler: async (req, _params, _ctx) => {
        try {
          const body = await req.json() as Partial<DynamicProviderConfig>;

          // Validate required fields
          const validation = validateDynamicConfig(body);
          if (!validation.valid) {
            return json({ ok: false, error: validation.errors.join("; ") }, 400);
          }

          // Validate and sanitize inputs
          let validatedBaseUrl: string | undefined;
          if (body.baseUrl) {
            const urlValidation = await validateUrl(body.baseUrl);
            if (urlValidation.safe && urlValidation.validatedHostname) {
              validatedBaseUrl = body.baseUrl;
            }
          }

          const config: DynamicProviderConfig = {
            name: validateProviderName(body.name) || body.name!,
            preset: body.preset ? sanitizeString(body.preset, 50) : undefined,
            displayName: body.displayName ? sanitizeString(body.displayName, 100) : undefined,
            apiKey: body.apiKey ? sanitizeString(body.apiKey, 500) : undefined,
            authToken: body.authToken ? sanitizeString(body.authToken, 1000) : undefined,
            baseUrl: validatedBaseUrl,
            disabled: body.disabled ?? false,
            headers: body.headers,
            selectedModels: body.selectedModels,
            modelMappings: body.modelMappings,
            reasoning: body.reasoning,
            modelReasoning: body.modelReasoning,
          };

          // Check if provider already exists
          if (providers.get(config.name as any)) {
            return json({ 
              ok: false, 
              error: `Provider "${config.name}" already exists. Use PATCH to update.` 
            }, 409);
          }

          // Create and add the provider
          const result = providers.addDynamicProvider(config);
          if (!result.success) {
            return json({ ok: false, error: result.error }, 400);
          }

          // Persist to config file
          await persistDynamicProvider(config);

          // Persist credentials to env if provided
          if (config.apiKey) {
            const envVarName = config.preset 
              ? DYNAMIC_PROVIDER_PRESETS[config.preset]?.envVar 
              : `${config.name.toUpperCase()}_API_KEY`;
            if (envVarName) {
              await persistEnvVar(PROJECT_ROOT, envVarName, await encryptForStorage(config.apiKey));
            }
          }

          // Broadcast update
          wsManager.broadcast({
            type: "provider.status",
            payload: { providers: await providers.getStatus() },
            timestamp: Date.now(),
          } satisfies WSMessage);

          serverLog.info({ provider: config.name }, "Dynamic provider added");

          return json({ 
            ok: true, 
            data: { 
              provider: config.name, 
              status: "added",
              isAvailable: providers.get(config.name as any)?.isAvailable() ?? false,
            } 
          }, 201);

        } catch (err: any) {
          serverLog.error({ error: err.message }, "Failed to add dynamic provider");
          return json({ ok: false, error: err.message || "Failed to add provider" }, 500);
        }
      },
    },

    // GET /api/providers/dynamic/:name - Get a specific dynamic provider
    {
      path: /^\/api\/providers\/dynamic\/(?<name>[^\/]+)$/,
      method: "GET",
      handler: async (req, params, _ctx) => {
        const rawName = params.get("name");
        const name = validateProviderName(rawName);
        if (!name) {
          return json({ ok: false, error: "Invalid provider name" }, 400);
        }

        const provider = providers.getDynamicProviders().find(p => p.name === name);
        if (!provider) {
          return json({ ok: false, error: "Provider not found" }, 404);
        }

        return json({
          ok: true,
          data: {
            name: provider.name,
            displayName: provider.getDisplayName(),
            description: provider.getDescription(),
            docsUrl: provider.getDocsUrl(),
            isAvailable: provider.isAvailable(),
            models: provider.listModels().map(m => ({
              id: m.id,
              name: m.name,
              contextWindow: m.contextWindow,
            })),
            config: provider.toConfig(),
            reasoning: provider.getReasoningConfig(),
          },
        }, 200);
      },
    },

    // PATCH /api/providers/dynamic/:name - Update a dynamic provider
    {
      path: /^\/api\/providers\/dynamic\/(?<name>[^\/]+)$/,
      method: "PATCH",
      handler: async (req, params, _ctx) => {
        try {
          const rawName = params.get("name");
          const name = validateProviderName(rawName);
          if (!name) {
            return json({ ok: false, error: "Invalid provider name" }, 400);
          }

          const existingProvider = providers.getDynamicProviders().find(p => p.name === name);
          if (!existingProvider) {
            return json({ ok: false, error: "Provider not found" }, 404);
          }

          const body = await req.json() as Partial<DynamicProviderConfig>;

          // Get existing config and merge
          const existingConfig = existingProvider.toConfig();
          const updatedConfig: DynamicProviderConfig = {
            ...existingConfig,
            ...body,
            name: name as any, // Preserve name
            // Merge nested objects instead of replacing
            headers: { ...existingConfig.headers, ...body.headers },
            modelMappings: { ...existingConfig.modelMappings, ...body.modelMappings },
            modelReasoning: { ...existingConfig.modelReasoning, ...body.modelReasoning },
          };

          // Remove undefined values
          Object.keys(updatedConfig).forEach(key => {
            if ((updatedConfig as any)[key] === undefined) {
              delete (updatedConfig as any)[key];
            }
          });

          // Remove and re-add provider (registry doesn't have update method)
          providers.removeDynamicProvider(name as any);
          const result = providers.addDynamicProvider(updatedConfig);

          if (!result.success) {
            // Try to restore old provider
            providers.addDynamicProvider(existingConfig);
            return json({ ok: false, error: result.error }, 400);
          }

          // Persist updated config
          await persistDynamicProvider(updatedConfig, true);

          // Broadcast update
          wsManager.broadcast({
            type: "provider.status",
            payload: { providers: await providers.getStatus() },
            timestamp: Date.now(),
          } satisfies WSMessage);

          serverLog.info({ provider: name }, "Dynamic provider updated");

          return json({
            ok: true,
            data: { provider: name, status: "updated" },
          }, 200);

        } catch (err: any) {
          serverLog.error({ error: err.message }, "Failed to update dynamic provider");
          return json({ ok: false, error: err.message || "Failed to update provider" }, 500);
        }
      },
    },

    // DELETE /api/providers/dynamic/:name - Remove a dynamic provider
    {
      path: /^\/api\/providers\/dynamic\/(?<name>[^\/]+)$/,
      method: "DELETE",
      handler: async (req, params, _ctx) => {
        try {
          const rawName = params.get("name");
          const name = validateProviderName(rawName);
          if (!name) {
            return json({ ok: false, error: "Invalid provider name" }, 400);
          }

          const provider = providers.getDynamicProviders().find(p => p.name === name);
          if (!provider) {
            return json({ ok: false, error: "Provider not found" }, 404);
          }

          // Remove from registry
          providers.removeDynamicProvider(name as any);

          // Remove from persisted config
          await removeDynamicProviderFromConfig(name);

          // Broadcast update
          wsManager.broadcast({
            type: "provider.status",
            payload: { providers: await providers.getStatus() },
            timestamp: Date.now(),
          } satisfies WSMessage);

          serverLog.info({ provider: name }, "Dynamic provider removed");

          return json({ ok: true, data: { provider: name, status: "removed" } }, 200);

        } catch (err: any) {
          serverLog.error({ error: err.message }, "Failed to remove dynamic provider");
          return json({ ok: false, error: err.message || "Failed to remove provider" }, 500);
        }
      },
    },

    // POST /api/providers/dynamic/:name/test - Test a dynamic provider connection
    {
      path: /^\/api\/providers\/dynamic\/(?<name>[^\/]+)\/test$/,
      method: "POST",
      handler: async (req, params, _ctx) => {
        try {
          const rawName = params.get("name");
          const name = validateProviderName(rawName);
          if (!name) {
            return json({ ok: false, error: "Invalid provider name" }, 400);
          }

          const body = await req.json().catch(() => ({})) as Partial<DynamicProviderConfig>;

          // Validate and build test config
          let testBaseUrl: string | undefined;
          if (body.baseUrl) {
            const urlValidation = await validateUrl(body.baseUrl);
            if (urlValidation.safe && urlValidation.validatedHostname) {
              testBaseUrl = body.baseUrl;
            }
          }

          const testConfig: DynamicProviderConfig = {
            name: name as any,
            preset: body.preset ? sanitizeString(body.preset, 50) : undefined,
            displayName: body.displayName ? sanitizeString(body.displayName, 100) : undefined,
            apiKey: body.apiKey ? sanitizeString(body.apiKey, 500) : undefined,
            baseUrl: testBaseUrl,
            disabled: false,
            headers: body.headers,
          };

          // Create temporary provider
          const tempProvider = new DynamicOpenAIProvider(testConfig);

          if (!tempProvider.isAvailable()) {
            return json({ 
              ok: false, 
              error: "Provider not available - check API key and base URL" 
            }, 400);
          }

          // Try to fetch models
          let models: string[] = [];
          try {
            models = tempProvider.listModels().map(m => m.id);
            
            // If no models returned, try to fetch from API
            if (models.length === 0) {
              // Wait a bit for background fetch
              await new Promise(resolve => setTimeout(resolve, 2000));
              models = tempProvider.listModels().map(m => m.id);
            }
          } catch (err: any) {
            return json({
              ok: false,
              error: `Failed to fetch models: ${err.message}`,
            }, 400);
          }

          return json({
            ok: true,
            data: {
              provider: name,
              isAvailable: tempProvider.isAvailable(),
              models,
              message: models.length > 0 
                ? `Connected successfully. Found ${models.length} models.` 
                : "Connected, but no models found. Check your API key.",
            },
          }, 200);

        } catch (err: any) {
          serverLog.error({ error: err.message }, "Failed to test dynamic provider");
          return json({ ok: false, error: err.message || "Test failed" }, 500);
        }
      },
    },

    // POST /api/providers/dynamic/:name/reasoning - Update provider reasoning config
    {
      path: /^\/api\/providers\/dynamic\/(?<name>[^\/]+)\/reasoning$/,
      method: "POST",
      handler: async (req, params, _ctx) => {
        try {
          const rawName = params.get("name");
          const name = validateProviderName(rawName);
          if (!name) {
            return json({ ok: false, error: "Invalid provider name" }, 400);
          }

          const provider = providers.getDynamicProviders().find(p => p.name === name);
          if (!provider) {
            return json({ ok: false, error: "Provider not found" }, 404);
          }

          const body = await req.json() as ReasoningConfig;

          // Validate reasoning config
          const validation = validateReasoningConfig(body);
          if (!validation.valid) {
            return json({ ok: false, error: validation.errors.join("; ") }, 400);
          }

          // Update provider reasoning config
          provider.setReasoningConfig(body);

          // Persist to config
          const existingConfig = provider.toConfig();
          await persistDynamicProvider({ ...existingConfig, reasoning: body }, true);

          serverLog.info({ provider: name, mode: body.mode }, "Provider reasoning config updated");

          return json({
            ok: true,
            data: {
              provider: name,
              reasoning: body,
              message: `Reasoning mode set to "${body.mode}"`,
            },
          }, 200);

        } catch (err: any) {
          serverLog.error({ error: err.message }, "Failed to update reasoning config");
          return json({ ok: false, error: err.message || "Update failed" }, 500);
        }
      },
    },

    // POST /api/providers/dynamic/:name/reasoning/:modelId - Update model-specific reasoning
    {
      path: /^\/api\/providers\/dynamic\/(?<name>[^\/]+)\/reasoning\/(?<modelId>.+)$/,
      method: "POST",
      handler: async (req, params, _ctx) => {
        try {
          const rawName = params.get("name");
          const name = validateProviderName(rawName);
          if (!name) {
            return json({ ok: false, error: "Invalid provider name" }, 400);
          }

          const modelId = params.get("modelId");
          if (!modelId) {
            return json({ ok: false, error: "Model ID is required" }, 400);
          }

          const provider = providers.getDynamicProviders().find(p => p.name === name);
          if (!provider) {
            return json({ ok: false, error: "Provider not found" }, 404);
          }

          const body = await req.json() as ReasoningConfig;

          // Validate reasoning config
          const validation = validateReasoningConfig(body);
          if (!validation.valid) {
            return json({ ok: false, error: validation.errors.join("; ") }, 400);
          }

          // Check if model supports reasoning
          if (!provider.modelSupportsReasoning(modelId)) {
            return json({
              ok: false,
              error: `Model "${modelId}" may not support reasoning. Configuration will be ignored if unsupported.`,
            }, 400);
          }

          // Update model-specific reasoning config
          provider.setModelReasoningConfig(modelId, body);

          // Persist to config
          const existingConfig = provider.toConfig();
          const updatedModelReasoning = { 
            ...existingConfig.modelReasoning, 
            [modelId]: body 
          };
          await persistDynamicProvider(
            { ...existingConfig, modelReasoning: updatedModelReasoning }, 
            true
          );

          serverLog.info({ provider: name, model: modelId, mode: body.mode }, "Model reasoning config updated");

          return json({
            ok: true,
            data: {
              provider: name,
              model: modelId,
              reasoning: body,
              message: `Model "${modelId}" reasoning mode set to "${body.mode}"`,
            },
          }, 200);

        } catch (err: any) {
          serverLog.error({ error: err.message }, "Failed to update model reasoning config");
          return json({ ok: false, error: err.message || "Update failed" }, 500);
        }
      },
    },

    // GET /api/providers/dynamic/:name/reasoning - Get reasoning configuration
    {
      path: /^\/api\/providers\/dynamic\/(?<name>[^\/]+)\/reasoning$/,
      method: "GET",
      handler: async (req, params, _ctx) => {
        const rawName = params.get("name");
        const name = validateProviderName(rawName);
        if (!name) {
          return json({ ok: false, error: "Invalid provider name" }, 400);
        }

        const provider = providers.getDynamicProviders().find(p => p.name === name);
        if (!provider) {
          return json({ ok: false, error: "Provider not found" }, 404);
        }

        const url = new URL(req.url);
        const modelId = url.searchParams.get("model");

        const reasoning = provider.getReasoningConfig(modelId || undefined);
        const modelSupports = modelId ? provider.modelSupportsReasoning(modelId) : undefined;

        return json({
          ok: true,
          data: {
            provider: name,
            model: modelId || null,
            reasoning,
            modelSupportsReasoning: modelSupports,
            availableModes: ALL_REASONING_MODES,
          },
        }, 200);
      },
    },
  ];
}

// ─── Helper Functions ──────────────────────────────────────────────────────

/**
 * Persist a dynamic provider to the config file
 */
async function persistDynamicProvider(
  config: DynamicProviderConfig, 
  update: boolean = false
): Promise<void> {
  try {
    const currentConfig = await readConfig();
    
    if (!currentConfig.dynamicProviders) {
      currentConfig.dynamicProviders = [];
    }

    const existingIndex = currentConfig.dynamicProviders.findIndex(
      p => p.name === config.name
    );

    if (existingIndex >= 0) {
      if (update) {
        currentConfig.dynamicProviders[existingIndex] = config;
      } else {
        throw new Error(`Provider "${config.name}" already exists in config`);
      }
    } else {
      currentConfig.dynamicProviders.push(config);
    }

    await writeConfig(currentConfig);
    serverLog.debug({ provider: config.name }, "Dynamic provider persisted to config");
  } catch (err: any) {
    serverLog.error({ error: err.message, provider: config.name }, "Failed to persist dynamic provider");
    throw err;
  }
}

/**
 * Remove a dynamic provider from the config file
 */
async function removeDynamicProviderFromConfig(name: string): Promise<void> {
  try {
    const currentConfig = await readConfig();
    
    if (!currentConfig.dynamicProviders) {
      return;
    }

    currentConfig.dynamicProviders = currentConfig.dynamicProviders.filter(
      p => p.name !== name
    );

    await writeConfig(currentConfig);
    serverLog.debug({ provider: name }, "Dynamic provider removed from config");
  } catch (err: any) {
    serverLog.error({ error: err.message, provider: name }, "Failed to remove dynamic provider from config");
    throw err;
  }
}
