// JSON Schema validation for koryphaios.json
// This provides runtime validation beyond TypeScript's compile-time checks

import type { KoryphaiosConfig } from "@koryphaios/shared";
import { ConfigError } from "./errors";
import { serverLog } from "./logger";
import { resolveModel } from "./providers/types";

/** Whether public registration is allowed. Set ALLOW_REGISTRATION=false in production to disable sign-up. */
export function getAllowRegistration(): boolean {
  return process.env.ALLOW_REGISTRATION !== "false";
}

/**
 * Validates the loaded configuration against expected schema
 */
export function validateConfig(config: Partial<KoryphaiosConfig>): void {
  const errors: string[] = [];

  // Validate server config
  if (config.server) {
    if (typeof config.server.port !== "number" || config.server.port < 1 || config.server.port > 65535) {
      errors.push("server.port must be a number between 1 and 65535");
    }
    if (typeof config.server.host !== "string" || config.server.host.trim() === "") {
      errors.push("server.host must be a non-empty string");
    }
  }

  // Validate agents config
  if (config.agents) {
    for (const [role, agentConfig] of Object.entries(config.agents)) {
      if (!agentConfig.model || typeof agentConfig.model !== "string") {
        errors.push(`agents.${role}.model must be a non-empty string`);
      }
      if (agentConfig.maxTokens !== undefined && (typeof agentConfig.maxTokens !== "number" || agentConfig.maxTokens < 1)) {
        errors.push(`agents.${role}.maxTokens must be a positive number`);
      }
      if ("reasoningLevel" in agentConfig && agentConfig.reasoningLevel !== undefined) {
        if (typeof agentConfig.reasoningLevel !== "string") {
          errors.push(`agents.${role}.reasoningLevel must be a string`);
        }
      }
    }
  }

  // Validate assignments config
  if (config.assignments) {
    for (const [domain, assignment] of Object.entries(config.assignments)) {
      if (typeof assignment !== "string" || !assignment.includes(":")) {
        errors.push(`assignments.${domain} must be a string in "provider:model" format`);
        continue;
      }
      const [, modelId] = assignment.split(":");
      const modelDef = resolveModel(modelId);
      if (!modelDef) {
        errors.push(`assignments.${domain} references unknown model "${modelId}" — check MODEL_CATALOG for valid IDs`);
      }
    }
  }

  // Validate fallbacks config
  if (config.fallbacks) {
    if (typeof config.fallbacks !== "object" || Array.isArray(config.fallbacks)) {
      errors.push("fallbacks must be an object mapping modelId -> array of modelIds");
    } else {
      for (const [fromModel, toModels] of Object.entries(config.fallbacks)) {
        if (!resolveModel(fromModel)) {
          errors.push(`fallbacks key "${fromModel}" references unknown model — check MODEL_CATALOG`);
        }
        if (!Array.isArray(toModels)) {
          errors.push(`fallbacks.${fromModel} must be an array of model ID strings`);
          continue;
        }
        for (const m of toModels) {
          if (typeof m !== "string") {
            errors.push(`fallbacks.${fromModel} contains non-string value`);
          } else if (!resolveModel(m)) {
            errors.push(`fallbacks.${fromModel} references unknown model "${m}" — check MODEL_CATALOG`);
          }
        }
      }
    }
  }

  // Validate providers config
  if (config.providers) {
    const validProviders = new Set([
      "anthropic", "openai", "google", "copilot", "openrouter",
      "groq", "xai", "azure", "bedrock", "vertexai", "local"
    ]);

    for (const [name, providerConfig] of Object.entries(config.providers)) {
      if (!validProviders.has(name)) {
        errors.push(`Invalid provider name: ${name}`);
      }
      if (providerConfig.disabled !== undefined && typeof providerConfig.disabled !== "boolean") {
        errors.push(`providers.${name}.disabled must be a boolean`);
      }
      if (providerConfig.baseUrl !== undefined && typeof providerConfig.baseUrl !== "string") {
        errors.push(`providers.${name}.baseUrl must be a string`);
      }
    }
  }

  // Validate MCP servers config
  if (config.mcpServers) {
    for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
      if (!serverConfig.type || !["stdio", "sse"].includes(serverConfig.type)) {
        errors.push(`mcpServers.${name}.type must be "stdio" or "sse"`);
      }
      if (serverConfig.type === "stdio") {
        if (!serverConfig.command || typeof serverConfig.command !== "string") {
          errors.push(`mcpServers.${name}.command is required for stdio type`);
        }
        if (serverConfig.args && !Array.isArray(serverConfig.args)) {
          errors.push(`mcpServers.${name}.args must be an array`);
        }
      }
      if (serverConfig.type === "sse") {
        if (!serverConfig.url || typeof serverConfig.url !== "string") {
          errors.push(`mcpServers.${name}.url is required for sse type`);
        }
      }
    }
  }

  // Validate telegram config
  if (config.telegram) {
    if (!config.telegram.botToken || typeof config.telegram.botToken !== "string") {
      errors.push("telegram.botToken must be a non-empty string");
    }
    if (typeof config.telegram.adminId !== "number" || config.telegram.adminId <= 0) {
      errors.push("telegram.adminId must be a positive number");
    }
    if (config.telegram.webhookUrl !== undefined && typeof config.telegram.webhookUrl !== "string") {
      errors.push("telegram.webhookUrl must be a string");
    }
  }

  // Validate dataDirectory
  if (config.dataDirectory && typeof config.dataDirectory !== "string") {
    errors.push("dataDirectory must be a string");
  }

  // Validate safety config
  if (config.safety) {
    if (config.safety.maxTokensPerTurn !== undefined) {
      if (typeof config.safety.maxTokensPerTurn !== "number" || config.safety.maxTokensPerTurn < 1 || config.safety.maxTokensPerTurn > 100000) {
        errors.push("safety.maxTokensPerTurn must be a number between 1 and 100000");
      }
    }
    if (config.safety.maxFileSizeBytes !== undefined) {
      if (typeof config.safety.maxFileSizeBytes !== "number" || config.safety.maxFileSizeBytes < 1 || config.safety.maxFileSizeBytes > 100_000_000) {
        errors.push("safety.maxFileSizeBytes must be a number between 1 and 100000000 (100MB)");
      }
    }
    if (config.safety.toolExecutionTimeoutMs !== undefined) {
      if (typeof config.safety.toolExecutionTimeoutMs !== "number" || config.safety.toolExecutionTimeoutMs < 1000 || config.safety.toolExecutionTimeoutMs > 600_000) {
        errors.push("safety.toolExecutionTimeoutMs must be a number between 1000 and 600000 (10 minutes)");
      }
    }
  }

  // Validate contextPaths
  if (config.contextPaths) {
    if (!Array.isArray(config.contextPaths)) {
      errors.push("contextPaths must be an array");
    } else {
      const invalidPaths = config.contextPaths.filter(p => typeof p !== "string");
      if (invalidPaths.length > 0) {
        errors.push("All contextPaths must be strings");
      }
    }
  }

  // Validate workspace config
  if (config.workspace) {
    if (config.workspace.worktreeLimit !== undefined) {
      if (typeof config.workspace.worktreeLimit !== "number" || config.workspace.worktreeLimit < 1 || config.workspace.worktreeLimit > 100) {
        errors.push("workspace.worktreeLimit must be a number between 1 and 100");
      }
    }
    if (config.workspace.worktreeDir !== undefined && typeof config.workspace.worktreeDir !== "string") {
      errors.push("workspace.worktreeDir must be a string");
    }
    if (config.workspace.copyEnvFiles !== undefined && typeof config.workspace.copyEnvFiles !== "boolean") {
      errors.push("workspace.copyEnvFiles must be a boolean");
    }
  }

  if (errors.length > 0) {
    serverLog.error({ errors }, "Configuration validation failed");
    throw new ConfigError(
      `Invalid configuration: ${errors.join("; ")}`,
      { validationErrors: errors }
    );
  }

  serverLog.debug("Configuration validation passed");
}

