/**
 * Resource manager for handling MCP resources
 */

import type { MCPResource, MCPContent } from '@/types/index.js';

export class ResourceManager {
  private resources: Map<string, MCPResource> = new Map();
  private resourceProviders: Map<string, ResourceProvider> = new Map();

  constructor() {
    this.registerCoreResources();
  }

  registerResource(resource: MCPResource, provider?: ResourceProvider): void {
    this.resources.set(resource.uri, resource);

    if (provider) {
      this.resourceProviders.set(resource.uri, provider);
    } else {
      // Register default provider based on URI
      this.resourceProviders.set(resource.uri, this.createDefaultProvider(resource.uri));
    }
  }

  unregisterResource(uri: string): void {
    this.resources.delete(uri);
    this.resourceProviders.delete(uri);
  }

  listResources(): MCPResource[] {
    return Array.from(this.resources.values());
  }

  getResource(uri: string): MCPResource | undefined {
    return this.resources.get(uri);
  }

  async readResource(uri: string): Promise<MCPContent> {
    const provider = this.resourceProviders.get(uri);
    if (!provider) {
      throw new Error(`No provider registered for resource: ${uri}`);
    }

    return await provider.read();
  }

  private registerCoreResources(): void {
    // Error logs resource
    this.registerResource({
      uri: 'error-debugging://logs/errors',
      name: 'Error Logs',
      description: 'Real-time error logs and history',
      mimeType: 'application/json',
    });

    // Performance metrics resource
    this.registerResource({
      uri: 'error-debugging://metrics/performance',
      name: 'Performance Metrics',
      description: 'Performance profiling data and metrics',
      mimeType: 'application/json',
    });

    // Memory usage resource
    this.registerResource({
      uri: 'error-debugging://metrics/memory',
      name: 'Memory Usage',
      description: 'Memory usage statistics and leak detection',
      mimeType: 'application/json',
    });

    // Debug sessions resource
    this.registerResource({
      uri: 'error-debugging://sessions/debug',
      name: 'Debug Sessions',
      description: 'Active and historical debug sessions',
      mimeType: 'application/json',
    });

    // Configuration resource
    this.registerResource({
      uri: 'error-debugging://config/settings',
      name: 'Configuration',
      description: 'Server configuration and settings',
      mimeType: 'application/json',
    });

    // Error patterns resource
    this.registerResource({
      uri: 'error-debugging://patterns/errors',
      name: 'Error Patterns',
      description: 'Known error patterns and signatures',
      mimeType: 'application/json',
    });

    // Fix suggestions resource
    this.registerResource({
      uri: 'error-debugging://suggestions/fixes',
      name: 'Fix Suggestions',
      description: 'AI-generated fix suggestions for errors',
      mimeType: 'application/json',
    });

    // Breakpoints resource
    this.registerResource({
      uri: 'error-debugging://debug/breakpoints',
      name: 'Breakpoints',
      description: 'Active breakpoints and their status',
      mimeType: 'application/json',
    });

    // Call stack resource
    this.registerResource({
      uri: 'error-debugging://debug/callstack',
      name: 'Call Stack',
      description: 'Current call stack information',
      mimeType: 'application/json',
    });

    // Variables resource
    this.registerResource({
      uri: 'error-debugging://debug/variables',
      name: 'Variables',
      description: 'Variable values and watch expressions',
      mimeType: 'application/json',
    });
  }

  private createDefaultProvider(uri: string): ResourceProvider {
    return {
      read: async (): Promise<MCPContent> => {
        switch (uri) {
          case 'error-debugging://logs/errors':
            return this.getErrorLogs();

          case 'error-debugging://metrics/performance':
            return this.getPerformanceMetrics();

          case 'error-debugging://metrics/memory':
            return this.getMemoryMetrics();

          case 'error-debugging://sessions/debug':
            return this.getDebugSessions();

          case 'error-debugging://config/settings':
            return this.getConfiguration();

          case 'error-debugging://patterns/errors':
            return this.getErrorPatterns();

          case 'error-debugging://suggestions/fixes':
            return this.getFixSuggestions();

          case 'error-debugging://debug/breakpoints':
            return this.getBreakpoints();

          case 'error-debugging://debug/callstack':
            return this.getCallStack();

          case 'error-debugging://debug/variables':
            return this.getVariables();

          default:
            throw new Error(`Unknown resource URI: ${uri}`);
        }
      },
    };
  }

