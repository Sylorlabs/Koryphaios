/**
 * Provider SDK Generator
 *
 * Generates provider plugin code from OpenAPI specs or templates.
 * Automates the creation of new provider integrations.
 */

import type { ProviderName } from '@koryphaios/shared';
import { routingLog } from '../../logger';

// ─── Generator Configuration ────────────────────────────────────────────────

export interface GeneratorConfig {
  /** Output directory for generated code */
  outputDir: string;

  /** Whether to generate tests */
  includeTests: boolean;

  /** Whether to generate documentation */
  includeDocs: boolean;

  /** Template to use */
  template: 'openai-compatible' | 'custom';
}

// ─── Provider Definition ────────────────────────────────────────────────────

export interface ProviderDefinition {
  name: ProviderName;
  displayName: string;
  description?: string;

  // API Configuration
  baseUrl: string;
  apiVersion?: string;

  // Authentication
  auth: {
    type: 'api_key' | 'oauth' | 'bearer';
    headerName?: string;
    envVarName: string;
  };

  // Capabilities
  capabilities: {
    supportsStreaming: boolean;
    supportsDiscovery: boolean;
    supportsTools: boolean;
    supportsVision: boolean;
    supportsReasoning: boolean;
  };

  // Endpoints (if custom)
  endpoints?: {
    chat?: string;
    models?: string;
    completions?: string;
  };

  // Known models (if no discovery)
  models?: Array<{
    id: string;
    name: string;
    contextWindow: number;
    costPerMInput?: number;
    costPerMOutput?: number;
  }>;
}

// ─── Generated Code Templates ───────────────────────────────────────────────

const OPENAI_COMPATIBLE_TEMPLATE = `
/**
 * <%= displayName %> Provider Plugin
 * 
 * Auto-generated from <%= source %>
 */

import { OpenAICompatiblePlugin } from "../openai-compatible";
import type { ProviderConfig } from "@koryphaios/shared";

export const <%= name %>Config = {
  name: "<%= name %>" as const,
  displayName: "<%= displayName %>",
  description: "<%= description %>",
  defaultBaseUrl: "<%= baseUrl %>",
  requiredEnvVars: ["<%= auth.envVarName %>"],
};

export class <%= className %>Provider extends OpenAICompatiblePlugin {
  constructor(config: ProviderConfig) {
    super("<%= name %>" as ProviderName, {
      ...config,
      baseUrl: config.baseUrl ?? "<%= baseUrl %>",
    }, {
      supportsDiscovery: <%= capabilities.supportsDiscovery %>,
      supportsStreaming: <%= capabilities.supportsStreaming %>,
      authMethods: ["<%= auth.type %>"],
    });
  }
}

// Register factory
import { registerPluginFactory } from "../registry";

registerPluginFactory({
  name: "<%= name %>" as ProviderName,
  displayName: "<%= displayName %>",
  description: "<%= description %>",
  defaultBaseUrl: "<%= baseUrl %>",
  requiredEnvVars: ["<%= auth.envVarName %>"],
  
  validateConfig(config) {
    const errors: string[] = [];
    if (!config.apiKey) {
      errors.push("API key required");
    }
    return { valid: errors.length === 0, errors: errors.length > 0 ? errors : undefined };
  },
  
  create(config) {
    return new <%= className %>Provider(config);
  },
});
`;

// ─── SDK Generator ──────────────────────────────────────────────────────────

export class ProviderSDKGenerator {
  private config: GeneratorConfig;

  constructor(config: Partial<GeneratorConfig> = {}) {
    this.config = {
      outputDir: './src/providers/generated',
      includeTests: true,
      includeDocs: true,
      template: 'openai-compatible',
      ...config,
    };
  }

