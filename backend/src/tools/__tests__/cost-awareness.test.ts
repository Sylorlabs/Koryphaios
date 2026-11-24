import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelDef } from '@koryphaios/shared';
import { initDb } from '../../db';
import { initCreditDb, getCreditDb, recordUsage } from '../../credit-accountant/db';
import { SessionStore } from '../../stores/session-store';
import { roleIncludesTool } from '../tool-roles';
import { GetModelPricingTool, GetUsageSummaryTool } from '../cost-awareness';
import { READ_ONLY_TOOLS, decideToolPermission, resolveToolPermissionPolicy } from '../permission-policy';
import { DEFAULT_AGENT_SETTINGS } from '../../agent-settings';
import { screenToolCall } from '../../security/banned-names';
import { KORY_TOOLS, toolsForRole } from '../../providers/kory-mcp-bridge';
import type { ProviderRegistry } from '../../providers';
import type { ToolCallInput, ToolContext } from '../registry';
import type { ResourceBudgetSnapshot } from '../../billing/resource-budget';
import type { SpendCapStatus, UsageSummaryDependencies } from '../../billing/cost-awareness';

const sessions = new SessionStore();
const dataDir = mkdtempSync(join(tmpdir(), 'kory-cost-awareness-'));

beforeAll(async () => {
  await initDb();
  initCreditDb(dataDir);
});

afterAll(() => {
  getCreditDb().run('DELETE FROM credit_usage');
});

function callFor(name: string, input: Record<string, unknown>): ToolCallInput {
  return { id: 'call-1', name, input };
}

function ctxFor(sessionId: string): ToolContext {
  return { sessionId, workingDirectory: '/tmp', callerRole: 'worker' };
}

function parse(output: string): any {
  return JSON.parse(output);
}

function catalogModel(overrides: Partial<ModelDef> & { id: string }): ModelDef {
  return {
    name: overrides.id,
    provider: 'openrouter',
    contextWindow: 200_000,
    maxOutputTokens: 8_000,
    ...overrides,
  } as ModelDef;
}

/** Minimal registry stand-in: the tools only call getStatus() and getConfigs(). */
function registryOf(
  providers: ReadonlyArray<{ name: string; models: ModelDef[] }>,
): ProviderRegistry {
  return {
    getStatus: () => providers.map((p) => ({ name: p.name, allAvailableModels: p.models })),
    getConfigs: () => ({}),
  } as unknown as ProviderRegistry;
}

function fakeRegistry(providers: Record<string, ModelDef[]>): ProviderRegistry {
  return registryOf(Object.entries(providers).map(([name, models]) => ({ name, models })));
}

const noSpendCap = async (sessionId: string | undefined): Promise<SpendCapStatus | null> => ({
  enabled: false,
  action: 'continue',
  limitsUsd: { sessionHourly: null, sessionDaily: null, globalHourly: null, globalDaily: null },
  spentUsd: { sessionHour: null, sessionDay: null, globalHour: null, globalDay: null },
  ...(sessionId ? { sessionId } : {}),
  paused: false,
});

function budgetWith(snapshot: Partial<ResourceBudgetSnapshot>): () => Promise<ResourceBudgetSnapshot> {
  return async () => ({
    generatedAt: 0,
    entries: [],
    rateLimits: [],
    limitations: [],
    decisionPolicy: '',
    ...snapshot,
  });
}

