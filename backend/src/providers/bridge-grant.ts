import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { createPrivateCliTextArtifact, type PrivateCliArtifact } from './private-cli-transport';

export type BridgeGrantAudience = 'mcp' | 'hook';
export type BridgeGrantAction =
  | 'mcp:catalog'
  | 'mcp:execute'
  | 'hook:pre-tool'
  | 'hook:post-tool'
  | 'hook:permission'
  | 'hook:prompt-submit'
  | 'hook:stop'
  | 'hook:session-start'
  | 'hook:session-end';

interface BridgeGrantFilePayload {
  version: 1;
  grantId: string;
  secret: string;
  sessionId: string;
  role: string;
  actions: BridgeGrantAction[];
  expiresAt: number;
}

interface BridgeGrantRecord extends Omit<BridgeGrantFilePayload, 'secret'> {
  secret: Buffer;
  artifact: PrivateCliArtifact;
  usedNonces: Map<string, number>;
}

export interface BridgeGrantHandle {
  grantId: string;
  path: string;
  directory: string;
  expiresAt: number;
}

export interface VerifiedBridgeGrant {
  grantId: string;
  sessionId: string;
  role: string;
  audience: BridgeGrantAudience;
  action: BridgeGrantAction;
}

const GRANT_LIFETIME_MS = 10 * 60 * 1000;
const REQUEST_CLOCK_SKEW_MS = 60 * 1000;
const MAX_USED_NONCES_PER_GRANT = 2_048;
const grants = new Map<string, BridgeGrantRecord>();
const ALLOWED_BRIDGE_ACTIONS: ReadonlySet<BridgeGrantAction> = new Set([
  'mcp:catalog',
  'mcp:execute',
  'hook:pre-tool',
  'hook:post-tool',
  'hook:permission',
  'hook:prompt-submit',
  'hook:stop',
  'hook:session-start',
  'hook:session-end',
]);

function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

function bodyDigest(body: unknown): string {
  return createHash('sha256').update(canonicalJson(body)).digest('base64url');
}

function signingPayload(
  audience: BridgeGrantAudience,
  method: string,
  path: string,
  timestamp: number,
  nonce: string,
  body: unknown,
): string {
  return [
    'kory-bridge-v1',
    audience,
    method.toUpperCase(),
    path,
    timestamp,
    nonce,
    bodyDigest(body),
  ].join('\n');
}

