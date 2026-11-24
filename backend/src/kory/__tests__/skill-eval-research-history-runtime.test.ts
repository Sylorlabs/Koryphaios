import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFixtureFile } from '../../eval/skills/skill-eval-fixture-helpers';
import type { SkillEvalScenarioV3 } from '../../eval/skills/skill-eval-harness';
import {
  RESEARCH_HISTORY_CASES,
  RESEARCH_HISTORY_SKILL_EVAL_MATERIALIZERS,
  RESEARCH_HISTORY_SKILL_EVAL_SCORERS,
  materializeResearchHistory,
  researchHistoryLocalBlockers,
  researchHistoryReadinessBlockers,
  VERIFICATION_MAX_AGE_MS,
  scoreResearchHistory,
  verifyResearchHistoryCorpus,
} from '../../eval/skills/skill-eval-research-history-runtime';

// Every test source below is GENERATED CONTROLLED DATA. None of these bodies or
// metadata purport to be real historical captures or publisher attestations.
const directories: string[] = [];
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), 'kory-research-history-test-'));
  directories.push(path);
  return path;
}

function scenario(index: 0 | 1): SkillEvalScenarioV3 {
  const item = RESEARCH_HISTORY_CASES[index]!;
  return {
    id: item.scenarioId,
    skill: 'research',
    category: 'full-task',
    prompt: '',
    expectedSelection: true,
    expectedSkills: [],
    forbiddenSkills: [],
    heldOut: true,
    adjacentSkills: [],
    tags: [],
    environment: {
      kind: 'synthetic',
      startingState: item.startingState,
      requirements: [...item.requiredEnvironment],
    },
    falsifiableChecks: [],
    scorers: [],
    requiredEvidence: [],
    requiredArtifacts: [],
  };
}

const gitRevision = 'a'.repeat(40);
const text = (name: string) =>
  `CONTROLLED TEST ONLY. ${name}: This is a deliberately fabricated ` +
  'input used to ensure provenance checks refuse unsupported historical claims. '.repeat(4);

function syntheticManifest(index: 0 | 1): {
  schemaVersion: 1;
  scenarioId: string;
  sourceRecords: any[];
} {
  const item = RESEARCH_HISTORY_CASES[index]!;
  const sourceRecords = item.sources.map((spec) => {
    const revision =
      spec.id === 'legacy-vendor-tutorial'
        ? 'c'.repeat(40)
        : spec.id === 'current-vendor-compatibility'
          ? 'd'.repeat(40)
          : gitRevision;
    const repository =
      spec.id === 'protocol-spec'
        ? 'modelcontextprotocol/modelcontextprotocol'
        : spec.id === 'official-migration'
          ? 'modelcontextprotocol/typescript-sdk'
          : spec.id === 'pre-support-internal-note'
            ? 'acme/internal'
            : 'microsoft/mcp-for-beginners';
    const repoPath =
      spec.id === 'protocol-spec'
        ? 'docs/specification/2026-07-28/example.mdx'
        : spec.id === 'official-migration'
          ? 'docs/migration/support-2026-07-28.md'
          : spec.id === 'legacy-vendor-tutorial'
            ? 'guides/2025-11-25/legacy.md'
            : spec.id === 'current-vendor-compatibility'
              ? 'guides/2026-07-28/compatibility.md'
              : 'notes/cursor.md';
    const sourceUrl =
      spec.sourceUrl ??
      (spec.id === 'community-client-extension'
        ? 'https://forum.cursor.com/t/agent-skill-client-extension'
        : spec.id === 'contradictory-forum-answer'
          ? 'https://stackoverflow.com/questions/1234/example'
          : `https://github.com/${repository}/blob/${revision}/${repoPath}`);
    const isArchive = spec.allowedProvenance[0] === 'internet-archive';
    const content = text(spec.id);
    const blobSha = createHash('sha1')
      .update(`blob ${Buffer.byteLength(content)}\0`)
      .update(content)
      .digest('hex');
    const versionScope =
      spec.id === 'legacy-vendor-tutorial'
        ? '2025-11-25'
        : ['protocol-spec', 'official-migration', 'current-vendor-compatibility'].includes(spec.id)
          ? '2026-07-28'
          : 'CONTROLLED TEST version';
    return {
      id: spec.id,
      sourceUrl,
      file: `${spec.id}.txt`,
      sha256: createHash('sha256').update(content).digest('hex'),
      publisher: `CONTROLLED TEST publisher ${spec.id}`,
      versionScope,
      provenance: isArchive
        ? {
            kind: 'internet-archive',
            timestamp: `${(spec.archivedOn ?? '2026-09-04').replaceAll('-', '')}120000`,
          }
        : { kind: 'github-commit', repository, revision, blobSha, path: repoPath },
    };
  });
  return { schemaVersion: 1, scenarioId: item.scenarioId, sourceRecords };
}

