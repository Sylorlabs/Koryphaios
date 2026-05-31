/**
 * Tests for the core MCP server implementation
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { ErrorDebuggingMCPServer } from '@/server/mcp-server.js';
import type { ServerConfig } from '@/types/index.js';

describe('ErrorDebuggingMCPServer', () => {
  let server: ErrorDebuggingMCPServer;
  let config: ServerConfig;

  beforeEach(() => {
    config = {
      server: {
        name: 'test-server',
        version: '1.0.0',
        logLevel: 'error', // Reduce noise in tests
      },
      detection: {
        enabled: true,
        realTime: false, // Disable for tests
        sources: {
          console: true,
          runtime: true,
          build: false,
          test: false,
          linter: false,
          staticAnalysis: false,
        },
        filters: {
          categories: [],
          severities: [],
          excludeFiles: [],
          excludePatterns: [],
        },
        polling: {
          interval: 5000,
          maxRetries: 1,
        },
        bufferSize: 100,
        maxErrorsPerSession: 1000,
      },
      analysis: {
        enabled: false, // Disable for basic tests
        aiEnhanced: false,
        confidenceThreshold: 0.7,
        maxAnalysisTime: 5000,
        enablePatternMatching: false,
        enableSimilaritySearch: false,
        enableRootCauseAnalysis: false,
        enableImpactPrediction: false,
        customPatterns: [],
        historicalDataRetention: 1,
      },
      debugging: {
        enabled: false, // Disable for basic tests
        languages: {},
        defaultTimeout: 5000,
        maxConcurrentSessions: 1,
        enableHotReload: false,
        enableRemoteDebugging: false,
        breakpoints: {
          maxPerSession: 10,
          enableConditional: false,
          enableLogPoints: false,
        },
        variableInspection: {
          maxDepth: 3,
          maxStringLength: 100,
          enableLazyLoading: false,
        },
      },
      performance: {
        enabled: false,
        profiling: {
          enabled: false,
          sampleRate: 10,
          maxDuration: 5000,
          includeMemory: false,
          includeCpu: false,
        },
        monitoring: {
          enabled: false,
          interval: 10000,
          thresholds: {
            memory: 100 * 1024 * 1024,
            cpu: 80,
            responseTime: 1000,
          },
        },
        optimization: {
          enableSuggestions: false,
          enableAutomaticOptimization: false,
          aggressiveness: 'conservative',
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
        reportingLevel: 'high-critical',
        autoFixVulnerabilities: false,
        excludePatterns: [],
      },
    };

    server = new ErrorDebuggingMCPServer(config);
  });

  afterEach(async () => {
    if (server.isServerRunning()) {
      await server.stop();
    }
  });

  describe('constructor', () => {
    it('should create server instance with config', () => {
      expect(server).toBeDefined();
      expect(server.getConfig()).toEqual(config);
    });

    it('should not be running initially', () => {
      expect(server.isServerRunning()).toBe(false);
    });
  });

  describe('configuration', () => {
    it('should return current config', () => {
      const currentConfig = server.getConfig();
      expect(currentConfig).toEqual(config);
    });

    it('should update config', () => {
      const updates = {
        server: {
          ...config.server,
          logLevel: 'debug' as const,
        },
      };

      server.updateConfig(updates);
      const updatedConfig = server.getConfig();
      expect(updatedConfig.server.logLevel).toBe('debug');
    });
  });

  describe('event handling', () => {
    it('should emit events', () => {
      return new Promise<void>(resolve => {
        server.on('config:changed', data => {
          expect(data.section).toBe('server');
          expect(data.oldValue).toBeDefined();
          expect(data.newValue).toBeDefined();
          resolve();
        });

        // Trigger a config change event
        server.updateConfig({
          server: {
            ...config.server,
            logLevel: 'info',
          },
        });
      });
    });
  });
});
