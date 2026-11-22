import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Detects the `bun --compile` standalone layout. Bun places every bundled
 * module under a virtual filesystem: Unix builds report `import.meta.dir`
 * under "/$bunfs/…" and Windows builds under the drive-rooted "~BUN" virtual
 * root ("B:\~BUN\…" / "B:/~BUN/…"). Source runs and packaged-directory builds
 * never match these roots, so this predicate is the one allowed answer to
 * "are we inside the compiled binary?".
 */
export function isCompiledStandalone(dir: string = import.meta.dir): boolean {
  return dir.startsWith('/$bunfs/') || /^[a-zA-Z]:[\\/]~BUN[\\/]/.test(dir);
}

/** argv sentinel the compiled binary dispatches on to run the MCP bridge. */
export const KORY_MCP_BRIDGE_ARG = '--kory-mcp-bridge';

/** argv sentinel the compiled binary dispatches on to run the hook bridge. */
export const KORY_HOOK_BRIDGE_ARG = '--kory-hook-bridge';

/**
 * Wire the CLI bridge environment for the current layout. The CLI bridges
 * (cli-bridges.ts, devin-bridge.ts) read these env vars to spawn the kory MCP
 * server + hook bridge as subprocesses of each native CLI. A compiled binary
 * has no sibling scripts — import.meta.dir is Bun's virtual root — so it
 * dispatches on argv sentinels instead (see packaged-entry.ts). Source and
 * build-directory layouts keep probing for the loose .ts/.js files: source
 * runs sit in src/ next to providers/, packaged bundles run from build/ where
 * the scripts ship as siblings of server.js. `compiled` is injectable for
 * tests.
 */
export function applyBridgeEnvironment(compiled = isCompiledStandalone()): void {
  const srcDir = resolve(import.meta.dir, '..');
  const resolveBridgeAsset = (name: string): string => {
    for (const candidate of [
      join(srcDir, 'providers', `${name}.ts`),
      join(srcDir, 'providers', `${name}.js`),
      join(import.meta.dir, `${name}.ts`),
      join(import.meta.dir, `${name}.js`),
    ]) {
      if (existsSync(candidate)) return candidate;
    }
    return '';
  };
  if (!process.env.KORY_MCP_BRIDGE_SCRIPT) {
    process.env.KORY_MCP_BRIDGE_SCRIPT = compiled
      ? KORY_MCP_BRIDGE_ARG
      : resolveBridgeAsset('kory-mcp-bridge');
  }
  if (!process.env.KORY_HOOK_BRIDGE_SCRIPT) {
    process.env.KORY_HOOK_BRIDGE_SCRIPT = compiled
      ? KORY_HOOK_BRIDGE_ARG
      : resolveBridgeAsset('kory-hook-bridge');
  }
  // The MCP bridge spawns via `node <script>`; ensure the command is set.
  if (!process.env.KORY_MCP_BRIDGE_COMMAND) {
    process.env.KORY_MCP_BRIDGE_COMMAND = process.execPath;
  }
}
