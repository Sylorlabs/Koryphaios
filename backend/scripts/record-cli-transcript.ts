#!/usr/bin/env bun
// Record ONE real CLI turn into a replay fixture.
//
// WARNING: this spends the user's provider credits (it runs a real model turn).
// Run it yourself, deliberately. Do not run it from CI or from an agent.
//
//   bun run backend/scripts/record-cli-transcript.ts \
//     --provider codex --name basic-turn --model <model-id> \
//     --prompt "List the files in src/ and summarise main.ts" \
//     --workdir /path/to/a/scratch/checkout
//
// The adapter runs for real. Only the spawn seam is wrapped, so the frames the
// CLI writes are captured exactly as the adapter received them. The result is
// written to backend/src/providers/replay/fixtures/<provider>-<name>.jsonl with
// "synthetic": false. Review it before committing: it contains model output and
// may contain paths or secrets that the CLI printed to stderr.

import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProviderConfig } from '@koryphaios/shared';
import { CodexCliProvider } from '../src/providers/codex-cli';
import { ClaudeCodeProvider } from '../src/providers/claude-code';
import { OpenCodeCliProvider } from '../src/providers/opencode-cli';
import { createRecordingSpawn } from '../src/providers/replay/record';
import { serializeTranscript, type Transcript } from '../src/providers/replay/transcript';
import type { Provider, StreamRequest } from '../src/providers/types';

type RecordableProvider = 'codex' | 'claude' | 'opencode';

/** Which spawn is the turn itself. Model probes and version checks are not recorded. */
const TURN_MATCHERS: Record<
  RecordableProvider,
  (command: string, args: readonly string[]) => boolean
> = {
  codex: (_command, args) => args.includes('exec'),
  claude: (_command, args) => args.includes('--include-partial-messages'),
  opencode: (_command, args) => args[0] === 'acp',
};

interface Options {
  provider: RecordableProvider;
  name: string;
  model: string;
  prompt: string;
  workdir: string;
}

function parseArgs(argv: string[]): Options {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key?.startsWith('--') || value === undefined)
      fail(`expected --flag value pairs, got "${key}"`);
    values.set(key.slice(2), value);
  }
  const provider = values.get('provider') as RecordableProvider | undefined;
  if (!provider || !(provider in TURN_MATCHERS))
    fail('--provider must be codex, claude or opencode');
  const name = values.get('name');
  const model = values.get('model');
  const prompt = values.get('prompt');
  if (!name || !/^[a-z0-9-]+$/.test(name))
    fail('--name is required (lowercase letters, digits, dashes)');
  if (!model) fail('--model is required');
  if (!prompt) fail('--prompt is required');
  return {
    provider,
    name,
    model,
    prompt,
    workdir: resolve(values.get('workdir') ?? process.cwd()),
  };
}

function fail(message: string): never {
  console.error(`record-cli-transcript: ${message}`);
  console.error(
    'usage: --provider <codex|claude|opencode> --name <slug> --model <id> --prompt <text> [--workdir <dir>]',
  );
  process.exit(2);
}

function cliVersion(binary: string): string {
  try {
    return execFileSync(binary, ['--version'], { encoding: 'utf8', timeout: 8_000 }).trim();
  } catch {
    return 'unknown';
  }
}

function buildProvider(provider: RecordableProvider, spawnChild: typeof spawn): Provider {
  const config = { name: provider } as ProviderConfig;
  switch (provider) {
    case 'codex':
      return new CodexCliProvider(config, spawnChild);
    case 'claude':
      return new ClaudeCodeProvider(config, spawnChild);
    case 'opencode':
      return new OpenCodeCliProvider(config, spawnChild);
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const recorded: Transcript[] = [];
  const recordingSpawn = createRecordingSpawn(
    spawn as unknown as Parameters<typeof createRecordingSpawn>[0],
    {
      provider: options.provider,
      cliVersion: cliVersion(options.provider),
      matches: TURN_MATCHERS[options.provider],
      onRecorded: (transcript) => recorded.push(transcript),
    },
  ) as unknown as typeof spawn;

  const provider = buildProvider(options.provider, recordingSpawn);
  const request: StreamRequest = {
    model: options.model,
    systemPrompt: '',
    messages: [{ role: 'user', content: options.prompt }],
    workingDirectory: options.workdir,
  };

  const events: string[] = [];
  for await (const event of provider.streamResponse(request)) {
    events.push(event.type);
    if (event.type === 'error') {
      console.error(`provider error: ${event.error}`);
    }
  }
  console.log(`events: ${events.join(' -> ')}`);

  const transcript = recorded.at(-1);
  if (!transcript) {
    fail('the adapter never spawned the turn process; nothing was recorded');
  }

  const outDir = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    'src',
    'providers',
    'replay',
    'fixtures',
  );
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `${options.provider}-${options.name}.jsonl`);
  writeFileSync(outPath, serializeTranscript(transcript));
  console.log(
    `wrote ${outPath} (${transcript.frames.length} frames). Review it before committing.`,
  );
}

await main();