function signatureFor(secret: Buffer, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

function normalizedActions(actions: readonly BridgeGrantAction[]): BridgeGrantAction[] {
  return [...new Set(actions)].sort();
}

function audienceForAction(action: BridgeGrantAction): BridgeGrantAudience {
  return action.startsWith('mcp:') ? 'mcp' : 'hook';
}

export function bridgeActionForPath(
  audience: BridgeGrantAudience,
  path: string,
): BridgeGrantAction | null {
  const prefix = '/api/v1/mcp-bridge/';
  if (!path.startsWith(prefix)) return null;
  const suffix = path.slice(prefix.length);
  const candidate = (
    audience === 'mcp' ? `mcp:${suffix}` : `hook:${suffix.replace(/^hooks\//, '')}`
  ) as BridgeGrantAction;
  return ALLOWED_BRIDGE_ACTIONS.has(candidate) && audienceForAction(candidate) === audience
    ? candidate
    : null;
}

function pruneExpiredGrants(now = Date.now()): void {
  for (const [grantId, grant] of grants) {
    if (grant.expiresAt > now) continue;
    grants.delete(grantId);
    grant.artifact.cleanup();
  }
}

/** Mint or reuse a short-lived grant whose secret exists only in backend
 * memory and a 0600 file under a 0700 directory. Config/argv receive only the
 * opaque file path. Every HTTP request is nonce-bound and replay rejected. */
export function getKoryBridgeGrant(
  sessionId: string,
  role: string,
  actions: readonly BridgeGrantAction[],
): BridgeGrantHandle {
  if (!sessionId || !role || actions.length === 0) {
    throw new Error('Bridge grant requires a session, role, and explicit action scope');
  }
  if (actions.some((action) => !ALLOWED_BRIDGE_ACTIONS.has(action))) {
    throw new Error('Bridge grant contains an unsupported action');
  }
  const now = Date.now();
  pruneExpiredGrants(now);
  const scopedActions = normalizedActions(actions);
  const grantId = randomUUID();
  const secret = randomBytes(32);
  const expiresAt = now + GRANT_LIFETIME_MS;
  const payload: BridgeGrantFilePayload = {
    version: 1,
    grantId,
    secret: secret.toString('base64url'),
    sessionId,
    role,
    actions: scopedActions,
    expiresAt,
  };
  const artifact = createPrivateCliTextArtifact('bridge-grant', JSON.stringify(payload), 'json');
  const record: BridgeGrantRecord = {
    ...payload,
    secret,
    artifact,
    usedNonces: new Map(),
  };
  grants.set(grantId, record);
  return { grantId, path: artifact.path, directory: artifact.directory, expiresAt };
}

function readGrantFile(path: string): BridgeGrantFilePayload {
  const fileStat = lstatSync(path);
  const parentStat = lstatSync(dirname(path));
  // Windows does not support Unix-style file permissions (chmod). Node.js
  // reports 0o666 for files and 0o777 for directories regardless of the mode
  // passed to writeFileSync/mkdirSync, so the group/other bit checks below
  // would always fail on Windows. Skip them there; the symlink and type
  // checks still apply, and the directory is under a process-private root.
  const isWindows = process.platform === 'win32';
  if (
    !fileStat.isFile() ||
    fileStat.isSymbolicLink() ||
    (!isWindows && (fileStat.mode & 0o077) !== 0)
  ) {
    throw new Error('Bridge grant file permissions are unsafe');
  }
  if (
    !parentStat.isDirectory() ||
    parentStat.isSymbolicLink() ||
    (!isWindows && (parentStat.mode & 0o077) !== 0)
  ) {
    throw new Error('Bridge grant directory permissions are unsafe');
  }
  if (typeof process.getuid === 'function') {
    const uid = process.getuid();
    if (fileStat.uid !== uid || parentStat.uid !== uid) {
      throw new Error('Bridge grant ownership is unsafe');
    }
  }
  if (fileStat.size <= 0 || fileStat.size > 4_096) throw new Error('Bridge grant file is invalid');
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<BridgeGrantFilePayload>;
  if (
    parsed.version !== 1 ||
    typeof parsed.grantId !== 'string' ||
    typeof parsed.secret !== 'string' ||
    typeof parsed.sessionId !== 'string' ||
    typeof parsed.role !== 'string' ||
    typeof parsed.expiresAt !== 'number' ||
    !Array.isArray(parsed.actions) ||
    parsed.actions.some(
      (action) =>
        typeof action !== 'string' || !ALLOWED_BRIDGE_ACTIONS.has(action as BridgeGrantAction),
    )
  ) {
    throw new Error('Bridge grant file is invalid');
  }
  if (parsed.expiresAt <= Date.now()) throw new Error('Bridge grant expired');
  return parsed as BridgeGrantFilePayload;
}

export function readBridgeGrantScopeFromFile(path: string): {
  sessionId: string;
  role: string;
  actions: BridgeGrantAction[];
  expiresAt: number;
} {
  const grant = readGrantFile(path);
  return {
    sessionId: grant.sessionId,
    role: grant.role,
    actions: [...grant.actions],
    expiresAt: grant.expiresAt,
  };
}

export function signedBridgeHeadersFromFile(
  authFile: string,
  audience: BridgeGrantAudience,
  method: string,
  path: string,
  body: unknown,
  options: { timestamp?: number; nonce?: string } = {},
): Record<string, string> {
  const grant = readGrantFile(authFile);
  const action = bridgeActionForPath(audience, path);
  if (!action || !grant.actions.includes(action)) throw new Error('Bridge grant action is invalid');
  const timestamp = options.timestamp ?? Date.now();
  const nonce = options.nonce ?? randomBytes(18).toString('base64url');
  const secret = Buffer.from(grant.secret, 'base64url');
  const signature = signatureFor(
    secret,
    signingPayload(audience, method, path, timestamp, nonce, body),
  );
  return {
    'x-kory-bridge-grant': grant.grantId,
    'x-kory-bridge-timestamp': String(timestamp),
    'x-kory-bridge-nonce': nonce,
    'x-kory-bridge-signature': signature,
  };
}

export function verifySignedBridgeRequest(
  headers: Headers,
  audience: BridgeGrantAudience,
  method: string,
  path: string,
  body: unknown,
  now = Date.now(),
): VerifiedBridgeGrant | null {
  pruneExpiredGrants(now);
  const action = bridgeActionForPath(audience, path);
  if (!action) return null;
  const grantId = headers.get('x-kory-bridge-grant') ?? '';
  const timestampText = headers.get('x-kory-bridge-timestamp') ?? '';
  const nonce = headers.get('x-kory-bridge-nonce') ?? '';
  const suppliedSignature = headers.get('x-kory-bridge-signature') ?? '';
  const grant = grants.get(grantId);
  if (!grant || !grant.actions.includes(action) || grant.expiresAt <= now) return null;
  if (!/^\d{10,16}$/.test(timestampText) || !/^[a-z0-9_-]{20,80}$/i.test(nonce)) return null;
  const timestamp = Number(timestampText);
  if (!Number.isSafeInteger(timestamp) || Math.abs(now - timestamp) > REQUEST_CLOCK_SKEW_MS)
    return null;
  if (grant.usedNonces.has(nonce)) return null;
  if (!/^[a-z0-9_-]{32,80}$/i.test(suppliedSignature)) return null;
  const expected = signatureFor(
    grant.secret,
    signingPayload(audience, method, path, timestamp, nonce, body),
  );
  const expectedBytes = Buffer.from(expected);
  const suppliedBytes = Buffer.from(suppliedSignature);
  if (
    expectedBytes.length !== suppliedBytes.length ||
    !timingSafeEqual(expectedBytes, suppliedBytes)
  )
    return null;

  const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const bodySession = record.sessionId ?? record.session_id;
  const bodyRole = record.role;
  if (bodySession !== grant.sessionId) return null;
  if (bodyRole !== undefined && bodyRole !== grant.role) return null;

  for (const [usedNonce, usedAt] of grant.usedNonces) {
    if (now - usedAt > REQUEST_CLOCK_SKEW_MS) grant.usedNonces.delete(usedNonce);
  }
  if (grant.usedNonces.size >= MAX_USED_NONCES_PER_GRANT) return null;
  grant.usedNonces.set(nonce, now);
  return {
    grantId,
    sessionId: grant.sessionId,
    role: grant.role,
    audience,
    action,
  };
}

export function revokeKoryBridgeGrantsForSession(sessionId: string): void {
  for (const [grantId, grant] of grants) {
    if (grant.sessionId !== sessionId) continue;
    grants.delete(grantId);
    grant.artifact.cleanup();
  }
}

function revokeKoryBridgeGrantIds(grantIds: ReadonlySet<string>): void {
  for (const grantId of grantIds) {
    const grant = grants.get(grantId);
    if (!grant) continue;
    grants.delete(grantId);
    grant.artifact.cleanup();
  }
}

export interface KoryBridgeGrantLease {
  readonly sessionId: string;
  readonly role: string;
  grant(actions: readonly BridgeGrantAction[]): BridgeGrantHandle;
  bindToChild(child: Pick<ChildProcess, 'once'>): void;
  cleanup(): void;
}

/** Owns only the capabilities minted for one provider invocation. Concurrent
 * turns in the same session receive distinct grants, so one child exiting can
 * never revoke another child's authorization. */
export function createKoryBridgeGrantLease(sessionId: string, role: string): KoryBridgeGrantLease {
  const grantIds = new Set<string>();
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    revokeKoryBridgeGrantIds(grantIds);
  };
  return {
    sessionId,
    role,
    grant(actions) {
      if (cleaned) throw new Error('Bridge grant lease is already closed');
      const handle = getKoryBridgeGrant(sessionId, role, actions);
      grantIds.add(handle.grantId);
      return handle;
    },
    bindToChild(child) {
      child.once('close', cleanup);
      child.once('error', cleanup);
    },
    cleanup,
  };
}

export function clearKoryBridgeGrantsForTesting(): void {
  for (const grant of grants.values()) grant.artifact.cleanup();
  grants.clear();
}
