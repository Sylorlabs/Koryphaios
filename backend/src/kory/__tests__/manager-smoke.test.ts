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
    expect(descriptor?.value?.length).toBe(9); // sessionId, content, model?, reasoningLevel?, attachments?, collabPolicy?, responseVariant?, immutable goal context?, interaction mode?
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

// Note: The refactored modules (clarification-service, routing-service, etc.)
// have comprehensive test coverage. This file provides basic smoke tests
// for the original manager.ts while it's still in production use.