describe('get_model_pricing', () => {
  const providers = [
    {
      name: 'openrouter',
      models: [
        catalogModel({
          id: 'openai/gpt-4.1',
          costPerMInputTokens: 2,
          costPerMOutputTokens: 8,
          costPerMInputCached: 0.5,
          contextVerified: true,
        }),
        catalogModel({ id: 'no-price/model', contextVerified: false }),
      ],
    },
    {
      name: 'custom:my-endpoint',
      models: [catalogModel({ id: 'llama3', provider: 'custom:my-endpoint', isGeneric: true, costPerMInputTokens: 0, costPerMOutputTokens: 0 })],
    },
    {
      name: 'codex',
      models: [catalogModel({ id: 'gpt-5', provider: 'codex', costPerMInputTokens: 0, costPerMOutputTokens: 0 })],
    },
  ];

  test('reports catalog prices with their source and the verified context window', async () => {
    const tool = new GetModelPricingTool(registryOf(providers), { resolvePricing: () => null });
    const result = await tool.run(ctxFor('s'), callFor('get_model_pricing', { models: ['openrouter:openai/gpt-4.1'] }));
    expect(result.isError).toBe(false);
    const [model] = parse(result.output).models;
    expect(model).toMatchObject({
      provider: 'openrouter',
      model: 'openai/gpt-4.1',
      inCatalog: true,
      inputPerMTok: 2,
      outputPerMTok: 8,
      cacheReadPerMTok: 0.5,
      priceSource: 'catalog',
      contextWindow: 200_000,
      contextSource: 'provider-reported',
    });
  });

  test('unknown prices stay null with source unknown, never zero', async () => {
    const tool = new GetModelPricingTool(registryOf(providers), { resolvePricing: () => null });
    const result = await tool.run(
      ctxFor('s'),
      callFor('get_model_pricing', { models: ['openrouter:no-price/model', 'openrouter:never/listed', 'custom:my-endpoint:llama3'] }),
    );
    const [unpriced, unlisted, generic] = parse(result.output).models;
    expect(unpriced).toMatchObject({ inCatalog: true, inputPerMTok: null, outputPerMTok: null, priceSource: 'unknown', contextWindow: null, contextSource: 'unknown' });
    expect(unlisted).toMatchObject({ inCatalog: false, inputPerMTok: null, priceSource: 'unknown' });
    expect(unlisted.note).toContain('unknown, not zero');
    // A generic placeholder carries zero costs; those are not a price.
    expect(generic).toMatchObject({ provider: 'custom:my-endpoint', model: 'llama3', inputPerMTok: null, priceSource: 'unknown' });
  });

  test('falls back to models.dev and provider-reported registries in that order', async () => {
    const calls: string[] = [];
    const tool = new GetModelPricingTool(
      fakeRegistry({ openrouter: [catalogModel({ id: 'vendor/a' }), catalogModel({ id: 'vendor/b' })] }),
      {
        resolvePricing: (provider, model) => {
          calls.push(`${provider}:${model}`);
          if (model === 'vendor/a') return { inPerM: 1, outPerM: 3, source: 'models.dev' };
          if (model === 'vendor/b') return { inPerM: 0.4, outPerM: 1.6, cacheReadPerM: 0.1, source: 'provider-rate' };
          return null;
        },
      },
    );
    const result = await tool.run(ctxFor('s'), callFor('get_model_pricing', { models: ['openrouter:vendor/a', 'openrouter:vendor/b'] }));
    const [a, b] = parse(result.output).models;
    expect(a).toMatchObject({ priceSource: 'models.dev', inputPerMTok: 1, outputPerMTok: 3 });
    expect(b).toMatchObject({ priceSource: 'provider-reported', inputPerMTok: 0.4, cacheReadPerMTok: 0.1, cacheWritePerMTok: null });
    expect(calls).toEqual(['openrouter:vendor/a', 'openrouter:vendor/b']);
  });

  test('parses custom provider names that contain a colon and lists a provider catalog', async () => {
    const tool = new GetModelPricingTool(registryOf(providers), { resolvePricing: () => null });
    const listed = await tool.run(ctxFor('s'), callFor('get_model_pricing', { provider: 'openrouter' }));
    const models = parse(listed.output).models.map((m: { model: string }) => m.model);
    expect(models).toEqual(['openai/gpt-4.1', 'no-price/model']);

    const bad = await tool.run(ctxFor('s'), callFor('get_model_pricing', { models: ['nocolon'] }));
    expect(parse(bad.output).models[0].error).toContain('provider:model');
  });

  test('rejects non-string model entries', async () => {
    const tool = new GetModelPricingTool(fakeRegistry({}), { resolvePricing: () => null });
    const result = await tool.run(ctxFor('s'), callFor('get_model_pricing', { models: [42] }));
    expect(result.isError).toBe(true);
  });

  test('is available to every role and read-only in plan mode', () => {
    const tool = new GetModelPricingTool(fakeRegistry({}));
    for (const role of ['manager', 'worker', 'critic', 'coder'] as const) {
      expect(roleIncludesTool(tool.name, role, tool.role)).toBe(true);
    }
    expect(READ_ONLY_TOOLS.has('get_model_pricing')).toBe(true);
    const plan = resolveToolPermissionPolicy(DEFAULT_AGENT_SETTINGS, 'plan');
    expect(decideToolPermission(plan, 'get_model_pricing').action).toBe('allow');
    expect(decideToolPermission(plan, 'get_usage_summary').action).toBe('allow');
  });
});

