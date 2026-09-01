import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { KoryphaiosConfig } from '@koryphaios/shared';
import type { ProviderRegistry, ToolRegistry } from '../../providers';
import type { IMessageStore } from '../../stores/message-store';
import { ContextArchiveService, getContextArchive } from '../context-archive';
import { KoryManager } from '../manager';

const testDirectories: string[] = [];

function createTestDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'kory-manager-context-preview-'));
  testDirectories.push(directory);
  return directory;
}

function createManager(
  directory = createTestDirectory(),
  messages?: Partial<
    Pick<IMessageStore, 'getContextMessages' | 'getActiveBoundary' | 'countContextImageAttachments'>
  >,
): KoryManager {
  const providers = {
    getAvailable: () => [],
    getStatus: () => [],
    isQuotaError: () => false,
  } as unknown as ProviderRegistry;
  const messageStore = messages
    ? ({
        getContextMessages: async () => [],
        getActiveBoundary: async () => ({ messageId: null, contextRevision: 0 }),
        ...messages,
      } as IMessageStore)
    : undefined;
  return new KoryManager(
    providers,
    {} as ToolRegistry,
    directory,
    {} as KoryphaiosConfig,
    undefined,
    messageStore,
  );
}

afterEach(() => {
  for (const directory of testDirectories.splice(0)) {
    if (existsSync(directory)) rmSync(directory, { recursive: true, force: true });
  }
});

