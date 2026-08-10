import { describe, expect, it } from 'vitest';

import { ResourceManager } from '@/server/resource-manager.js';

describe('ResourceManager', () => {
  it('starts empty instead of advertising fabricated runtime resources', () => {
    const resources = new ResourceManager();

    expect(resources.listResources()).toEqual([]);
  });

  it('lists only resources with a real provider and returns that provider output', async () => {
    const resources = new ResourceManager();
    const content = { type: 'text' as const, text: '{"healthy":true}' };

    resources.registerResource(
      {
        uri: 'koryphaios://runtime/health',
        name: 'Runtime health',
        mimeType: 'application/json',
      },
      { read: async () => content }
    );

    expect(resources.listResources()).toEqual([
      {
        uri: 'koryphaios://runtime/health',
        name: 'Runtime health',
        mimeType: 'application/json',
      },
    ]);
    await expect(resources.readResource('koryphaios://runtime/health')).resolves.toEqual(content);
  });

  it('rejects duplicate or unknown resources explicitly', async () => {
    const resources = new ResourceManager();
    const descriptor = { uri: 'koryphaios://runtime/health', name: 'Runtime health' };
    const provider = { read: async () => ({ type: 'text' as const, text: 'ok' }) };

    resources.registerResource(descriptor, provider);

    expect(() => resources.registerResource(descriptor, provider)).toThrow(
      'Resource already registered'
    );
    await expect(resources.readResource('koryphaios://missing')).rejects.toThrow(
      'No provider registered'
    );
  });
});
