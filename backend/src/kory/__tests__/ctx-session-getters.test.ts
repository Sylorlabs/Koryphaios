import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KoryManager } from '../manager';
import { ProviderRegistry } from '../../providers';
import type { ToolRegistry } from '../../tools';
import {
  resetSessionAgentOverridesCache,
  setSessionAgentOverrides,
} from '../../stores/session-agent-overrides';
import type { ToolContext } from '../../tools/types';
import type { Provider } from '../../providers/types';
import { TurnUsageFold } from '../services/turn-usage-fold';

mock.module('../../pubsub', () => ({
  wsBroker: { publish: mock() },
}));

// Regression: the session-scoped ctx policy getters used to be written as
// method-style `get() { this.settingsForSession(...) }` inside
// Object.defineProperties, where `this` is the ctx object — every read threw
// "this.settingsForSession is not a function" on every turn. These tests build
// the real worker ToolContext through executeWithProvider and the real manager
// ctx getters through installManagerSessionGetters, then read every lazy field.

const testWorkDir = realpathSync(mkdtempSync(join(tmpdir(), 'kory-ctxget-')));

const mockProviderRegistry = {
  resolveProvider: mock(),
  getAvailable: mock(() => []),
  getStatus: mock(() => []),
  get: mock(),
} as unknown as ProviderRegistry;
const mockToolRegistry = {
  getToolDefs: mock(() => []),
  execute: mock(),
} as unknown as ToolRegistry;

const sessions = {
  get: async (id: string) => ({
    id,
    title: id,
    workingDirectory: testWorkDir,
    messageCount: 0,
    totalTokensIn: 0,
    totalTokensOut: 0,
    totalCost: 0,
    createdAt: 1,
    updatedAt: 1,
    version: 1,
  }),
  update: async () => undefined,
};

const manager = new KoryManager(
  mockProviderRegistry,
  mockToolRegistry,
  testWorkDir,
  { agents: { manager: { model: 'mock-model' } }, assignments: {}, fallbacks: {} } as never,
  sessions as never,
  { getRecent: () => [], add: () => {}, getContextMessages: () => [] } as never,
);

afterEach(() => {
  resetSessionAgentOverridesCache();
});

afterAll(() => rmSync(testWorkDir, { recursive: true, force: true }));

describe('session-scoped ctx policy getters', () => {
  test('installWorkerSessionGetters getters read without throwing', () => {
    const ctx = {} as ToolContext;
    manager['installWorkerSessionGetters'](
      ctx,
      'sess-g',
      'worker-1',
      'do the thing',
      new AbortController(),
      false,
    );
    expect(() => {
      void ctx.permissionPolicy;
      void ctx.sandboxOptions;
      void ctx.isSandboxed;
      void ctx.requestToolApproval;
    }).not.toThrow();
    expect(typeof ctx.permissionPolicy.mode).toBe('string');

    // The getters re-resolve durable overrides on every read.
    setSessionAgentOverrides('sess-g', { permissionMode: 'yolo' });
    expect(ctx.permissionPolicy.mode).toBe('yolo');
    expect(ctx.isSandboxed).toBe(false);
  });

  test('installManagerSessionGetters getters read without throwing', () => {
    const ctx = {} as ToolContext;
    manager['installManagerSessionGetters'](ctx, 'sess-m', 'act', false);
    expect(() => {
      void ctx.permissionPolicy;
      void ctx.sandboxOptions;
      void ctx.isSandboxed;
    }).not.toThrow();
    expect(typeof ctx.permissionPolicy.mode).toBe('string');
    setSessionAgentOverrides('sess-m', { permissionMode: 'yolo' });
    expect(ctx.permissionPolicy.mode).toBe('yolo');
  });

  test('a real worker ToolContext from executeWithProvider exposes working getters', async () => {
    manager['recordAgentThreadRunMembership'] = async () => {};
    let captured: ToolContext | undefined;
    manager['runAgentThread'] = async (id: string) => {
      captured = manager['agentThreads'].get(id)?.ctx;
    };
    const provider = { name: 'mock', isAvailable: () => true } as unknown as Provider;
    await manager.executeWithProvider(
      'sess-w',
      provider,
      'mock-model',
      'inspect the repo',
      'general',
      undefined,
      false,
      [testWorkDir],
      false,
    );
    expect(captured).toBeDefined();
    expect(() => {
      void captured!.permissionPolicy;
      void captured!.sandboxOptions;
      void captured!.isSandboxed;
      void captured!.requestToolApproval;
    }).not.toThrow();
    expect(captured!.permissionPolicy.mode).toBeTruthy();
    // Default guarded preset keeps the workspace pin; YOLO drops it.
    expect(captured!.requiredWorkspaceRoot).toBeTruthy();
    setSessionAgentOverrides('sess-w', { permissionMode: 'yolo' });
    expect(captured!.permissionPolicy.mode).toBe('yolo');
    expect(captured!.isSandboxed).toBe(false);
  });
});

describe('worker usage fold', () => {
  test('a 3-request CLI turn reports the latest per-request snapshot, not the cumulative max', () => {
    const workerId = 'worker-fold';
    const fold = new TurnUsageFold();
    manager['agentThreads'].set(workerId, { usageFold: fold } as never);
    const emit = mock();
    manager['emitUsageUpdate'] = emit;

    // Per-request snapshots: context grew to 12k, then the CLI compacted to 8k.
    manager['updateUsageFromEvent'](
      'sess-w',
      workerId,
      'mock-model',
      'codex',
      { type: 'usage_update', tokensIn: 10_000, tokensOut: 100 } as never,
    );
    manager['updateUsageFromEvent'](
      'sess-w',
      workerId,
      'mock-model',
      'codex',
      { type: 'usage_update', tokensIn: 12_000, tokensOut: 250 } as never,
    );
    manager['updateUsageFromEvent'](
      'sess-w',
      workerId,
      'mock-model',
      'codex',
      { type: 'usage_update', tokensIn: 8_000, tokensOut: 400 } as never,
    );
    let usage = manager['workers'].getUsage(workerId);
    // Math.max folding would keep 12k after the mid-turn compaction.
    expect(usage?.tokensIn).toBe(8_000);
    expect(usage?.tokensOut).toBe(400);

    // The cumulative turn receipt (billing evidence) must never inflate the
    // occupancy meter.
    manager['updateUsageFromEvent'](
      'sess-w',
      workerId,
      'mock-model',
      'codex',
      {
        type: 'usage_update',
        tokensIn: 30_000,
        tokensOut: 750,
        estimated: true,
        billingTokensIn: 30_000,
        billingTokensOut: 750,
      } as never,
    );
    usage = manager['workers'].getUsage(workerId);
    expect(usage?.tokensIn).toBe(8_000);
    // A per-request sample already describes this turn — the cumulative
    // receipt never replaces either figure.
    expect(usage?.tokensOut).toBe(400);
  });
});
