import { existsSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { PROJECT_ROOT } from './paths';

/** Resolve the project selected by the desktop client. Local-route auth is
 * checked by callers; invalid or stale paths fail closed to the launch root. */
export function getRequestProjectRoot(request: Request): string {
  const requested = request.headers.get('x-koryphaios-project')?.trim();
  if (!requested || !isAbsolute(requested)) return PROJECT_ROOT;
  const root = resolve(requested);
  try { return existsSync(root) && statSync(root).isDirectory() ? root : PROJECT_ROOT; }
  catch { return PROJECT_ROOT; }
}
