import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  acquireScenario,
  auditExactDayArchiveIndices,
  assertArchiveTemporalScope,
  assertGitPayload,
  cdxDigest,
  gitBlobSha,
  loadPlan,
  selectArchiveRow,
  verifyArchiveBytes,
  verifyRecordedArchiveIndices,
  verifyRoleInventory,
  writeAuditReport,
} from './snapshot-corpus';

// All hashes/rows created inside these tests describe CONTROLLED DATA only.
// They are never presented as historical source captures or written to a corpus.
const planPath = fileURLToPath(new URL('./source-corpus-plan.json', import.meta.url));
const observedOutagePath = fileURLToPath(
  new URL(
    './source-audits/research-full-task-1-individual-2026-10-12T00-05-23-351Z-9bbac984.json',
    import.meta.url,
  ),
);
const scenario1 = 'research-full-task-1-individual';
const scenario2 = 'research-full-task-2-individual';
const archiveUrl = 'https://agentskills.io/specification';
const body = Buffer.from('CONTROLLED BYTE VALIDATION ONLY. '.repeat(12));
const digest = cdxDigest(body);
const indexHeader = ['timestamp', 'original', 'statuscode', 'digest'];
const workdirs: string[] = [];

afterEach(() => {
  for (const path of workdirs.splice(0)) rmSync(path, { force: true, recursive: true });
});

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), 'research-source-acquisition-test-'));
  workdirs.push(path);
  return path;
}

function plan(id: string): any[] {
  return structuredClone(loadPlan(planPath, id));
}

