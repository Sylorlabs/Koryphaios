/**
 * Configuration management utilities
 */

import { readFile, writeFile, access } from 'fs/promises';
import { join } from 'path';

import { validateConfig } from './validation.js';

import type { ServerConfig, WorkspaceConfig, UserPreferences } from '@/types/index.js';
import { SupportedLanguage } from '@/types/languages.js';

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

function parseJson<T>(contents: string, filePath: string): T {
  try {
    return JSON.parse(contents) as T;
  } catch (error) {
    throw new Error(
      `Invalid JSON in ${filePath}; the existing file was preserved: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}

function assertWorkspaceConfig(value: unknown, filePath: string): asserts value is WorkspaceConfig {
  if (
    !isRecord(value) ||
    typeof value['root'] !== 'string' ||
    !Object.values(SupportedLanguage).includes(value['language'] as SupportedLanguage) ||
    !isRecord(value['configFiles']) ||
    !isStringArray(value['excludePatterns']) ||
    !isStringArray(value['includePatterns']) ||
    (value['projectName'] !== undefined && typeof value['projectName'] !== 'string')
  ) {
    throw new Error(
      `Invalid workspace configuration in ${filePath}; the existing file was preserved`
    );
  }
}

function assertUserPreferences(value: unknown, filePath: string): asserts value is UserPreferences {
  const notifications = isRecord(value) ? value['notifications'] : undefined;
  const ui = isRecord(value) ? value['ui'] : undefined;
  const debugging = isRecord(value) ? value['debugging'] : undefined;
  const performance = isRecord(value) ? value['performance'] : undefined;

  if (
    !isRecord(value) ||
    !['light', 'dark', 'auto'].includes(String(value['theme'])) ||
    !isRecord(notifications) ||
    typeof notifications['enabled'] !== 'boolean' ||
    !isStringArray(notifications['types']) ||
    !notifications['types'].every(type => ['error', 'warning', 'info'].includes(type)) ||
    typeof notifications['sound'] !== 'boolean' ||
    !isRecord(ui) ||
    typeof ui['showLineNumbers'] !== 'boolean' ||
    typeof ui['showMinimap'] !== 'boolean' ||
    typeof ui['fontSize'] !== 'number' ||
    !Number.isFinite(ui['fontSize']) ||
    typeof ui['fontFamily'] !== 'string' ||
    !isRecord(debugging) ||
    typeof debugging['autoStartSessions'] !== 'boolean' ||
    typeof debugging['showInlineValues'] !== 'boolean' ||
    typeof debugging['showVariableTypes'] !== 'boolean' ||
    !isRecord(performance) ||
    typeof performance['enableRealTimeMonitoring'] !== 'boolean' ||
    typeof performance['showPerformanceHints'] !== 'boolean'
  ) {
    throw new Error(`Invalid user preferences in ${filePath}; the existing file was preserved`);
  }
}

export class ConfigManager {
  private config: ServerConfig | null = null;
  private configPath: string;
  private workspaceConfig: WorkspaceConfig | null = null;
  private userPreferences: UserPreferences | null = null;

  constructor(configPath?: string) {
    if (configPath) {
      this.configPath = configPath;
    } else {
      // Try to use a writable directory
      const cwd = process.cwd();
      const homeDir = process.env['HOME'] || process.env['USERPROFILE'] || '';

      // If we're in root directory or can't write to cwd, use home directory
      if (cwd === '/' || cwd === '' || !homeDir) {
        this.configPath = join(homeDir || '/tmp', '.error-debugging-config.json');
      } else {
        this.configPath = join(cwd, 'error-debugging-config.json');
      }
    }
  }

  async loadConfig(): Promise<ServerConfig> {
    try {
      await access(this.configPath);
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw new Error(
          `Could not access configuration at ${this.configPath}; the existing path was preserved: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error }
        );
      }

      this.config = this.getDefaultConfig();
      try {
        await this.saveConfig();
      } catch (saveError) {
        console.warn(
          `Warning: Could not save default config to ${this.configPath}:`,
          saveError instanceof Error ? saveError.message : saveError
        );
      }
      return this.config;
    }

    let configData: string;
    try {
      configData = await readFile(this.configPath, 'utf-8');
    } catch (error) {
      throw new Error(
        `Could not read configuration at ${this.configPath}; the existing file was preserved: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }

    const parsedConfig = parseJson<ServerConfig>(configData, this.configPath);
    const validation = validateConfig(parsedConfig);
    if (!validation.valid) {
      throw new Error(
        `Invalid configuration in ${this.configPath}; the existing file was preserved: ${validation.errors.map(e => e.message).join(', ')}`
      );
    }

    this.config = parsedConfig;
    return parsedConfig;
  }

  async saveConfig(): Promise<void> {
    if (!this.config) {
      throw new Error('No configuration to save');
    }

    const configData = JSON.stringify(this.config, null, 2);
    await writeFile(this.configPath, configData, 'utf-8');
  }

  async updateConfig(updates: Partial<ServerConfig>): Promise<void> {
    if (!this.config) {
      await this.loadConfig();
    }

    const updatedConfig = { ...this.config!, ...updates };

    // Validate updated config
    const validation = validateConfig(updatedConfig);
    if (!validation.valid) {
      throw new Error(
        `Invalid configuration update: ${validation.errors.map(e => e.message).join(', ')}`
      );
    }

    const configData = JSON.stringify(updatedConfig, null, 2);
    await writeFile(this.configPath, configData, 'utf-8');
    this.config = updatedConfig;
  }

  getConfig(): ServerConfig {
    if (!this.config) {
      throw new Error('Configuration not loaded');
    }
    return this.config;
  }

  async loadWorkspaceConfig(workspaceRoot: string): Promise<WorkspaceConfig> {
    const workspaceConfigPath = join(workspaceRoot, '.error-debugging.json');

    try {
      await access(workspaceConfigPath);
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw new Error(
          `Could not access workspace configuration at ${workspaceConfigPath}; the existing path was preserved: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error }
        );
      }

      this.workspaceConfig = this.getDefaultWorkspaceConfig(workspaceRoot);
      await writeFile(workspaceConfigPath, JSON.stringify(this.workspaceConfig, null, 2), 'utf-8');
      return this.workspaceConfig;
    }

    let configData: string;
    try {
      configData = await readFile(workspaceConfigPath, 'utf-8');
    } catch (error) {
      throw new Error(
        `Could not read workspace configuration at ${workspaceConfigPath}; the existing file was preserved: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }

    const workspaceConfig = parseJson<WorkspaceConfig>(configData, workspaceConfigPath);
    assertWorkspaceConfig(workspaceConfig, workspaceConfigPath);
    this.workspaceConfig = workspaceConfig;
    return workspaceConfig;
  }

  async loadUserPreferences(preferencesPath?: string): Promise<UserPreferences> {
    const userConfigPath =
      preferencesPath ||
      join(
        process.env['HOME'] || process.env['USERPROFILE'] || '',
        '.error-debugging-preferences.json'
      );

    try {
      await access(userConfigPath);
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw new Error(
          `Could not access user preferences at ${userConfigPath}; the existing path was preserved: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error }
        );
      }

      this.userPreferences = this.getDefaultUserPreferences();
      await writeFile(userConfigPath, JSON.stringify(this.userPreferences, null, 2), 'utf-8');
      return this.userPreferences;
    }

    let configData: string;
    try {
      configData = await readFile(userConfigPath, 'utf-8');
    } catch (error) {
      throw new Error(
        `Could not read user preferences at ${userConfigPath}; the existing file was preserved: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }

    const userPreferences = parseJson<UserPreferences>(configData, userConfigPath);
    assertUserPreferences(userPreferences, userConfigPath);
    this.userPreferences = userPreferences;
    return userPreferences;
  }

  async saveUserPreferences(preferences: UserPreferences, preferencesPath?: string): Promise<void> {
    const userConfigPath =
      preferencesPath ||
      join(
        process.env['HOME'] || process.env['USERPROFILE'] || '',
        '.error-debugging-preferences.json'
      );

    assertUserPreferences(preferences, userConfigPath);
    const preferencesData = JSON.stringify(preferences, null, 2);
    await writeFile(userConfigPath, preferencesData, 'utf-8');
    this.userPreferences = preferences;
  }

  async getMergedConfig(
    workspaceConfigPath?: string,
    preferencesPath?: string
  ): Promise<ServerConfig & { workspace?: WorkspaceConfig; userPreferences?: UserPreferences }> {
    // Load base config if not already loaded
    if (!this.config) {
      await this.loadConfig();
    }

    let workspaceConfig: WorkspaceConfig | undefined;
    let userPreferences: UserPreferences | undefined;

    // Load workspace config if path provided
    if (workspaceConfigPath) {
      try {
        await access(workspaceConfigPath);
        const configData = await readFile(workspaceConfigPath, 'utf-8');
        const parsedWorkspaceConfig = parseJson<WorkspaceConfig>(configData, workspaceConfigPath);
        assertWorkspaceConfig(parsedWorkspaceConfig, workspaceConfigPath);
        workspaceConfig = parsedWorkspaceConfig;
      } catch (error) {
        if (!isMissingFileError(error)) {
          throw error;
        }
      }
    }

    // Load user preferences if path provided
    if (preferencesPath) {
      try {
        await access(preferencesPath);
        const configData = await readFile(preferencesPath, 'utf-8');
        const parsedUserPreferences = parseJson<UserPreferences>(configData, preferencesPath);
        assertUserPreferences(parsedUserPreferences, preferencesPath);
        userPreferences = parsedUserPreferences;
      } catch (error) {
        if (!isMissingFileError(error)) {
          throw error;
        }
      }
    }

    // Merge configurations with base config taking precedence
    const mergedConfig: ServerConfig & {
      workspace?: WorkspaceConfig;
      userPreferences?: UserPreferences;
    } = {
      ...this.config!,
      ...(workspaceConfig && { workspace: workspaceConfig }),
      ...(userPreferences && { userPreferences: userPreferences }),
    };

    return mergedConfig;
  }

  private getDefaultConfig(): ServerConfig {
    const config = {
      server: {
        name: 'error-debugging-mcp-server',
        version: '1.0.0',
        logLevel: 'info' as const,
        maxConnections: 10,
        timeout: 30000,
      },
      transport: {
        type: 'stdio' as const,
      },
      detection: {
        enabled: true,
        realTime: true,
        sources: {
          console: true,
          runtime: true,
          build: true,
          test: true,
          linter: true,
          staticAnalysis: true,
          // External IDE diagnostics can be ingested explicitly, but the MCP
          // server does not install or impersonate an IDE extension.
          ide: false,
          buildTools: true,
          processMonitor: true,
          multiLanguage: true,
        },
        filters: {
          categories: [],
          severities: [],
          excludeFiles: ['node_modules/**', 'dist/**', 'build/**'],
          excludePatterns: ['*.min.js', '*.map'],
        },
        polling: {
          interval: 1000,
          maxRetries: 3,
        },
        bufferSize: 1000,
        maxErrorsPerSession: 10000,
      },
      analysis: {
        // Reserved compatibility schema. The MCP runtime does not currently
        // execute an AI analysis provider from these flags.
        enabled: false,
        aiEnhanced: false,
        confidenceThreshold: 0.7,
        maxAnalysisTime: 10000,
        enablePatternMatching: true,
        enableSimilaritySearch: true,
        enableRootCauseAnalysis: true,
        enableImpactPrediction: false,
        customPatterns: [],
        historicalDataRetention: 30, // days
      },
      debugging: {
        // Language handlers truthfully report debugger sessions unavailable.
        enabled: false,
        languages: {},
        defaultTimeout: 30000,
        maxConcurrentSessions: 5,
        enableHotReload: false,
        enableRemoteDebugging: false,
        breakpoints: {
          maxPerSession: 50,
          enableConditional: true,
          enableLogPoints: true,
        },
        variableInspection: {
          maxDepth: 10,
          maxStringLength: 1000,
          enableLazyLoading: true,
        },
      },
      performance: {
        enabled: false,
        profiling: {
          enabled: false,
          sampleRate: 100,
          maxDuration: 60000,
          includeMemory: true,
          includeCpu: true,
        },
        monitoring: {
          enabled: true,
          interval: 5000,
          thresholds: {
            memory: 512 * 1024 * 1024, // 512MB
            cpu: 80, // 80%
            responseTime: 1000, // 1s
          },
        },
        optimization: {
          enableSuggestions: true,
          enableAutomaticOptimization: false,
          aggressiveness: 'moderate' as const,
        },
      },
      integrations: {
        buildSystems: {
          webpack: false,
          vite: false,
          rollup: false,
          parcel: false,
          esbuild: false,
        },
        testRunners: {
          jest: false,
          vitest: false,
          mocha: false,
          pytest: false,
          goTest: false,
          cargoTest: false,
        },
        linters: {
          eslint: false,
          tslint: false,
          pylint: false,
          flake8: false,
          golint: false,
          clippy: false,
        },
        versionControl: {
          git: false,
          enableCommitHooks: false,
          enableBranchAnalysis: false,
        },
        containers: {
          docker: false,
          kubernetes: false,
          enableContainerDebugging: false,
        },
        ides: {
          vscode: false,
          cursor: false,
          windsurf: false,
          augmentCode: false,
        },
      },
      security: {
        enableSecurityScanning: false,
        vulnerabilityDatabases: [],
        enableDependencyScanning: false,
        enableCodeScanning: false,
        reportingLevel: 'medium-high' as const,
        autoFixVulnerabilities: false,
        excludePatterns: ['test/**', 'tests/**'],
      },
    };

    // Add backward compatibility alias
    (config as any).detectors = config.detection;

    return config;
  }

  private getDefaultWorkspaceConfig(workspaceRoot: string): WorkspaceConfig {
    return {
      root: workspaceRoot,
      projectName: 'Unnamed Project',
      language: SupportedLanguage.TYPESCRIPT,
      configFiles: {},
      excludePatterns: ['node_modules/**', 'dist/**', 'build/**', '.git/**'],
      includePatterns: ['src/**', 'lib/**', 'app/**'],
    };
  }

  private getDefaultUserPreferences(): UserPreferences {
    return {
      theme: 'auto',
      notifications: {
        enabled: true,
        types: ['error', 'warning'],
        sound: false,
      },
      ui: {
        showLineNumbers: true,
        showMinimap: true,
        fontSize: 14,
        fontFamily: 'Monaco, Consolas, "Courier New", monospace',
      },
      debugging: {
        autoStartSessions: false,
        showInlineValues: true,
        showVariableTypes: true,
      },
      performance: {
        enableRealTimeMonitoring: true,
        showPerformanceHints: true,
      },
    };
  }
}
