/**
 * Research V5 historical corpus acquisition sidecar.
 *
 * A probe reports what remote authorities actually returned. A snapshot is
 * written only if ALL roles have verifiable original bytes. No source may be
 * substituted with a newer page, search snippet, hand-written text or a local
 * test transport. The runtime scorer independently rechecks every source.
 *
 * bun skills-v5/research/evals/snapshot-corpus.ts probe --scenario research-full-task-2-individual
 * bun skills-v5/research/evals/snapshot-corpus.ts snapshot --scenario <id> --out <fixture-directory>
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const RESEARCH_CUTOFF = '2026-09-04T23:59:59Z';
const PROTOCOL_FINAL = '2026-07-28T00:00:00Z';
const PROTOCOL_FINAL_CAPTURE = '20260728000000';
const MAX_SOURCE_BYTES = 1_500_000;
const MAX_API_BYTES = 3_000_000;
/** Small index responses are preserved verbatim for independent offline inspection. */
const MAX_INLINE_INDEX_BYTES = 32_768;
const SHA40 = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const CAPTURE = /^\d{14}$/u;
const BASE32 = /^[A-Z2-7]{32}$/u;

/** A 14-digit CDX timestamp can be syntactically valid but calendrically impossible. */
function validCapture(timestamp: string): boolean {
  if (!CAPTURE.test(timestamp)) return false;
  const iso =
    `${timestamp.slice(0, 4)}-${timestamp.slice(4, 6)}-${timestamp.slice(6, 8)}T` +
    `${timestamp.slice(8, 10)}:${timestamp.slice(10, 12)}:${timestamp.slice(12, 14)}Z`;
  const at = Date.parse(iso);
  return Number.isFinite(at) && new Date(at).toISOString() === iso.replace('Z', '.000Z');
}

type Role =
  | 'agent-skills-spec'
  | 'cursor-skills-docs'
  | 'community-client-extension'
  | 'pre-support-internal-note'
  | 'protocol-spec'
  | 'official-migration'
  | 'legacy-vendor-tutorial'
  | 'current-vendor-compatibility'
  | 'contradictory-forum-answer';
type ProvenanceKind = 'internet-archive' | 'github-commit';

/** Match the runtime's historical window before obtaining or publishing any replay. */
export function assertArchiveTemporalScope(id: Role, timestamp: string): void {
  if (!validCapture(timestamp) || timestamp > '20260904235959')
    throw Error(`Invalid or post-cutoff archive date for ${id}`);
  if (
    ['agent-skills-spec', 'cursor-skills-docs'].includes(id) &&
    timestamp.slice(0, 8) !== '20260904'
  )
    throw Error(`Exact September 4 archive date required for ${id}`);
  if (
    ['protocol-spec', 'official-migration', 'current-vendor-compatibility'].includes(id) &&
    timestamp < PROTOCOL_FINAL_CAPTURE
  )
    throw Error(`Current protocol archive predates final revision for ${id}`);
  if (id === 'legacy-vendor-tutorial' && timestamp >= PROTOCOL_FINAL_CAPTURE)
    throw Error(`Legacy vendor archive postdates final revision for ${id}`);
}

interface RequiredRole {
  id: Role;
  kinds: readonly ProvenanceKind[];
  allowedHosts: readonly string[];
  exactUrl?: string;
  exactArchiveDay?: string;
}

export const RESEARCH_ROLES: Readonly<Record<string, readonly RequiredRole[]>> = {
  'research-full-task-1-individual': [
    {
      id: 'agent-skills-spec',
      kinds: ['internet-archive'],
      allowedHosts: ['agentskills.io'],
      exactUrl: 'https://agentskills.io/specification',
      exactArchiveDay: '20260904',
    },
    {
      id: 'cursor-skills-docs',
      kinds: ['internet-archive'],
      allowedHosts: ['cursor.com'],
      exactUrl: 'https://cursor.com/docs/skills',
      exactArchiveDay: '20260904',
    },
    {
      id: 'community-client-extension',
      kinds: ['internet-archive', 'github-commit'],
      allowedHosts: ['github.com', 'stackoverflow.com', 'forum.cursor.com', 'www.reddit.com'],
    },
    { id: 'pre-support-internal-note', kinds: ['github-commit'], allowedHosts: ['github.com'] },
  ],
  'research-full-task-2-individual': [
    {
      id: 'protocol-spec',
      kinds: ['github-commit', 'internet-archive'],
      allowedHosts: ['modelcontextprotocol.io', 'github.com'],
    },
    {
      id: 'official-migration',
      kinds: ['github-commit', 'internet-archive'],
      allowedHosts: ['modelcontextprotocol.io', 'ts.sdk.modelcontextprotocol.io', 'github.com'],
    },
    {
      id: 'legacy-vendor-tutorial',
      kinds: ['github-commit', 'internet-archive'],
      allowedHosts: ['learn.microsoft.com', 'github.com', 'ts.sdk.modelcontextprotocol.io'],
    },
    {
      id: 'current-vendor-compatibility',
      kinds: ['github-commit', 'internet-archive'],
      allowedHosts: ['learn.microsoft.com', 'github.com', 'ts.sdk.modelcontextprotocol.io'],
    },
    {
      id: 'contradictory-forum-answer',
      kinds: ['internet-archive'],
      allowedHosts: ['stackoverflow.com', 'github.com', 'discuss.modelcontextprotocol.io'],
    },
  ],
};

