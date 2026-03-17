// Configuration Manager
// Handles atomic read/write of koryphaios.json configuration

import { readFile, writeFile, rename, unlink, copyFile } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import type { KoryphaiosConfig } from "@koryphaios/shared";
import { PROJECT_ROOT } from "../runtime/paths";
import { serverLog } from "../logger";

const CONFIG_FILE = "koryphaios.json";
const CONFIG_PATH = join(PROJECT_ROOT, CONFIG_FILE);
const TEMP_SUFFIX = ".tmp";
const BACKUP_SUFFIX = ".backup";

/**
 * Read the current configuration from koryphaios.json
 * Returns default config if file doesn't exist
 */
export async function readConfig(): Promise<KoryphaiosConfig> {
  try {
    if (!existsSync(CONFIG_PATH)) {
      serverLog.warn("Config file not found, returning defaults");
      return getDefaultConfig();
    }

    const content = await readFile(CONFIG_PATH, "utf-8");
    const parsed = JSON.parse(content) as KoryphaiosConfig;

    // Validate required fields
    if (!parsed.providers) {
      parsed.providers = {};
    }
    if (!parsed.agents) {
      parsed.agents = getDefaultConfig().agents;
    }
    if (!parsed.server) {
      parsed.server = { port: 29473, host: "127.0.0.1" };
    }
    if (!parsed.dataDirectory) {
      parsed.dataDirectory = ".koryphaios";
    }

    return parsed;
  } catch (err: any) {
    serverLog.error({ error: err.message }, "Failed to read config, returning defaults");
    return getDefaultConfig();
  }
}

/**
 * Write configuration to koryphaios.json atomically
 * Uses write-to-temp + rename pattern for crash safety
 */
export async function writeConfig(config: KoryphaiosConfig): Promise<void> {
  const tempPath = `${CONFIG_PATH}${TEMP_SUFFIX}`;
  const backupPath = `${CONFIG_PATH}${BACKUP_SUFFIX}`;

  try {
    // 1. Validate config before writing
    validateConfig(config);

    // 2. Create backup of existing config (if exists)
    if (existsSync(CONFIG_PATH)) {
      try {
        await copyFile(CONFIG_PATH, backupPath);
      } catch (err: any) {
        serverLog.warn({ error: err.message }, "Failed to create config backup");
        // Continue anyway - main write is more important
      }
    }

    // 3. Write to temp file with proper formatting
    const jsonContent = JSON.stringify(config, null, 2);
    await writeFile(tempPath, jsonContent, "utf-8");

    // 4. Atomic rename (POSIX guarantee)
    await rename(tempPath, CONFIG_PATH);

    // 5. Remove backup on success
    if (existsSync(backupPath)) {
      try {
        await unlink(backupPath);
      } catch {
        // Ignore cleanup errors
      }
    }

    serverLog.debug("Config saved successfully");
  } catch (err: any) {
    // Cleanup temp file on failure
    try {
      if (existsSync(tempPath)) {
        await unlink(tempPath);
      }
    } catch {
      // Ignore cleanup errors
    }

    serverLog.error({ error: err.message }, "Failed to write config");
    throw new Error(`Failed to save configuration: ${err.message}`);
  }
}

/**
 * Update specific sections of the config without overwriting everything
 */
export async function updateConfig(
  updates: Partial<KoryphaiosConfig>
): Promise<KoryphaiosConfig> {
  const current = await readConfig();
  const updated = { ...current, ...updates };
  await writeConfig(updated);
  return updated;
}

/**
 * Get a specific section of the config
 */
export async function getConfigSection<K extends keyof KoryphaiosConfig>(
  section: K
): Promise<KoryphaiosConfig[K]> {
  const config = await readConfig();
  return config[section];
}

/**
 * Restore configuration from backup
 */
export async function restoreFromBackup(): Promise<boolean> {
  const backupPath = `${CONFIG_PATH}${BACKUP_SUFFIX}`;

  try {
    if (!existsSync(backupPath)) {
      serverLog.warn("No backup file found to restore from");
      return false;
    }

    await copyFile(backupPath, CONFIG_PATH);
    serverLog.info("Config restored from backup");
    return true;
  } catch (err: any) {
    serverLog.error({ error: err.message }, "Failed to restore config from backup");
    return false;
  }
}

/**
 * Validate configuration structure
 */
function validateConfig(config: KoryphaiosConfig): void {
  const errors: string[] = [];

  // Check required fields
  if (!config.providers || typeof config.providers !== "object") {
    errors.push("Missing or invalid 'providers' field");
  }

  if (!config.agents || typeof config.agents !== "object") {
    errors.push("Missing or invalid 'agents' field");
  } else {
    if (!config.agents.manager?.model) {
      errors.push("Missing 'agents.manager.model' field");
    }
    if (!config.agents.coder?.model) {
      errors.push("Missing 'agents.coder.model' field");
    }
    if (!config.agents.task?.model) {
      errors.push("Missing 'agents.task.model' field");
    }
  }

  if (!config.server || typeof config.server !== "object") {
    errors.push("Missing or invalid 'server' field");
  } else {
    if (typeof config.server.port !== "number") {
      errors.push("Invalid 'server.port' field");
    }
    if (typeof config.server.host !== "string") {
      errors.push("Invalid 'server.host' field");
    }
  }

  if (typeof config.dataDirectory !== "string") {
    errors.push("Missing or invalid 'dataDirectory' field");
  }

  // Validate dynamic providers if present
  if (config.dynamicProviders) {
    if (!Array.isArray(config.dynamicProviders)) {
      errors.push("'dynamicProviders' must be an array");
    } else {
      for (let i = 0; i < config.dynamicProviders.length; i++) {
        const dp = config.dynamicProviders[i];
        if (!dp.name) {
          errors.push(`Dynamic provider at index ${i} is missing 'name'`);
        }
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(`Config validation failed: ${errors.join("; ")}`);
  }
}

/**
 * Get default configuration
 */
export function getDefaultConfig(): KoryphaiosConfig {
  return {
    providers: {},
    agents: {
      manager: {
        model: "claude-3-7-sonnet",
        maxTokens: 8192,
        reasoningLevel: "high",
      },
      coder: {
        model: "claude-3-7-sonnet",
        maxTokens: 16384,
        reasoningLevel: "medium",
      },
      task: {
        model: "gpt-4o-mini",
        maxTokens: 8192,
      },
    },
    server: {
      port: 29473,
      host: "127.0.0.1",
    },
    dataDirectory: ".koryphaios",
    dynamicProviders: [],
  };
}

/**
 * Initialize config file if it doesn't exist
 */
export async function initializeConfig(): Promise<void> {
  if (existsSync(CONFIG_PATH)) {
    return;
  }

  try {
    const defaultConfig = getDefaultConfig();
    await writeConfig(defaultConfig);
    serverLog.info({ path: CONFIG_PATH }, "Created default config file");
  } catch (err: any) {
    serverLog.error({ error: err.message }, "Failed to initialize config");
    throw err;
  }
}

/**
 * Watch config file for changes (for future hot-reload support)
 */
export function watchConfig(callback: (config: KoryphaiosConfig) => void): () => void {
  // TODO: Implement file watching with fs.watch or chokidar
  // For now, return no-op cleanup function
  return () => {};
}
