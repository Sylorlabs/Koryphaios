import { describe, expect, test } from 'bun:test';
import { AskUserTool, normalizeAskUserInput } from '../interaction';
import type { ToolContext } from '../registry';

describe('normalizeAskUserInput', () => {
  test('keeps plain string options', () => {
    expect(
      normalizeAskUserInput({ question: 'Pick one', options: ['Alpha', 'Beta'] }),
    ).toEqual([{ question: 'Pick one', options: ['Alpha', 'Beta'] }]);
  });

  test('maps object options to their labels', () => {
    expect(
      normalizeAskUserInput({
        question: 'Which database?',
        options: [
          { label: 'SQLite', description: 'Zero-config local store' },
          { label: 'Postgres', description: 'Full server' },
        ],
      }),
    ).toEqual([{ question: 'Which database?', options: ['SQLite', 'Postgres'] }]);
  });

  test('accepts a single string as options', () => {
    expect(normalizeAskUserInput({ question: 'Proceed?', options: 'Yes' })).toEqual([
      { question: 'Proceed?', options: ['Yes'] },
    ]);
  });

  test("drops 'Other' and 'Something else' placeholders but keeps real options mentioning 'another'", () => {
    expect(
      normalizeAskUserInput({
        question: 'Pick one',
        options: ['Alpha', 'Other...', 'Something else', 'other', 'Use another library'],
      }),
    ).toEqual([{ question: 'Pick one', options: ['Alpha', 'Use another library'] }]);
  });

  test('dedupes options case-insensitively keeping the first spelling', () => {
    expect(
      normalizeAskUserInput({
        question: 'Pick one',
        options: ['Alpha', ' alpha ', 'ALPHA', 'Beta'],
      }),
    ).toEqual([{ question: 'Pick one', options: ['Alpha', 'Beta'] }]);
  });

  test('normalizes the Claude Code questions[] shape into multiple prompts', () => {
    expect(
      normalizeAskUserInput({
        questions: [
          {
            question: 'Which database?',
            header: 'Storage',
            options: [
              { label: 'SQLite', description: 'Zero-config' },
              { label: 'Postgres' },
            ],
          },
          { prompt: 'Which region?', options: ['us-east', 'eu-west'] },
          { text: 'Confirm the plan' },
          { header: 'no question text' },
        ],
      }),
    ).toEqual([
      { question: 'Which database?', options: ['SQLite', 'Postgres'] },
      { question: 'Which region?', options: ['us-east', 'eu-west'] },
      { question: 'Confirm the plan', options: [] },
    ]);
  });

  test('returns [] when no valid question is present', () => {
    expect(normalizeAskUserInput({ options: ['a'] })).toEqual([]);
    expect(normalizeAskUserInput({ question: '   ' })).toEqual([]);
    expect(normalizeAskUserInput({})).toEqual([]);
    expect(normalizeAskUserInput(null)).toEqual([]);
    expect(normalizeAskUserInput('nope')).toEqual([]);
    expect(normalizeAskUserInput({ questions: [{ header: 'x' }, {}] })).toEqual([]);
  });
});

describe('AskUserTool.run', () => {
  const tool = new AskUserTool();

  function ctxWithWait(
    wait?: (
      question: string,
      options: string[],
      opts: { allowOther: boolean; allowKeepChatting: boolean },
    ) => Promise<string>,
  ): { ctx: ToolContext; calls: { question: string; options: string[]; opts: unknown }[] } {
    const calls: { question: string; options: string[]; opts: unknown }[] = [];
    const ctx: ToolContext = {
      sessionId: 'ask-user-test',
      workingDirectory: '/tmp',
      ...(wait
        ? {
            waitForUserInput: async (
              question: string,
              options: string[],
              opts?: { allowOther?: boolean; allowKeepChatting?: boolean },
            ) => {
              calls.push({ question, options, opts });
              return wait(question, options, opts as {
                allowOther: boolean;
                allowKeepChatting: boolean;
              });
            },
          }
        : {}),
    };
    return { ctx, calls };
  }

  test('always passes allowOther and allowKeepChatting, even when options are omitted', async () => {
    const { ctx, calls } = ctxWithWait(async () => 'Yes');
    const result = await tool.run(ctx, { id: 'c1', name: 'ask_user', input: { question: 'Proceed?' } });
    expect(result.isError).toBe(false);
    expect(result.output).toBe('User selected: Yes');
    expect(calls).toEqual([
      { question: 'Proceed?', options: [], opts: { allowOther: true, allowKeepChatting: true } },
    ]);
  });

  test('errors when no question is supplied', async () => {
    const { ctx, calls } = ctxWithWait(async () => 'never');
    const result = await tool.run(ctx, { id: 'c2', name: 'ask_user', input: {} });
    expect(result.isError).toBe(true);
    expect(result.output).toContain('ask_user needs');
    expect(calls).toEqual([]);
  });

  test('reports an unavailable input system', async () => {
    const { ctx } = ctxWithWait();
    const result = await tool.run(ctx, {
      id: 'c3',
      name: 'ask_user',
      input: { question: 'Proceed?' },
    });
    expect(result.isError).toBe(true);
    expect(result.output).toContain('not available');
  });

  test('asks every prompt in a questions[] call and joins the answers', async () => {
    const { ctx, calls } = ctxWithWait(async (question) =>
      question === 'Which database?' ? 'SQLite' : 'us-east',
    );
    const result = await tool.run(ctx, {
      id: 'c4',
      name: 'ask_user',
      input: {
        questions: [
          { question: 'Which database?', options: [{ label: 'SQLite' }, { label: 'Postgres' }] },
          { question: 'Which region?', options: ['us-east', 'eu-west'] },
        ],
      },
    });
    expect(result.isError).toBe(false);
    expect(calls.map((call) => call.question)).toEqual(['Which database?', 'Which region?']);
    expect(calls[1]!.options).toEqual(['us-east', 'eu-west']);
    expect(result.output).toBe(
      'Q: Which database?\nUser selected: SQLite\n\nQ: Which region?\nUser selected: us-east',
    );
  });

  test('stops asking after a __cancelled__ answer', async () => {
    const { ctx, calls } = ctxWithWait(async () => '__cancelled__');
    const result = await tool.run(ctx, {
      id: 'c5',
      name: 'ask_user',
      input: {
        questions: [{ question: 'First?' }, { question: 'Second?' }, { question: 'Third?' }],
      },
    });
    expect(calls).toHaveLength(1);
    expect(result.isError).toBe(false);
    expect(result.output).toBe('User selected: __cancelled__');
  });
});
