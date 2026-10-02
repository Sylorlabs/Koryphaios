import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { PROJECT_ROOT } from './paths';
import { ValidationError } from '../errors/types';

/** Stable identity for existing projects; retain offline paths for stored notes.
 * Request admission separately requires an existing directory. */
export function resolveProjectIdentity(projectRoot: string): string {
  const root = resolve(projectRoot);
  try {
    return realpathSync(root);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return root;
    throw error;
  }
}

/** Resolve the project selected by the desktop client. Local-route auth is
 * checked by callers. An explicitly supplied invalid path fails rather than
 * silently redirecting a project-scoped read or mutation to the launch root. */
export function getRequestProjectRoot(request: Request): string {
  const requested = request.headers.get('x-koryphaios-project')?.trim();
  if (requested && !isAbsolute(requested)) {
    throw new ValidationError('The selected project path must be absolute.');
  }
  try {
    const root = realpathSync(resolve(requested || PROJECT_ROOT));
    if (!statSync(root).isDirectory()) {
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
