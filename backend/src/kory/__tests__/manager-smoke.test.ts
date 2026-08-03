// Kory Manager Smoke Tests
// Domain: Basic smoke tests for original manager.ts
// Note: Full integration tests require proper database setup.
// The refactored modules have comprehensive test coverage.

import { describe, it, expect } from 'bun:test';
import { KoryManager } from '../manager';
import type { ProviderRegistry, ToolRegistry } from '../../providers';
import type { KoryphaiosConfig, ProviderName } from '@koryphaios/shared';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Provider, StreamRequest } from '../../providers/types';
import type { IMessageStore, CompactionCommit } from '../../stores/message-store';
import { db, sessions as sessionRows } from '../../db';

describe('KoryManager (Original) - Smoke Tests', () => {
  it('should have KoryManager class', () => {
    expect(KoryManager).toBeDefined();
    expect(typeof KoryManager === 'function').toBe(true);
  });

  it('should have expected public methods', () => {
    // Create instance to check methods
    const providers = {} as ProviderRegistry;
    const tools = {} as ToolRegistry;
    const config = {} as KoryphaiosConfig;

    // Note: Constructor will fail without proper setup
    // We're just verifying the class structure exists
    expect(KoryManager.prototype).toBeDefined();
    expect(typeof KoryManager.prototype.setYoloMode).toBe('function');
    expect(typeof KoryManager.prototype.handleUserInput).toBe('function');
    expect(typeof KoryManager.prototype.handleSessionResponse).toBe('function');
    expect(typeof KoryManager.prototype.cancelWorker).toBe('function');
    expect(typeof KoryManager.prototype.cancelSessionWorkers).toBe('function');
    expect(typeof KoryManager.prototype.isSessionRunning).toBe('function');
    expect(typeof KoryManager.prototype.getStatus).toBe('function');
    expect(typeof KoryManager.prototype.cancel).toBe('function');
  });

  it('should export KoryManager class', () => {
    // Verify it's exported from manager.ts
    const managerModule = require('../manager');
    expect(managerModule.KoryManager).toBeDefined();
  });
});

describe('KoryManager - Method Signatures', () => {
  it('should have correct constructor signature', () => {
    // Constructor takes: providers, tools, workingDirectory, config, sessions, messages, tasks, timeTravel
    expect(KoryManager.length).toBe(8);
  });

  it('setYoloMode should accept boolean', () => {
    const descriptor = Object.getOwnPropertyDescriptor(KoryManager.prototype, 'setYoloMode');
    expect(descriptor?.value?.length).toBe(1); // Takes enabled: boolean
  });

  it('handleUserInput should accept sessionId, selection, optional text, and optional questionId', () => {
    const descriptor = Object.getOwnPropertyDescriptor(KoryManager.prototype, 'handleUserInput');
    expect(descriptor?.value?.length).toBe(4); // sessionId, selection, text?, questionId?
  });

  it('processTask should accept sessionId, message, and optional parameters', () => {
    const descriptor = Object.getOwnPropertyDescriptor(KoryManager.prototype, 'processTask');
    expect(descriptor?.value?.length).toBe(10); // sessionId, content, model?, reasoningLevel?, attachments?, collabPolicy?, responseVariant?, goalContext?, interactionMode?, fastMode?
  });
});

