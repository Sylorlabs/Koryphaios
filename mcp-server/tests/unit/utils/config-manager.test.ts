import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ConfigManager } from '../../../src/utils/config-manager.js';
import { readFile, writeFile, access } from 'fs/promises';
import { validateConfig } from '../../../src/utils/validation.js';

// Mock fs modules and validation
vi.mock('fs/promises');
vi.mock('../../../src/utils/validation.js');

describe('ConfigManager', () => {
  let configManager: ConfigManager;
  let mockReadFile: ReturnType<typeof vi.mocked>;
  let mockWriteFile: ReturnType<typeof vi.mocked>;
  let mockAccess: ReturnType<typeof vi.mocked>;
  let mockValidateConfig: ReturnType<typeof vi.mocked>;

  const validConfig = {
    server: {
      name: 'error-debugging-mcp-server',
      version: '1.0.0',
      port: 3000,
      host: 'localhost',
      logLevel: 'info' as const,
    },
    detectors: {
      build: {
        enabled: true,
        languages: ['typescript', 'javascript'],
      },
      linter: {
        enabled: true,
        tools: ['eslint', 'tslint'],
      },
      runtime: {
        enabled: true,
        captureStackTraces: true,
      },
      console: {
        enabled: true,
        captureWarnings: true,
      },
    },
    ai: {
      enabled: true,
      provider: 'openai',
      model: 'gpt-4',
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockReadFile = vi.mocked(readFile);
    mockWriteFile = vi.mocked(writeFile);
    mockAccess = vi.mocked(access);
    mockValidateConfig = vi.mocked(validateConfig);

    mockWriteFile.mockResolvedValue(undefined);
    mockValidateConfig.mockReturnValue({ valid: true, errors: [] });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('initialization', () => {
    it('should create config manager with default path', () => {
      configManager = new ConfigManager();
      expect(configManager).toBeInstanceOf(ConfigManager);
    });

    it('should create config manager with custom path', () => {
      configManager = new ConfigManager('/custom/path/config.json');
      expect(configManager).toBeInstanceOf(ConfigManager);
    });
  });

  describe('loadConfig', () => {
    beforeEach(() => {
      configManager = new ConfigManager('/test/config.json');
    });

    it('should load existing valid config', async () => {
      mockAccess.mockResolvedValue(undefined);
      mockReadFile.mockResolvedValue(JSON.stringify(validConfig));

      const config = await configManager.loadConfig();

      expect(mockAccess).toHaveBeenCalledWith('/test/config.json');
      expect(mockReadFile).toHaveBeenCalledWith('/test/config.json', 'utf-8');
      expect(mockValidateConfig).toHaveBeenCalledWith(validConfig);
      expect(config).toEqual(validConfig);
    });

    it('should create default config when file does not exist', async () => {
      mockAccess.mockRejectedValue(new Error('File not found'));

      const config = await configManager.loadConfig();

      expect(mockWriteFile).toHaveBeenCalled();
      expect(config).toBeDefined();
      expect(config.server).toBeDefined();
      expect(config.detectors).toBeDefined();
    });

    it('should handle invalid JSON in config file', async () => {
      mockAccess.mockResolvedValue(undefined);
      mockReadFile.mockResolvedValue('invalid json');

      const config = await configManager.loadConfig();

      // Should fall back to default config
      expect(mockWriteFile).toHaveBeenCalled();
      expect(config).toBeDefined();
    });

    it('should handle validation errors', async () => {
      mockAccess.mockResolvedValue(undefined);
      mockReadFile.mockResolvedValue(JSON.stringify(validConfig));
      mockValidateConfig.mockReturnValue({
        valid: false,
        errors: [{ message: 'Invalid server port' }],
      });

      const config = await configManager.loadConfig();

      // Should fall back to default config
      expect(mockWriteFile).toHaveBeenCalled();
      expect(config).toBeDefined();
    });
  });

  describe('saveConfig', () => {
    beforeEach(() => {
      configManager = new ConfigManager('/test/config.json');
    });

    it('should save config to file', async () => {
      // First load a config
      mockAccess.mockResolvedValue(undefined);
      mockReadFile.mockResolvedValue(JSON.stringify(validConfig));
      await configManager.loadConfig();

      // Then save it
      await configManager.saveConfig();

      expect(mockWriteFile).toHaveBeenCalledWith(
        '/test/config.json',
        expect.stringContaining('"server"'),
        'utf-8'
      );
    });

    it('should handle save errors gracefully', async () => {
      mockAccess.mockResolvedValue(undefined);
      mockReadFile.mockResolvedValue(JSON.stringify(validConfig));
      await configManager.loadConfig();

      mockWriteFile.mockRejectedValue(new Error('Write error'));

      await expect(configManager.saveConfig()).rejects.toThrow('Write error');
    });
  });

  describe('updateConfig', () => {
    beforeEach(async () => {
      configManager = new ConfigManager('/test/config.json');
      mockAccess.mockResolvedValue(undefined);
      mockReadFile.mockResolvedValue(JSON.stringify(validConfig));
      await configManager.loadConfig();
    });

    it('should update server config', async () => {
      const updates = { port: 4000, logLevel: 'debug' as const };

      await configManager.updateConfig({ server: updates });

      expect(mockWriteFile).toHaveBeenCalled();
      const savedConfig = JSON.parse(mockWriteFile.mock.calls[0][1] as string);
      expect(savedConfig.server.port).toBe(4000);
      expect(savedConfig.server.logLevel).toBe('debug');
    });

    it('should update detector config', async () => {
      const updates = {
        build: { enabled: false, languages: ['typescript'] },
      };

      await configManager.updateConfig({ detectors: updates });

      expect(mockWriteFile).toHaveBeenCalled();
      const savedConfig = JSON.parse(mockWriteFile.mock.calls[0][1] as string);
      expect(savedConfig.detectors.build.enabled).toBe(false);
    });

    it('should validate config before saving', async () => {
      mockValidateConfig.mockReturnValue({
        valid: false,
        errors: [{ message: 'Invalid update' }],
      });

      await expect(
        configManager.updateConfig({
          server: { port: -1 },
        })
      ).rejects.toThrow('Invalid update');
    });
  });

  describe('workspace config', () => {
    beforeEach(async () => {
      configManager = new ConfigManager('/test/config.json');
      mockAccess.mockResolvedValue(undefined);
      mockReadFile.mockResolvedValue(JSON.stringify(validConfig));
      await configManager.loadConfig();
    });

    it('should load workspace config', async () => {
      const workspaceConfig = {
        projectName: 'test-project',
        rootPath: '/project/root',
        excludePatterns: ['node_modules', 'dist'],
        includePatterns: ['src/**/*.ts'],
        languageSettings: {
          typescript: {
            configFile: 'tsconfig.json',
            strictMode: true,
          },
        },
      };

      mockReadFile.mockResolvedValue(JSON.stringify(workspaceConfig));

      const config = await configManager.loadWorkspaceConfig('/project/workspace.json');

      expect(config).toEqual(workspaceConfig);
    });

    it('should handle missing workspace config', async () => {
      mockAccess.mockRejectedValue(new Error('File not found'));

      const config = await configManager.loadWorkspaceConfig('/project/workspace.json');

      expect(config).toBeDefined();
      expect(config.projectName).toBe('Unnamed Project');
    });
  });

  describe('user preferences', () => {
    beforeEach(async () => {
      configManager = new ConfigManager('/test/config.json');
      mockAccess.mockResolvedValue(undefined);
      mockReadFile.mockResolvedValue(JSON.stringify(validConfig));
      await configManager.loadConfig();
    });

    it('should load user preferences', async () => {
      const preferences = {
        theme: 'dark' as const,
        notifications: {
          enabled: true,
          sound: false,
          desktop: true,
        },
        editor: {
          fontSize: 14,
          fontFamily: 'Monaco',
          tabSize: 2,
        },
        debugging: {
          autoBreakOnError: true,
          showStackTrace: true,
          verboseLogging: false,
        },
      };

      mockReadFile.mockResolvedValue(JSON.stringify(preferences));

      const prefs = await configManager.loadUserPreferences('/user/prefs.json');

      expect(prefs).toEqual(preferences);
    });

    it('should save user preferences', async () => {
      const preferences = {
        theme: 'light' as const,
        notifications: { enabled: false, sound: false, desktop: false },
        editor: { fontSize: 12, fontFamily: 'Arial', tabSize: 4 },
        debugging: { autoBreakOnError: false, showStackTrace: false, verboseLogging: true },
      };

      await configManager.saveUserPreferences(preferences, '/user/prefs.json');

      expect(mockWriteFile).toHaveBeenCalledWith(
        '/user/prefs.json',
        JSON.stringify(preferences, null, 2),
        'utf-8'
      );
    });
  });

  describe('config merging', () => {
    beforeEach(async () => {
      configManager = new ConfigManager('/test/config.json');
      mockAccess.mockResolvedValue(undefined);
      mockReadFile.mockResolvedValue(JSON.stringify(validConfig));
      await configManager.loadConfig();
    });

    it('should merge configs correctly', async () => {
      const workspaceConfig = {
        projectName: 'test-project',
        rootPath: '/project',
        excludePatterns: ['node_modules'],
        includePatterns: ['src/**'],
        languageSettings: {},
      };

      const userPrefs = {
        theme: 'dark' as const,
        notifications: { enabled: true, sound: false, desktop: true },
        editor: { fontSize: 14, fontFamily: 'Monaco', tabSize: 2 },
        debugging: { autoBreakOnError: true, showStackTrace: true, verboseLogging: false },
      };

      mockReadFile
        .mockResolvedValueOnce(JSON.stringify(workspaceConfig))
        .mockResolvedValueOnce(JSON.stringify(userPrefs));

      const merged = await configManager.getMergedConfig('/workspace.json', '/prefs.json');

      expect(merged.server).toEqual(validConfig.server);
      expect(merged.workspace).toEqual(workspaceConfig);
      expect(merged.userPreferences).toEqual(userPrefs);
    });
  });
});