describe('research historical acquisition sidecar', () => {
  test('saved live archive outage retains independently checkable wire bytes without provenance credit', () => {
    const report = JSON.parse(readFileSync(observedOutagePath, 'utf8'));
    expect(() => verifyRecordedArchiveIndices(report)).not.toThrow();
    expect(report.kind).toBe('nonqualifying-source-audit');
    expect(report.candidateProbe.complete).toBe(false);
    expect(report.candidateProbe.snapshotWritten).toBe(false);
    expect(report.exactDayArchiveIndices.map((item: any) => item.roleId)).toEqual([
      'agent-skills-spec',
      'cursor-skills-docs',
    ]);
    for (const observed of report.exactDayArchiveIndices) {
      expect(observed.outcome).toBe('http-unavailable');
      expect(observed.httpStatus).toBe(503);
      const bytes = Buffer.from(observed.responseBodyBase64, 'base64');
      expect(bytes.length).toBe(11832);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(observed.responseSha256);
      expect(bytes.toString('utf8')).toContain('Temporarily Offline');
      expect(observed.indexedDigest).toBeUndefined();
    }
  });

  test('records exact URL/day CDX outages without claiming zero captures', async () => {
    const urls: string[] = [];
    const request = (async (url: string) => {
      urls.push(url);
      const response = new Response('<html>Internet Archive: Temporarily Offline</html>', {
        status: 503,
      });
      Object.defineProperty(response, 'url', { value: url });
      return response;
    }) as typeof fetch;
    const indices = await auditExactDayArchiveIndices(scenario1, request);
    expect(indices).toHaveLength(2);
    expect(indices.map((row) => row.outcome)).toEqual(['http-unavailable', 'http-unavailable']);
    expect(indices.every((row) => row.httpStatus === 503 && row.responseBytes! > 0)).toBe(true);
    expect(indices.every((row) => /^[0-9a-f]{64}$/u.test(row.responseSha256 ?? ''))).toBe(true);
    expect(
      indices.every(
        (row) =>
          Buffer.from(row.responseBodyBase64 ?? '', 'base64').toString('utf8') ===
          '<html>Internet Archive: Temporarily Offline</html>',
      ),
    ).toBe(true);
    expect(indices.every((row) => !row.indexedTimestamp && !row.indexedDigest)).toBe(true);
    for (const url of urls) {
      const parsed = new URL(url);
      expect(parsed.hostname).toBe('web.archive.org');
      expect(parsed.searchParams.get('from')).toBe('20260904');
      expect(parsed.searchParams.get('to')).toBe('20260904');
    }
    expect(new Set(urls.map((url) => new URL(url).searchParams.get('url')))).toEqual(
      new Set(['https://agentskills.io/specification', 'https://cursor.com/docs/skills']),
    );
  });

  test('distinguishes genuinely empty indices, unverified candidates, and malformed responses', async () => {
    const archive = (body: string, url: string) => {
      const response = new Response(body, { status: 200 });
      Object.defineProperty(response, 'url', { value: url });
      return response;
    };
    const empty = await auditExactDayArchiveIndices(scenario1, (async (url: string) =>
      archive('[]', url)) as typeof fetch);
    expect(empty.map((row) => row.outcome)).toEqual([
      'no-indexed-200-capture',
      'no-indexed-200-capture',
    ]);
    expect(empty.map((row) => Buffer.from(row.responseBodyBase64!, 'base64').toString())).toEqual([
      '[]',
      '[]',
    ]);
    const headerOnly = await auditExactDayArchiveIndices(scenario1, (async (url: string) =>
      archive(JSON.stringify([indexHeader]), url)) as typeof fetch);
    expect(headerOnly.every((row) => row.outcome === 'no-indexed-200-capture')).toBe(true);
    const candidates = await auditExactDayArchiveIndices(scenario1, (async (url: string) => {
      const roleUrl = new URL(url).searchParams.get('url');
      return archive(
        JSON.stringify([indexHeader, ['20260904120000', roleUrl, '200', digest]]),
        url,
      );
    }) as typeof fetch);
    expect(candidates.every((row) => row.outcome === 'indexed-candidate-unverified')).toBe(true);
    expect(candidates.every((row) => row.indexedTimestamp === '20260904120000')).toBe(true);
    expect(candidates.every((row) => row.indexedDigest === digest)).toBe(true);
    const malformed = await auditExactDayArchiveIndices(scenario1, (async (url: string) =>
      archive('{bad json', url)) as typeof fetch);
    expect(malformed.every((row) => row.outcome === 'invalid-index')).toBe(true);
    const requestNever = (async () => {
      throw Error('Scenario 2 has no exact-day archive roles');
    }) as typeof fetch;
    expect(await auditExactDayArchiveIndices(scenario2, requestNever)).toEqual([]);
  });

  test('a network error remains unknown and the audit is outside runtime fixtures', async () => {
    const indices = await auditExactDayArchiveIndices(scenario1, (async () => {
      throw Error('CONTROLLED outage');
    }) as typeof fetch);
    expect(indices.every((row) => row.outcome === 'request-failed')).toBe(true);
    expect(indices.every((row) => row.detail === 'CONTROLLED outage')).toBe(true);
    const dir = directory();
    const report = {
      schemaVersion: 1 as const,
      kind: 'nonqualifying-source-audit' as const,
      scenarioId: scenario1,
      observedAt: '2026-10-11T18:40:00.000Z',
      historicalCutoff: '2026-09-04T23:59:59Z' as const,
      sourcePlanSha256: '0'.repeat(64),
      candidateProbe: {
        scenarioId: scenario1,
        observedAt: '2026-10-11T18:40:00.000Z',
        complete: false,
        snapshotWritten: false,
        observations: [],
      },
      exactDayArchiveIndices: indices,
    };
    const saved = writeAuditReport(report, dir);
    expect(JSON.parse(readFileSync(saved, 'utf8')).kind).toBe('nonqualifying-source-audit');
    expect(readdirSync(dir)).toHaveLength(1);
    expect(() =>
      writeAuditReport(
        { ...report, candidateProbe: { ...report.candidateProbe, snapshotWritten: true } },
        dir,
      ),
    ).toThrow(/Invalid or qualifying/);
    expect(readdirSync(dir)).toHaveLength(1);
  });

  test('verifies original CDX index bytes in an offline audit, including honest empty inventory', async () => {
    const observations = await auditExactDayArchiveIndices(scenario1, (async (url: string) => {
      const response = new Response('[]\n', { status: 200 });
      Object.defineProperty(response, 'url', { value: url });
      return response;
    }) as typeof fetch);
    const report = {
      schemaVersion: 1 as const,
      kind: 'nonqualifying-source-audit' as const,
      scenarioId: scenario1,
      observedAt: '2026-10-11T20:00:00.000Z',
      historicalCutoff: '2026-09-04T23:59:59Z' as const,
      sourcePlanSha256: 'a'.repeat(64),
      candidateProbe: {
        scenarioId: scenario1,
        observedAt: '2026-10-11T20:00:00.000Z',
        complete: false,
        snapshotWritten: false,
        observations: [],
      },
      exactDayArchiveIndices: observations,
    };
    expect(() => verifyRecordedArchiveIndices(report)).not.toThrow();
    const saved = writeAuditReport(report, directory());
    const loaded = JSON.parse(readFileSync(saved, 'utf8'));
    expect(loaded.exactDayArchiveIndices).toHaveLength(2);
    expect(
      loaded.exactDayArchiveIndices.every(
        (row: any) =>
          row.responseBytes === 3 &&
          row.responseSha256 ===
            '37517e5f3dc66819f61f5a7bb8ace1921282415f10551d2defa5c3eb0985b570' &&
          Buffer.from(row.responseBodyBase64, 'base64').equals(Buffer.from('[]\n')),
      ),
    ).toBe(true);

    // The mock responses are controlled validation input. They are not Internet Archive evidence.
    for (const mutate of [
      (rows: any[]) => {
        rows[0].responseSha256 = '0'.repeat(64);
      },
      (rows: any[]) => {
        rows[0].responseBytes += 1;
      },
      (rows: any[]) => {
        rows[0].responseBodyBase64 = Buffer.from('{}').toString('base64');
      },
      (rows: any[]) => {
        rows[0].indexUrl = rows[0].indexUrl.replace('20260904', '20260903');
      },
      (rows: any[]) => {
        rows[0].sourceUrl = 'https://agentskills.io/other';
      },
      (rows: any[]) => {
        rows[0].returnedUrl = 'https://web.archive.org/unrelated';
      },
      (rows: any[]) => {
        rows[0].httpStatus = 503;
      },
      (rows: any[]) => {
        rows[0].outcome = 'indexed-candidate-unverified';
      },
      (rows: any[]) => {
        rows[1] = { ...rows[0] };
      },
    ]) {
      const changed = structuredClone(report);
      mutate(changed.exactDayArchiveIndices);
      expect(() => writeAuditReport(changed, directory())).toThrow();
    }
    const misreported = structuredClone(report);
    const response = Buffer.from(
      JSON.stringify([indexHeader, ['20260904120000', archiveUrl, '200', digest]]),
    );
    misreported.exactDayArchiveIndices[0] = {
      ...misreported.exactDayArchiveIndices[0]!,
      responseBytes: response.length,
      responseSha256: createHash('sha256').update(response).digest('hex'),
      responseBodyBase64: response.toString('base64'),
    };
    expect(() => verifyRecordedArchiveIndices(misreported)).toThrow(/mislabeled absent/);
    expect(() =>
      writeAuditReport(
        {
          ...report,
          candidateProbe: {
            ...report.candidateProbe,
            complete: true,
          },
        },
        directory(),
      ),
    ).toThrow(/Invalid or qualifying/);
  });

  test('preserves large response hashes while clearly flagging unavailable offline replay', async () => {
    const oversized = JSON.stringify([
      indexHeader,
      ...Array.from({ length: 450 }, (_, i) => [
        '20260904120000',
        `https://unrelated.example.org/post/${i.toString().padStart(5, '0')}`,
        '200',
        digest,
      ]),
    ]);
    expect(Buffer.byteLength(oversized)).toBeGreaterThan(32768);
    const indices = await auditExactDayArchiveIndices(scenario1, (async (url: string) => {
      const response = new Response(oversized, { status: 200 });
      Object.defineProperty(response, 'url', { value: url });
      return response;
    }) as typeof fetch);
    expect(indices.every((row) => row.outcome === 'no-indexed-200-capture')).toBe(true);
    expect(
      indices.every(
        (row) =>
          row.responseBodyOmittedReason === 'exceeds-inline-limit' &&
          row.responseBodyBase64 === undefined &&
          row.responseSha256 === createHash('sha256').update(oversized).digest('hex'),
      ),
    ).toBe(true);
    const report = {
      schemaVersion: 1 as const,
      kind: 'nonqualifying-source-audit' as const,
      scenarioId: scenario1,
      observedAt: '2026-10-11T20:00:00.000Z',
      historicalCutoff: '2026-09-04T23:59:59Z' as const,
      sourcePlanSha256: 'a'.repeat(64),
      candidateProbe: {
        scenarioId: scenario1,
        observedAt: '2026-10-11T20:00:00.000Z',
        complete: false,
        snapshotWritten: false,
        observations: [],
      },
      exactDayArchiveIndices: indices,
    };
    expect(() => verifyRecordedArchiveIndices(report)).not.toThrow();
    const altered = structuredClone(report);
    altered.exactDayArchiveIndices[0]!.responseBytes = 3;
    expect(() => verifyRecordedArchiveIndices(altered)).toThrow(/Unverifiable omitted/);
  });
  test('loads exact role inventories without converting unresolved sources into verified snapshots', () => {
    const first = plan(scenario1);
    const second = plan(scenario2);
    expect(first.map((row) => row.id)).toEqual([
      'agent-skills-spec',
      'cursor-skills-docs',
      'community-client-extension',
      'pre-support-internal-note',
    ]);
    expect(second.map((row) => row.id)).toEqual([
      'protocol-spec',
      'official-migration',
      'legacy-vendor-tutorial',
      'current-vendor-compatibility',
      'contradictory-forum-answer',
    ]);
    expect(first.every((row) => row.kind === 'unresolved')).toBe(true);
    expect(second.filter((row) => row.kind === 'github-commit')).toHaveLength(3);
    expect(second.filter((row) => row.kind === 'unresolved')).toHaveLength(2);
  });

  test('requires one unique candidate per role and rejects changed source origins', () => {
    const first = plan(scenario1);
    expect(() => verifyRoleInventory(scenario1, first.slice(1))).toThrow(/Incomplete/);
    expect(() => verifyRoleInventory(scenario1, [first[0], first[0], ...first.slice(2)])).toThrow(
      /duplicated/,
    );
    first[0] = {
      id: 'agent-skills-spec',
      kind: 'internet-archive',
      publisher: 'example',
      versionScope: '2026-09-04',
      claimQuote: 'A controlled quote of adequate length.',
      sourceUrl: 'https://agentskills.io/other-page',
    };
    expect(() => verifyRoleInventory(scenario1, first)).toThrow(/Wrong source origin/);
    first[0].sourceUrl = 'http://agentskills.io/specification';
    expect(() => verifyRoleInventory(scenario1, first)).toThrow(/Noncanonical HTTPS/);
  });

  test('requires pinned, historically dated Git commits and consequential literal quotes', () => {
    const second = plan(scenario2);
    second[0].expectedCommitDate = '2026-09-05T00:00:00Z';
    expect(() => verifyRoleInventory(scenario2, second)).toThrow(/cutoff/);
    second[0].expectedCommitDate = '2026-02-30T12:00:00Z';
    expect(() => verifyRoleInventory(scenario2, second)).toThrow(/invalid/);
    second[0].expectedCommitDate = '2026-07-29T18:19:34Z';
    second[0].expectedBlobSha = 'unknown';
    expect(() => verifyRoleInventory(scenario2, second)).toThrow(/Unpinned/);
    second[0].expectedBlobSha = '452d78601b135b95bbe45287e756c0579534096b';
    second[0].claimQuote = 'too short';
    expect(() => verifyRoleInventory(scenario2, second)).toThrow(/Verbatim/);
  });

  test('rejects wrong protocol ancestry, vendor mismatch, and an invalid Git path', () => {
    const second = plan(scenario2);
    second[0].path = 'docs/specification/2025-11-25/index.mdx';
    expect(() => verifyRoleInventory(scenario2, second)).toThrow(/normative/);
    second[0].path = 'docs/specification/2026-07-28/../index.mdx';
    expect(() => verifyRoleInventory(scenario2, second)).toThrow(/Unpinned/);
    second[0].path = 'docs/specification/2026-07-28/index.mdx';
    // These are role-validation inputs, not claims that this is a vendor compatibility document.
    second[3] = { ...second[1], id: 'current-vendor-compatibility' };
    expect(() => verifyRoleInventory(scenario2, second)).toThrow(/same vendor/);
  });

  test('archive index enforces the exact date, historical cutoff, status and original URL', () => {
    const rows = [
      indexHeader,
      ['20260903235959', archiveUrl, '200', digest],
      ['20260904110000', archiveUrl, '200', digest],
      ['20260904140000', archiveUrl, '200', digest],
      ['20260904235959', archiveUrl, '404', digest],
      ['20260905000000', archiveUrl, '200', digest],
      ['20260904150000', 'https://agentskills.io/other', '200', digest],
    ];
    expect(selectArchiveRow(rows, archiveUrl, '20260904')).toEqual({
      timestamp: '20260904140000',
      digest,
    });
    expect(() => selectArchiveRow(rows, archiveUrl, '20260902')).toThrow(/No indexed 200 capture/);
    expect(() => selectArchiveRow([indexHeader, rows[5]], archiveUrl)).toThrow(
      /No indexed 200 capture/,
    );
    expect(() => selectArchiveRow([], archiveUrl)).toThrow(/No CDX index/);
  });

  test('rejects impossible calendar dates, missing index columns and ambiguous capture hashes', () => {
    const badDate = [indexHeader, ['20260230010101', archiveUrl, '200', digest]];
    expect(() => selectArchiveRow(badDate, archiveUrl)).toThrow(/No indexed/);
    expect(() => selectArchiveRow([['timestamp', 'original', 'digest']], archiveUrl)).toThrow(
      /missing required columns/,
    );
    const collision = [
      indexHeader,
      ['20260904110000', archiveUrl, '200', digest],
      ['20260904110000', archiveUrl, '200', 'A'.repeat(32)],
    ];
    expect(() => selectArchiveRow(collision, archiveUrl)).toThrow(/Conflicting independent hashes/);
  });

  test("archive provenance must belong to the scenario role's actual protocol window", () => {
    expect(() => assertArchiveTemporalScope('protocol-spec', '20260727235959')).toThrow(
      /predates final revision/,
    );
    expect(() => assertArchiveTemporalScope('official-migration', '20260728000000')).not.toThrow();
    expect(() => assertArchiveTemporalScope('legacy-vendor-tutorial', '20260728000000')).toThrow(
      /postdates final revision/,
    );
    expect(() =>
      assertArchiveTemporalScope('legacy-vendor-tutorial', '20260727235959'),
    ).not.toThrow();
    expect(() => assertArchiveTemporalScope('agent-skills-spec', '20260903235959')).toThrow(
      /Exact September 4/,
    );
    expect(() => assertArchiveTemporalScope('cursor-skills-docs', '20260904120000')).not.toThrow();
    expect(() =>
      assertArchiveTemporalScope('contradictory-forum-answer', '20260905000000'),
    ).toThrow(/post-cutoff/);
  });

  test('checks original response bytes against CDX SHA-1/base32 and pinned Git blob identity', () => {
    expect(digest).toMatch(/^[A-Z2-7]{32}$/);
    expect(() => verifyArchiveBytes(body, digest)).not.toThrow();
    expect(() => verifyArchiveBytes(Buffer.from(`${body.toString()}changed`), digest)).toThrow(
      /Archive replay differs/,
    );
    expect(() => verifyArchiveBytes(body, 'A'.repeat(32))).toThrow(/Archive replay differs/);
    const blob = gitBlobSha(body);
    expect(blob).toMatch(/^[0-9a-f]{40}$/);
    expect(() => assertGitPayload(body, blob)).not.toThrow();
    expect(() => assertGitPayload(Buffer.concat([body, Buffer.from('tampered')]), blob)).toThrow(
      /Git contents do not match/,
    );
    expect(() =>
      assertGitPayload(Buffer.from([0xff, ...body]), gitBlobSha(Buffer.from([0xff, ...body]))),
    ).toThrow(/Invalid byte sequence/);
  });

  test('an incomplete corpus never creates sources, manifests, or modifies existing files', async () => {
    const path = directory();
    writeFileSync(join(path, 'keep.txt'), 'user-owned file');
    const observed = await acquireScenario(scenario1, plan(scenario1), path);
    expect(observed.complete).toBe(false);
    expect(observed.snapshotWritten).toBe(false);
    expect(observed.observations).toHaveLength(4);
    expect(observed.observations.every((row) => row.status === 'unresolved')).toBe(true);
    expect(readdirSync(path)).toEqual(['keep.txt']);
    expect(readFileSync(join(path, 'keep.txt'), 'utf8')).toBe('user-owned file');
  });
});
