/**
 * Configuration validation utilities
 */

import { z } from 'zod';

import type {
  ServerConfig,
  ConfigValidationResult,
  ConfigValidationError,
  ConfigValidationWarning,
} from '@/types/index.js';

// Zod schemas for validation
const ServerConfigSchema = z.object({
  server: z.object({
    name: z.string().min(1),
    version: z.string().min(1),
    port: z.number().int().min(1).max(65535).optional(),
    host: z.string().optional(),
    logLevel: z.enum(['debug', 'info', 'warn', 'error']),
    maxConnections: z.number().int().min(1).optional(),
    timeout: z.number().int().min(1000).optional(),
  }),
  detection: z.object({
    enabled: z.boolean(),
    realTime: z.boolean(),
    sources: z.object({
      console: z.boolean(),
      runtime: z.boolean(),
      build: z.boolean(),
      test: z.boolean(),
      linter: z.boolean(),
      staticAnalysis: z.boolean(),
      ide: z.boolean(),
    }),
    filters: z.object({
      categories: z.array(z.string()),
      severities: z.array(z.string()),
      excludeFiles: z.array(z.string()),
      excludePatterns: z.array(z.string()),
    }),
    polling: z.object({
      interval: z.number().int().min(100),
      maxRetries: z.number().int().min(0),
    }),
    bufferSize: z.number().int().min(1),
    maxErrorsPerSession: z.number().int().min(1),
  }),
  analysis: z.object({
    enabled: z.boolean(),
    aiEnhanced: z.boolean(),
    confidenceThreshold: z.number().min(0).max(1),
    maxAnalysisTime: z.number().int().min(1000),
    enablePatternMatching: z.boolean(),
    enableSimilaritySearch: z.boolean(),
    enableRootCauseAnalysis: z.boolean(),
    enableImpactPrediction: z.boolean(),
    customPatterns: z.array(z.string()),
    historicalDataRetention: z.number().int().min(1),
  }),
  debugging: z.object({
    enabled: z.boolean(),
    languages: z.record(z.string(), z.any()),
    defaultTimeout: z.number().int().min(1000),
    maxConcurrentSessions: z.number().int().min(1),
    enableHotReload: z.boolean(),
    enableRemoteDebugging: z.boolean(),
    breakpoints: z.object({
      maxPerSession: z.number().int().min(1),
      enableConditional: z.boolean(),
      enableLogPoints: z.boolean(),
    }),
    variableInspection: z.object({
      maxDepth: z.number().int().min(1),
      maxStringLength: z.number().int().min(1),
      enableLazyLoading: z.boolean(),
    }),
  }),
  performance: z.object({
    enabled: z.boolean(),
    profiling: z.object({
      enabled: z.boolean(),
      sampleRate: z.number().int().min(1),
      maxDuration: z.number().int().min(1000),
      includeMemory: z.boolean(),
      includeCpu: z.boolean(),
    }),
    monitoring: z.object({
      enabled: z.boolean(),
      interval: z.number().int().min(1000),
      thresholds: z.object({
        memory: z.number().int().min(1),
        cpu: z.number().min(0).max(100),
        responseTime: z.number().int().min(1),
      }),
    }),
    optimization: z.object({
      enableSuggestions: z.boolean(),
      enableAutomaticOptimization: z.boolean(),
      aggressiveness: z.enum(['conservative', 'moderate', 'aggressive']),
    }),
  }),
  integrations: z.object({
    buildSystems: z.record(z.string(), z.boolean()),
    testRunners: z.record(z.string(), z.boolean()),
    linters: z.record(z.string(), z.boolean()),
    versionControl: z.object({
      git: z.boolean(),
      enableCommitHooks: z.boolean(),
      enableBranchAnalysis: z.boolean(),
    }),
    containers: z.object({
      docker: z.boolean(),
      kubernetes: z.boolean(),
      enableContainerDebugging: z.boolean(),
    }),
    ides: z.record(z.string(), z.boolean()),
  }),
  security: z.object({
    enableSecurityScanning: z.boolean(),
    vulnerabilityDatabases: z.array(z.string()),
    enableDependencyScanning: z.boolean(),
    enableCodeScanning: z.boolean(),
    reportingLevel: z.enum(['all', 'medium-high', 'high-critical']),
    autoFixVulnerabilities: z.boolean(),
    excludePatterns: z.array(z.string()),
  }),
});