describe('KoryManager live agent-thread retention', () => {
  it('expires completed threads that no longer have a live session state entry', () => {
    const dir = mkdtempSync(join(tmpdir(), 'koryphaios-manager-memory-'));
    try {
      const manager = new KoryManager(
        {} as ProviderRegistry,
        {} as ToolRegistry,
        dir,
        {} as KoryphaiosConfig,
      );
      const internal = manager as unknown as {
        agentThreads: Map<string, { sessionId: string; busy: boolean; updatedAt: number }>;
      };
      internal.agentThreads.set('finished-worker', {
        sessionId: 'old-session',
        busy: false,
        updatedAt: Date.now() - 1_000,
      });

      manager.cleanupAbandonedResources(1);

      expect(internal.agentThreads.has('finished-worker')).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('bounds completed threads for an active session', () => {
    const dir = mkdtempSync(join(tmpdir(), 'koryphaios-manager-memory-'));
    try {
      const manager = new KoryManager(
        {} as ProviderRegistry,
        {} as ToolRegistry,
        dir,
        {} as KoryphaiosConfig,
      );
      const internal = manager as unknown as {
        agentThreads: Map<string, { sessionId: string; busy: boolean; updatedAt: number }>;
        enforceCompletedAgentThreadLimit(sessionId: string): void;
      };
      for (let index = 0; index < 25; index++) {
        internal.agentThreads.set(`worker-${index}`, {
          sessionId: 'active-session',
          busy: false,
          updatedAt: index,
        });
      }

      internal.enforceCompletedAgentThreadLimit('active-session');

      expect(internal.agentThreads.size).toBe(24);
      expect(internal.agentThreads.has('worker-0')).toBe(false);
      expect(internal.agentThreads.has('worker-24')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('KoryManager real compaction', () => {
  it('uses the selected model in a fresh provider context and commits only the validated checkpoint', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'koryphaios-compaction-'));
    const sessionId = `compact-manager-${Date.now()}-${Math.random()}`;
    await db.insert(sessionRows).values({ id: sessionId, title: 'Compact', workingDirectory: dir, createdAt: new Date(), updatedAt: new Date() });
    let request: StreamRequest | undefined;
    let committed: CompactionCommit | undefined;
    const structured = {
      projectBrief: 'Continue the verified compaction implementation without restoring archived transcript messages.',
      decisions: ['Use revisioned active context and preserve old messages locally.'],
      filesAndCodeState: ['backend compaction path is active and awaiting continued verification.'],
      completedWork: ['Selected-model fresh-context summarization is wired.'],
      activeWork: ['Run remaining verification.'],
      openIssues: ['None invented.'],
      nextActions: ['Continue from this checkpoint.'],
      criticalContext: ['The source transcript remains in revision zero.'],
      confidenceAndRisk: 'High confidence in the checkpoint contract; runtime provider behavior still needs integration proof.',
      durableMemory: '# Session Memory\n\nCompaction uses revisioned checkpoints.',
    };
    const provider = {
      name: 'codex', config: {}, isAvailable: () => true, listModels: () => [],
      async *streamResponse(next: StreamRequest) {
        request = next;
        yield { type: 'content_delta' as const, content: JSON.stringify(structured) };
        yield { type: 'usage_update' as const, tokensIn: 500, tokensOut: 120 };
        yield { type: 'complete' as const };
      },
    } as Provider;
    const messageStore = {
      getContextMessages: async () => [
        { id: 'u', sessionId, role: 'user' as const, content: 'Implement real compaction.', createdAt: 1 },
        { id: 'a', sessionId, role: 'assistant' as const, content: 'Implementation is in progress with concrete code changes.', createdAt: 2 },
      ],
      commitCompaction: async (input: CompactionCommit) => { committed = input; return { sourceRevision: 0, targetRevision: 1 }; },
    } as IMessageStore;
    const registry = {
      getStatus: () => [{ name: 'codex', authenticated: true, models: ['gpt-selected'] }],
      resolveProvider: async (model: string, name: string) => model === 'gpt-selected' && name === 'codex' ? provider : undefined,
    } as unknown as ProviderRegistry;
    const manager = new KoryManager(registry, {} as ToolRegistry, dir, {} as KoryphaiosConfig, undefined, messageStore);
    try {
      await manager.compactSession({ sessionId, selectedModel: 'codex:gpt-selected' });
      expect(request?.model).toBe('gpt-selected');
      expect(request?.sessionId).toStartWith(`${sessionId}:compaction:`);
      expect(request?.messages).toHaveLength(1);
      expect(request?.sandbox?.preset).toBe('readonly');
      expect(committed).toMatchObject({ sessionId, provider: 'codex', model: 'gpt-selected', automatic: false, sourceMessageCount: 2 });
      expect(committed?.summary).toContain('# Compacted Session Checkpoint');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Note: The refactored modules (clarification-service, routing-service, etc.)
// have comprehensive test coverage. This file provides basic smoke tests
// for the original manager.ts while it's still in production use.