interface SourceBase {
  id: Role;
  publisher: string;
  versionScope: string;
  claimQuote?: string;
}
interface Unresolved {
  id: Role;
  kind: 'unresolved';
  reason: string;
}
interface ArchiveCandidate extends SourceBase {
  kind: 'internet-archive';
  sourceUrl: string;
}
interface GitCandidate extends SourceBase {
  kind: 'github-commit';
  repository: string;
  revision: string;
  path: string;
  /** Pinned, previously inspected Git object identity and self-recorded commit date. */
  expectedBlobSha: string;
  expectedCommitDate: string;
}
export type SourceCandidate = Unresolved | ArchiveCandidate | GitCandidate;
interface SourcePlan {
  schemaVersion: 1;
  cases: Array<{ scenarioId: string; sources: SourceCandidate[] }>;
}

interface SourceRecord {
  id: Role;
  sourceUrl: string;
  file: string;
  sha256: string;
  publisher: string;
  versionScope: string;
  provenance:
    | { kind: 'internet-archive'; timestamp: string }
    | {
        kind: 'github-commit';
        repository: string;
        revision: string;
        path: string;
        blobSha: string;
      };
}

interface AcquiredSource {
  record: SourceRecord;
  bytes: Buffer;
  retrievedAt: string;
}
export interface SourceObservation {
  id: Role;
  status: 'verified-original-bytes' | 'unresolved' | 'unavailable';
  detail: string;
  retrievedAt?: string;
  sourceUrl?: string;
  sha256?: string;
  bytes?: number;
  provenance?: SourceRecord['provenance'];
}

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
export const gitBlobSha = (bytes: Buffer): string =>
  createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');

/** Wayback CDX digests are base32-encoded SHA-1 of captured response bytes. */
export function cdxDigest(bytes: Buffer): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let carry = 0;
  let bits = 0;
  let output = '';
  for (const byte of createHash('sha1').update(bytes).digest()) {
    carry = (carry << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      output += alphabet[(carry >> bits) & 31];
    }
  }
  if (bits) output += alphabet[(carry << (5 - bits)) & 31];
  return output;
}

function canonicalHttps(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash)
    throw new Error(`Noncanonical HTTPS URL: ${value}`);
  return url;
}

function decode(bytes: Buffer): string {
  const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (!Buffer.from(content, 'utf8').equals(bytes)) throw Error('Source cannot round-trip UTF-8');
  return content;
}

async function get(url: string, limit: number): Promise<{ data: Buffer; json: unknown }> {
  const expected = canonicalHttps(url);
  const response = await fetch(url, {
    headers: {
      accept: 'application/vnd.github+json,application/json,text/plain,text/html,*/*',
      'user-agent': 'koryphaios-research-corpus-acquisition',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(15_000),
  });
  const actual = canonicalHttps(response.url);
  if (
    response.status !== 200 ||
    response.url !== url ||
    actual.host !== expected.host ||
    actual.pathname !== expected.pathname
  )
    throw new Error(`Source unavailable or redirected (HTTP ${response.status}): ${url}`);
  const data = await boundedResponse(response, url, limit);
  let json: unknown = null;
  try {
    json = JSON.parse(decode(data));
  } catch {
    /* HTML or text source */
  }
  return { data, json };
}

/** Limit bytes even when a server omits Content-Length or returns an error. */
async function boundedResponse(response: Response, url: string, limit: number): Promise<Buffer> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (declaredLength > limit) throw Error(`Response exceeds ${limit} bytes: ${url}`);
  if (!response.body) throw Error(`Missing response body: ${url}`);
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    const part = Buffer.from(chunk);
    bytes += part.length;
    if (bytes > limit) throw Error(`Response exceeds ${limit} bytes: ${url}`);
    chunks.push(part);
  }
  const data = Buffer.concat(chunks);
  if (data.length === 0) throw Error(`Empty response: ${url}`);
  return data;
}

/**
 * An indexed capture is only a discovery lead. Neither a CDX row nor this
 * diagnostic audit can qualify a source without replay and byte verification.
 */
