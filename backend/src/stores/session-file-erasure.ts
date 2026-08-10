import {
  existsSync,
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { redactSecretsInText } from '../security';

const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,511}$/;
const RECEIPT_VERSION = 1;

interface StagedPath {
  root: string;
  source: string;
  staged: string;
}

interface SessionFileErasureReceipt {
  version: typeof RECEIPT_VERSION;
  operationId: string;
  scope: 'selected' | 'all';
  sessionIds: string[];
  projectRoots: string[];
  phase:
    | 'staged'
    | 'db-commit-started'
    | 'db-committed'
    | 'stage-rollback-failed'
    | 'post-commit-cleanup-failed';
  paths: StagedPath[];
  createdAt: number;
  updatedAt: number;
  error?: {
    code: 'STAGE_ROLLBACK_FAILED' | 'POST_COMMIT_CLEANUP_FAILED';
    message: string;
    recordedAt: number;
  };
}

function boundedReceiptError(
  code: NonNullable<SessionFileErasureReceipt['error']>['code'],
  error: unknown,
): NonNullable<SessionFileErasureReceipt['error']> {
  const raw = error instanceof Error ? error.message : String(error);
  return {
    code,
    message: redactSecretsInText(raw.replace(/[\r\n\t]+/g, ' '), 1_000),
    recordedAt: Date.now(),
  };
}

function assertWithin(root: string, candidate: string): void {
  const rel = relative(root, candidate);
  if (rel === '..' || rel.startsWith(`..${sep}`) || resolve(candidate) === resolve(root)) {
    throw new Error(`Session erasure path escaped its project root: ${candidate}`);
  }
}

