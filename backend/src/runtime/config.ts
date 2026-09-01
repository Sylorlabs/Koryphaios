import type { KoryphaiosConfig, AppConfig, ServerConfig, AgentSettings } from '@koryphaios/shared';
import { existsSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { validateConfig } from '../config-schema';
import { serverLog } from '../logger';
import { safeJsonParse, ConfigError } from '../errors';
import { AGENT, DEFAULT_CONTEXT_PATHS, FS, SERVER, WORKSPACE } from '../constants';
import { wsBroker } from '../pubsub';
import {
  migrateSecretsOutOfConfig,
  hydrateProviderSecrets,
  stripProviderSecrets,
  upsertProviderSecrets,
  removeProviderSecrets,
  stripMcpEnvSecrets,
  hydrateMcpEnvSecrets,
  removeMcpEnvSecrets,
  loadMcpEnvSecrets,
  saveMcpEnvSecrets,
} from '../security/secret-store';

/** Merge file corsOrigins with CORS_ORIGINS env (comma-separated). Production can set CORS_ORIGINS=https://app.example.com */
function mergeCorsOrigins(fromFile: string[], envValue?: string): string[] {
  const fromEnv = envValue
    ? envValue
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
  return [...fromFile, ...fromEnv];
}

/**
 * Load infrastructure configuration from app.config.json
 */
function loadAppConfig(projectRoot: string): Partial<AppConfig> {
  const appConfigPath = join(projectRoot, 'config', 'app.config.json');
  if (existsSync(appConfigPath)) {
    try {
      const raw = readFileSync(appConfigPath, 'utf-8');
      return safeJsonParse(raw, {}, { path: appConfigPath });
    } catch (err) {
      serverLog.warn({ path: appConfigPath, err }, 'Failed to load app.config.json');
    }
  }
  return {};
}

/**
 * Backend-specific config that guarantees server infrastructure is populated
 */
export type BackendConfig = KoryphaiosConfig & { server: ServerConfig };

/** Read only the selected project's MCP map. Unlike loadConfig(), this never
 * falls back to a home/global config, because project-scoped routes must not
 * inherit another project's servers or secrets. */
export function loadProjectMcpServers(
  projectRoot: string,
): Record<string, Record<string, unknown>> {
  const configPath = join(projectRoot, 'koryphaios.json');
  if (!existsSync(configPath)) return {};
  try {
    const parsed = safeJsonParse(readFileSync(configPath, 'utf-8'), {}, { path: configPath }) as {
      mcpServers?: Record<string, Record<string, unknown>>;
    };
    return hydrateMcpEnvSecrets(projectRoot, parsed.mcpServers ?? {});
  } catch (err: unknown) {
    throw new ConfigError('Invalid project MCP configuration', {
      path: configPath,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export function loadConfig(projectRoot: string): BackendConfig {
  const configPaths = [
    join(projectRoot, 'koryphaios.json'),
    join(homedir(), '.config', 'koryphaios', 'config.json'),
    join(homedir(), '.koryphaios.json'),
  ];

  // Heal any credentials still living in koryphaios.json (moves them into
  // the 0600 secret store) BEFORE reading — settings and secrets never mix.
  migrateSecretsOutOfConfig(projectRoot);
  // Same healing for MCP server env values (tokens often live in env maps).
  migrateMcpEnvSecretsOutOfConfig(projectRoot);

  let fileConfig: Partial<KoryphaiosConfig> = {};

  for (const path of configPaths) {
    if (existsSync(path)) {
      try {
        const rawConfig = readFileSync(path, 'utf-8');
        fileConfig = safeJsonParse(rawConfig, {}, { path });
        if (Object.keys(fileConfig).length > 0) {
          serverLog.info({ path }, 'Loaded config');
          break;
        }
      } catch (err) {
        serverLog.warn({ path, err }, 'Failed to parse config');
        throw new ConfigError(`Invalid config file: ${path}`, { path, error: String(err) });
      }
    }
  }

  // Load infrastructure from app.config.json as base for server settings
  const appConfig = loadAppConfig(projectRoot);

  const config: KoryphaiosConfig = {
    // Runtime gets real keys from the 0600 secret store; the on-disk
    // koryphaios.json stays credential-free.
    providers: hydrateProviderSecrets(
      projectRoot,
      (fileConfig.providers ?? {}) as Record<string, unknown>,
    ) as KoryphaiosConfig['providers'],
    agents: fileConfig.agents ?? {
      manager: {
        model: AGENT.DEFAULT_MANAGER_MODEL,
        reasoningLevel: AGENT.DEFAULT_REASONING_LEVEL,
      },
      coder: { model: AGENT.DEFAULT_CODER_MODEL, maxTokens: AGENT.CODER_MAX_TOKENS },
      task: { model: AGENT.DEFAULT_TASK_MODEL, maxTokens: AGENT.DEFAULT_MAX_TOKENS },
    },
    server: {
      port: Number(
        process.env.KORYPHAIOS_PORT ??
          fileConfig.server?.port ??
          appConfig.server?.port ??
          SERVER.DEFAULT_PORT,
      ),
      host:
        process.env.KORYPHAIOS_HOST ??
        fileConfig.server?.host ??
        appConfig.server?.host ??
        SERVER.DEFAULT_HOST,
    },
    mcpServers: hydrateMcpEnvSecrets(projectRoot, fileConfig.mcpServers ?? {}),
    contextPaths: fileConfig.contextPaths ?? DEFAULT_CONTEXT_PATHS,
    dataDirectory: fileConfig.dataDirectory ?? FS.DEFAULT_DATA_DIR,
    fallbacks: fileConfig.fallbacks ?? AGENT.DEFAULT_FALLBACKS,
    corsOrigins: mergeCorsOrigins(fileConfig.corsOrigins ?? [], process.env.CORS_ORIGINS),
    assignments: fileConfig.assignments,
    safety: {
      maxTokensPerTurn: fileConfig.safety?.maxTokensPerTurn ?? 4096,
      maxFileSizeBytes: fileConfig.safety?.maxFileSizeBytes ?? 10_000_000,
      toolExecutionTimeoutMs: fileConfig.safety?.toolExecutionTimeoutMs ?? 60_000,
    },
    workspace: {
      worktreeLimit: fileConfig.workspace?.worktreeLimit ?? WORKSPACE.DEFAULT_WORKTREE_LIMIT,
      worktreeDir: fileConfig.workspace?.worktreeDir ?? WORKSPACE.DEFAULT_WORKTREE_DIR,
      copyEnvFiles: fileConfig.workspace?.copyEnvFiles ?? WORKSPACE.DEFAULT_COPY_ENV_FILES,
    },
    mode:
      fileConfig.mode ??
      (process.env.KORYPHAIOS_MODE as 'beginner' | 'advanced' | undefined) ??
      'beginner',
    enableCritic: fileConfig.enableCritic,
    agentSettings: fileConfig.agentSettings,
  };

  validateConfig(config);

  return config as BackendConfig;
}

/**
 * Sync UI mode back to koryphaios.json atomically.
 */
export function syncModeToConfig(projectRoot: string, mode: 'beginner' | 'advanced'): void {
  const configPath = join(projectRoot, 'koryphaios.json');

  if (!existsSync(configPath)) {
    return;
  }

  const tempPath = `${configPath}.${process.pid}.tmp`;

  try {
    const content = readFileSync(configPath, 'utf-8');
    const config = JSON.parse(content);

    config.mode = mode;

    // Track global update
    const updatedAt = Date.now();
    config.updatedAt = updatedAt;

    writeFileSync(tempPath, JSON.stringify(config, null, 2), 'utf-8');
    renameSync(tempPath, configPath);

    serverLog.info({ mode, updatedAt }, 'Synced mode to koryphaios.json atomically');

    // Broadcast update via WebSocket broker
    wsBroker.publish('custom', {
      type: 'system.config_updated',
      payload: { source: 'mode-sync', mode, updatedAt },
      timestamp: updatedAt,
      sessionId: 'global',
      agentId: 'system',
    });
  } catch (err) {
    serverLog.warn({ err }, 'Failed to sync mode to koryphaios.json');
  }
}

/**
 * Sync agent settings back to koryphaios.json atomically.
 * This keeps UI settings and config file in sync without corruption.
 */
export function syncAgentSettingsToConfig(projectRoot: string, settings: AgentSettings): void {
  const configPath = join(projectRoot, 'koryphaios.json');

  if (!existsSync(configPath)) {
    return;
  }

  const tempPath = `${configPath}.${process.pid}.tmp`;

  try {
    const content = readFileSync(configPath, 'utf-8');
    const config = JSON.parse(content);

    // Update both for compatibility
    config.enableCritic = settings.criticGateEnabled;
    config.agentSettings = settings;

    // Track global update
    const updatedAt = Date.now();
    config.updatedAt = updatedAt;
    if (config.agentSettings) {
      config.agentSettings.updatedAt = updatedAt;
    }

    writeFileSync(tempPath, JSON.stringify(config, null, 2), 'utf-8');
    renameSync(tempPath, configPath);

    serverLog.info({ updatedAt }, 'Synced agent settings to koryphaios.json atomically');

    // Broadcast update via WebSocket broker
    wsBroker.publish('custom', {
      type: 'system.config_updated',
      payload: { source: 'config-sync', updatedAt },
      timestamp: updatedAt,
      sessionId: 'global',
      agentId: 'system',
    });
  } catch (err) {
    serverLog.warn({ err }, 'Failed to sync agent settings to koryphaios.json');
  }
}

/**
 * Sync per-category model assignments (domain -> "provider:model") back to
 * koryphaios.json atomically. Empty/"auto" values are removed so the smart
 * router falls back to DOMAIN.DEFAULT_MODELS for that category.
 */
export function syncAssignmentsToConfig(
  projectRoot: string,
  assignments: Record<string, string>,
): void {
  const configPath = join(projectRoot, 'koryphaios.json');

  if (!existsSync(configPath)) {
    return;
  }

  const tempPath = `${configPath}.${process.pid}.tmp`;

  try {
    const content = readFileSync(configPath, 'utf-8');
    const config = JSON.parse(content);

    // Drop empty/"auto" entries so the file only carries explicit overrides.
    const cleaned: Record<string, string> = {};
    for (const [domain, value] of Object.entries(assignments)) {
      const v = (value ?? '').trim();
      if (v && v !== 'auto') cleaned[domain] = v;
    }
    config.assignments = cleaned;

    const updatedAt = Date.now();
    config.updatedAt = updatedAt;

    writeFileSync(tempPath, JSON.stringify(config, null, 2), 'utf-8');
    renameSync(tempPath, configPath);

    serverLog.info(
      { updatedAt, assignments: cleaned },
      'Synced category assignments to koryphaios.json',
    );

    wsBroker.publish('custom', {
      type: 'system.config_updated',
      payload: { source: 'assignments-sync', updatedAt },
      timestamp: updatedAt,
      sessionId: 'global',
      agentId: 'system',
    });
  } catch (err) {
    serverLog.warn({ err }, 'Failed to sync category assignments to koryphaios.json');
  }
}

/**
 * Remove a provider entry from koryphaios.json (used for deleting custom providers).
 * syncProviderConfigsToConfig only merges, so deletions need an explicit removal.
 */
export function removeProviderFromConfig(projectRoot: string, providerId: string): void {
  // Credential deletion is authoritative and independent of the settings
  // file. A missing koryphaios.json (or a provider entry already removed from
  // it) must not strand a reusable direct secret on disk.
  removeProviderSecrets(projectRoot, providerId);
  const configPath = join(projectRoot, 'koryphaios.json');
  if (!existsSync(configPath)) return;
  const tempPath = `${configPath}.${process.pid}.tmp`;
  try {
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    if (config.providers && config.providers[providerId]) {
      delete config.providers[providerId];
      config.updatedAt = Date.now();
      writeFileSync(tempPath, JSON.stringify(config, null, 2), 'utf-8');
      renameSync(tempPath, configPath);
      serverLog.info({ providerId }, 'Removed provider from koryphaios.json');
    }
  } catch (err) {
    serverLog.warn({ err, providerId }, 'Failed to remove provider from koryphaios.json');
  }
}

/**
 * Sync the full mcpServers map back to koryphaios.json atomically. Env values
 * are stripped into the 0600 MCP env secret store; only key names remain in
 * the config file. Broadcasts system.config_updated so the frontend reloads.
 */
export function syncMcpServersToConfig(
  projectRoot: string,
  servers: Record<string, Record<string, unknown>>,
): void {
  const configPath = join(projectRoot, 'koryphaios.json');
  const tempPath = `${configPath}.${process.pid}.${randomUUID()}.tmp`;
  let previousSecrets: Record<string, Record<string, string>> = {};
  try {
    const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf-8')) : {};
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      throw new Error('project configuration root is not an object');
    }
    const { clean, secrets } = stripMcpEnvSecrets(servers);
    previousSecrets = loadMcpEnvSecrets(projectRoot);
    config.mcpServers = clean;
    const updatedAt = Date.now();
    config.updatedAt = updatedAt;
    writeFileSync(tempPath, JSON.stringify(config, null, 2), { encoding: 'utf-8', mode: 0o600 });
    // Publish the secret snapshot before the config rename, then roll it back
    // if either durable write fails. A caller must never receive success while
    // only one half of the project MCP registration is durable.
    saveMcpEnvSecrets(projectRoot, secrets);
    renameSync(tempPath, configPath);
    serverLog.info({ updatedAt }, 'Synced MCP servers to koryphaios.json atomically');
    wsBroker.publish('custom', {
      type: 'system.config_updated',
      payload: { source: 'mcp-servers-sync', updatedAt },
      timestamp: updatedAt,
      sessionId: 'global',
      agentId: 'system',
    });
  } catch (err) {
    try {
      saveMcpEnvSecrets(projectRoot, previousSecrets);
    } catch {
      // Preserve the original failure; the secret store remains fail-closed
      // and the next retry will reconcile it from the project config.
    }
    try {
      rmSync(tempPath, { force: true });
    } catch {
      /* best effort */
    }
    serverLog.warn(
      { errorType: err instanceof Error ? err.name : typeof err },
      'Failed to sync MCP servers to the selected project configuration',
    );
    throw new Error('MCP server configuration could not be saved');
  }
}

/**
 * Remove a single MCP server from koryphaios.json and purge its env secrets.
 */
export function removeMcpServerFromConfig(projectRoot: string, serverName: string): void {
  const configPath = join(projectRoot, 'koryphaios.json');
  const tempPath = `${configPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf-8')) : null;
    if (!config) {
      removeMcpEnvSecrets(projectRoot, serverName);
      return;
    }
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      throw new Error('project configuration root is not an object');
    }
    if (config.mcpServers && config.mcpServers[serverName]) {
      delete config.mcpServers[serverName];
      config.updatedAt = Date.now();
      writeFileSync(tempPath, JSON.stringify(config, null, 2), { encoding: 'utf-8', mode: 0o600 });
      renameSync(tempPath, configPath);
      serverLog.info({ serverName }, 'Removed MCP server from koryphaios.json');
    }
    // Config removal is the first durable step. If secret deletion fails, the
    // route reports failure and leaves the old secret recoverable for retry.
    removeMcpEnvSecrets(projectRoot, serverName);
  } catch (err) {
    try {
      rmSync(tempPath, { force: true });
    } catch {
      /* best effort */
    }
    serverLog.warn(
      { serverName, errorType: err instanceof Error ? err.name : typeof err },
      'Failed to remove MCP server from the selected project configuration',
    );
    throw new Error('MCP server configuration could not be removed');
  }
}

/** One-time healing: move MCP env values from koryphaios.json into the secret store. */
export function migrateMcpEnvSecretsOutOfConfig(projectRoot: string): void {
  const configPath = join(projectRoot, 'koryphaios.json');
  if (!existsSync(configPath)) return;
  try {
    const config = JSON.parse(readFileSync(configPath, 'utf-8')) as {
      mcpServers?: Record<string, Record<string, unknown>>;
    };
    if (!config.mcpServers) return;
    const { clean, secrets } = stripMcpEnvSecrets(config.mcpServers);
    if (Object.keys(secrets).length === 0) return;
    const existing = loadMcpEnvSecrets(projectRoot);
    for (const [name, env] of Object.entries(secrets)) {
      existing[name] = { ...existing[name], ...env };
    }
    saveMcpEnvSecrets(projectRoot, existing);
    config.mcpServers = clean;
    const tmp = `${configPath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(config, null, 2), 'utf-8');
    renameSync(tmp, configPath);
    serverLog.info(
      { servers: Object.keys(secrets) },
      'Migrated MCP env secrets out of koryphaios.json into the secret store',
    );
  } catch (err) {
    serverLog.warn({ err }, 'MCP env secret migration from koryphaios.json failed');
  }
}

/**
 * Sync provider configurations back to koryphaios.json atomically.
 */
export function syncProviderConfigsToConfig(
  projectRoot: string,
  providers: Record<string, unknown>,
): boolean {
  const configPath = join(projectRoot, 'koryphaios.json');
  const tempPath = `${configPath}.${process.pid}.tmp`;

  try {
    const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf-8')) : {};

    // Secrets go to the 0600 store; koryphaios.json gets everything else.
    const { clean, secrets } = stripProviderSecrets(providers);
    for (const [name, vals] of Object.entries(secrets)) {
      upsertProviderSecrets(projectRoot, name, vals);
    }
    const merged: Record<string, unknown> = { ...(config.providers || {}) };
    for (const [name, cfg] of Object.entries(clean)) {
      merged[name] = {
        ...((merged[name] as Record<string, unknown>) ?? {}),
        ...(cfg as Record<string, unknown>),
      };
      for (const field of ['apiKey', 'authToken', 'headers'])
        delete (merged[name] as Record<string, unknown>)[field];
    }
    config.providers = merged;

    // Track global update
    const updatedAt = Date.now();
    config.updatedAt = updatedAt;

    writeFileSync(tempPath, JSON.stringify(config, null, 2), 'utf-8');
    renameSync(tempPath, configPath);

    serverLog.info({ updatedAt }, 'Synced provider configurations to koryphaios.json atomically');

    // Broadcast update via WebSocket broker
    wsBroker.publish('custom', {
      type: 'system.config_updated',
      payload: { source: 'provider-sync', updatedAt },
      timestamp: updatedAt,
      sessionId: 'global',
      agentId: 'system',
    });
    return true;
  } catch (err) {
    serverLog.warn({ err }, 'Failed to sync provider configurations to koryphaios.json');
    return false;
  }
}
