import { existsSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { PROJECT_ROOT } from './paths';
import { ValidationError } from '../errors/types';

/** Resolve the project selected by the desktop client. Local-route auth is
 * checked by callers. An explicitly supplied invalid path fails rather than
 * silently redirecting a project-scoped read or mutation to the launch root. */
export function getRequestProjectRoot(request: Request): string {
  const requested = request.headers.get('x-koryphaios-project')?.trim();
  if (!requested) return PROJECT_ROOT;
  if (!isAbsolute(requested)) {
    throw new ValidationError('The selected project path must be absolute.');
  }
  const root = resolve(requested);
  try {
    if (!existsSync(root) || !statSync(root).isDirectory()) {
      throw new ValidationError('The selected project directory is unavailable.');
    }
    return root;
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    throw new ValidationError(
      `The selected project directory is unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
