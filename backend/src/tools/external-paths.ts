import { existsSync, lstatSync } from 'node:fs';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { canonicalizePath, isContainedBy } from '../runtime/platform';
import { validatePathAccess, type PathValidationResult } from '../security/path-security';
import type { ToolCallInput, ToolContext } from './registry';

export const FILESYSTEM_TOOLS = new Set([
  'read_file',
  'write_file',
  'edit_file',
  'batch_edit',
  'patch',
  'delete_file',
  'move_file',
  'grep',
  'glob',
  'ls',
  'diff',
  'view_image',
]);
export const FILE_MUTATING_TOOLS = new Set([
  'write_file',
  'edit_file',
  'batch_edit',
  'patch',
  'delete_file',
  'move_file',
]);

/** Anything that can write into the workspace, files or not: the file tools
 *  plus shell and Git mutation. While a chat's workspace binding changed
 *  mid-turn (isolate_chat/merge_chat_back) the pipeline denies these — the
 *  turn's ToolContext still points at the pre-change directory. */
export const WORKSPACE_MUTATING_TOOLS = new Set([
  ...FILE_MUTATING_TOOLS,
  'bash',
  'shell_manage',
  'git_switch',
  'commit_and_create_pr',
  'ghost_commit',
]);

/** Resolve missing leaves via the nearest existing ancestor. A dangling link
 * is an error, never authority to create a file beyond that link. */
function canonicalTarget(path: string): string {
  if (path.includes('\0')) throw new Error('Invalid filesystem path');
  let cursor = resolve(path);
  const missing: string[] = [];
  for (;;) {
    try {
      lstatSync(cursor);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      missing.unshift(basename(cursor));
      cursor = parent;
      continue;
    }
    return resolve(canonicalizePath(cursor), ...missing);
  }
}

/** A snapshot of literal operands and canonical destinations, private to one
 * invocation. No root is added to the caller's durable allowedPaths. */
export class FilePathScope {
  readonly call: ToolCallInput;
  readonly targets: Array<{ literal: string; canonical: string; recursive: boolean }> = [];
  readonly cwd: string;
  private readonly literalCwd: string;