function setupFakeCorpus(index: 0 | 1): {
  dir: string;
  manifest: ReturnType<typeof syntheticManifest>;
} {
  const dir = directory();
  const manifest = syntheticManifest(index);
  writeFixtureFile(dir, `${manifest.scenarioId}.json`, JSON.stringify(manifest));
  for (const entry of manifest.sourceRecords) writeFixtureFile(dir, entry.file, text(entry.id));
  return { dir, manifest };
}

const base32Digest = (data: string): string => {
  const binary = [...createHash('sha1').update(data).digest()]
    .map((byte) => byte.toString(2).padStart(8, '0'))
    .join('');
  const digits = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  return (binary.match(/.{1,5}/gu) ?? [])
    .map((bits) => digits[Number.parseInt(bits.padEnd(5, '0'), 2)])
    .join('');
};

function controlledSourcesRequest(
  manifest: ReturnType<typeof syntheticManifest>,
  invalidDigest = false,
) {
  const observed: string[] = [];
  const response = (url: string, data: unknown) => {
    const result = new Response(typeof data === 'string' ? data : JSON.stringify(data), {
      status: 200,
    });
    Object.defineProperty(result, 'url', { value: url });
    return result;
  };
  return {
    observed,
    request: async (url: string): Promise<Response> => {
      observed.push(url);
      const parsed = new URL(url);
      if (parsed.pathname === '/cdx/search/cdx') {
        const sourceUrl = parsed.searchParams.get('url');
        const record = manifest.sourceRecords.find((row) => row.sourceUrl === sourceUrl);
        if (!record) throw Error('Unknown controlled archive source');
        const digest = invalidDigest ? 'A'.repeat(32) : base32Digest(text(record.id));
        return response(url, [
          ['timestamp', 'original', 'statuscode', 'digest'],
          [record.provenance.timestamp, record.sourceUrl, '200', digest],
        ]);
      }
      if (parsed.pathname.startsWith('/web/')) {
        const record = manifest.sourceRecords.find((row) => url.endsWith(row.sourceUrl));
        if (!record) throw Error('Unknown controlled archive replay');
        return response(url, text(record.id));
      }
      const source = manifest.sourceRecords.find(
        (row) =>
          row.provenance.kind === 'github-commit' &&
          parsed.pathname.includes(`/repos/${row.provenance.repository}/`) &&
          (parsed.pathname.endsWith(`/commits/${row.provenance.revision}`) ||
            parsed.searchParams.get('ref') === row.provenance.revision),
      );
      if (!source) throw Error(`Unknown controlled GitHub URL ${url}`);
      if (parsed.pathname.endsWith(`/commits/${source.provenance.revision}`)) {
        return response(url, {
          sha: source.provenance.revision,
          commit: {
            committer: {
              date:
                source.id === 'legacy-vendor-tutorial'
                  ? '2025-11-26T12:00:00Z'
                  : '2026-08-20T12:00:00Z',
            },
          },
        });
      }
      return response(url, {
        type: 'file',
        path: source.provenance.path,
        sha: source.provenance.blobSha,
        encoding: 'base64',
        content: Buffer.from(text(source.id)).toString('base64'),
      });
    },
  };
}