export interface ArchiveIndexObservation {
  roleId: Role;
  sourceUrl: string;
  indexUrl: string;
  checkedAt: string;
  outcome:
    | 'indexed-candidate-unverified'
    | 'no-indexed-200-capture'
    | 'http-unavailable'
    | 'invalid-index'
    | 'request-failed';
  detail: string;
  httpStatus?: number;
  returnedUrl?: string;
  responseBytes?: number;
  responseSha256?: string;
  /** Original CDX response bytes, never an inferred or reconstructed historical page. */
  responseBodyBase64?: string;
  /** Larger wire responses retain only a checksum and byte count; offline replay is unavailable. */
  responseBodyOmittedReason?: 'exceeds-inline-limit';
  indexedTimestamp?: string;
  indexedDigest?: string;
}

function exactDayIndexUrl(role: RequiredRole): string {
  if (!role.exactUrl || !role.exactArchiveDay) throw Error(`No exact-day source: ${role.id}`);
  const params = new URLSearchParams({
    url: role.exactUrl,
    output: 'json',
    fl: 'timestamp,original,statuscode,digest',
    filter: 'statuscode:200',
    from: role.exactArchiveDay,
    to: role.exactArchiveDay,
  });
  return `https://web.archive.org/cdx/search/cdx?${params}`;
}

/** Probe only exact-day URL requirements from the evaluator's fixed contract. */
export async function auditExactDayArchiveIndices(
  scenarioId: string,
  request: typeof fetch = fetch,
): Promise<ArchiveIndexObservation[]> {
  const roles = RESEARCH_ROLES[scenarioId];
  if (!roles) throw Error(`Unknown research scenario: ${scenarioId}`);
  const results: ArchiveIndexObservation[] = [];
  for (const role of roles) {
    if (!role.exactUrl || !role.exactArchiveDay) continue;
    const indexUrl = exactDayIndexUrl(role);
    const observation: ArchiveIndexObservation = {
      roleId: role.id,
      sourceUrl: role.exactUrl,
      indexUrl,
      checkedAt: new Date().toISOString(),
      outcome: 'request-failed',
      detail: 'Archive index request has not completed',
    };
    try {
      const response = await request(indexUrl, {
        headers: { accept: 'application/json', 'user-agent': 'koryphaios-research-corpus-audit' },
        redirect: 'follow',
        signal: AbortSignal.timeout(15_000),
      });
      observation.httpStatus = response.status;
      observation.returnedUrl = response.url;
      const bytes = await boundedResponse(response, indexUrl, MAX_API_BYTES);
      observation.responseBytes = bytes.length;
      observation.responseSha256 = sha256(bytes);
      if (bytes.length <= MAX_INLINE_INDEX_BYTES)
        observation.responseBodyBase64 = bytes.toString('base64');
      else observation.responseBodyOmittedReason = 'exceeds-inline-limit';
      if (response.status !== 200 || response.url !== indexUrl) {
        observation.outcome = 'http-unavailable';
        observation.detail = `CDX returned HTTP ${response.status}${response.url !== indexUrl ? ' or redirected' : ''}; capture existence cannot be inferred`;
      } else {
        let index: unknown;
        try {
          index = JSON.parse(decode(bytes));
        } catch {
          observation.outcome = 'invalid-index';
          observation.detail = 'CDX response is not valid UTF-8 JSON';
          results.push(observation);
          continue;
        }
        if (Array.isArray(index) && index.length === 0) {
          observation.outcome = 'no-indexed-200-capture';
          observation.detail = 'CDX returned an empty capture inventory for the exact URL/day';
        } else {
          try {
            const { timestamp, digest } = selectArchiveRow(
              index,
              role.exactUrl,
              role.exactArchiveDay,
            );
            observation.outcome = 'indexed-candidate-unverified';
            observation.indexedTimestamp = timestamp;
            observation.indexedDigest = digest;
            observation.detail =
              'Indexed candidate found; replay and original bytes are not verified';
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            observation.outcome = detail.startsWith('No indexed 200 capture within required date')
              ? 'no-indexed-200-capture'
              : 'invalid-index';
            observation.detail = detail;
          }
        }
      }
    } catch (error) {
      observation.outcome = 'request-failed';
      observation.detail = error instanceof Error ? error.message : String(error);
    }
    results.push(observation);
  }
  return results;
}

