#!/usr/bin/env bun
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { EphemeralHarness, type EvalRunner } from '../backend/src/eval/benchmark';

/** The adapter is trusted local code explicitly selected by the operator. It
 * owns provider credentials, paid-call consent, process shutdown and confinement. */
async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--adapter') {
    throw new Error('Usage: bun run eval:core --adapter <trusted-local-adapter.ts>');
  }
  const adapter = (await import(pathToFileURL(resolve(args[1])).href)) as {
    identity?: string;
    run?: EvalRunner;
  };
  if (
    typeof adapter.identity !== 'string' ||
    !adapter.identity.trim() ||
    typeof adapter.run !== 'function'
  ) {
    throw new Error(
      'Adapter must export identity (including provider/model/version) and run(workspace, context)',
    );
  }
  const harness = new EphemeralHarness({ runnerIdentity: adapter.identity });
  const report = await harness.runAll(adapter.run);
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  if (report.failedTasks) process.exitCode = 1;
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
