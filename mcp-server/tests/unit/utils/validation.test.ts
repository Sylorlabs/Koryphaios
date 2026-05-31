import { describe, it, expect } from 'vitest';
import {
  validateConfig,
  validateEnvironment,
  validateWorkspaceStructure,
  validateToolConfiguration,
} from '../../../src/utils/validation.js';

describe('Validation', () => {
  describe('validateConfig', () => {
    const validConfig = {
      server: {
        name: 'error-debugging-mcp-server',
        version: '1.0.0',
        port: 3000,
        host: 'localhost',
        logLevel: 'info' as const,
        maxConnections: 100,
        timeout: 5000,
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
          staticAnalysis: false,
          ide: true,
        },
        filters: {
          categories: ['error', 'warning'],
          severities: ['high', 'medium'],
          excludeFiles: ['node_modules'],
          excludePatterns: ['*.test.js'],
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
        aiProvider: 'openai',
        model: 'gpt-4',
        contextWindow: 4000,
        temperature: 0.1,
        maxTokens: 1000,
        timeout: 30000,
        aiEnhanced: true,
        confidenceThreshold: 0.8,
        maxAnalysisTime: 30000,
        enablePatternMatching: true,
        enableSimilaritySearch: true,
        enableRootCauseAnalysis: true,
        enableImpactPrediction: true,
        customPatterns: [],
        historicalDataRetention: 30,
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
        monitoring: {
          enabled: true,
          sampleRate: 1000,
          interval: 5000,
          thresholds: {
            cpu: 80,
            memory: 90,
            responseTime: 1000,
          },
        },
        profiling: {
          enabled: false,
          sampleRate: 100,
          maxDuration: 60000,
          includeMemory: true,
          includeCpu: true,
        },
        optimization: {
          enableCaching: true,
          cacheSize: 100,
          enableCompression: true,
          enableSuggestions: true,
          enableAutomaticOptimization: false,
          aggressiveness: 'moderate',
        },
      },
      integrations: {
        buildSystems: { npm: true, yarn: true, webpack: true },
        testRunners: { jest: true, vitest: true, mocha: true },
        linters: { eslint: true, tslint: true, prettier: true },
        versionControl: {
          git: true,
          enableCommitHooks: true,
          enableBranchAnalysis: true,
        },
        containers: {
          docker: true,
          kubernetes: false,
          enableContainerDebugging: true,
        },
        ides: {
          vscode: true,
          cursor: false,
          windsurf: false,
          augmentCode: false,
        },
      },
      security: {
        enableSecurityScanning: true,
        vulnerabilityDatabases: ['npm-audit', 'snyk'],
        enableDependencyScanning: true,
        enableCodeScanning: true,
        reportingLevel: 'medium-high' as const,
        autoFixVulnerabilities: false,
        excludePatterns: [],
      },
    };

    it('should validate correct config', () => {
      const result = validateConfig(validConfig);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should reject config with invalid server port', () => {
      const invalidConfig = {
        ...validConfig,
        server: { ...validConfig.server, port: 70000 },
      };

      const result = validateConfig(invalidConfig);

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      // Check that there's an error related to port
      const portError = result.errors.find(e => e.path === 'server.port');
      expect(portError).toBeDefined();
    });

    it('should reject config with invalid log level', () => {
      const invalidConfig = {
        ...validConfig,
        server: { ...validConfig.server, logLevel: 'invalid' as any },
      };

      const result = validateConfig(invalidConfig);

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      // Check that there's an error related to logLevel
      const logLevelError = result.errors.find(e => e.path === 'server.logLevel');
      expect(logLevelError).toBeDefined();
    });

    it('should reject config with missing required fields', () => {
      const invalidConfig = {
        server: {
          name: '',
          version: '1.0.0',
        },
      };

      const result = validateConfig(invalidConfig as any);

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('should validate nested objects correctly', () => {
      const invalidConfig = {
        ...validConfig,
        detection: {
          ...validConfig.detection,
          polling: {
            interval: 50, // Too low
            maxRetries: -1, // Invalid
          },
        },
      };

      const result = validateConfig(invalidConfig);

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      // Check for specific validation errors
      const intervalError = result.errors.find(e => e.path === 'detection.polling.interval');
      const retriesError = result.errors.find(e => e.path === 'detection.polling.maxRetries');
      expect(intervalError || retriesError).toBeDefined();
    });
  });

  describe('validateEnvironment', () => {
    it('should validate current environment', () => {
      const result = validateEnvironment();

      expect(result).toBeDefined();
      expect(result.valid).toBeDefined();
      expect(result.errors).toBeDefined();
      expect(result.warnings).toBeDefined();
    });

    it('should return validation result structure', () => {
      const result = validateEnvironment();

      expect(typeof result.valid).toBe('boolean');
      expect(Array.isArray(result.errors)).toBe(true);
      expect(Array.isArray(result.warnings)).toBe(true);
    });
  });

  describe('validateWorkspaceStructure', () => {
    it('should validate workspace structure', () => {
      const result = validateWorkspaceStructure('/test/workspace');

      expect(result).toBeDefined();
      expect(result.valid).toBeDefined();
      expect(result.errors).toBeDefined();
      expect(result.warnings).toBeDefined();
    });

    it('should handle invalid workspace paths', () => {
      const result = validateWorkspaceStructure('');

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });

  describe('validateToolConfiguration', () => {
    it('should validate tool configuration', () => {
      const result = validateToolConfiguration('eslint', {
        enabled: true,
        configFile: '.eslintrc.js',
      });

      expect(result).toBeDefined();
      expect(result.valid).toBeDefined();
      expect(result.errors).toBeDefined();
      expect(result.warnings).toBeDefined();
    });

    it('should handle empty tool configuration', () => {
      const result = validateToolConfiguration('test-tool', {});

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should handle invalid tool configuration', () => {
      const result = validateToolConfiguration('', null);

      expect(result).toBeDefined();
      expect(typeof result.valid).toBe('boolean');
    });
  });
});