/** Rejects missing, ambiguous and incorrectly dated index records. */
export function selectArchiveRow(
  index: unknown,
  original: string,
  day?: string,
): {
  timestamp: string;
  digest: string;
} {
  if (!Array.isArray(index) || !Array.isArray(index[0]))
    throw Error(`No CDX index for ${original}`);
  const header = index[0];
  if (
    !header.every((field: unknown) => typeof field === 'string') ||
    new Set(header).size !== header.length ||
    !['timestamp', 'original', 'statuscode', 'digest'].every((field) => header.includes(field))
  )
    throw Error('CDX index missing required columns');
  const records = index
    .slice(1)
    .filter((entry): entry is unknown[] => Array.isArray(entry))
    .map(
      (entry) =>
        Object.fromEntries(header.map((key: string, i: number) => [key, entry[i]])) as {
          timestamp: string;
          original: string;
          statuscode: string;
          digest: string;
        },
    )
    .filter(
      (entry) =>
        entry.original === original &&
        entry.statuscode === '200' &&
        typeof entry.timestamp === 'string' &&
        validCapture(entry.timestamp) &&
        entry.timestamp <= '20260904235959' &&
        (!day || entry.timestamp.slice(0, 8) === day) &&
        typeof entry.digest === 'string' &&
        BASE32.test(entry.digest),
    );
  if (!records.length) throw Error(`No indexed 200 capture within required date for ${original}`);
  records.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  if (
    records.some(
      (entry) => entry.timestamp === records[0]!.timestamp && entry.digest !== records[0]!.digest,
    )
  )
    throw Error(`Conflicting independent hashes for the same archive capture: ${original}`);
  return { timestamp: records[0]!.timestamp, digest: records[0]!.digest };
}

/** Hash check is against the indexed capture, not a generated search excerpt. */
export function verifyArchiveBytes(bytes: Buffer, digest: string): void {
  if (
    bytes.length < 160 ||
    bytes.length > MAX_SOURCE_BYTES ||
    !BASE32.test(digest) ||
    cdxDigest(bytes) !== digest
  )
    throw Error('Archive replay differs from independently indexed payload');
  decode(bytes);
}

function checkCandidate(role: RequiredRole, candidate: SourceCandidate): void {
  if (candidate.id !== role.id) throw Error(`Source role mismatch: ${role.id}`);
  if (candidate.kind === 'unresolved') {
    if (!candidate.reason?.trim()) throw Error(`Unresolved source needs reason: ${role.id}`);
    return;
  }
  if (
    !role.kinds.includes(candidate.kind) ||
    !candidate.publisher?.trim() ||
    !candidate.versionScope?.trim()
  )
    throw Error(`Invalid provenance plan: ${role.id}`);
  if (!candidate.claimQuote || candidate.claimQuote.length < 24)
    throw Error(`Verbatim consequential claim required for ${role.id}`);
  const url =
    candidate.kind === 'internet-archive'
      ? canonicalHttps(candidate.sourceUrl)
      : canonicalHttps(`https://github.com/${candidate.repository}`);
  if (
    !role.allowedHosts.includes(url.hostname) ||
    (role.exactUrl &&
      candidate.kind === 'internet-archive' &&
      candidate.sourceUrl !== role.exactUrl)
  )
    throw Error(`Wrong source origin for ${role.id}`);
  if (candidate.kind === 'github-commit') {
    if (
      !/^[\w.-]+\/[\w.-]+$/u.test(candidate.repository) ||
      !SHA40.test(candidate.revision) ||
      !SHA40.test(candidate.expectedBlobSha) ||
      !candidate.expectedCommitDate ||
      !/^[a-zA-Z\w.-]+(?:\/[a-zA-Z\w.-]+)*$/u.test(candidate.path) ||
      candidate.path.split('/').some((part) => part === '.' || part === '..')
    )
      throw Error(`Unpinned Git evidence for ${role.id}`);
    checkDates(role.id, candidate.expectedCommitDate);
    if (
      role.id === 'protocol-spec' &&
      (candidate.repository !== 'modelcontextprotocol/modelcontextprotocol' ||
        !candidate.path.startsWith('docs/specification/2026-07-28/'))
    )
      throw Error('Protocol spec must be the normative 2026-07-28 source');
    if (
      role.id === 'official-migration' &&
      ![
        'modelcontextprotocol/modelcontextprotocol',
        'modelcontextprotocol/typescript-sdk',
      ].includes(candidate.repository)
    )
      throw Error('Migration notes are not from an official MCP repository');
    if (
      ['legacy-vendor-tutorial', 'current-vendor-compatibility'].includes(role.id) &&
      !['microsoft/mcp-for-beginners', 'modelcontextprotocol/typescript-sdk'].includes(
        candidate.repository,
      )
    )
      throw Error('Vendor repository is not qualified');
  }
  if (
    ['protocol-spec', 'official-migration', 'current-vendor-compatibility'].includes(role.id) &&
    !candidate.versionScope.includes('2026-07-28')
  )
    throw Error(`Current protocol scope absent for ${role.id}`);
  if (role.id === 'legacy-vendor-tutorial' && !/202(?:4|5)-\d\d-\d\d/u.test(candidate.versionScope))
    throw Error('Prior protocol revision absent from legacy source scope');
}

