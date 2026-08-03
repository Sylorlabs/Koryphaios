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
    expect(parseDevinModelsOutput(`List the models available to your account

Usage: devin models <COMMAND>

Commands:
  list  List available models, organized by model family
  help  Print this message or the help of the given subcommand(s)
`)).toEqual([]);
  });
});
