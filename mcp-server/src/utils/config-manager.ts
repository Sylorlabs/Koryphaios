/**
 * Configuration management utilities
 */

import { readFile, writeFile, access } from 'fs/promises';
import { join } from 'path';

import type { ServerConfig, WorkspaceConfig, UserPreferences } from '@/types/index.js';
import { SupportedLanguage } from '@/types/languages.js';
import { validateConfig } from './validation.js';

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
      // Try to load existing config
      await access(this.configPath);
      const configData = await readFile(this.configPath, 'utf-8');
      const parsedConfig = JSON.parse(configData) as ServerConfig;

      // Validate config
      const validation = validateConfig(parsedConfig);
      if (!validation.valid) {
        throw new Error(
          `Invalid configuration: ${validation.errors.map(e => e.message).join(', ')}`
        );
      }

      this.config = parsedConfig;
    } catch (error) {
      // Create default config if file doesn't exist
      this.config = this.getDefaultConfig();

      // Try to save config, but don't fail if we can't write
      try {
        await this.saveConfig();
      } catch (saveError) {
        // Log the warning but continue with default config
        console.warn(
          `Warning: Could not save default config to ${this.configPath}:`,
          saveError instanceof Error ? saveError.message : saveError
        );
      }
    }

    return this.config;
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

    this.config = { ...this.config!, ...updates };

    // Validate updated config
    const validation = validateConfig(this.config);
    if (!validation.valid) {
      throw new Error(
        `Invalid configuration update: ${validation.errors.map(e => e.message).join(', ')}`
      );
    }

    await this.saveConfig();
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
      const configData = await readFile(workspaceConfigPath, 'utf-8');
      this.workspaceConfig = JSON.parse(configData) as WorkspaceConfig;
    } catch (error) {
      // Create default workspace config
      this.workspaceConfig = this.getDefaultWorkspaceConfig(workspaceRoot);
      await writeFile(workspaceConfigPath, JSON.stringify(this.workspaceConfig, null, 2), 'utf-8');
    }

    return this.workspaceConfig;
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
      const configData = await readFile(userConfigPath, 'utf-8');
      this.userPreferences = JSON.parse(configData) as UserPreferences;
    } catch (error) {
      // Create default user preferences
      this.userPreferences = this.getDefaultUserPreferences();
      await writeFile(userConfigPath, JSON.stringify(this.userPreferences, null, 2), 'utf-8');
    }

    return this.userPreferences;
  }

  async saveUserPreferences(preferences: UserPreferences, preferencesPath?: string): Promise<void> {
    const userConfigPath =
      preferencesPath ||
      join(
        process.env['HOME'] || process.env['USERPROFILE'] || '',
        '.error-debugging-preferences.json'
      );

    this.userPreferences = preferences;
    const preferencesData = JSON.stringify(preferences, null, 2);
    await writeFile(userConfigPath, preferencesData, 'utf-8');
  }

  async getMergedConfig(
    workspaceConfigPath?: string,
    preferencesPath?: string
  ): Promise<ServerConfig & { workspace?: WorkspaceConfig; preferences?: UserPreferences }> {
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
        workspaceConfig = JSON.parse(configData) as WorkspaceConfig;
      } catch (error) {
        // Workspace config is optional
      }
    }

    // Load user preferences if path provided
    if (preferencesPath) {
      try {
        await access(preferencesPath);
        const configData = await readFile(preferencesPath, 'utf-8');
        userPreferences = JSON.parse(configData) as UserPreferences;
      } catch (error) {
        // User preferences are optional
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
          ide: true,
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
        enabled: true,
        aiEnhanced: true,
        confidenceThreshold: 0.7,
        maxAnalysisTime: 10000,
        enablePatternMatching: true,
        enableSimilaritySearch: true,
        enableRootCauseAnalysis: true,
        enableImpactPrediction: true,
        customPatterns: [],
        historicalDataRetention: 30, // days
      },
      debugging: {
        enabled: true,
        languages: {},
        defaultTimeout: 30000,
        maxConcurrentSessions: 5,
        enableHotReload: true,
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
        enabled: true,
        profiling: {
          enabled: true,
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
          webpack: true,
          vite: true,
          rollup: true,
          parcel: true,
          esbuild: true,
        },
        testRunners: {
          jest: true,
          vitest: true,
          mocha: true,
          pytest: true,
          goTest: true,
          cargoTest: true,
        },
        linters: {
          eslint: true,
          tslint: false,
          pylint: true,
          flake8: true,
          golint: true,
          clippy: true,
        },
        versionControl: {
          git: true,
          enableCommitHooks: false,
          enableBranchAnalysis: true,
        },
        containers: {
          docker: true,
          kubernetes: false,
          enableContainerDebugging: false,
        },
        ides: {
          vscode: true,
          cursor: true,
          windsurf: true,
          augmentCode: true,
        },
      },
      security: {
        enableSecurityScanning: true,
        vulnerabilityDatabases: ['npm-audit', 'snyk'],
        enableDependencyScanning: true,
        enableCodeScanning: true,
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