/**
 * Validates required environment variables on startup
 */
export function validateEnvironment(): void {
  const warnings: string[] = [];
  const errors: string[] = [];

  // Check if at least one provider API key is set
  const providerKeys = [
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "GEMINI_API_KEY",
    "GROQ_API_KEY",
    "XAI_API_KEY",
    "AZURE_OPENAI_API_KEY",
    "OPENROUTER_API_KEY",
    "GITHUB_TOKEN",
    "AWS_ACCESS_KEY_ID",
  ];

  const hasAnyProvider = providerKeys.some(key => process.env[key]);
  if (!hasAnyProvider) {
    warnings.push("No provider API keys found in environment. You'll need to configure providers via the UI.");
  }

  // Validate Telegram config if set
  if (process.env.TELEGRAM_BOT_TOKEN) {
    if (!process.env.TELEGRAM_ADMIN_ID) {
      errors.push("TELEGRAM_ADMIN_ID is required when TELEGRAM_BOT_TOKEN is set");
    } else {
      const adminId = Number(process.env.TELEGRAM_ADMIN_ID);
      if (isNaN(adminId) || adminId <= 0) {
        errors.push("TELEGRAM_ADMIN_ID must be a valid positive number");
      }
    }
  }

  // In production, warn if CORS_ORIGINS is not explicitly set
  if (process.env.NODE_ENV === "production") {
    if (!process.env.CORS_ORIGINS?.trim()) {
      warnings.push("In production, set CORS_ORIGINS explicitly (defaults include localhost only)");
    }
  }

  // Validate port if set
  if (process.env.KORYPHAIOS_PORT) {
    const port = Number(process.env.KORYPHAIOS_PORT);
    if (isNaN(port) || port < 1 || port > 65535) {
      errors.push("KORYPHAIOS_PORT must be a number between 1 and 65535");
    }
  }

  // Validate AWS credentials if set
  if (process.env.AWS_ACCESS_KEY_ID && !process.env.AWS_SECRET_ACCESS_KEY) {
    errors.push("AWS_SECRET_ACCESS_KEY is required when AWS_ACCESS_KEY_ID is set");
  }

  // Log warnings — in development log as debug to avoid noisy console output; warn in production
  if (warnings.length > 0) {
    for (const warning of warnings) {
      if (process.env.NODE_ENV === "production") {
        serverLog.warn(warning);
      } else {
        serverLog.debug(warning);
      }
    }
  }

  // Throw on errors
  if (errors.length > 0) {
    serverLog.error({ errors }, "Environment validation failed");
    throw new ConfigError(
      `Invalid environment: ${errors.join("; ")}`,
      { validationErrors: errors }
    );
  }

  serverLog.info("Environment validation passed");
}
