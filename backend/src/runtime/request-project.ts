import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { PROJECT_ROOT } from './paths';
import { NotFoundError, ValidationError } from '../errors/types';

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

/** A supplied session is authoritative; never fall back to the selected source project. */
export async function getRequestWorkspaceRoot(request: Request): Promise<string> {
  const sessionId = request.headers.get('x-koryphaios-session');
  if (sessionId === null) return getRequestProjectRoot(request);
  if (!sessionId.trim()) throw new ValidationError('The selected session is required.');
  // Context imports the manager, which itself uses project identity helpers.
  const { getContext } = await import('../context');
  const { sessions, kory } = getContext();
  if (!(await sessions.get(sessionId))) throw new NotFoundError('Session', sessionId);
  const workspace = await kory.resolveSessionWorkingDirectoryPublic(sessionId);
  try {
    if (!workspace || !isAbsolute(workspace)) throw new Error('Missing workspace path');
    const root = realpathSync(workspace);
    if (!statSync(root).isDirectory()) throw new Error('Not a directory');
    return root;
  } catch {
    throw new ValidationError('The selected session workspace directory is unavailable.');
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
