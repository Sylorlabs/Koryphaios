import { existsSync, lstatSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
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
  /** Extra read roots the host explicitly granted (ctx.allowedPaths), in
   *  canonical form — e.g. a managed CLI's private jail temp. The canonical
   *  cwd clause remains the real escape guard; these only keep the host's own
   *  grants from prompting as "outside the working directory", and only for
   *  tools that cannot mutate files. */
  private readonly allowedRoots: string[];
  /** The producer checkout a review copy mirrors (ctx.reviewSourceRoot):
   *  literal and canonical forms, for rewriting producer-spelled targets. */
  private readonly reviewSource?: { literal: string; canonical: string };

  constructor(ctx: ToolContext, call: ToolCallInput) {
    this.literalCwd = resolve(ctx.workingDirectory);
    this.cwd = canonicalizePath(this.literalCwd);
    this.allowedRoots = (ctx.allowedPaths ?? []).map((root) => {
      const absolute = resolve(this.literalCwd, root);
      try {
        return canonicalizePath(absolute);
      } catch {
        return absolute;
      }
    });
    if (ctx.reviewSourceRoot) {
      const sourceLiteral = resolve(ctx.reviewSourceRoot);
      let sourceCanonical = sourceLiteral;
      try {
        sourceCanonical = canonicalizePath(sourceLiteral);
      } catch {
        // A missing source root still maps literal spellings.
      }
      this.reviewSource = { literal: sourceLiteral, canonical: sourceCanonical };
    }
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
      const literal = this.mapProducerLiteral(resolve(this.literalCwd, value));
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

  /** A critic works in a disposable copy, but transcripts keep spelling the
   *  producer checkout's absolute paths. A target inside the source root —
   *  by literal spelling, or canonically for /var↔/private/var and symlinked
   *  roots — is rewritten to the same relative path under the critic cwd
   *  before canonicalization and containment run, so the pipeline and the
   *  tool see an in-copy path. Shell commands carry no path operands here. */
  private mapProducerLiteral(literal: string): string {
    const source = this.reviewSource;
    if (!source) return literal;
    // A copy nested under the producer root must not remap its own paths.
    if (isContainedBy(this.literalCwd, literal) || isContainedBy(this.cwd, literal)) return literal;
    if (isContainedBy(source.literal, literal))
      return resolve(this.literalCwd, relative(source.literal, literal));
    try {
      const canonical = canonicalTarget(literal);
      if (isContainedBy(source.canonical, canonical))
        return resolve(this.literalCwd, relative(source.canonical, canonical));
    } catch {
      // A dangling producer path falls through unmapped; the normal
      // literal/canonical clauses classify it.
    }
    return literal;
  }

  get externalPaths(): string[] {
    return [
      ...new Set(
        this.targets
          .filter((target) => {
            // A host-granted root is authority only through the canonical
            // target: a symlink inside the grant pointing outside resolves
            // canonically outside and stays external.
            const insideGrant =
              !FILE_MUTATING_TOOLS.has(this.call.name) &&
              this.allowedRoots.some((root) => isContainedBy(root, target.canonical));
            // Containment is decided on the canonical form only: it is derived
            // from the literal with symlink resolution, so it is the escape
            // guard on every platform. A literal spelling check would flag
            // inside paths spelled through an aliased root (macOS /tmp vs
            // /private/tmp) even though they canonically resolve inside.
            return !isContainedBy(this.cwd, target.canonical) && !insideGrant;
          })
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