function checkDates(id: Role, date: string): void {
  const time = Date.parse(date);
  if (
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/u.test(date) ||
    !Number.isFinite(time) ||
    new Date(time).toISOString() !== date.replace('Z', '.000Z') ||
    time > Date.parse(RESEARCH_CUTOFF)
  )
    throw Error(`Commit date exceeds cutoff or is invalid: ${id}`);
  if (
    ['protocol-spec', 'official-migration', 'current-vendor-compatibility'].includes(id) &&
    time < Date.parse(PROTOCOL_FINAL)
  )
    throw Error(`Current source predates final protocol: ${id}`);
  if (id === 'legacy-vendor-tutorial' && time >= Date.parse(PROTOCOL_FINAL))
    throw Error(`Legacy source was not captured before the new protocol: ${id}`);
}

export function assertGitPayload(content: Buffer, blobSha: string): void {
  if (
    content.length < 160 ||
    content.length > MAX_SOURCE_BYTES ||
    !SHA40.test(blobSha) ||
    gitBlobSha(content) !== blobSha
  )
    throw Error('Git contents do not match original blob SHA');
  decode(content);
}

async function archive(candidate: ArchiveCandidate, role: RequiredRole): Promise<AcquiredSource> {
  const currentProtocol = [
    'protocol-spec',
    'official-migration',
    'current-vendor-compatibility',
  ].includes(role.id);
  const params = new URLSearchParams({
    url: candidate.sourceUrl,
    output: 'json',
    fl: 'timestamp,original,statuscode,digest',
    filter: 'statuscode:200',
    from: role.exactArchiveDay ?? (currentProtocol ? '20260728' : '19960101'),
    to: role.exactArchiveDay ?? (role.id === 'legacy-vendor-tutorial' ? '20260727' : '20260904'),
  });
  const indexUrl = `https://web.archive.org/cdx/search/cdx?${params}`;
  const indexed = (await get(indexUrl, MAX_API_BYTES)).json;
  const { timestamp, digest } = selectArchiveRow(
    indexed,
    candidate.sourceUrl,
    role.exactArchiveDay,
  );
  assertArchiveTemporalScope(role.id, timestamp);
  // Match the precise independently indexed row the runtime will query again.
  const exactParams = new URLSearchParams({
    url: candidate.sourceUrl,
    output: 'json',
    filter: `timestamp:${timestamp}`,
    fl: 'timestamp,original,statuscode,digest',
  });
  const exact = (await get(`https://web.archive.org/cdx/search/cdx?${exactParams}`, MAX_API_BYTES))
    .json;
  const confirmed = selectArchiveRow(exact, candidate.sourceUrl, role.exactArchiveDay);
  if (confirmed.timestamp !== timestamp || confirmed.digest !== digest)
    throw Error('Archive index changed between discovery and precise lookup');
  const replayUrl = `https://web.archive.org/web/${timestamp}id_/${candidate.sourceUrl}`;
  const bytes = (await get(replayUrl, MAX_SOURCE_BYTES)).data;
  verifyArchiveBytes(bytes, digest);
  const body = decode(bytes);
  if (candidate.claimQuote && !body.includes(candidate.claimQuote))
    throw Error(`Claim is not verbatim in original archive: ${candidate.id}`);
  return {
    bytes,
    retrievedAt: new Date().toISOString(),
    record: {
      id: candidate.id,
      sourceUrl: candidate.sourceUrl,
      file: `${candidate.id}.html`,
      sha256: sha256(bytes),
      publisher: candidate.publisher,
      versionScope: candidate.versionScope,
      provenance: { kind: 'internet-archive', timestamp },
    },
  };
}

async function github(candidate: GitCandidate): Promise<AcquiredSource> {
  const base = `https://api.github.com/repos/${candidate.repository}`;
  const meta = (await get(`${base}/commits/${candidate.revision}`, MAX_API_BYTES)).json as {
    sha?: string;
    commit?: { committer?: { date?: string } };
  } | null;
  if (!meta || meta.sha !== candidate.revision)
    throw Error(`Unverified Git revision: ${candidate.id}`);
  checkDates(candidate.id, meta.commit?.committer?.date ?? '');
  if (meta.commit?.committer?.date !== candidate.expectedCommitDate)
    throw Error(`Pinned Git date differs from inspected source: ${candidate.id}`);
  const encodedPath = candidate.path.split('/').map(encodeURIComponent).join('/');
  const payload = (
    await get(`${base}/contents/${encodedPath}?ref=${candidate.revision}`, MAX_API_BYTES)
  ).json as {
    type?: string;
    sha?: string;
    encoding?: string;
    content?: string;
    path?: string;
  } | null;
  if (
    !payload ||
    payload.type !== 'file' ||
    payload.path !== candidate.path ||
    payload.encoding !== 'base64' ||
    !SHA40.test(payload.sha ?? '') ||
    typeof payload.content !== 'string'
  )
    throw Error(`Unverified GitHub contents: ${candidate.id}`);
  if (payload.sha !== candidate.expectedBlobSha)
    throw Error(`Pinned Git blob differs from inspected source: ${candidate.id}`);
  const bytes = Buffer.from(payload.content.replace(/\s/gu, ''), 'base64');
  assertGitPayload(bytes, payload.sha!);
  const body = decode(bytes);
  if (candidate.claimQuote && !body.includes(candidate.claimQuote))
    throw Error(`Claim is not verbatim in pinned source: ${candidate.id}`);
  if (candidate.id === 'protocol-spec' && !candidate.path.includes('2026-07-28'))
    throw Error('Protocol text does not identify final revision');
  if (
    ['official-migration', 'current-vendor-compatibility'].includes(candidate.id) &&
    !body.includes('2026-07-28')
  )
    throw Error(`Missing explicit current revision: ${candidate.id}`);
  const sourceUrl = `https://github.com/${candidate.repository}/blob/${candidate.revision}/${candidate.path}`;
  return {
    bytes,
    retrievedAt: new Date().toISOString(),
    record: {
      id: candidate.id,
      sourceUrl,
      file: `${candidate.id}.md`,
      sha256: sha256(bytes),
      publisher: candidate.publisher,
      versionScope: candidate.versionScope,
      provenance: {
        kind: 'github-commit',
        repository: candidate.repository,
        revision: candidate.revision,
        path: candidate.path,
        blobSha: payload.sha!,
      },
    },
  };
}

