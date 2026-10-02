import { describe, expect, test } from 'bun:test';
import { parseDevinModelsOutput } from '../devin-capabilities';

describe('parseDevinModelsOutput', () => {
  test('keeps every selectable row and excludes family headings and aliases', () => {
    const models = parseDevinModelsOutput(`Available models (2 families)

Claude Opus 5 (claude-opus-5)
  aliases: opus
  claude-opus-5-medium                   Claude Opus 5 Medium  [1M context, $5 / MTok In]
  claude-opus-5-max                      Claude Opus 5 Max  [1M context, $5 / MTok In]

GPT-5.2 (gpt-5.2)
  MODEL_GPT_5_2_LOW                      GPT-5.2 Low Thinking  [384K context]
  MODEL_GPT_5_2_XHIGH                    GPT-5.2 XHigh Thinking  [384K context]
`);

    expect(models).toEqual([
      { id: 'claude-opus-5-medium', name: 'Claude Opus 5 Medium', contextWindow: 1_000_000 },
      { id: 'claude-opus-5-max', name: 'Claude Opus 5 Max', contextWindow: 1_000_000 },
      { id: 'MODEL_GPT_5_2_LOW', name: 'GPT-5.2 Low Thinking', contextWindow: 384_000 },
      { id: 'MODEL_GPT_5_2_XHIGH', name: 'GPT-5.2 XHigh Thinking', contextWindow: 384_000 },
    ]);
  });

  test('does not mistake the models command help for a catalog', () => {
    expect(
      parseDevinModelsOutput(`List the models available to your account

Usage: devin models <COMMAND>

Commands:
  list  List available models, organized by model family
  help  Print this message or the help of the given subcommand(s)
`),
    ).toEqual([]);
  });

  test('strips price brackets so entries keep just the model name', () => {
    const models = parseDevinModelsOutput(`Available models (53 families)

Claude Opus 5.5 (claude-opus-5.5)
  aliases: opus
  aliases:  opus-duplicate-spacing
  claude-opus-5-5-medium                                                   Claude Opus 5.5 Medium  [$4 / 1M Input · $0.2 / 1M Cached input · $20 / 1M Output, new]
  claude-opus-5-5-max-fast                                                 Claude Opus 5.5 Max Fast  [$8 / 1M Input · $0.4 / 1M Cached input · $40 / 1M Output, new]

GPT-6 Sol (gpt-6-sol)
  aliases: gpt
  gpt-6-sol-none                                                           GPT-6 Sol No Thinking  [$2 / 1M Input · $0.2 / 1M Cached input · $10 / 1M Output, new]
`);

    expect(models).toEqual([
      { id: 'claude-opus-5-5-medium', name: 'Claude Opus 5.5 Medium', contextWindow: undefined },
      {
        id: 'claude-opus-5-5-max-fast',
        name: 'Claude Opus 5.5 Max Fast',
        contextWindow: undefined,
      },
      { id: 'gpt-6-sol-none', name: 'GPT-6 Sol No Thinking', contextWindow: undefined },
    ]);
  });
});