describe('research-history real-source gate', () => {
  test('covers the two exact tasks and their 4/5 required evidence roles', () => {
    expect(RESEARCH_HISTORY_CASES.map((item) => item.scenarioId)).toEqual([
      'research-full-task-1-individual',
      'research-full-task-2-individual',
    ]);
    expect(RESEARCH_HISTORY_CASES.map((item) => item.sources.length)).toEqual([4, 5]);
    // The archive holds no capture on the 2026-09-04 cutoff itself, so each site
    // names the genuine nearest capture a researcher on that date would have had.
    expect(RESEARCH_HISTORY_CASES[0]!.sources.slice(0, 2).map((entry) => entry.archivedOn)).toEqual(
      ['2026-09-01', '2026-09-02'],
    );
    for (const index of [0, 1] as const) {
      const item = scenario(index);
      expect(RESEARCH_HISTORY_SKILL_EVAL_MATERIALIZERS.some((entry) => entry.matches(item))).toBe(
        true,
      );
      expect(
        RESEARCH_HISTORY_SKILL_EVAL_SCORERS.some((entry) => entry.scenarioIds.includes(item.id)),
      ).toBe(true);
    }
  });

  test('genuine September 4 archives absent: both scenarios fail closed', async () => {
    const corpusRoot = directory();
    for (const index of [0, 1] as const) {
      const item = scenario(index);
      const blockers = researchHistoryLocalBlockers(item, corpusRoot);
      expect(blockers.some((detail) => detail.includes('No original dated research corpus'))).toBe(
        true,
      );
      const status = await verifyResearchHistoryCorpus(item, { corpusRoot });
      expect(status.verified).toBe(false);
      expect(status.sources).toHaveLength(0);
      await expect(materializeResearchHistory(directory(), item, { corpusRoot })).rejects.toThrow(
        'Historical corpus unverified',
      );
      const score = await scoreResearchHistory(item, directory(), { corpusRoot });
      expect(score.passed).toBe(false);
      expect(score.verification).toBe(0);
    }
  });

  test('rejects an invented September 5 capture for the September 4 requirement', () => {
    const { dir, manifest } = setupFakeCorpus(0);
    manifest.sourceRecords[0].provenance.timestamp = '20260905120000';
    writeFixtureFile(dir, `${manifest.scenarioId}.json`, JSON.stringify(manifest));
    expect(researchHistoryLocalBlockers(scenario(0), dir).join(' ')).toContain(
      'Missing exact dated archive capture',
    );
  });

  test('a Git commit before the date cannot substitute for dated Agent Skills site retrieval', () => {
    const { dir, manifest } = setupFakeCorpus(0);
    manifest.sourceRecords[0].provenance = {
      kind: 'github-commit',
      repository: 'agentskills/agentskills',
      revision: gitRevision,
      path: 'docs/specification.mdx',
      blobSha: 'b'.repeat(40),
    };
    writeFixtureFile(dir, `${manifest.scenarioId}.json`, JSON.stringify(manifest));
    expect(researchHistoryLocalBlockers(scenario(0), dir).join(' ')).toContain(
      'Missing/invalid source metadata',
    );
  });

  test('rejects modified bytes, missing sources, and unsafe file paths before network', async () => {
    const { dir, manifest } = setupFakeCorpus(0);
    writeFixtureFile(dir, manifest.sourceRecords[1].file, 'TAMPERED content');
    expect(researchHistoryLocalBlockers(scenario(0), dir).join(' ')).toContain(
      'Source bytes absent, changed',
    );
    writeFixtureFile(dir, manifest.sourceRecords[1].file, text(manifest.sourceRecords[1].id));
    manifest.sourceRecords[1].file = '../outside.txt';
    writeFixtureFile(dir, `${manifest.scenarioId}.json`, JSON.stringify(manifest));
    expect(researchHistoryLocalBlockers(scenario(0), dir).join(' ')).toContain(
      'Missing/invalid source metadata',
    );
    manifest.sourceRecords.splice(2, 1);
    writeFixtureFile(dir, `${manifest.scenarioId}.json`, JSON.stringify(manifest));
    const status = await verifyResearchHistoryCorpus(scenario(0), { corpusRoot: dir });
    expect(status.verified).toBe(false);
    expect(status.blockers.join(' ')).toContain('Incomplete historical source inventory');
  });

  test('controlled, synthetic HTTP sources can never certify historical authenticity', async () => {
    const { dir } = setupFakeCorpus(0);
    // The fake corpus is syntactically complete; qualification still requires
    // third-party archive and Git evidence observed independently.
    expect(researchHistoryLocalBlockers(scenario(0), dir)).toEqual([]);
    const requested: string[] = [];
    const request = async (url: string) => {
      requested.push(url);
      const response = new Response('CONTROLLED TEST: service unavailable', { status: 503 });
      Object.defineProperty(response, 'url', { value: url });
      return response;
    };
    const status = await verifyResearchHistoryCorpus(scenario(0), { corpusRoot: dir, request });
    expect(requested[0]).toStartWith('https://web.archive.org/cdx/search/cdx?');
    expect(status.verified).toBe(false);
    expect(status.blockers.join(' ')).toContain('Historical provenance unavailable');
    await expect(
      materializeResearchHistory(directory(), scenario(0), { corpusRoot: dir, request }),
    ).rejects.toThrow('Historical corpus unverified');
  });

  test('a fabricated manifest cannot make readiness green, and only a recorded observation can', () => {
    const { dir, manifest } = setupFakeCorpus(0);
    expect(researchHistoryLocalBlockers(scenario(0), dir)).toEqual([]);
    // Locally consistent bytes are not provenance, so nothing is green yet.
    expect(researchHistoryReadinessBlockers(scenario(0), dir).join(' ')).toContain(
      'Independent provenance has not been recorded',
    );
    // A record that no independent observation produced still cannot certify, because
    // it is only written by the verification path; here it is written directly to prove
    // that the record is checked against the corpus bytes rather than trusted blindly.
    writeFixtureFile(
      dir,
      `${manifest.scenarioId}.verified.json`,
      JSON.stringify({
        schemaVersion: 1,
        scenarioId: manifest.scenarioId,
        verifiedAt: new Date().toISOString(),
        sources: manifest.sourceRecords.map((row) => ({ id: row.id, sha256: 'f'.repeat(64) })),
      }),
    );
    expect(researchHistoryReadinessBlockers(scenario(0), dir).join(' ')).toContain(
      'no longer matches the corpus bytes',
    );
    writeFixtureFile(
      dir,
      `${manifest.scenarioId}.verified.json`,
      JSON.stringify({
        schemaVersion: 1,
        scenarioId: manifest.scenarioId,
        verifiedAt: new Date(Date.now() - VERIFICATION_MAX_AGE_MS - 60_000).toISOString(),
        sources: manifest.sourceRecords.map((row) => ({ id: row.id, sha256: row.sha256 })),
      }),
    );
    expect(researchHistoryReadinessBlockers(scenario(0), dir).join(' ')).toContain('is stale');
    writeFixtureFile(
      dir,
      `${manifest.scenarioId}.verified.json`,
      JSON.stringify({
        schemaVersion: 1,
        scenarioId: manifest.scenarioId,
        verifiedAt: new Date().toISOString(),
        sources: manifest.sourceRecords.map((row) => ({ id: row.id, sha256: row.sha256 })),
      }),
    );
    expect(researchHistoryReadinessBlockers(scenario(0), dir)).toEqual([]);
  });

  test('controlled archive hashes and pinned Git blobs exercise validation without conferring provenance', async () => {
    for (const index of [0, 1] as const) {
      const { dir, manifest } = setupFakeCorpus(index);
      const transport = controlledSourcesRequest(manifest);
      const status = await verifyResearchHistoryCorpus(scenario(index), {
        corpusRoot: dir,
        request: transport.request,
      });
      expect(status.verified).toBe(false);
      expect(status.sources).toEqual([]);
      expect(status.blockers.join(' ')).toContain('CONTROLLED TEST TRANSPORT');
      expect(transport.observed.some((url) => url.includes('web.archive.org/cdx/'))).toBe(true);
      expect(transport.observed.some((url) => url.includes('api.github.com/repos/'))).toBe(true);
    }
  });

  test('archive digest mismatch is rejected even when replay and local bytes match', async () => {
    const { dir, manifest } = setupFakeCorpus(0);
    const transport = controlledSourcesRequest(manifest, true);
    const status = await verifyResearchHistoryCorpus(scenario(0), {
      corpusRoot: dir,
      request: transport.request,
    });
    expect(status.verified).toBe(false);
    expect(status.blockers.join(' ')).toContain('Archive replay bytes differ');
  });

  test('current revision evidence cannot predate the published current revision', () => {
    const { dir, manifest } = setupFakeCorpus(1);
    manifest.sourceRecords[0].provenance = {
      kind: 'internet-archive',
      timestamp: '20260501000000',
    };
    manifest.sourceRecords[0].sourceUrl =
      'https://modelcontextprotocol.io/specification/2026-07-28';
    writeFixtureFile(dir, `${manifest.scenarioId}.json`, JSON.stringify(manifest));
    expect(researchHistoryLocalBlockers(scenario(1), dir).join(' ')).toContain(
      'Current protocol source predates final revision',
    );
  });

  test('rejects mismatched vendor histories and unpinned Git URLs', () => {
    const { dir, manifest } = setupFakeCorpus(1);
    manifest.sourceRecords[3].provenance.repository = 'modelcontextprotocol/typescript-sdk';
    manifest.sourceRecords[3].sourceUrl = `https://github.com/modelcontextprotocol/typescript-sdk/blob/${manifest.sourceRecords[3].provenance.revision}/${manifest.sourceRecords[3].provenance.path}`;
    writeFixtureFile(dir, `${manifest.scenarioId}.json`, JSON.stringify(manifest));
    expect(researchHistoryLocalBlockers(scenario(1), dir).join(' ')).toContain('same vendor');
    manifest.sourceRecords[3].provenance.repository = 'microsoft/mcp-for-beginners';
    manifest.sourceRecords[3].sourceUrl =
      'https://github.com/microsoft/mcp-for-beginners/blob/main/guides/2026-07-28/compatibility.md';
    writeFixtureFile(dir, `${manifest.scenarioId}.json`, JSON.stringify(manifest));
    expect(researchHistoryLocalBlockers(scenario(1), dir).join(' ')).toContain('Pinned GitHub URL');
  });

  test('refuses scope drift and altered historical scenario requirements', async () => {
    const dir = directory();
    const task = scenario(1);
    task.environment.requirements = [
      ...task.environment.requirements,
      'shortcut: rely on web snippets',
    ];
    expect(researchHistoryLocalBlockers(task, dir).join(' ')).toContain('contract changed');
    const status = await verifyResearchHistoryCorpus(task, { corpusRoot: dir });
    expect(status.verified).toBe(false);
  });
});
