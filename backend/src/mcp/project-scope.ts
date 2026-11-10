import { resolve } from 'node:path';
import { sessionSettingsRoot } from '../kory/session-workspace';
import { canonicalizePath } from '../runtime/platform';

/** MCP configuration belongs to the source project, including in chat/worker
 * checkouts. Canonicalize existing roots so symlink spellings share a scope. */
export function mcpProjectScope(directory: string): string {
  const source = sessionSettingsRoot(directory);
  try {
    return canonicalizePath(source);
  } catch {
    return resolve(source);
  }
}