describe('get_usage_summary', () => {
  const folderA = join(dataDir, 'folder-a');
  const folderB = join(dataDir, 'folder-b');
  let own: string;
  let sibling: string;
  let distant: string;

  beforeAll(async () => {
    mkdirSync(folderA, { recursive: true });
    mkdirSync(folderB, { recursive: true });
    own = (await sessions.create('local-user', 'Cost own')).id;
    await sessions.update(own, { workingDirectory: folderA });
    sibling = (await sessions.create('local-user', 'Cost sibling')).id;
    await sessions.update(sibling, { workingDirectory: folderA });
    distant = (await sessions.create('local-user', 'Cost distant')).id;
    await sessions.update(distant, { workingDirectory: folderB });

    recordUsage('priced-model', 'openrouter', 1_000, 500, 0.25, { sessionId: own }, { costKnown: true });
    recordUsage('priced-model', 'openrouter', 2_000, 100, 0.5, { sessionId: sibling }, { costKnown: true });
    recordUsage('priced-model', 'openrouter', 9_000, 900, 9, { sessionId: distant }, { costKnown: true });
    recordUsage('mystery-model', 'mystery', 300, 30, 0, { sessionId: own }, { costKnown: false });
    recordUsage('sub-model', 'codex', 700, 70, 0, { sessionId: own }, { costKnown: true });
  });

  function tool(overrides: Partial<UsageSummaryDependencies> = {}) {
    return new GetUsageSummaryTool(
      fakeRegistry({}),
      sessions,
      {
        spendCap: noSpendCap,
        budget: budgetWith({}),
        ...overrides,
      },
    );
  }

  test('session scope counts only this chat, and unknown spend is not zero', async () => {
    const result = await tool().run(ctxFor(own), callFor('get_usage_summary', {}));
    expect(result.isError).toBe(false);
    const report = parse(result.output);
    expect(report.scope).toBe('session');
    expect(report.sessionId).toBe(own);
    expect(report.tokens).toMatchObject({ input: 1_000 + 300 + 700, output: 500 + 30 + 70 });
    // The unpriced row keeps spend a lower bound instead of contributing zero silently.
    expect(report.spend.pricingIncomplete).toBe(true);
    expect(report.spend.totalUsd).toBeCloseTo(0.25, 6);
    // Subscription tokens are listed separately, never as dollars.
    expect(report.subscriptionProviders).toEqual([{ provider: 'codex', tokensIn: 700, tokensOut: 70 }]);
    expect(report.byProvider.map((p: { provider: string }) => p.provider)).not.toContain('codex');
    expect(report.byModel.find((m: { model: string }) => m.model === 'mystery-model')).toMatchObject({ spendUsd: null, pricingIncomplete: true });
  });

  test('session scope for another chat requires its id and does not leak the caller chat', async () => {
    const other = parse((await tool().run(ctxFor(own), callFor('get_usage_summary', { sessionId: distant }))).output);
    expect(other.sessionId).toBe(distant);
    expect(other.tokens.input).toBe(9_000);
    expect(other.spend.totalUsd).toBeCloseTo(9, 6);

    const missing = await tool().run(ctxFor(own), callFor('get_usage_summary', { sessionId: 'no-such-chat' }));
    expect(missing.isError).toBe(true);
    expect(missing.output).toContain('list_sessions');
  });

  test('project scope includes chats in the same folder only', async () => {
    const report = parse((await tool().run(ctxFor(own), callFor('get_usage_summary', { scope: 'project' }))).output);
    expect(report.scope).toBe('project');
    expect(report.tokens.input).toBe(1_000 + 2_000 + 300 + 700);
    expect(report.spend.totalUsd).toBeCloseTo(0.75, 6);
  });

  test('today and month windows exclude older usage', async () => {
    getCreditDb().run(
      'INSERT INTO credit_usage (ts, model, provider, session_id, tokens_in, tokens_out, cost_usd, cost_known) VALUES (?, ?, ?, ?, ?, ?, ?, 1)',
      [Date.now() - 400 * 24 * 60 * 60 * 1000, 'old-model', 'openrouter', own, 77_000, 0, 77],
    );
    const today = parse((await tool().run(ctxFor(own), callFor('get_usage_summary', { scope: 'today' }))).output);
    const month = parse((await tool().run(ctxFor(own), callFor('get_usage_summary', { scope: 'month' }))).output);
    // Every row above was written today; the 400-day-old row (77k input) is outside both windows.
    expect(today.window.from).not.toBeNull();
    expect(today.tokens.input).toBe(1_000 + 2_000 + 9_000 + 300 + 700);
    expect(month.tokens.input).toBe(1_000 + 2_000 + 9_000 + 300 + 700);
    expect(new Date(month.window.from).getDate()).toBe(1);
  });

  test('rejects an unknown scope', async () => {
    const result = await tool().run(ctxFor(own), callFor('get_usage_summary', { scope: 'year' }));
    expect(result.isError).toBe(true);
  });

  test('reports an unavailable ledger as unknown, never zero', async () => {
    const report = parse(
      (await tool({ rows: () => null }).run(ctxFor(own), callFor('get_usage_summary', {}))).output,
    );
    expect(report.ledgerAvailable).toBe(false);
    expect(report.spend.totalUsd).toBeNull();
    expect(report.tokens).toBeNull();
  });

  test('passes through spend caps and quota states with freshness', async () => {
    const observedAt = Date.now() - 120_000;
    const report = parse(
      (
        await tool({
          spendCap: async (sessionId: string | undefined) => ({
            enabled: true,
            action: 'pause',
            limitsUsd: { sessionHourly: 5, sessionDaily: null, globalHourly: null, globalDaily: 50 },
            spentUsd: { sessionHour: 1.2, sessionDay: 1.5, globalHour: 3, globalDay: 4 },
            sessionId,
            paused: false,
          }),
          budget: budgetWith({
            entries: [
              {
                provider: 'devin',
                kind: 'subscription_quota',
                state: 'low',
                usedPercent: 93,
                window: 'daily',
                source: 'provider_cli',
                authoritative: true,
                observedAt,
              },
              {
                provider: 'openrouter',
                kind: 'api_balance',
                state: 'available',
                availableUsd: 12.5,
                source: 'provider_api',
                authoritative: true,
                observedAt,
              },
            ],
            limitations: ['Missing providers are unknown, not zero.'],
          }),
        }).run(ctxFor(own), callFor('get_usage_summary', {})),
      ).output,
    );
    expect(report.spendCap).toMatchObject({ enabled: true, action: 'pause', limitsUsd: { sessionHourly: 5, globalDaily: 50 } });
    expect(report.quotas).toHaveLength(2);
    expect(report.quotas[0]).toMatchObject({ provider: 'devin', usedPercent: 93, state: 'low' });
    expect(report.quotas[0].observedAgeSeconds).toBeGreaterThanOrEqual(119);
    expect(report.quotas[1]).toMatchObject({ provider: 'openrouter', availableUsd: 12.5 });
    expect(report.limitations).toContain('Missing providers are unknown, not zero.');
  });

  test('is available to every role and keeps its name off the banned-name bouncer', () => {
    const t = tool();
    for (const role of ['manager', 'worker', 'critic', 'coder'] as const) {
      expect(roleIncludesTool(t.name, role, t.role)).toBe(true);
    }
    expect(READ_ONLY_TOOLS.has('get_usage_summary')).toBe(true);
    expect(screenToolCall({ name: 'get_usage_summary', input: { scope: 'month' } })).toBeNull();
  });
});

describe('cost-awareness bridge catalog', () => {
  test('both tools are exposed through the kory MCP bridge to every role', () => {
    for (const name of ['kory__get_model_pricing', 'kory__get_usage_summary']) {
      expect(KORY_TOOLS.some((tool) => tool.name === name && tool.role === 'any')).toBe(true);
      for (const role of ['manager', 'worker', 'critic'] as const) {
        expect(toolsForRole(role).map((tool) => tool.name)).toContain(name);
      }
    }
  });
});