export function validateConfig(config: unknown): ConfigValidationResult {
  const errors: ConfigValidationError[] = [];
  const warnings: ConfigValidationWarning[] = [];

  try {
    // Basic schema validation with partial support
    const result = ServerConfigSchema.safeParse(config);
    if (!result.success) {
      // Convert Zod errors to our format
      result.error.errors.forEach(error => {
        errors.push({
          path: error.path.join('.'),
          message: error.message,
          value: error.code,
        });
      });

      return {
        valid: false,
        errors,
        warnings,
      };
    }

    // Additional custom validations
    const typedConfig = config as ServerConfig;

    // Validate performance thresholds
    if (typedConfig.performance.monitoring.thresholds.memory < 64 * 1024 * 1024) {
      warnings.push({
        path: 'performance.monitoring.thresholds.memory',
        message: 'Memory threshold is very low (< 64MB), this may cause frequent alerts',
        suggestion: 'Consider setting a higher threshold (e.g., 128MB or more)',
      });
    }

    // Validate polling interval
    if (typedConfig.detection.polling.interval < 500) {
      warnings.push({
        path: 'detection.polling.interval',
        message: 'Polling interval is very low (< 500ms), this may impact performance',
        suggestion: 'Consider using a higher interval (e.g., 1000ms or more)',
      });
    }

    // Validate confidence threshold
    if (typedConfig.analysis.confidenceThreshold < 0.5) {
      warnings.push({
        path: 'analysis.confidenceThreshold',
        message: 'Confidence threshold is low (< 0.5), this may result in many false positives',
        suggestion: 'Consider using a higher threshold (e.g., 0.7 or more)',
      });
    }

    // Validate max concurrent sessions
    if (typedConfig.debugging.maxConcurrentSessions > 10) {
      warnings.push({
        path: 'debugging.maxConcurrentSessions',
        message: 'High number of concurrent debug sessions may impact performance',
        suggestion: 'Consider limiting to 5-10 sessions for optimal performance',
      });
    }

    // Validate buffer size
    if (typedConfig.detection.bufferSize > 10000) {
      warnings.push({
        path: 'detection.bufferSize',
        message: 'Large buffer size may consume significant memory',
        suggestion: 'Consider using a smaller buffer size (e.g., 1000-5000)',
      });
    }

    return {
      valid: true,
      errors,
      warnings,
    };
  } catch (error) {
    if (error instanceof z.ZodError) {
      for (const issue of error.issues) {
        errors.push({
          path: issue.path.join('.'),
          message: issue.message,
          value: issue.code === 'invalid_type' ? issue.received : undefined,
        });
      }
    } else {
      errors.push({
        path: 'root',
        message: error instanceof Error ? error.message : 'Unknown validation error',
      });
    }

    return {
      valid: false,
      errors,
      warnings,
    };
  }
}