  /**
   * Generate provider plugin from definition
   */
  async generateProvider(def: ProviderDefinition): Promise<{
    files: Array<{ path: string; content: string }>;
    instructions: string[];
  }> {
    const files: Array<{ path: string; content: string }> = [];
    const instructions: string[] = [];

    // Generate main plugin file
    const mainFile = this.generateMainFile(def);
    files.push({
      path: `${this.config.outputDir}/${def.name}.ts`,
      content: mainFile,
    });

    // Generate test file if requested
    if (this.config.includeTests) {
      const testFile = this.generateTestFile(def);
      files.push({
        path: `${this.config.outputDir}/__tests__/${def.name}.test.ts`,
        content: testFile,
      });
    }

    // Generate documentation if requested
    if (this.config.includeDocs) {
      const docs = this.generateDocumentation(def);
      files.push({
        path: `${this.config.outputDir}/docs/${def.name}.md`,
        content: docs,
      });
    }

    // Generate registration
    instructions.push(
      `1. Import the provider in your main registry:`,
      `   import "./generated/${def.name}";`,
      ``,
      `2. Add environment variable to .env:`,
      `   ${def.auth.envVarName}=your_api_key`,
      ``,
      `3. Configure in koryphaios.json:`,
      `   "${def.name}": {`,
      `     "enabled": true`,
      `   }`,
    );

    routingLog.info({ provider: def.name, files: files.length }, 'Provider SDK generated');

    return { files, instructions };
  }

  /**
   * Generate provider from OpenAPI spec
   */
  async generateFromOpenAPI(
    name: ProviderName,
    specUrl: string,
    options: {
      displayName: string;
      authType: 'api_key' | 'oauth' | 'bearer';
      envVarName: string;
    },
  ): Promise<{
    files: Array<{ path: string; content: string }>;
    instructions: string[];
  }> {
    // Fetch and parse OpenAPI spec
    const response = await fetch(specUrl);
    const spec = await response.json();

    // Extract relevant information
    const def: ProviderDefinition = {
      name,
      displayName: options.displayName,
      description: spec.info?.description,
      baseUrl: this.extractBaseUrl(spec),
      auth: {
        type: options.authType,
        envVarName: options.envVarName,
      },
      capabilities: {
        supportsStreaming: this.checkStreamingSupport(spec),
        supportsDiscovery: this.checkDiscoverySupport(spec),
        supportsTools: this.checkToolSupport(spec),
        supportsVision: false, // Usually requires testing
        supportsReasoning: false,
      },
    };

    return this.generateProvider(def);
  }

  /**
   * Generate from simple template (for OpenAI-compatible providers)
   */
  async generateSimple(
    name: ProviderName,
    options: {
      displayName: string;
      baseUrl: string;
      envVarName: string;
    },
  ): Promise<{
    files: Array<{ path: string; content: string }>;
    instructions: string[];
  }> {
    const def: ProviderDefinition = {
      name,
      displayName: options.displayName,
      baseUrl: options.baseUrl,
      auth: {
        type: 'api_key',
        envVarName: options.envVarName,
      },
      capabilities: {
        supportsStreaming: true,
        supportsDiscovery: true,
        supportsTools: true,
        supportsVision: false,
        supportsReasoning: false,
      },
    };

    return this.generateProvider(def);
  }

  /**
   * Validate a generated provider
   */
  async validateProvider(providerPath: string): Promise<{
    valid: boolean;
    errors: string[];
  }> {
    const errors: string[] = [];

    try {
      // Try to import and validate
      const module = await import(providerPath);

      // Check for required exports
      if (!module.registerPluginFactory) {
        errors.push('Missing registerPluginFactory call');
      }

      return { valid: errors.length === 0, errors };
    } catch (error) {
      return {
        valid: false,
        errors: [(error as Error).message],
      };
    }
  }

  // ─── Private Methods ──────────────────────────────────────────────────────

  private generateMainFile(def: ProviderDefinition): string {
    const template = OPENAI_COMPATIBLE_TEMPLATE;

    return template
      .replace(/<%= name %>/g, def.name)
      .replace(/<%= displayName %>/g, def.displayName)
      .replace(/<%= description %>/g, def.description ?? '')
      .replace(/<%= className %>/g, this.toPascalCase(def.name))
      .replace(/<%= baseUrl %>/g, def.baseUrl)
      .replace(/<%= auth.envVarName %>/g, def.auth.envVarName)
      .replace(/<%= auth.type %>/g, def.auth.type)
      .replace(/<%= capabilities.supportsDiscovery %>/g, String(def.capabilities.supportsDiscovery))
      .replace(/<%= capabilities.supportsStreaming %>/g, String(def.capabilities.supportsStreaming))
      .replace(/<%= source %>/g, def.description ?? 'template');
  }

