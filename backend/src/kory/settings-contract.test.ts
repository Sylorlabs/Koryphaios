import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyMemoryPromptBudget, automaticMemoryPrompt } from './settings-contract';

describe('manager settings contract', () => {
  it('uses the shared 100k safety ceiling when the custom memory cap is disabled', () => {
    const context = 'x'.repeat(12_000);
    expect(
      applyMemoryPromptBudget(context, {
        maxContextTokensEnabled: false,
        maxContextTokens: 500,
      }),
    ).toHaveLength(context.length);
    expect(
      applyMemoryPromptBudget(context, {
        maxContextTokensEnabled: true,
        maxContextTokens: 500,
      }),
    ).toHaveLength(2_000);
    expect(
      applyMemoryPromptBudget('x'.repeat(500_000), {
        maxContextTokensEnabled: false,
        maxContextTokens: 500,
      }),
    ).toHaveLength(400_000);
  });

  it('uses one automatic-inclusion predicate for manager, worker, and critic prompts', () => {
    expect(
      automaticMemoryPrompt('private memory', {
        autoIncludeInContext: false,
        maxContextTokensEnabled: true,
        maxContextTokens: 2_000,
      }),
    ).toBe('');
    expect(
      automaticMemoryPrompt('included memory', {
        autoIncludeInContext: true,
        maxContextTokensEnabled: true,
        maxContextTokens: 2_000,
      }),
    ).toBe('included memory');
  });

  it('keeps Plan note reads and writes on the resolved session project', () => {
    const source = readFileSync(join(import.meta.dir, 'manager.ts'), 'utf8');
    expect(source).toContain('ensurePlanNote(sessionId, userMessage, sessionRoot)');
    expect(source).toMatch(
      /syncPlanNote\(\s*sessionId,\s*userMessage,\s*toPersist,\s*managerCtx\.workingDirectory,\s*\)/,
    );
  });

  it('runs the spend-limit preflight before the provider turn', () => {
    const source = readFileSync(join(import.meta.dir, 'manager.ts'), 'utf8');
    const preflight = source.indexOf('checkAndEnforceCaps(sessionId)');
    const providerTurn = source.indexOf('await this.handleDirectly(', preflight);
    expect(preflight).toBeGreaterThan(0);
    expect(providerTurn).toBeGreaterThan(preflight);
  });
});