export function verifyRoleInventory(
  scenarioId: string,
  candidates: SourceCandidate[],
): readonly RequiredRole[] {
  const requirements = RESEARCH_ROLES[scenarioId];
  if (
    !requirements ||
    candidates.length !== requirements.length ||
    new Set(candidates.map((row) => row.id)).size !== requirements.length
  )
    throw Error(`Incomplete or duplicated research source roles: ${scenarioId}`);
  for (const role of requirements) {
    const candidate = candidates.find((item) => item.id === role.id);
    if (!candidate) throw Error(`Missing research role: ${role.id}`);
    checkCandidate(role, candidate);
  }
  const vendor = (row: SourceCandidate): string => {
    if (row.kind === 'github-commit') return row.repository;
    if (row.kind === 'internet-archive') {
      if (row.sourceUrl.includes('learn.microsoft.com')) return 'microsoft/mcp-for-beginners';
      if (row.sourceUrl.includes('ts.sdk.modelcontextprotocol.io'))
        return 'modelcontextprotocol/typescript-sdk';
      if (row.sourceUrl.includes('github.com/microsoft/mcp-for-beginners/'))
        return 'microsoft/mcp-for-beginners';
      if (row.sourceUrl.includes('github.com/modelcontextprotocol/typescript-sdk/'))
        return 'modelcontextprotocol/typescript-sdk';
    }
    return 'unknown';
  };
  if (scenarioId === 'research-full-task-2-individual') {
    const oldSource = candidates.find((row) => row.id === 'legacy-vendor-tutorial')!;
    const newSource = candidates.find((row) => row.id === 'current-vendor-compatibility')!;
    if (
      oldSource.kind !== 'unresolved' &&
      newSource.kind !== 'unresolved' &&
      (vendor(oldSource) === 'unknown' || vendor(oldSource) !== vendor(newSource))
    )
      throw Error('Vendor historical and current sources must be from the same vendor');
  }
  return requirements;
}

function writeCompleteCorpus(output: string, scenarioId: string, sources: AcquiredSource[]): void {
  if (!isAbsolute(output)) throw Error('Snapshot output must be an absolute path');
  const directory = resolve(output);
  const files = sources.map((source) => source.record.file);
  const manifestName = `${scenarioId}.json`;
  if (!sources.length || new Set(files).size !== files.length)
    throw Error('Snapshot requires a nonempty, uniquely named complete corpus');
  if ([...files, manifestName].some((file) => existsSync(join(directory, file))))
    throw Error('Refusing to overwrite an existing research source or manifest');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  // Stage each immutable file first. Linking with EEXIST semantics preserves
  // existing evidence, while publishing the manifest last is the commit point.
  const staged = mkdtempSync(join(directory, '.research-stage-'));
  const published: string[] = [];
  try {
    for (const source of sources) {
      writeFileSync(join(staged, source.record.file), source.bytes, { flag: 'wx' });
    }
    writeFileSync(
      join(staged, manifestName),
      `${JSON.stringify(
        { schemaVersion: 1, scenarioId, sourceRecords: sources.map((source) => source.record) },
        null,
        2,
      )}\n`,
      { flag: 'wx' },
    );
    for (const file of [...files, manifestName]) {
      linkSync(join(staged, file), join(directory, file));
      published.push(join(directory, file));
    }
  } catch (error) {
    // Remove only files this invocation published, never a preexisting file.
    for (const path of published) unlinkSync(path);
    throw error;
  } finally {
    rmSync(staged, { recursive: true, force: true });
  }
}

