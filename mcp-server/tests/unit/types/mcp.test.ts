/**
 * Tests for MCP (Model Context Protocol) type definitions
 */

import { describe, it, expect } from 'vitest';
import {
  MCPTool,
  MCPResource,
  MCPPrompt,
  MCPPromptArgument,
  MCPToolCall,
  MCPToolResult,
  MCPContent,
  MCPServerCapabilities,
  MCPClientCapabilities,
  MCPInitializeParams,
  MCPInitializeResult,
  DetectErrorsParams,
  AnalyzeErrorParams,
  SuggestFixesParams,
  SetBreakpointParams,
  InspectVariablesParams,
  ProfilePerformanceParams,
  TrackMemoryParams,
  ConfigureDebuggerParams,
  GetErrorHistoryParams,
  ExportDiagnosticsParams,
  MCP_RESOURCE_URIS,
  MCP_PROMPTS,
} from '../../../src/types/mcp.js';

describe('MCP Types', () => {
  describe('Core MCP Types', () => {
    it('should define MCPTool interface correctly', () => {
      const tool: MCPTool = {
        name: 'detect-errors',
        description: 'Detect errors in code',
        inputSchema: {
          type: 'object',
          properties: {
            source: { type: 'string' },
            language: { type: 'string' },
          },
          required: ['source'],
        },
      };

      expect(tool.name).toBe('detect-errors');
      expect(tool.description).toBe('Detect errors in code');
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.inputSchema.required).toEqual(['source']);
    });

    it('should define MCPResource interface correctly', () => {
      const resource: MCPResource = {
        uri: 'error-debugging://logs/errors',
        name: 'Error Log',
        description: 'Current error log',
        mimeType: 'application/json',
      };

      expect(resource.uri).toBe('error-debugging://logs/errors');
      expect(resource.name).toBe('Error Log');
      expect(resource.description).toBe('Current error log');
      expect(resource.mimeType).toBe('application/json');
    });

    it('should define MCPPrompt interface correctly', () => {
      const prompt: MCPPrompt = {
        name: 'explain-error',
        description: 'Explain an error and suggest fixes',
        arguments: [
          {
            name: 'errorId',
            description: 'The ID of the error to explain',
            required: true,
          },
          {
            name: 'includeContext',
            description: 'Whether to include context',
            required: false,
          },
        ],
      };

      expect(prompt.name).toBe('explain-error');
      expect(prompt.description).toBe('Explain an error and suggest fixes');
      expect(prompt.arguments).toHaveLength(2);
      expect(prompt.arguments![0].required).toBe(true);
      expect(prompt.arguments![1].required).toBe(false);
    });

    it('should define MCPToolCall interface correctly', () => {
      const toolCall: MCPToolCall = {
        name: 'detect-errors',
        arguments: {
          source: 'console',
          language: 'javascript',
          includeWarnings: true,
        },
      };

      expect(toolCall.name).toBe('detect-errors');
      expect(toolCall.arguments.source).toBe('console');
      expect(toolCall.arguments.language).toBe('javascript');
      expect(toolCall.arguments.includeWarnings).toBe(true);
    });

    it('should define MCPToolResult interface correctly', () => {
      const result: MCPToolResult = {
        content: [
          {
            type: 'text',
            text: 'Found 3 errors in the code',
          },
          {
            type: 'resource',
            data: 'base64encodeddata',
            mimeType: 'application/json',
          },
        ],
        isError: false,
      };

      expect(result.content).toHaveLength(2);
      expect(result.content[0].type).toBe('text');
      expect(result.content[1].type).toBe('resource');
      expect(result.isError).toBe(false);
    });
  });

  describe('Capability Types', () => {
    it('should define MCPServerCapabilities correctly', () => {
      const capabilities: MCPServerCapabilities = {
        logging: {},
        prompts: {
          listChanged: true,
        },
        resources: {
          subscribe: true,
          listChanged: true,
        },
        tools: {
          listChanged: true,
        },
      };

      expect(capabilities.prompts?.listChanged).toBe(true);
      expect(capabilities.resources?.subscribe).toBe(true);
      expect(capabilities.tools?.listChanged).toBe(true);
    });

    it('should define MCPClientCapabilities correctly', () => {
      const capabilities: MCPClientCapabilities = {
        experimental: {
          customFeature: true,
        },
        sampling: {
          maxTokens: 1000,
        },
      };

      expect(capabilities.experimental?.customFeature).toBe(true);
      expect(capabilities.sampling?.maxTokens).toBe(1000);
    });

    it('should define initialization types correctly', () => {
      const initParams: MCPInitializeParams = {
        protocolVersion: '2024-11-05',
        capabilities: {
          experimental: {},
          sampling: {},
        },
        clientInfo: {
          name: 'Test Client',
          version: '1.0.0',
        },
      };

      const initResult: MCPInitializeResult = {
        protocolVersion: '2024-11-05',
        capabilities: {
          tools: { listChanged: true },
          resources: { subscribe: true },
        },
        serverInfo: {
          name: 'Error Debugging MCP Server',
          version: '1.0.0',
        },
      };

      expect(initParams.protocolVersion).toBe('2024-11-05');
      expect(initParams.clientInfo.name).toBe('Test Client');
      expect(initResult.serverInfo.name).toBe('Error Debugging MCP Server');
    });
  });

  describe('Error Debugging Specific Types', () => {
    it('should define DetectErrorsParams correctly', () => {
      const params: DetectErrorsParams = {
        source: 'console',
        language: 'javascript',
        files: ['src/index.js', 'src/utils.js'],
        includeWarnings: true,
        realTime: false,
      };

      expect(params.source).toBe('console');
      expect(params.language).toBe('javascript');
      expect(params.files).toEqual(['src/index.js', 'src/utils.js']);
      expect(params.includeWarnings).toBe(true);
      expect(params.realTime).toBe(false);
    });

    it('should define AnalyzeErrorParams correctly', () => {
      const params: AnalyzeErrorParams = {
        errorId: 'error-123',
        includeContext: true,
        includeSuggestions: true,
        includeHistory: false,
      };

      expect(params.errorId).toBe('error-123');
      expect(params.includeContext).toBe(true);
      expect(params.includeSuggestions).toBe(true);
      expect(params.includeHistory).toBe(false);
    });

    it('should define SuggestFixesParams correctly', () => {
      const params: SuggestFixesParams = {
        errorId: 'error-123',
        maxSuggestions: 5,
        confidenceThreshold: 0.8,
        includeRiskyFixes: false,
      };

      expect(params.errorId).toBe('error-123');
      expect(params.maxSuggestions).toBe(5);
      expect(params.confidenceThreshold).toBe(0.8);
      expect(params.includeRiskyFixes).toBe(false);
    });

    it('should define debugging parameter types correctly', () => {
      const breakpointParams: SetBreakpointParams = {
        file: 'src/index.js',
        line: 42,
        condition: 'x > 10',
        logMessage: 'Value of x: {x}',
        temporary: true,
      };

      const inspectParams: InspectVariablesParams = {
        sessionId: 'debug-session-1',
        scope: 'local',
        frameId: 0,
        expression: 'myVariable',
      };

      expect(breakpointParams.file).toBe('src/index.js');
      expect(breakpointParams.line).toBe(42);
      expect(inspectParams.sessionId).toBe('debug-session-1');
      expect(inspectParams.scope).toBe('local');
    });

    it('should define performance parameter types correctly', () => {
      const profileParams: ProfilePerformanceParams = {
        duration: 30000,
        sampleRate: 100,
        includeMemory: true,
        includeCpu: true,
        filters: ['src/**/*.js'],
      };

      const memoryParams: TrackMemoryParams = {
        duration: 60000,
        threshold: 100 * 1024 * 1024, // 100MB
        detectLeaks: true,
        includeHeapSnapshot: false,
      };

      expect(profileParams.duration).toBe(30000);
      expect(profileParams.includeMemory).toBe(true);
      expect(memoryParams.threshold).toBe(100 * 1024 * 1024);
      expect(memoryParams.detectLeaks).toBe(true);
    });

    it('should define configuration parameter types correctly', () => {
      const debuggerParams: ConfigureDebuggerParams = {
        language: 'javascript',
        configuration: {
          type: 'node',
          program: 'src/index.js',
          args: ['--debug'],
        },
        workspaceRoot: '/path/to/workspace',
      };

      expect(debuggerParams.language).toBe('javascript');
      expect(debuggerParams.configuration.type).toBe('node');
      expect(debuggerParams.workspaceRoot).toBe('/path/to/workspace');
    });

    it('should define history and export parameter types correctly', () => {
      const historyParams: GetErrorHistoryParams = {
        timeRange: {
          start: '2024-01-01T00:00:00Z',
          end: '2024-01-31T23:59:59Z',
        },
        categories: ['syntax', 'runtime'],
        severities: ['error', 'warning'],
        limit: 100,
        offset: 0,
      };

      const exportParams: ExportDiagnosticsParams = {
        format: 'json',
        includeStackTraces: true,
        includeContext: true,
        timeRange: {
          start: '2024-01-01T00:00:00Z',
          end: '2024-01-31T23:59:59Z',
        },
      };

      expect(historyParams.timeRange?.start).toBe('2024-01-01T00:00:00Z');
      expect(historyParams.categories).toEqual(['syntax', 'runtime']);
      expect(exportParams.format).toBe('json');
      expect(exportParams.includeStackTraces).toBe(true);
    });
  });

  describe('Constants', () => {
    it('should define MCP_RESOURCE_URIS correctly', () => {
      expect(MCP_RESOURCE_URIS.ERROR_LOG).toBe('error-debugging://logs/errors');
      expect(MCP_RESOURCE_URIS.PERFORMANCE_METRICS).toBe('error-debugging://metrics/performance');
      expect(MCP_RESOURCE_URIS.MEMORY_USAGE).toBe('error-debugging://metrics/memory');
      expect(MCP_RESOURCE_URIS.DEBUG_SESSIONS).toBe('error-debugging://sessions/debug');
      expect(MCP_RESOURCE_URIS.CONFIGURATION).toBe('error-debugging://config/settings');
      expect(MCP_RESOURCE_URIS.ERROR_PATTERNS).toBe('error-debugging://patterns/errors');
      expect(MCP_RESOURCE_URIS.FIX_SUGGESTIONS).toBe('error-debugging://suggestions/fixes');
      expect(MCP_RESOURCE_URIS.BREAKPOINTS).toBe('error-debugging://debug/breakpoints');
      expect(MCP_RESOURCE_URIS.CALL_STACK).toBe('error-debugging://debug/callstack');
      expect(MCP_RESOURCE_URIS.VARIABLES).toBe('error-debugging://debug/variables');
    });

    it('should define MCP_PROMPTS correctly', () => {
      expect(MCP_PROMPTS.EXPLAIN_ERROR).toBe('explain-error');
      expect(MCP_PROMPTS.SUGGEST_FIX).toBe('suggest-fix');
      expect(MCP_PROMPTS.ANALYZE_PERFORMANCE).toBe('analyze-performance');
      expect(MCP_PROMPTS.DEBUG_GUIDANCE).toBe('debug-guidance');
      expect(MCP_PROMPTS.CODE_REVIEW).toBe('code-review');
      expect(MCP_PROMPTS.ERROR_PREVENTION).toBe('error-prevention');
    });

    it('should have immutable constants', () => {
      // Test that constants are readonly
      expect(() => {
        // @ts-expect-error - Testing immutability
        MCP_RESOURCE_URIS.ERROR_LOG = 'modified';
      }).toThrow();

      expect(() => {
        // @ts-expect-error - Testing immutability
        MCP_PROMPTS.EXPLAIN_ERROR = 'modified';
      }).toThrow();
    });
  });

  describe('Type Validation', () => {
    it('should validate MCPContent types', () => {
      const textContent: MCPContent = {
        type: 'text',
        text: 'Hello world',
      };

      const imageContent: MCPContent = {
        type: 'image',
        data: 'base64imagedata',
        mimeType: 'image/png',
      };

      const resourceContent: MCPContent = {
        type: 'resource',
        data: 'resourcedata',
        mimeType: 'application/json',
      };

      expect(textContent.type).toBe('text');
      expect(textContent.text).toBe('Hello world');
      expect(imageContent.type).toBe('image');
      expect(imageContent.mimeType).toBe('image/png');
      expect(resourceContent.type).toBe('resource');
      expect(resourceContent.mimeType).toBe('application/json');
    });

    it('should validate optional properties', () => {
      // Test minimal required properties
      const minimalTool: MCPTool = {
        name: 'test-tool',
        description: 'Test tool',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      };

      const minimalResource: MCPResource = {
        uri: 'test://resource',
        name: 'Test Resource',
      };

      const minimalPrompt: MCPPrompt = {
        name: 'test-prompt',
        description: 'Test prompt',
      };

      expect(minimalTool.name).toBe('test-tool');
      expect(minimalResource.uri).toBe('test://resource');
      expect(minimalPrompt.name).toBe('test-prompt');
      expect(minimalPrompt.arguments).toBeUndefined();
    });
  });
});