  private generateTestFile(def: ProviderDefinition): string {
    return `
import { describe, it, expect } from "bun:test";
import { ${this.toPascalCase(def.name)}Provider } from "../${def.name}";

describe("${def.displayName} Provider", () => {
  it("should be instantiable", () => {
    const provider = new ${this.toPascalCase(def.name)}Provider({
      name: "${def.name}",
      apiKey: "test-key",
      disabled: false,
    });
    
    expect(provider).toBeDefined();
    expect(provider.name).toBe("${def.name}");
  });
  
  it("should check availability", () => {
    const provider = new ${this.toPascalCase(def.name)}Provider({
      name: "${def.name}",
      disabled: false,
    });
    
    expect(provider.isAvailable()).toBe(false); // No API key
  });
});
`;
  }

  private generateDocumentation(def: ProviderDefinition): string {
    return `# ${def.displayName} Provider

## Overview

${def.description ?? `Provider integration for ${def.displayName}.`}

## Configuration

### Environment Variables

\`\`\`bash
${def.auth.envVarName}=your_api_key_here
\`\`\`

### Config File

\`\`\`json
{
  "providers": {
    "${def.name}": {
      "enabled": true,
      "selectedModels": []
    }
  }
}
\`\`\`

## Capabilities

| Feature | Supported |
|---------|-----------|
| Streaming | ${def.capabilities.supportsStreaming ? '✅' : '❌'} |
| Model Discovery | ${def.capabilities.supportsDiscovery ? '✅' : '❌'} |
| Tools | ${def.capabilities.supportsTools ? '✅' : '❌'} |
| Vision | ${def.capabilities.supportsVision ? '✅' : '❌'} |
| Reasoning | ${def.capabilities.supportsReasoning ? '✅' : '❌'} |

## Base URL

\`\`\`
${def.baseUrl}
\`\`\`
`;
  }

  private extractBaseUrl(spec: unknown): string {
    // Extract from OpenAPI spec
    if (typeof spec === 'object' && spec !== null) {
      const s = spec as { servers?: Array<{ url: string }> };
      if (s.servers?.[0]?.url) {
        return s.servers[0].url;
      }
    }
    return 'https://api.example.com/v1';
  }

  private checkStreamingSupport(spec: unknown): boolean {
    // Check if spec mentions streaming
    const specStr = JSON.stringify(spec).toLowerCase();
    return specStr.includes('stream') || specStr.includes('sse');
  }

  private checkDiscoverySupport(spec: unknown): boolean {
    // Check if /models endpoint exists
    const specStr = JSON.stringify(spec).toLowerCase();
    return specStr.includes('/models');
  }

  private checkToolSupport(spec: unknown): boolean {
    // Check if tools are mentioned
    const specStr = JSON.stringify(spec).toLowerCase();
    return specStr.includes('tool') || specStr.includes('function');
  }

  private toPascalCase(str: string): string {
    return str
      .split(/[-_]/)
      .map((s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase())
      .join('');
  }
}

// ─── CLI Helper ─────────────────────────────────────────────────────────────

export async function generateProviderCLI(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    console.log('Usage: generate-provider <name> <baseUrl> [envVar]');
    process.exit(1);
  }

  const [name, baseUrl, envVar] = args;

  const generator = new ProviderSDKGenerator({
    outputDir: './src/providers/generated',
  });

  const { files, instructions } = await generator.generateSimple(name as ProviderName, {
    displayName: name.charAt(0).toUpperCase() + name.slice(1),
    baseUrl,
    envVarName: envVar ?? `${name.toUpperCase()}_API_KEY`,
  });

  // Write files
  const fs = await import('fs/promises');
  for (const file of files) {
    await fs.mkdir(file.path.split('/').slice(0, -1).join('/'), { recursive: true });
    await fs.writeFile(file.path, file.content);
    console.log(`✓ Generated: ${file.path}`);
  }

  console.log('\n' + instructions.join('\n'));
}

// ─── Singleton Export ───────────────────────────────────────────────────────

export const sdkGenerator = new ProviderSDKGenerator();
