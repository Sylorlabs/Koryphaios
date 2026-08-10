/**
 * Registry for MCP resources backed by real providers.
 *
 * Resource descriptors must never be published without a readable data source:
 * clients otherwise cannot distinguish fabricated demo data from runtime truth.
 */

import type { MCPContent, MCPResource } from '@/types/index.js';

export interface ResourceProvider {
  read(): Promise<MCPContent>;
}

export class ResourceManager {
  private readonly resources = new Map<string, MCPResource>();
  private readonly resourceProviders = new Map<string, ResourceProvider>();

  registerResource(resource: MCPResource, provider: ResourceProvider): void {
    if (!resource.uri.trim()) {
      throw new Error('Resource URI is required');
    }

    if (this.resources.has(resource.uri)) {
      throw new Error(`Resource already registered: ${resource.uri}`);
    }

    this.resources.set(resource.uri, resource);
    this.resourceProviders.set(resource.uri, provider);
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

    return provider.read();
  }
}
