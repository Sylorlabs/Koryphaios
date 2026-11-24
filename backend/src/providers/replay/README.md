# CLI transcript replay

Tests the real CLI adapters (codex, claude, opencode) against recorded CLI output.
Only the child process is replaced. Argv construction, stdin prompt writing, stdout
parsing and event normalization all run for real.

## Files

- `transcript.ts`: the JSONL format, parser, and JSON-subset matcher.
- `replay-process.ts`: a fake child process that plays a transcript, and `createReplaySpawn()`,
  the spawn seam the adapters accept.
- `record.ts`: `createRecordingSpawn()`, which wraps a real spawn and captures the frames.
- `fixtures/`: one hand-authored (`"synthetic": true`) turn per provider.
- `__tests__/`: replay tests per provider, plus transport and round-trip tests.

## Format

Line 1 is the header. Each later line is one frame.

```
{"provider":"codex","cliVersion":"0.x","recordedAt":"2026-…","argv":["codex","exec",…],"synthetic":false}
{"t":0,"stream":"stdout","data":"…raw bytes the CLI wrote…"}
{"t":12,"stream":"stderr","data":"…"}
{"t":40,"stream":"stdin-expect","match":{"method":"initialize"}}
{"t":900,"stream":"exit","code":0}
```

- `t` is the millisecond offset. Replay ignores it unless it is run with `realtime: true`.
- `stdin-expect` makes replay wait until the adapter writes a matching stdin line, then
  continue. A string match is a substring of the raw line. An object match is a JSON subset.
  A line that does not match fails the replay with exit 3.
- `{{id}}` in stdout data becomes the id of the last matched request. Write it unquoted
  where the id sits in JSON: `"id":{{id}}`. ACP request ids are random per request.

## Using the seam in a test

```ts
const transcript = loadTranscript(path);
const spawnChild = createReplaySpawn((command, args) =>
  args.includes('exec') ? transcript : null,
);
const provider = new CodexCliProvider({ name: 'codex' } as ProviderConfig, spawnChild as never);
```

A route that returns `null` gives a process that exits 127. The adapters' model-catalog
probes use that. `spawnChild.calls` records every spawn, its argv, and its stdin text.

The seam is an optional constructor parameter, `spawnChild: typeof spawn = spawn`, on
`CodexCliProvider`, `ClaudeCodeProvider` and `OpenCodeCliProvider`. It is also passed to
`OpenCodeAcpClient` through `spawnChild`. Production code never sets it.

## Recording a real turn (spends provider credits)

Run this yourself. Do not run it from CI or an agent.

```sh
bun run backend/scripts/record-cli-transcript.ts \
  --provider codex --name basic-turn --model <model-id> \
  --prompt "List the files in src/ and summarise main.ts" \
  --workdir /path/to/a/scratch/checkout
```

Providers: `codex`, `claude`, `opencode`. The script records only the turn process
(`exec`, `--include-partial-messages`, or `acp`) and writes
`fixtures/<provider>-<name>.jsonl` with `"synthetic": false`.

Before committing a recording, review it. It holds model output, and stderr may hold
paths or account details. Remove anything sensitive. Then the fixture can replace the
synthetic one of the same provider.

## Running the tests

```sh
cd backend && DATABASE_URL=sqlite:/tmp/replay.db bun test src/providers/replay
```

Tests set HOME and PATH to a temp directory (`__tests__/support.ts`), so no real CLI
state is read or written. The fake binaries exit 1 and are only used so `whichBinary()`
finds them.
