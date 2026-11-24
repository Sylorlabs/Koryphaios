import { describe, expect, test } from 'bun:test';
import {
  AGY_OUTPUT_RESERVE_TOKENS,
  antigravityPromptBudget,
  buildAntigravityPrompt,
  buildAntigravityTurnPrompt,
  fitAntigravityPrompt,
  type AgyPromptBudget,
} from '../antigravity';
import { createCliAttachmentScope } from '../cli-attachments';
import type { ProviderMessage } from '../types';

function budgetWithChars(inputBudgetChars: number): AgyPromptBudget {
  return {
    contextWindow: 8_000,
    standingOverheadTokens: 2_000,
    inputBudgetTokens: Math.floor(inputBudgetChars / 4),
    inputBudgetChars,
  };
}

describe('Antigravity prompt budget', () => {
  test('reserves the CLI standing prompt out of the model window', () => {
    expect(antigravityPromptBudget(0)).toBeUndefined();
    expect(antigravityPromptBudget(undefined)).toBeUndefined();

    const wide = antigravityPromptBudget(200_000)!;
    expect(wide.standingOverheadTokens).toBe(48_000);
    expect(wide.inputBudgetTokens).toBe(200_000 - 48_000 - AGY_OUTPUT_RESERVE_TOKENS);

    // A narrow window cannot give up a quarter of itself to the reserve.
    const narrow = antigravityPromptBudget(32_000)!;
    expect(narrow.standingOverheadTokens).toBe(8_000);
    expect(narrow.inputBudgetTokens).toBe(32_000 - 8_000 - AGY_OUTPUT_RESERVE_TOKENS);

    // A huge window does not scale the reserve without bound.
    expect(antigravityPromptBudget(1_000_000)!.standingOverheadTokens).toBe(48_000);
  });

  test('an unbudgeted prompt is still the full history', () => {
    expect(fitAntigravityPrompt('POLICY', ['User: a', 'User: b'])).toBe(
      'POLICY\n\nUser: a\n\nUser: b',
    );
  });
});

describe('Antigravity host continuations', () => {
  const history: ProviderMessage[] = [
    { role: 'system', content: 'Earlier host instruction' },
    { role: 'user', content: 'Original objective' },
    { role: 'assistant', content: 'Proposed answer' },
  ];
  const repair: ProviderMessage = {
    role: 'system',
    content: 'CRITIC REQUIRES REPAIR:\nVerify the claim and correct the answer.',
  };

  test('resumes with Critic repair instructions without replaying the previous answer', () => {
    const scope = createCliAttachmentScope();
    try {
      expect(buildAntigravityTurnPrompt([...history, repair], scope)).toBe(
        `System: ${repair.content}`,
      );
    } finally {
      scope.cleanup();
    }
  });

  test('preserves ordered tool results, host continuations and user follow-ups', () => {
    const scope = createCliAttachmentScope();
    try {
      expect(
        buildAntigravityTurnPrompt(
          [
            ...history,
            { role: 'tool', content: 'Verification failed', tool_call_id: 'check' },
            repair,
            { role: 'user', content: 'Keep the original scope.' },
          ],
          scope,
        ),
      ).toBe(
        `Tool result: Verification failed\n\nSystem: ${repair.content}\n\nUser: Keep the original scope.`,
      );
      expect(
        buildAntigravityTurnPrompt([...history, { role: 'user', content: 'Next task' }], scope),
      ).toBe('Next task');
      expect(buildAntigravityTurnPrompt(history, scope)).toBe('');
    } finally {
      scope.cleanup();
    }
  });

  test('does not replay more history than the Antigravity CLI can hold', () => {
    const prompt = fitAntigravityPrompt(
      'POLICY',
      ['User: old', 'Assistant: older answer', 'User: newest'],
      budgetWithChars(40),
    );
    expect(prompt).toBe(
      'POLICY\n\n[Koryphaios] 2 earlier messages omitted to fit the Antigravity CLI context window. ' +
        'Ask for a specific earlier detail if you need it again.\n\nUser: newest',
    );
  });

  test('keeps the head and tail of a single oversized turn instead of dropping it', () => {
    const block = `${'H'.repeat(4_000)}TAIL`;
    const prompt = fitAntigravityPrompt('', [block], budgetWithChars(2_000));
    expect(prompt.length).toBeLessThanOrEqual(2_000);
    expect(prompt.startsWith('H')).toBe(true);
    expect(prompt.endsWith('TAIL')).toBe(true);
    expect(prompt).toContain('truncated by Koryphaios');
  });

  test('retains host instructions when a fresh conversation replays the history', () => {
    const scope = createCliAttachmentScope();
    try {
      const prompt = buildAntigravityPrompt('Base policy', [...history, repair], scope);
      expect(prompt).toContain('Base policy');
      expect(prompt).toContain('supplied kory MCP server');
      expect(prompt).toContain('kory__list_mcp_tools');
      expect(prompt).toContain('kory__invoke_mcp_tool');
      expect(prompt).toContain('System: Earlier host instruction');
      expect(prompt).toContain(`Assistant: Proposed answer\n\nSystem: ${repair.content}`);
    } finally {
      scope.cleanup();
    }
  });
});