  constructor(ctx: ToolContext, call: ToolCallInput) {
    this.literalCwd = resolve(ctx.workingDirectory);
    this.cwd = canonicalizePath(this.literalCwd);
    this.call = structuredClone(call);
    const input = this.call.input;
    const add = (
      object: Record<string, unknown>,
      key: string,
      recursive = false,
      fallback?: string,
    ) => {
      const value = object[key] ?? fallback;
      if (typeof value !== 'string' || !value) throw new Error(`Missing filesystem path: ${key}`);
      const literal = resolve(this.literalCwd, value);
      const canonical = canonicalTarget(literal);
      this.targets.push({ literal, canonical, recursive });
      object[key] = canonical;
    };
    switch (call.name) {
      case 'move_file':
        add(input, 'source');
        add(input, 'destination');
        break;
      case 'diff':
        add(input, 'path_a');
        if (input.path_b !== undefined) add(input, 'path_b');
        break;
      case 'batch_edit':
        if (!Array.isArray(input.files)) throw new Error('Missing batch files');
        for (const file of input.files) add(file, 'path');
        break;
      case 'glob': {
        // Pull a static prefix out of the pattern, so ../outside/*.ts and
        // absolute patterns request the actual search root. Traversal after
        // wildcard expansion cannot be bounded: require an explicit path.
        if (typeof input.pattern !== 'string') throw new Error('Missing glob pattern');
        const pattern = input.pattern.replaceAll('\\', '/');
        if (isAbsolute(pattern)) {
          const magic = pattern.search(/[\*?{\[]/);
          const slash = pattern.lastIndexOf('/', magic < 0 ? pattern.length : magic);
          const absoluteBase = pattern.slice(0, slash || 1) || '/';
          input.path = absoluteBase;
          input.pattern = pattern.slice((slash || 1) + 1);
          add(input, 'path', true);
          break;
        }
        const segments = pattern.split('/');
        const magic = segments.findIndex((segment) => /[*?{\[]/.test(segment));
        const count = magic < 0 ? Math.max(0, segments.length - 1) : magic;
        const prefix = segments.slice(0, count).join('/');
        const tail = segments.slice(count).join('/');
        if (tail.split('/').includes('..') || tail.startsWith('/'))
          throw new Error(
            'Glob traversal after a wildcard is unsupported; use path for the search root',
          );
        const base = typeof input.path === 'string' ? input.path : this.literalCwd;
        input.path = resolve(this.literalCwd, base, prefix || '.');
        input.pattern = tail;
        input.__displayPath = this.literalCwd;
        add(input, 'path', true);
        break;
      }
      case 'grep':
      case 'ls':
        add(input, 'path', true, this.literalCwd);
        break;
      default:
        add(input, 'path');
    }
  }

  get externalPaths(): string[] {
    return [
      ...new Set(
        this.targets
          .filter(
            (target) =>
              !isContainedBy(this.cwd, target.canonical) ||
              (!isContainedBy(this.literalCwd, target.literal) &&
                !isContainedBy(this.cwd, target.literal)),
          )
          .map((target) => target.canonical),
      ),
    ];
  }

  /** Path validators need an existing root for a not-yet-created destination,
   * while the exact canonical target remains the invocation authority. */
  get accessRoots(): string[] {
    return [
      ...new Set(
        this.targets.map((target) =>
          existsSync(target.canonical) ? target.canonical : dirname(target.canonical),
        ),
      ),
    ];
  }

  revalidate(ctx: ToolContext): void {
    ctx.signal?.throwIfAborted();
    if (
      resolve(ctx.workingDirectory) !== this.literalCwd ||
      canonicalizePath(this.literalCwd) !== this.cwd
    )
      throw new Error('Filesystem working directory changed during approval');
    for (const target of this.targets) {
      if (
        canonicalTarget(target.literal) !== target.canonical ||
        canonicalTarget(target.canonical) !== target.canonical
      )
        throw new Error('Filesystem path changed during approval or execution');
    }
  }
}

const scopes = new WeakMap<
  ToolContext,
  {
    call: ToolCallInput;
    scope: FilePathScope;
    check: () => void;
  }
>();

export function bindFilePathScope(
  ctx: ToolContext,
  scope: FilePathScope,
  check: () => void,
): () => void {
  scopes.set(ctx, { call: scope.call, scope, check });
  return () => scopes.delete(ctx);
}

/** Tool-local checks consume only the active invocation, not a reusable ID or
 * an approved parent directory. Direct tool.run callers retain scope checks. */
export function validateFileToolPath(
  ctx: ToolContext,
  call: ToolCallInput,
  path: string,
): PathValidationResult {
  const bound = scopes.get(ctx);
  if (!bound)
    return validatePathAccess(
      resolve(ctx.workingDirectory, path),
      ctx.allowedPaths?.length ? ctx.allowedPaths : [resolve(ctx.workingDirectory)],
      { followSymlinks: true },
    );
  try {
    if (bound.call !== call) throw new Error('Filesystem grant belongs to another invocation');
    bound.check();
    bound.scope.revalidate(ctx);
    const absolute = resolve(ctx.workingDirectory, path);
    const canonical = canonicalTarget(absolute);
    if (
      !bound.scope.targets.some((target) =>
        target.recursive
          ? isContainedBy(target.canonical, absolute) && isContainedBy(target.canonical, canonical)
          : target.canonical === absolute && target.canonical === canonical,
      )
    )
      throw new Error('Path is outside this invocation grant');
    return { allowed: true, resolvedPath: canonical };
  } catch (error) {
    return {
      allowed: false,
      reason: error instanceof Error ? error.message : 'Cannot verify filesystem grant',
    };
  }
}

export function assertFileToolPath(ctx: ToolContext, call: ToolCallInput, path: string): void {
  const access = validateFileToolPath(ctx, call, path);
  if (!access.allowed) throw new Error(`Access denied: ${access.reason}`);
}