export async function acquireScenario(
  scenarioId: string,
  candidates: SourceCandidate[],
  output?: string,
): Promise<{
  scenarioId: string;
  observedAt: string;
  complete: boolean;
  snapshotWritten: boolean;
  observations: SourceObservation[];
}> {
  const roles = verifyRoleInventory(scenarioId, candidates);
  const found: AcquiredSource[] = [];
  const observations: SourceObservation[] = [];
  for (const role of roles) {
    const candidate = candidates.find((source) => source.id === role.id)!;
    if (candidate.kind === 'unresolved') {
      observations.push({ id: role.id, status: 'unresolved', detail: candidate.reason });
      continue;
    }
    try {
      const acquired =
        candidate.kind === 'internet-archive'
          ? await archive(candidate, role)
          : await github(candidate);
      found.push(acquired);
      observations.push({
        id: role.id,
        status: 'verified-original-bytes',
        detail: 'Response verified against the archive index or immutable Git object',
        retrievedAt: acquired.retrievedAt,
        sourceUrl: acquired.record.sourceUrl,
        sha256: acquired.record.sha256,
        bytes: acquired.bytes.length,
        provenance: acquired.record.provenance,
      });
    } catch (error) {
      observations.push({
        id: role.id,
        status: 'unavailable',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const complete = found.length === roles.length;
  if (complete && output) writeCompleteCorpus(output, scenarioId, found);
  return {
    scenarioId,
    observedAt: new Date().toISOString(),
    complete,
    snapshotWritten: complete && !!output,
    observations,
  };
}

export interface SourceAuditReport {
  schemaVersion: 1;
  kind: 'nonqualifying-source-audit';
  scenarioId: string;
  observedAt: string;
  historicalCutoff: typeof RESEARCH_CUTOFF;
  sourcePlanSha256: string;
  candidateProbe: Awaited<ReturnType<typeof acquireScenario>>;
  exactDayArchiveIndices: ArchiveIndexObservation[];
}

/** Verify a recorded index's wire bytes and role identity, without contacting the archive. */
export function verifyRecordedArchiveIndices(report: SourceAuditReport): void {
  const roles = RESEARCH_ROLES[report.scenarioId]?.filter(
    (role) => role.exactUrl && role.exactArchiveDay,
  );
  if (
    !roles ||
    report.exactDayArchiveIndices.length !== roles.length ||
    new Set(report.exactDayArchiveIndices.map((item) => item.roleId)).size !== roles.length
  )
    throw Error('Missing or duplicated historical archive index roles');

  for (const role of roles) {
    const observation = report.exactDayArchiveIndices.find((item) => item.roleId === role.id);
    if (
      !observation ||
      observation.sourceUrl !== role.exactUrl ||
      observation.indexUrl !== exactDayIndexUrl(role) ||
      !Number.isFinite(Date.parse(observation.checkedAt)) ||
      ![
        'indexed-candidate-unverified',
        'no-indexed-200-capture',
        'http-unavailable',
        'invalid-index',
        'request-failed',
      ].includes(observation.outcome)
    )
      throw Error(`Wrong archive identity or status: ${role.id}`);

    const encoded = observation.responseBodyBase64;
    let bytes: Buffer | undefined;
    if (encoded !== undefined) {
      if (observation.responseBodyOmittedReason !== undefined)
        throw Error(`Contradictory CDX response storage: ${role.id}`);
      if (
        typeof encoded !== 'string' ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)
      )
        throw Error(`Malformed recorded CDX bytes: ${role.id}`);
      bytes = Buffer.from(encoded, 'base64');
      if (
        bytes.length === 0 ||
        bytes.length > MAX_INLINE_INDEX_BYTES ||
        bytes.toString('base64') !== encoded ||
        observation.responseBytes !== bytes.length ||
        observation.responseSha256 !== sha256(bytes)
      )
        throw Error(`CDX response bytes/checksum mismatch: ${role.id}`);
    } else if (observation.responseBodyOmittedReason !== undefined) {
      if (
        observation.responseBodyOmittedReason !== 'exceeds-inline-limit' ||
        !Number.isInteger(observation.responseBytes) ||
        observation.responseBytes! <= MAX_INLINE_INDEX_BYTES ||
        observation.responseBytes! > MAX_API_BYTES ||
        !SHA256.test(observation.responseSha256 ?? '')
      )
        throw Error(`Unverifiable omitted CDX response: ${role.id}`);
    }

    if (
      observation.outcome === 'no-indexed-200-capture' ||
      observation.outcome === 'indexed-candidate-unverified'
    ) {
      if (
        observation.httpStatus !== 200 ||
        observation.returnedUrl !== observation.indexUrl ||
        (!bytes && observation.responseBodyOmittedReason !== 'exceeds-inline-limit')
      )
        throw Error(`Unverified archive index result: ${role.id}`);
      // A response above the storage cap remains a nonqualifying diagnostic.
      // Its live classification cannot be reproduced offline from a checksum.
      if (!bytes) continue;
      let indexed: unknown;
      try {
        indexed = JSON.parse(decode(bytes));
      } catch {
        throw Error(`Invalid recorded CDX JSON: ${role.id}`);
      }
      let selected: ReturnType<typeof selectArchiveRow> | undefined;
      try {
        selected = selectArchiveRow(indexed, role.exactUrl!, role.exactArchiveDay);
      } catch (error) {
        if (
          !Array.isArray(indexed) ||
          (indexed.length !== 0 &&
            !(
              error instanceof Error &&
              error.message.startsWith('No indexed 200 capture within required date')
            ))
        )
          throw Error(`Malformed or contradictory CDX inventory: ${role.id}`);
      }
      if (observation.outcome === 'no-indexed-200-capture' && selected)
        throw Error(`Indexed capture mislabeled absent: ${role.id}`);
      if (
        observation.outcome === 'indexed-candidate-unverified' &&
        (!selected ||
          selected.timestamp !== observation.indexedTimestamp ||
          selected.digest !== observation.indexedDigest)
      )
        throw Error(`Archive index candidate does not match original bytes: ${role.id}`);
    }
  }
}

/**
 * Record a nonqualifying audit separately from the runtime fixtures. The
 * evaluator can audit outages, empty inventories and verified Git candidates
 * without creating a partial or misleading scenario snapshot.
 */
export function writeAuditReport(
  report: SourceAuditReport,
  outputDir = join(dirname(fileURLToPath(import.meta.url)), 'source-audits'),
): string {
  if (
    report.kind !== 'nonqualifying-source-audit' ||
    report.schemaVersion !== 1 ||
    !RESEARCH_ROLES[report.scenarioId] ||
    report.candidateProbe.scenarioId !== report.scenarioId ||
    report.candidateProbe.complete ||
    report.candidateProbe.snapshotWritten ||
    !SHA256.test(report.sourcePlanSha256) ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(report.observedAt) ||
    !Number.isFinite(Date.parse(report.observedAt)) ||
    new Date(report.observedAt).toISOString() !== report.observedAt
  )
    throw Error('Invalid or qualifying source audit report');
  verifyRecordedArchiveIndices(report);
  mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  const name = `${report.scenarioId}-${report.observedAt.replace(/[:.]/gu, '-')}-${randomUUID().slice(0, 8)}.json`;
  const staged = mkdtempSync(join(outputDir, '.audit-stage-'));
  const destination = join(outputDir, name);
  try {
    const source = join(staged, name);
    writeFileSync(source, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    linkSync(source, destination); // EEXIST prevents replacing earlier audit evidence.
  } finally {
    rmSync(staged, { recursive: true, force: true });
  }
  return destination;
}

export function loadPlan(path: string, scenarioId: string): SourceCandidate[] {
  const plan: SourcePlan = JSON.parse(readFileSync(path, 'utf8'));
  if (plan.schemaVersion !== 1 || !Array.isArray(plan.cases)) throw Error('Invalid source plan');
  const matches = plan.cases.filter((item) => item.scenarioId === scenarioId);
  if (matches.length !== 1) throw Error(`Expected one source plan for ${scenarioId}`);
  verifyRoleInventory(scenarioId, matches[0]!.sources);
  return matches[0]!.sources;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, ...args] = process.argv.slice(2);
  const flag = (name: string) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  try {
    if (!['probe', 'snapshot', 'audit'].includes(mode ?? '') || !flag('--scenario'))
      throw Error(
        'Usage: bun snapshot-corpus.ts probe|audit|snapshot --scenario <id> [--plan <json>] [--out <absolute-directory for snapshot>]',
      );
    const output = flag('--out');
    if (mode === 'snapshot' && !output) throw Error('Snapshot requires --out');
    if (mode !== 'snapshot' && output) throw Error('Only snapshot accepts --out');
    const planPath =
      flag('--plan') ?? join(dirname(fileURLToPath(import.meta.url)), 'source-corpus-plan.json');
    const scenarioId = flag('--scenario')!;
    const result = await acquireScenario(
      scenarioId,
      loadPlan(planPath, scenarioId),
      mode === 'snapshot' ? output : undefined,
    );
    if (mode === 'audit') {
      const report: SourceAuditReport = {
        schemaVersion: 1,
        kind: 'nonqualifying-source-audit',
        scenarioId,
        observedAt: new Date().toISOString(),
        historicalCutoff: RESEARCH_CUTOFF,
        sourcePlanSha256: sha256(readFileSync(planPath)),
        candidateProbe: result,
        exactDayArchiveIndices: await auditExactDayArchiveIndices(scenarioId),
      };
      const path = writeAuditReport(report);
      console.log(JSON.stringify({ ...report, auditFile: path }, null, 2));
    } else {
      console.log(JSON.stringify(result, null, 2));
    }
    if (!result.complete) process.exitCode = 2;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
