import type { KoryphaiosConfig, AppConfig, ServerConfig } from '@koryphaios/shared';
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { validateConfig } from '../config-schema';
import { serverLog } from '../logger';
import { safeJsonParse, ConfigError } from '../errors';
import { AGENT, DEFAULT_CONTEXT_PATHS, FS, SERVER, WORKSPACE } from '../constants';
import { wsBroker } from '../pubsub';

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

export function loadConfig(projectRoot: string): BackendConfig {
  const configPaths = [
    join(projectRoot, 'koryphaios.json'),
    join(homedir(), '.config', 'koryphaios', 'config.json'),
    join(homedir(), '.koryphaios.json'),
  ];

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
    providers: fileConfig.providers ?? {},
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
    telegram:
      fileConfig.telegram ??
      (process.env.TELEGRAM_BOT_TOKEN
        ? {
            botToken: process.env.TELEGRAM_BOT_TOKEN,
            adminId: Number(process.env.TELEGRAM_ADMIN_ID ?? 0),
            secretToken: process.env.TELEGRAM_SECRET_TOKEN,
          }
        : undefined),
    discord:
      fileConfig.discord ??
      (process.env.DISCORD_BOT_TOKEN
        ? {
            botToken: process.env.DISCORD_BOT_TOKEN,
            allowedGuildIds: process.env.DISCORD_ALLOWED_GUILD_IDS?.split(',').filter(Boolean),
            allowedUserIds: process.env.DISCORD_ALLOWED_USER_IDS?.split(',').filter(Boolean),
          }
        : undefined),
    slack:
      fileConfig.slack ??
      (process.env.SLACK_BOT_TOKEN && process.env.SLACK_APP_TOKEN
        ? {
            botToken: process.env.SLACK_BOT_TOKEN,
            appToken: process.env.SLACK_APP_TOKEN,
            signingSecret: process.env.SLACK_SIGNING_SECRET,
            allowedChannelIds: process.env.SLACK_ALLOWED_CHANNEL_IDS?.split(',').filter(Boolean),
            allowedUserIds: process.env.SLACK_ALLOWED_USER_IDS?.split(',').filter(Boolean),
          }
        : undefined),
    mcpServers: fileConfig.mcpServers,
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
    mode: fileConfig.mode ?? (process.env.KORYPHAIOS_MODE as any) ?? 'beginner',
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
      type: 'system.config_updated' as any,
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
export function syncAgentSettingsToConfig(projectRoot: string, settings: any): void {
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
      type: 'system.config_updated' as any,
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
 * Sync provider configurations back to koryphaios.json atomically.
 */
export function syncProviderConfigsToConfig(
  projectRoot: string,
  providers: Record<string, any>,
): void {
  const configPath = join(projectRoot, 'koryphaios.json');

  if (!existsSync(configPath)) {
    return;
  }

  const tempPath = `${configPath}.${process.pid}.tmp`;

  try {
    const content = readFileSync(configPath, 'utf-8');
    const config = JSON.parse(content);

    config.providers = {
      ...(config.providers || {}),
      ...providers,
    };

    // Track global update
    const updatedAt = Date.now();
    config.updatedAt = updatedAt;

    writeFileSync(tempPath, JSON.stringify(config, null, 2), 'utf-8');
    renameSync(tempPath, configPath);

    serverLog.info({ updatedAt }, 'Synced provider configurations to koryphaios.json atomically');

    // Broadcast update via WebSocket broker
    wsBroker.publish('custom', {
      type: 'system.config_updated' as any,
      payload: { source: 'provider-sync', updatedAt },
      timestamp: updatedAt,
      sessionId: 'global',
      agentId: 'system',
    });
  } catch (err) {
    serverLog.warn({ err }, 'Failed to sync provider configurations to koryphaios.json');
  }
}
