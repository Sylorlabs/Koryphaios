import { statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { ValidationError } from '../errors/types';
import { getRequestProjectRoot, getRequestWorkspaceRoot } from './request-project';
import { canonicalizePath } from './platform';

/**
 * A project directory admitted by request resolution and canonicalized for
 * source-control use.
 *
 * This is intentionally a class with a private constructor rather than a
 * string brand. A model-controlled string cannot be passed to a source
 * control facade and become a trusted root by type assertion alone.
 */
export class ProjectRoot {
  private constructor(public readonly path: string) {
    Object.freeze(this);
  }

  static fromRequest(request: Request): ProjectRoot {
    return new ProjectRoot(
      canonicalExistingDirectory(getRequestProjectRoot(request), 'Project root'),
    );
  }
}

/** A canonical session workspace bound to an admitted project and session. */
export class TaskScope {
  private constructor(
    public readonly sessionId: string,
    public readonly projectRoot: ProjectRoot,
    public readonly workspaceRoot: string,
  ) {
    Object.freeze(this);
  }

  static async fromRequest(request: Request): Promise<TaskScope> {
    const sessionId = request.headers.get('x-koryphaios-session')?.trim();
    if (!sessionId) throw new ValidationError('Select a chat before using source control.');

    const projectRoot = ProjectRoot.fromRequest(request);
    const workspaceRoot = canonicalExistingDirectory(
      await getRequestWorkspaceRoot(request),
      'Session workspace',
    );
    return new TaskScope(sessionId, projectRoot, workspaceRoot);
  }

  /**
   * Build a scope when the project root was already admitted by another
   * backend boundary. Resolution of the workspace still goes through the
   * existing session resolver; callers cannot supply a workspace path.
   */
  static async fromSession(sessionId: string, projectRoot: ProjectRoot): Promise<TaskScope> {
    const selectedSessionId = sessionId.trim();
    if (!selectedSessionId) throw new ValidationError('The selected session is required.');
    assertProjectRoot(projectRoot);
    const request = new Request('http://koryphaios.internal/source-control', {
      headers: {
        'x-koryphaios-session': selectedSessionId,
        'x-koryphaios-project': projectRoot.path,
      },
    });
    const workspaceRoot = canonicalExistingDirectory(
      await getRequestWorkspaceRoot(request),
      'Session workspace',
    );
    return new TaskScope(selectedSessionId, projectRoot, workspaceRoot);
  }
}

export function projectRootFromRequest(request: Request): ProjectRoot {
  return ProjectRoot.fromRequest(request);
}

export function taskScopeFromRequest(request: Request): Promise<TaskScope> {
  return TaskScope.fromRequest(request);
}

export function assertProjectRoot(value: ProjectRoot): asserts value is ProjectRoot {
  if (!(value instanceof ProjectRoot)) {
    throw new ValidationError('Source control requires a trusted canonical project root.');
  }
}

export function assertTaskScope(value: TaskScope): asserts value is TaskScope {
  if (!(value instanceof TaskScope)) {
    throw new ValidationError('Source control requires a trusted session task scope.');
  }
  assertProjectRoot(value.projectRoot);
  if (!value.sessionId.trim() || !isCanonicalDirectory(value.workspaceRoot)) {
    throw new ValidationError('The trusted session task scope is unavailable.');
  }
}

function canonicalExistingDirectory(path: string, label: string): string {
  if (!path || !isAbsolute(path)) {
    throw new ValidationError(`${label} must be an absolute directory.`);
  }
  try {
    const canonical = canonicalizePath(path);
    if (!statSync(canonical).isDirectory()) throw new Error('not a directory');
    return canonical;
  } catch {
    throw new ValidationError(`${label} is unavailable.`);
  }
}

function isCanonicalDirectory(path: string): boolean {
  try {
    return isAbsolute(path) && canonicalizePath(path) === path && statSync(path).isDirectory();
  } catch {
    return false;
  }
}
