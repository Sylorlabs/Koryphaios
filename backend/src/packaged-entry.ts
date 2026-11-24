/**
 * Compile entry for the standalone backend binary (`bun --compile`). The
 * binary doubles as its own tool bridge: CLI MCP configs and permission hooks
 * invoke `<binary> --kory-mcp-bridge …` / `<binary> --kory-hook-bridge …`,
 * which this dispatcher turns into the provider bridge modules a source
 * checkout runs as loose scripts. Any other invocation starts the server.
 */

// tsyringe decorators evaluate at module scope; the polyfill must load before
// any bundled module that uses them (server.ts carries the same first import).
import 'reflect-metadata';
import { KORY_HOOK_BRIDGE_ARG, KORY_MCP_BRIDGE_ARG } from './runtime/standalone';

export interface PackagedEntryImporters {
  mcpBridge?: () => Promise<{ runBridge: () => Promise<void> }>;
  hookBridge?: () => Promise<{
    main: () => Promise<void>;
    encodeHookDecision: (decision: { decision: string; reason: string }, format: string) => unknown;
  }>;
  server?: () => Promise<unknown>;
}

const removeDispatchArg = (flag: string) => {
  const index = process.argv.indexOf(flag);
  if (index >= 0) process.argv.splice(index, 1);
};

export async function dispatchPackagedEntry(
  argv: string[] = process.argv,
  importers: PackagedEntryImporters = {},
): Promise<void> {
  if (argv[2] === KORY_MCP_BRIDGE_ARG) {
    removeDispatchArg(KORY_MCP_BRIDGE_ARG);
    const module = await (importers.mcpBridge?.() ?? import('./providers/kory-mcp-bridge'));
    try {
      await module.runBridge();
    } catch {
      // Mirrors kory-mcp-bridge's `import.meta.main` handler; exitCode keeps
      // the dispatch unit-testable while the process still exits 1.
      process.stderr.write('[kory-mcp-bridge] fatal error\n');
      process.exitCode = 1;
    }
    return;
  }
  if (argv[2] === KORY_HOOK_BRIDGE_ARG) {
    removeDispatchArg(KORY_HOOK_BRIDGE_ARG);
    const module = await (importers.hookBridge?.() ?? import('./providers/kory-hook-bridge'));
    try {
      await module.main();
    } catch {
      // Mirrors kory-hook-bridge's `import.meta.main` handler exactly.
      process.stderr.write('[kory-hook-bridge] fatal error\n');
      process.stdout.write(
        JSON.stringify(
          module.encodeHookDecision(
            { decision: 'block', reason: 'Kory permission hook failed' },
            'claude',
          ),
        ),
      );
    }
    return;
  }
  await (importers.server?.() ?? import('./server'));
}

if (import.meta.main) await dispatchPackagedEntry();
