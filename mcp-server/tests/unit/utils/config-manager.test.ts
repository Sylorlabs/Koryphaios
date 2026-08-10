import { readFile, writeFile, access } from 'fs/promises';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { ConfigManager } from '../../../src/utils/config-manager.js';
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

  const missingFileError = () => Object.assign(new Error('File not found'), { code: 'ENOENT' });

  const validWorkspaceConfig = {
    root: '/project',
    projectName: 'test-project',
    language: 'typescript' as const,
    configFiles: {
      typescript: 'tsconfig.json',
    },
    excludePatterns: ['node_modules', 'dist'],
    includePatterns: ['src/**/*.ts'],
  };

  const validPreferences = {
    theme: 'dark' as const,
    notifications: {
      enabled: true,
      types: ['error', 'warning'] as ('error' | 'warning')[],
      sound: false,
    },
    ui: {
      showLineNumbers: true,
      showMinimap: false,
      fontSize: 14,
      fontFamily: 'Monaco',
    },
    debugging: {
      autoStartSessions: true,
      showInlineValues: true,
      showVariableTypes: true,
    },
    performance: {
      enableRealTimeMonitoring: true,
      showPerformanceHints: false,
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
      mockAccess.mockRejectedValue(missingFileError());

      const config = await configManager.loadConfig();

      expect(mockWriteFile).toHaveBeenCalled();
      expect(config).toBeDefined();
      expect(config.server).toBeDefined();
      expect(config.detectors).toBeDefined();
    });

    it('should reject invalid JSON without overwriting the config file', async () => {
      mockAccess.mockResolvedValue(undefined);
      mockReadFile.mockResolvedValue('invalid json');

      await expect(configManager.loadConfig()).rejects.toThrow(
        'Invalid JSON in /test/config.json; the existing file was preserved'
      );
      expect(mockWriteFile).not.toHaveBeenCalled();
    });

    it('should reject validation errors without overwriting the config file', async () => {
      mockAccess.mockResolvedValue(undefined);
      mockReadFile.mockResolvedValue(JSON.stringify(validConfig));
      mockValidateConfig.mockReturnValue({
        valid: false,
        errors: [{ message: 'Invalid server port' }],
      });

      await expect(configManager.loadConfig()).rejects.toThrow(
        'Invalid configuration in /test/config.json; the existing file was preserved'
      );
      expect(mockWriteFile).not.toHaveBeenCalled();
    });

    it('should reject unreadable existing paths without overwriting them', async () => {
      mockAccess.mockRejectedValue(
        Object.assign(new Error('Permission denied'), { code: 'EACCES' })
      );

      await expect(configManager.loadConfig()).rejects.toThrow(
        'Could not access configuration at /test/config.json; the existing path was preserved'
      );
      expect(mockReadFile).not.toHaveBeenCalled();
      expect(mockWriteFile).not.toHaveBeenCalled();
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
      expect(mockWriteFile).not.toHaveBeenCalled();
      expect(configManager.getConfig()).toEqual(validConfig);
    });

    it('should retain the loaded config when persistence fails', async () => {
      mockWriteFile.mockRejectedValue(new Error('Disk full'));

      await expect(
        configManager.updateConfig({ server: { port: 4000, logLevel: 'debug' } })
      ).rejects.toThrow('Disk full');
      expect(configManager.getConfig()).toEqual(validConfig);
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
      mockReadFile.mockResolvedValue(JSON.stringify(validWorkspaceConfig));

      const config = await configManager.loadWorkspaceConfig('/project');

      expect(config).toEqual(validWorkspaceConfig);
    });

    it('should handle missing workspace config', async () => {
      mockAccess.mockRejectedValue(missingFileError());

      const config = await configManager.loadWorkspaceConfig('/project');

      expect(config).toBeDefined();
      expect(config.projectName).toBe('Unnamed Project');
    });

    it('should preserve malformed workspace config', async () => {
      mockReadFile.mockResolvedValue('{bad');

      await expect(configManager.loadWorkspaceConfig('/project')).rejects.toThrow(
        'Invalid JSON in /project/.error-debugging.json; the existing file was preserved'
      );
      expect(mockWriteFile).not.toHaveBeenCalled();
    });

    it('should preserve semantically invalid workspace config', async () => {
      mockReadFile.mockResolvedValue(JSON.stringify({ projectName: 'missing required fields' }));

      await expect(configManager.loadWorkspaceConfig('/project')).rejects.toThrow(
        'Invalid workspace configuration in /project/.error-debugging.json'
      );
      expect(mockWriteFile).not.toHaveBeenCalled();
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
      mockReadFile.mockResolvedValue(JSON.stringify(validPreferences));

      const prefs = await configManager.loadUserPreferences('/user/prefs.json');

      expect(prefs).toEqual(validPreferences);
    });

    it('should save user preferences', async () => {
      const preferences = { ...validPreferences, theme: 'light' as const };

      await configManager.saveUserPreferences(preferences, '/user/prefs.json');

      expect(mockWriteFile).toHaveBeenCalledWith(
        '/user/prefs.json',
        JSON.stringify(preferences, null, 2),
        'utf-8'
      );
    });

    it('should create default user preferences only when the file is absent', async () => {
      mockAccess.mockRejectedValue(missingFileError());

      const preferences = await configManager.loadUserPreferences('/user/prefs.json');

      expect(preferences.theme).toBe('auto');
      expect(mockWriteFile).toHaveBeenCalledOnce();
    });

    it('should preserve malformed user preferences', async () => {
      mockReadFile.mockResolvedValue(JSON.stringify({ theme: 'dark' }));

      await expect(configManager.loadUserPreferences('/user/prefs.json')).rejects.toThrow(
        'Invalid user preferences in /user/prefs.json'
      );
      expect(mockWriteFile).not.toHaveBeenCalled();
    });

    it('should not replace loaded preferences when saving fails', async () => {
      mockReadFile.mockResolvedValue(JSON.stringify(validPreferences));
      await configManager.loadUserPreferences('/user/prefs.json');
      mockWriteFile.mockRejectedValue(new Error('Disk full'));

      await expect(
        configManager.saveUserPreferences(
          { ...validPreferences, theme: 'light' },
          '/user/prefs.json'
        )
      ).rejects.toThrow('Disk full');

      mockWriteFile.mockResolvedValue(undefined);
      await configManager.saveUserPreferences(validPreferences, '/user/prefs.json');
      expect(mockWriteFile).toHaveBeenLastCalledWith(
        '/user/prefs.json',
        JSON.stringify(validPreferences, null, 2),
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
      mockReadFile
        .mockResolvedValueOnce(JSON.stringify(validWorkspaceConfig))
        .mockResolvedValueOnce(JSON.stringify(validPreferences));

      const merged = await configManager.getMergedConfig('/workspace.json', '/prefs.json');

      expect(merged.server).toEqual(validConfig.server);
      expect(merged.workspace).toEqual(validWorkspaceConfig);
      expect(merged.userPreferences).toEqual(validPreferences);
    });

    it('should reject explicitly supplied malformed optional configs', async () => {
      mockReadFile.mockResolvedValueOnce('{bad');

      await expect(configManager.getMergedConfig('/workspace.json')).rejects.toThrow(
        'Invalid JSON in /workspace.json; the existing file was preserved'
      );
    });
  });
});