  private async getErrorLogs(): Promise<MCPContent> {
    // TODO: Implement actual error log retrieval
    const mockLogs = {
      errors: [
        {
          id: 'error-001',
          timestamp: new Date().toISOString(),
          message: 'TypeError: Cannot read property "length" of undefined',
          severity: 'high',
          category: 'runtime',
          file: 'src/utils/helper.ts',
          line: 42,
        },
      ],
      total: 1,
      lastUpdated: new Date().toISOString(),
    };

    return {
      type: 'text',
      text: JSON.stringify(mockLogs, null, 2),
    };
  }

  private async getPerformanceMetrics(): Promise<MCPContent> {
    // TODO: Implement actual performance metrics retrieval
    const mockMetrics = {
      cpu: {
        usage: 45.2,
        cores: 8,
        loadAverage: [1.2, 1.5, 1.8],
      },
      memory: {
        used: 512 * 1024 * 1024,
        total: 8 * 1024 * 1024 * 1024,
        percentage: 6.25,
      },
      responseTime: {
        average: 120,
        p95: 250,
        p99: 500,
      },
      lastUpdated: new Date().toISOString(),
    };

    return {
      type: 'text',
      text: JSON.stringify(mockMetrics, null, 2),
    };
  }

  private async getMemoryMetrics(): Promise<MCPContent> {
    // TODO: Implement actual memory metrics retrieval
    const mockMemory = {
      heap: {
        used: 45 * 1024 * 1024,
        total: 128 * 1024 * 1024,
        limit: 512 * 1024 * 1024,
      },
      gc: {
        collections: 15,
        totalTime: 250,
        averageTime: 16.7,
      },
      leaks: [],
      lastUpdated: new Date().toISOString(),
    };

    return {
      type: 'text',
      text: JSON.stringify(mockMemory, null, 2),
    };
  }

  private async getDebugSessions(): Promise<MCPContent> {
    // TODO: Implement actual debug sessions retrieval
    const mockSessions = {
      active: [],
      recent: [
        {
          id: 'session-001',
          language: 'typescript',
          status: 'stopped',
          startTime: new Date(Date.now() - 3600000).toISOString(),
          endTime: new Date().toISOString(),
        },
      ],
      total: 1,
    };

    return {
      type: 'text',
      text: JSON.stringify(mockSessions, null, 2),
    };
  }

  private async getConfiguration(): Promise<MCPContent> {
    // TODO: Implement actual configuration retrieval
    const mockConfig = {
      server: {
        name: 'error-debugging-mcp-server',
        version: '1.0.0',
        logLevel: 'info',
      },
      detection: {
        enabled: true,
        realTime: true,
        sources: {
          console: true,
          runtime: true,
          build: true,
          test: true,
        },
      },
      lastUpdated: new Date().toISOString(),
    };

    return {
      type: 'text',
      text: JSON.stringify(mockConfig, null, 2),
    };
  }

  private async getErrorPatterns(): Promise<MCPContent> {
    // TODO: Implement actual error patterns retrieval
    const mockPatterns = {
      patterns: [
        {
          id: 'pattern-001',
          name: 'Undefined Property Access',
          regex: /Cannot read property .* of undefined/,
          category: 'runtime',
          severity: 'high',
          commonCauses: ['Null/undefined variables', 'Missing null checks'],
          suggestedFixes: ['Add optional chaining', 'Add null checks'],
        },
      ],
      total: 1,
    };

    return {
      type: 'text',
      text: JSON.stringify(mockPatterns, null, 2),
    };
  }

  private async getFixSuggestions(): Promise<MCPContent> {
    // TODO: Implement actual fix suggestions retrieval
    const mockSuggestions = {
      suggestions: [
        {
          id: 'fix-001',
          errorId: 'error-001',
          description: 'Add optional chaining to safely access property',
          confidence: 0.95,
          type: 'code-change',
        },
      ],
      total: 1,
    };

    return {
      type: 'text',
      text: JSON.stringify(mockSuggestions, null, 2),
    };
  }

  private async getBreakpoints(): Promise<MCPContent> {
    // TODO: Implement actual breakpoints retrieval
    const mockBreakpoints = {
      breakpoints: [],
      total: 0,
    };

    return {
      type: 'text',
      text: JSON.stringify(mockBreakpoints, null, 2),
    };
  }

  private async getCallStack(): Promise<MCPContent> {
    // TODO: Implement actual call stack retrieval
    const mockCallStack = {
      frames: [],
      total: 0,
    };

    return {
      type: 'text',
      text: JSON.stringify(mockCallStack, null, 2),
    };
  }

  private async getVariables(): Promise<MCPContent> {
    // TODO: Implement actual variables retrieval
    const mockVariables = {
      scopes: [],
      total: 0,
    };

    return {
      type: 'text',
      text: JSON.stringify(mockVariables, null, 2),
    };
  }
}

interface ResourceProvider {
  read(): Promise<MCPContent>;
}