function assertOwnedDirectory(path: string, label: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Session erasure refused unsafe ${label}: ${path}`);
  }
}

function canonicalRoot(root: string): string {
  const requested = resolve(root);
  if (!existsSync(requested)) throw new Error(`Session project directory is unavailable: ${requested}`);
  assertOwnedDirectory(requested, 'project directory');
  return realpathSync(requested);
}

function secureDirectory(path: string): void {
  if (existsSync(path)) {
    assertOwnedDirectory(path, 'erasure metadata directory');
    chmodSync(path, 0o700);
    return;
  }
  mkdirSync(path, { recursive: false, mode: 0o700 });
}

function writeReceipt(path: string, receipt: SessionFileErasureReceipt): void {
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(receipt, null, 2), { mode: 0o600 });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

function assertSessionId(sessionId: string): void {
  if (!SAFE_SESSION_ID.test(sessionId) || sessionId === '.' || sessionId === '..') {
    throw new Error('Session file erasure refused an unsafe session ID');
  }
}

function discoverSessionDirectories(root: string): string[] {
  const discovered = new Set<string>();
  for (const namespace of ['sessions', 'snapshots'] as const) {
    const namespaceRoot = join(root, '.koryphaios', namespace);
    if (!existsSync(namespaceRoot)) continue;
    assertOwnedDirectory(namespaceRoot, `${namespace} directory`);
    for (const entry of readdirSync(namespaceRoot, { withFileTypes: true })) {
      assertSessionId(entry.name);
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        throw new Error(`Session erasure refused unsafe ${namespace} entry: ${entry.name}`);
      }
      discovered.add(entry.name);
    }
  }
  return [...discovered];
}

function validateReceipt(
  receiptRoot: string,
  receiptPath: string,
  receipt: SessionFileErasureReceipt,
): void {
  const receiptStat = lstatSync(receiptPath);
  if (!receiptStat.isFile() || receiptStat.isSymbolicLink()) {
    throw new Error('unsafe receipt file');
  }
  chmodSync(receiptPath, 0o600);
  if (
    receipt.version !== RECEIPT_VERSION ||
    !/^[a-f0-9-]{36}$/i.test(receipt.operationId) ||
    !['selected', 'all'].includes(receipt.scope) ||
    ![
      'staged',
      'db-commit-started',
      'db-committed',
      'stage-rollback-failed',
      'post-commit-cleanup-failed',
    ].includes(receipt.phase) ||
    !Array.isArray(receipt.sessionIds) ||
    !Array.isArray(receipt.projectRoots) ||
    !Array.isArray(receipt.paths) ||
    `${receipt.operationId}.json` !== receiptPath.slice(receiptPath.lastIndexOf(sep) + 1)
  ) {
    throw new Error('unsupported or damaged receipt');
  }
  const allowedSessionIds = new Set(receipt.sessionIds);
  for (const sessionId of allowedSessionIds) assertSessionId(sessionId);
  const allowedRoots = new Set(receipt.projectRoots.map(canonicalRoot));
  if (!allowedRoots.has(receiptRoot)) {
    // The receipt root need not own session data, but including it makes the
    // recovery scope explicit and prevents a forged detached receipt.
    allowedRoots.add(receiptRoot);
  }
  const seen = new Set<string>();
  for (const entry of receipt.paths) {
    const root = canonicalRoot(entry.root);
    if (!allowedRoots.has(root) || entry.root !== root) throw new Error('receipt root mismatch');
    let matched = false;
    for (const sessionId of allowedSessionIds) {
      for (const namespace of ['sessions', 'snapshots'] as const) {
        const expectedSource = join(root, '.koryphaios', namespace, sessionId);
        const expectedStaged = join(
          root,
          '.koryphaios',
          'session-erasure-staging',
          receipt.operationId,
          `${namespace}-${sessionId}`,
        );
        if (entry.source === expectedSource && entry.staged === expectedStaged) matched = true;
      }
    }
    if (!matched || seen.has(entry.source)) throw new Error('receipt path ownership mismatch');
    seen.add(entry.source);
    assertWithin(root, entry.source);
    assertWithin(root, entry.staged);
    if (existsSync(entry.source)) assertOwnedDirectory(entry.source, 'receipt source directory');
    if (existsSync(entry.staged)) assertOwnedDirectory(entry.staged, 'receipt staged directory');
  }
}

export class SessionFileErasureLease {
  private finalized = false;

  constructor(
    private readonly receiptPath: string,
    private readonly receipt: SessionFileErasureReceipt,
  ) {}

  get operationId(): string {
    return this.receipt.operationId;
  }

  get recoveryReceiptPath(): string {
    return this.receiptPath;
  }

  get sessionIds(): readonly string[] {
    return this.receipt.sessionIds;
  }

  get projectRoots(): readonly string[] {
    return this.receipt.projectRoots;
  }

  markDatabaseCommitStarted(): void {
    this.update('db-commit-started');
  }

  markDatabaseCommitted(): void {
    this.update('db-committed');
  }

  recordPartial(error: unknown): void {
    this.receipt.error = boundedReceiptError('POST_COMMIT_CLEANUP_FAILED', error);
    this.update('post-commit-cleanup-failed');
  }

  rollback(): void {
    if (this.finalized) return;
    try {
      for (const entry of [...this.receipt.paths].reverse()) {
        if (!existsSync(entry.staged)) continue;
        if (existsSync(entry.source)) {
          throw new Error(`Cannot roll back session erasure over an existing path: ${entry.source}`);
        }
        renameSync(entry.staged, entry.source);
      }
      rmSync(this.receiptPath, { force: true });
      this.finalized = true;
    } catch (error) {
      this.receipt.error = boundedReceiptError('STAGE_ROLLBACK_FAILED', error);
      this.update('stage-rollback-failed');
      throw error;
    }
  }

  finalize(): void {
    if (this.finalized) return;
    try {
      for (const entry of this.receipt.paths) {
        if (existsSync(entry.staged)) rmSync(entry.staged, { recursive: true, force: true });
      }
      for (const parent of new Set(this.receipt.paths.map((entry) => dirname(entry.staged)))) {
        if (existsSync(parent)) {
          try {
            rmSync(parent, { recursive: false });
          } catch {
            // A sibling operation still owns this staging directory.
          }
        }
      }
      rmSync(this.receiptPath, { force: true });
      this.finalized = true;
    } catch (error) {
      this.receipt.error = boundedReceiptError('POST_COMMIT_CLEANUP_FAILED', error);
      this.update('post-commit-cleanup-failed');
      throw new Error(
        `Session database state was erased, but file cleanup is incomplete. Recovery receipt: ${this.receiptPath}`,
        { cause: error },
      );
    }
  }

  private update(phase: SessionFileErasureReceipt['phase']): void {
    this.receipt.phase = phase;
    this.receipt.updatedAt = Date.now();
    writeReceipt(this.receiptPath, this.receipt);
  }
}

/**
 * Move per-session memory, context archives, and snapshots out of their live
 * namespaces before the SQLite transaction. Rename is same-filesystem and
 * reversible until the database commit begins.
 */
export function stageSessionFilesForErasure(input: {
  receiptRoot: string;
  projectRoots: readonly string[];
  sessionIds: readonly string[];
  scope: 'selected' | 'all';
}): SessionFileErasureLease {
  const sessionIds = [...new Set(input.sessionIds)];
  for (const sessionId of sessionIds) assertSessionId(sessionId);
  const roots = [...new Set(input.projectRoots.map(canonicalRoot))];
  if (input.scope === 'all') {
    for (const root of roots) {
      for (const sessionId of discoverSessionDirectories(root)) sessionIds.push(sessionId);
    }
  }
  const ownedSessionIds = [...new Set(sessionIds)];
  const receiptRoot = canonicalRoot(input.receiptRoot);
  const receiptDirectory = join(receiptRoot, '.koryphaios', 'session-erasure-receipts');
  const metadataRoot = dirname(receiptDirectory);
  if (!existsSync(metadataRoot)) mkdirSync(metadataRoot, { mode: 0o700 });
  else {
    assertOwnedDirectory(metadataRoot, '.koryphaios directory');
    chmodSync(metadataRoot, 0o700);
  }
  secureDirectory(receiptDirectory);

  const operationId = crypto.randomUUID();
  const receiptPath = join(receiptDirectory, `${operationId}.json`);
  const receipt: SessionFileErasureReceipt = {
    version: RECEIPT_VERSION,
    operationId,
    scope: input.scope,
    sessionIds: ownedSessionIds,
    projectRoots: roots,
    phase: 'staged',
    paths: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  writeReceipt(receiptPath, receipt);

  try {
    for (const root of roots) {
      const koryRoot = join(root, '.koryphaios');
      if (!existsSync(koryRoot)) continue;
      assertOwnedDirectory(koryRoot, '.koryphaios directory');
      const stagingRoot = join(koryRoot, 'session-erasure-staging');
      if (!existsSync(stagingRoot)) mkdirSync(stagingRoot, { mode: 0o700 });
      else assertOwnedDirectory(stagingRoot, 'session erasure staging directory');
      const operationRoot = join(stagingRoot, operationId);
      mkdirSync(operationRoot, { mode: 0o700 });

      for (const sessionId of ownedSessionIds) {
        for (const namespace of ['sessions', 'snapshots'] as const) {
          const namespaceRoot = join(koryRoot, namespace);
          if (!existsSync(namespaceRoot)) continue;
          assertOwnedDirectory(namespaceRoot, `${namespace} directory`);
          const source = join(namespaceRoot, sessionId);
          assertWithin(root, source);
          if (!existsSync(source)) continue;
          assertOwnedDirectory(source, `${namespace} session directory`);
          const canonicalSource = realpathSync(source);
          assertWithin(root, canonicalSource);
          const staged = join(operationRoot, `${namespace}-${sessionId}`);
          assertWithin(root, staged);
          renameSync(source, staged);
          receipt.paths.push({ root, source, staged });
          receipt.updatedAt = Date.now();
          writeReceipt(receiptPath, receipt);
        }
      }
    }
    return new SessionFileErasureLease(receiptPath, receipt);
  } catch (error) {
    const lease = new SessionFileErasureLease(receiptPath, receipt);
    try {
      lease.rollback();
    } catch {
      // rollback() records a bounded, typed recovery error in the receipt.
    }
    throw error;
  }
}

/** Resume or roll back an interrupted file-erasure receipt after restart. */
export async function recoverSessionFileErasures(input: {
  receiptRoot: string;
  sessionExists: (sessionId: string) => boolean;
  eraseCredit?: (scope: 'selected' | 'all', sessionIds: readonly string[]) => Promise<void>;
  eraseCheckpoints?: (root: string, sessionId: string) => Promise<void>;
}): Promise<
  Array<{ operationId: string; action: 'finalized' | 'rolled-back' | 'failed'; error?: string }>
> {
  const root = canonicalRoot(input.receiptRoot);
  const receiptDirectory = join(root, '.koryphaios', 'session-erasure-receipts');
  if (!existsSync(receiptDirectory)) return [];
  assertOwnedDirectory(receiptDirectory, 'session erasure receipt directory');
  const receipts = Array.from(new Bun.Glob('*.json').scanSync({ cwd: receiptDirectory })).sort();
  const results: Array<{
    operationId: string;
    action: 'finalized' | 'rolled-back' | 'failed';
    error?: string;
  }> = [];
  for (const filename of receipts) {
    const receiptPath = join(receiptDirectory, filename);
    let receipt: SessionFileErasureReceipt;
    try {
      receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as SessionFileErasureReceipt;
      validateReceipt(root, receiptPath, receipt);
      const lease = new SessionFileErasureLease(receiptPath, receipt);
      const databaseCommitted =
        receipt.phase === 'db-committed' ||
        receipt.phase === 'post-commit-cleanup-failed' ||
        (receipt.phase === 'db-commit-started' &&
          receipt.sessionIds.every((sessionId) => !input.sessionExists(sessionId)));
      if (databaseCommitted) {
        await input.eraseCredit?.(receipt.scope, receipt.sessionIds);
        if (input.eraseCheckpoints) {
          for (const projectRoot of receipt.projectRoots) {
            for (const sessionId of receipt.sessionIds) {
              await input.eraseCheckpoints(projectRoot, sessionId);
            }
          }
        }
        lease.finalize();
        results.push({ operationId: receipt.operationId, action: 'finalized' });
      } else {
        lease.rollback();
        results.push({ operationId: receipt.operationId, action: 'rolled-back' });
      }
    } catch (error) {
      results.push({
        operationId: filename.replace(/\.json$/, ''),
        action: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}