describe('KoryManager model context preview provenance', () => {
  test('counts active user images without hydrating message payloads', async () => {
    let hydratedMessages = false;
    const manager = createManager(createTestDirectory(), {
      countContextImageAttachments: async () => 2,
      getContextMessages: async () => {
        hydratedMessages = true;
        throw new Error('preview should use the metadata-only image count');
      },
    });
    try {
      const preview = await manager.previewModelContext('image-context', 'text-model', 'openai');
      expect(preview).toMatchObject({ hasImageAttachments: true, imageAttachmentCount: 2 });
      expect(hydratedMessages).toBe(false);
    } finally {
      manager.shutdown();
    }
  });

  test('keeps exact usage for the same routing identity', async () => {
    const directory = createTestDirectory();
    await new ContextArchiveService(directory).recordUsage('same-route', {
      used: 211_700,
      max: 1_000_000,
      contextKnown: true,
      model: 'minimax-m3',
      provider: 'codex',
      activeMessageId: 'assistant-final',
      contextRevision: 2,
      cachedInputTokens: 199_200,
      breakdown: { system: 1_200, memory: 10_200, tools: 0, chat: 1_200 },
      ts: Date.now(),
    });
    // Constructing the manager creates a fresh archive service, exercising
    // the durable restart path rather than reading the object that wrote it.
    const manager = createManager(directory, {
      getActiveBoundary: async () => ({ messageId: 'assistant-final', contextRevision: 2 }),
    });
    try {
      const preview = await manager.previewModelContext('same-route', 'minimax-m3', 'codex');

      expect(preview).toMatchObject({
        model: 'minimax-m3',
        provider: 'codex',
        used: 211_700,
        usageKnown: true,
        cachedInputTokens: 199_200,
        breakdown: { system: 1_200, memory: 10_200, tools: 0, chat: 1_200 },
      });
    } finally {
      manager.shutdown();
    }
  });

  test('fails closed when a new message or rewind changes the conversation boundary', async () => {
    for (const scenario of [
      { name: 'new-message', boundary: { messageId: 'user-new', contextRevision: 4 } },
      { name: 'rewind', boundary: { messageId: 'user-old', contextRevision: 3 } },
      { name: 'revision-change', boundary: { messageId: 'assistant-old', contextRevision: 5 } },
    ]) {
      const directory = createTestDirectory();
      const sessionId = `boundary-${scenario.name}`;
      await new ContextArchiveService(directory).recordUsage(sessionId, {
        used: 72_000,
        max: 128_000,
        contextKnown: true,
        model: 'gpt-5',
        provider: 'openai',
        activeMessageId: 'assistant-old',
        contextRevision: 4,
        breakdown: { system: 10_000, memory: 2_000, tools: 8_000, chat: 40_000 },
        ts: Date.now(),
      });
      const manager = createManager(directory, {
        getActiveBoundary: async () => scenario.boundary,
      });
      try {
        const preview = await manager.previewModelContext(sessionId, 'gpt-5', 'openai');
        expect(preview, scenario.name).toMatchObject({ used: 0, usageKnown: false });
        expect(preview, scenario.name).not.toHaveProperty('breakdown');
      } finally {
        manager.shutdown();
      }
    }
  });

  test('persists and reuses known usage against the completed assistant boundary', async () => {
    const manager = createManager(createTestDirectory(), {
      getActiveBoundary: async () => ({ messageId: 'assistant-final', contextRevision: 7 }),
    });
    try {
      const persisted = await (
        manager as unknown as {
          persistCompletedManagerUsage(
            sessionId: string,
            expectedActiveMessageId: string,
            model: string,
            provider: 'openai',
            tokensIn: number,
            tokensOut: number,
            breakdown: { system: number; memory: number; tools: number; chat: number },
            cachedInputTokens: number,
          ): Promise<boolean>;
        }
      ).persistCompletedManagerUsage(
        'completed-boundary',
        'assistant-final',
        'gpt-5',
        'openai',
        60_000,
        3_000,
        { system: 10_000, memory: 2_000, tools: 8_000, chat: 40_000 },
        30_000,
      );

      expect(persisted).toBe(true);
      expect(await getContextArchive()!.getLastUsage('completed-boundary')).toMatchObject({
        activeMessageId: 'assistant-final',
        contextRevision: 7,
      });
      expect(
        await manager.previewModelContext('completed-boundary', 'gpt-5', 'openai'),
      ).toMatchObject({
        used: 63_000,
        usageKnown: true,
        cachedInputTokens: 30_000,
      });
    } finally {
      manager.shutdown();
    }
  });

  test('drops CLI harness occupancy when switching to a non-CLI provider', async () => {
    const manager = createManager(createTestDirectory(), {
      getActiveBoundary: async () => ({ messageId: 'assistant-cli', contextRevision: 1 }),
    });
    try {
      await getContextArchive()!.recordUsage('provider-switch', {
        used: 211_700,
        max: 1_000_000,
        contextKnown: true,
        model: 'minimax-m3',
        provider: 'codex',
        activeMessageId: 'assistant-cli',
        contextRevision: 1,
        cachedInputTokens: 199_200,
        breakdown: { system: 1_200, memory: 10_200, tools: 0, chat: 1_200 },
        ts: Date.now(),
      });

      const preview = await manager.previewModelContext('provider-switch', 'minimax-m3', 'openai');

      expect(preview).toMatchObject({
        model: 'minimax-m3',
        provider: 'openai',
        used: 0,
        usageKnown: false,
      });
      expect(preview).not.toHaveProperty('breakdown');
      expect(preview).not.toHaveProperty('cachedInputTokens');
    } finally {
      manager.shutdown();
    }
  });

  test('fails closed for legacy usage snapshots without routing provenance', async () => {
    const directory = createTestDirectory();
    const archiveDirectory = join(directory, '.koryphaios', 'sessions', 'legacy-snapshot');
    mkdirSync(archiveDirectory, { recursive: true });
    writeFileSync(
      join(archiveDirectory, 'context-archive.jsonl'),
      `${JSON.stringify({
        type: 'usage',
        usage: {
          used: 42_000,
          max: 128_000,
          contextKnown: true,
          breakdown: { system: 4_000, memory: 2_000, tools: 30_000, chat: 6_000 },
          ts: 123,
        },
      })}\n`,
    );
    const manager = createManager(directory, {
      getActiveBoundary: async () => ({ messageId: 'assistant-old', contextRevision: 1 }),
    });
    try {
      const preview = await manager.previewModelContext('legacy-snapshot', 'gpt-5', 'openai');

      expect(preview).toMatchObject({ used: 0, usageKnown: false });
      expect(preview).not.toHaveProperty('breakdown');
    } finally {
      manager.shutdown();
    }
  });
});
