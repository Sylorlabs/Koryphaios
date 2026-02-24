import type { KoryphaiosConfig } from "@koryphaios/shared";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { validateConfig } from "../config-schema";
import { serverLog } from "../logger";
import { safeJsonParse, ConfigError } from "../errors";
import { AGENT, DEFAULT_CONTEXT_PATHS, FS, SERVER, WORKSPACE } from "../constants";

/** Merge file corsOrigins with CORS_ORIGINS env (comma-separated). Production can set CORS_ORIGINS=https://app.example.com */
function mergeCorsOrigins(fromFile: string[], envValue?: string): string[] {
  const fromEnv = envValue
    ? envValue.split(",").map((s) => s.trim()).filter(Boolean)
    : [];
  return [...fromFile, ...fromEnv];
}

export function loadConfig(projectRoot: string): KoryphaiosConfig {
  const configPaths = [
    join(projectRoot, "koryphaios.json"),
    join(homedir(), ".config", "koryphaios", "config.json"),
    join(homedir(), ".koryphaios.json"),
  ];

  let fileConfig: Partial<KoryphaiosConfig> = {};

  for (const path of configPaths) {
    if (existsSync(path)) {
      try {
        const rawConfig = readFileSync(path, "utf-8");
        fileConfig = safeJsonParse(rawConfig, {}, { path });
        if (Object.keys(fileConfig).length > 0) {
          serverLog.info({ path }, "Loaded config");
          break;
        }
      } catch (err) {
        serverLog.warn({ path, err }, "Failed to parse config");
        throw new ConfigError(`Invalid config file: ${path}`, { path, error: String(err) });
      }
    }
  }

  const config: KoryphaiosConfig = {
    providers: fileConfig.providers ?? {},
    agents: fileConfig.agents ?? {
      manager: { model: AGENT.DEFAULT_MANAGER_MODEL, reasoningLevel: AGENT.DEFAULT_REASONING_LEVEL },
      coder: { model: AGENT.DEFAULT_CODER_MODEL, maxTokens: AGENT.CODER_MAX_TOKENS },
      task: { model: AGENT.DEFAULT_TASK_MODEL, maxTokens: AGENT.DEFAULT_MAX_TOKENS },
    },
    server: {
      port: Number(process.env.KORYPHAIOS_PORT ?? fileConfig.server?.port ?? SERVER.DEFAULT_PORT),
      host: process.env.KORYPHAIOS_HOST ?? fileConfig.server?.host ?? SERVER.DEFAULT_HOST,
    },
    telegram: fileConfig.telegram ?? (process.env.TELEGRAM_BOT_TOKEN
      ? {
        botToken: process.env.TELEGRAM_BOT_TOKEN,
        adminId: Number(process.env.TELEGRAM_ADMIN_ID ?? 0),
        secretToken: process.env.TELEGRAM_SECRET_TOKEN,
      }
      : undefined),
    mcpServers: fileConfig.mcpServers,
    contextPaths: fileConfig.contextPaths ?? DEFAULT_CONTEXT_PATHS,
    dataDirectory: fileConfig.dataDirectory ?? FS.DEFAULT_DATA_DIR,
    fallbacks: fileConfig.fallbacks ?? AGENT.DEFAULT_FALLBACKS,
    corsOrigins: mergeCorsOrigins(fileConfig.corsOrigins ?? [], process.env.CORS_ORIGINS),
    assignments: fileConfig.assignments,
    workspace: {
      worktreeLimit: fileConfig.workspace?.worktreeLimit ?? WORKSPACE.DEFAULT_WORKTREE_LIMIT,
      worktreeDir: fileConfig.workspace?.worktreeDir ?? WORKSPACE.DEFAULT_WORKTREE_DIR,
      copyEnvFiles: fileConfig.workspace?.copyEnvFiles ?? WORKSPACE.DEFAULT_COPY_ENV_FILES,
    },
  };

  validateConfig(config);

  return config;
}