export function validateEnvironment(): ConfigValidationResult {
  const errors: ConfigValidationError[] = [];
  const warnings: ConfigValidationWarning[] = [];

  // Check Node.js version
  const nodeVersion = process.version;
  const majorVersion = parseInt(nodeVersion.slice(1).split('.')[0] || '0', 10);

  if (majorVersion < 18) {
    errors.push({
      path: 'environment.node',
      message: `Node.js version ${nodeVersion} is not supported. Minimum required version is 18.0.0`,
    });
  }

  // Check available memory
  const totalMemory = process.memoryUsage().heapTotal;
  if (totalMemory < 128 * 1024 * 1024) {
    // 128MB
    warnings.push({
      path: 'environment.memory',
      message: 'Available memory is low, this may impact performance',
      suggestion: 'Consider increasing available memory or reducing buffer sizes',
    });
  }

  // Check platform-specific requirements
  const platform = process.platform;
  if (platform === 'win32') {
    warnings.push({
      path: 'environment.platform',
      message: 'Windows platform detected, some features may have limited support',
      suggestion: 'Consider using WSL for better compatibility',
    });
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

export function validateWorkspaceStructure(workspaceRoot: string): ConfigValidationResult {
  const errors: ConfigValidationError[] = [];
  const warnings: ConfigValidationWarning[] = [];

  // Validate workspace root path
  if (!workspaceRoot || workspaceRoot.trim() === '') {
    errors.push({
      path: 'workspace.root',
      message: 'Workspace root path cannot be empty',
    });

    return {
      valid: false,
      errors,
      warnings,
    };
  }

  // This would typically check for:
  // - Required files and directories
  // - Package manager files (package.json, requirements.txt, etc.)
  // - Configuration files
  // - Source code structure

  try {
    // In a real implementation, we would use fs.access or similar
    // to check if the workspace root exists and is accessible

    // For now, just validate the path format
    if (!workspaceRoot.startsWith('/') && !workspaceRoot.match(/^[A-Za-z]:/)) {
      warnings.push({
        path: 'workspace.root',
        message: 'Workspace root should be an absolute path',
        suggestion: 'Use an absolute path for better reliability',
      });
    }

    return {
      valid: true,
      errors,
      warnings,
    };
  } catch (error) {
    errors.push({
      path: 'workspace.root',
      message: `Workspace root is not accessible: ${error instanceof Error ? error.message : 'Unknown error'}`,
    });

    return {
      valid: false,
      errors,
      warnings,
    };
  }
}

export function validateToolConfiguration(
  _toolName: string,
  _config: unknown
): ConfigValidationResult {
  const errors: ConfigValidationError[] = [];
  const warnings: ConfigValidationWarning[] = [];

  // Tool-specific validation would go here
  // For example, validating debugger paths, linter configurations, etc.

  return {
    valid: true,
    errors,
    warnings,
  };
}

/**
 * Validate language-specific configuration
 */
export function validateLanguageConfig(language: string, config: unknown): ConfigValidationResult {
  const errors: ConfigValidationError[] = [];
  const warnings: ConfigValidationWarning[] = [];

  if (!language || typeof language !== 'string') {
    errors.push({
      path: 'language',
      message: 'Language must be a non-empty string',
    });
    return { valid: false, errors, warnings };
  }

  const supportedLanguages = ['javascript', 'typescript', 'python', 'go', 'rust', 'java', 'csharp'];
  if (!supportedLanguages.includes(language.toLowerCase())) {
    warnings.push({
      path: 'language',
      message: `Language '${language}' may not be fully supported`,
      suggestion: `Consider using one of: ${supportedLanguages.join(', ')}`,
    });
  }

  // Validate config structure if provided
  if (config && typeof config === 'object') {
    const langConfig = config as Record<string, unknown>;

    // Check for common configuration properties
    if ('debuggerPath' in langConfig && typeof langConfig['debuggerPath'] !== 'string') {
      errors.push({
        path: 'debuggerPath',
        message: 'Debugger path must be a string',
      });
    }

    if ('linterPath' in langConfig && typeof langConfig['linterPath'] !== 'string') {
      errors.push({
        path: 'linterPath',
        message: 'Linter path must be a string',
      });
    }

    if ('compilerPath' in langConfig && typeof langConfig['compilerPath'] !== 'string') {
      errors.push({
        path: 'compilerPath',
        message: 'Compiler path must be a string',
      });
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Validate detector configuration
 */
export function validateDetectorConfig(
  detectorType: string,
  config: unknown
): ConfigValidationResult {
  const errors: ConfigValidationError[] = [];
  const warnings: ConfigValidationWarning[] = [];

  if (!detectorType || typeof detectorType !== 'string') {
    errors.push({
      path: 'detectorType',
      message: 'Detector type must be a non-empty string',
    });
    return { valid: false, errors, warnings };
  }

  const supportedDetectors = [
    'build',
    'linter',
    'runtime',
    'console',
    'test',
    'static-analysis',
    'ide',
  ];
  if (!supportedDetectors.includes(detectorType.toLowerCase())) {
    errors.push({
      path: 'detectorType',
      message: `Unsupported detector type: ${detectorType}`,
      value: detectorType,
    });
  }

  // Validate config structure if provided
  if (config && typeof config === 'object') {
    const detectorConfig = config as Record<string, unknown>;

    if ('enabled' in detectorConfig && typeof detectorConfig['enabled'] !== 'boolean') {
      errors.push({
        path: 'enabled',
        message: 'Enabled flag must be a boolean',
      });
    }

    if ('interval' in detectorConfig) {
      const interval = detectorConfig['interval'];
      if (typeof interval !== 'number' || interval < 100) {
        errors.push({
          path: 'interval',
          message: 'Interval must be a number >= 100ms',
        });
      }
    }

    if ('maxRetries' in detectorConfig) {
      const maxRetries = detectorConfig['maxRetries'];
      if (typeof maxRetries !== 'number' || maxRetries < 0) {
        errors.push({
          path: 'maxRetries',
          message: 'Max retries must be a non-negative number',
        });
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Validate debug configuration
 */
export function validateDebugConfig(config: unknown): ConfigValidationResult {
  const errors: ConfigValidationError[] = [];
  const warnings: ConfigValidationWarning[] = [];

  if (!config || typeof config !== 'object') {
    errors.push({
      path: 'config',
      message: 'Debug config must be an object',
    });
    return { valid: false, errors, warnings };
  }

  const debugConfig = config as Record<string, unknown>;

  // Validate required properties
  if (!('type' in debugConfig) || typeof debugConfig['type'] !== 'string') {
    errors.push({
      path: 'type',
      message: 'Debug config must have a type property (string)',
    });
  }

  if (!('program' in debugConfig) || typeof debugConfig['program'] !== 'string') {
    errors.push({
      path: 'program',
      message: 'Debug config must have a program property (string)',
    });
  }

  // Validate optional properties
  if ('port' in debugConfig) {
    const port = debugConfig['port'];
    if (typeof port !== 'number' || port < 1 || port > 65535) {
      errors.push({
        path: 'port',
        message: 'Port must be a number between 1 and 65535',
      });
    }
  }

  if ('timeout' in debugConfig) {
    const timeout = debugConfig['timeout'];
    if (typeof timeout !== 'number' || timeout < 1000) {
      errors.push({
        path: 'timeout',
        message: 'Timeout must be a number >= 1000ms',
      });
    }
  }

  if ('env' in debugConfig && debugConfig['env'] !== null) {
    if (typeof debugConfig['env'] !== 'object') {
      errors.push({
        path: 'env',
        message: 'Environment variables must be an object or null',
      });
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Validate MCP configuration
 */
export function validateMCPConfig(config: unknown): ConfigValidationResult {
  const errors: ConfigValidationError[] = [];
  const warnings: ConfigValidationWarning[] = [];

  if (!config || typeof config !== 'object') {
    errors.push({
      path: 'config',
      message: 'MCP config must be an object',
    });
    return { valid: false, errors, warnings };
  }

  const mcpConfig = config as Record<string, unknown>;

  // Validate server capabilities
  if ('capabilities' in mcpConfig) {
    const capabilities = mcpConfig['capabilities'];
    if (typeof capabilities !== 'object' || capabilities === null) {
      errors.push({
        path: 'capabilities',
        message: 'Capabilities must be an object',
      });
    } else {
      const caps = capabilities as Record<string, unknown>;

      // Check for valid capability structure
      const validCapabilities = ['logging', 'prompts', 'resources', 'tools'];
      for (const [key, value] of Object.entries(caps)) {
        if (!validCapabilities.includes(key)) {
          warnings.push({
            path: `capabilities.${key}`,
            message: `Unknown capability: ${key}`,
            suggestion: `Valid capabilities are: ${validCapabilities.join(', ')}`,
          });
        }

        if (typeof value !== 'object' || value === null) {
          errors.push({
            path: `capabilities.${key}`,
            message: `Capability ${key} must be an object`,
          });
        }
      }
    }
  }

  // Validate transport configuration
  if ('transport' in mcpConfig) {
    const transport = mcpConfig['transport'];
    if (typeof transport !== 'object' || transport === null) {
      errors.push({
        path: 'transport',
        message: 'Transport must be an object',
      });
    } else {
      const transportConfig = transport as Record<string, unknown>;

      if ('type' in transportConfig) {
        const type = transportConfig['type'];
        if (typeof type !== 'string') {
          errors.push({
            path: 'transport.type',
            message: 'Transport type must be a string',
          });
        } else {
          const validTypes = ['stdio', 'websocket', 'http'];
          if (!validTypes.includes(type)) {
            errors.push({
              path: 'transport.type',
              message: `Invalid transport type: ${type}`,
              value: type,
            });
          }
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}
