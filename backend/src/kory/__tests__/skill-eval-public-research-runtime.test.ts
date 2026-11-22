import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditSkillEvalExecutionReadiness } from '../../eval/skills/skill-eval-execution';
import { readFixtureText, writeFixtureFile } from '../../eval/skills/skill-eval-fixture-helpers';
import {
  BUILTIN_SKILL_EVAL_MATERIALIZERS,
  BUILTIN_SKILL_EVAL_SCORERS,
} from '../../eval/skills/skill-eval-fixtures';
import { buildSkillEvalSuiteV3, type SkillEvalScenarioV3 } from '../../eval/skills/skill-eval-harness';
import {
  EXTERNAL_ENVIRONMENT_SKILL_EVAL_MATERIALIZERS,
  EXTERNAL_ENVIRONMENT_SKILL_EVAL_SCORERS,
} from '../../eval/skills/skill-eval-external-environment-fixtures';
import {
  PUBLIC_RESEARCH_CASES,
  PUBLIC_RESEARCH_SKILL_EVAL_MATERIALIZERS,
  PUBLIC_RESEARCH_SKILL_EVAL_SCORERS,
  scorePublicResearchRuntime,
} from '../../eval/skills/skill-eval-public-research-runtime';
import { loadV5SkillPackages } from '../skill-packages';

const TIME = '2026-10-09T23:26:00.000Z';
const roots: string[] = [];
const sha = (body: string) => createHash('sha256').update(body).digest('hex');
const excerpt = (body: string) =>
  body
    .replace(/<[^>]*>/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 100);

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface MockSource {
  id: string;
  url: string;
  body: string;
  contentType: string;
  status?: number;
}

const abstract = (subject: string) =>
  `We investigated ${subject} with a clearly identified study population and comparison group. ` +
  'Results varied across groups and required sensitivity checks, with stated limits on generalization to other populations.';

const routeLlm = {
  id: '2406.18665',
  title: 'RouteLLM: Learning to Route LLMs from Preference Data',
  published: '2024-06-26',
  abstract: abstract('routing among language models with model preference observations'),
};
const routerBench = {
  id: '2403.12031',
  title: 'RouterBench: A Benchmark for Multi-LLM Routing System',
  published: '2024-03-18',
  abstract: abstract('routing costs and answer quality across benchmark queries'),
};

function arxivBody(study: typeof routeLlm): string {
  return (
    `<?xml version="1.0"?><feed><opensearch:totalResults>1</opensearch:totalResults>` +
    `<entry><id>http://arxiv.org/abs/${study.id}</id><title>${study.title}</title>` +
    `<published>${study.published}T12:00:00Z</published><summary>${study.abstract}</summary></entry></feed>`
  );
}

const pubmed = [
  {
    id: '33991001',
    title: 'Randomized trial of patient navigation for outreach and timely referrals',
    year: '2023',
  },
  {
    id: '33991002',
    title: 'Randomized controlled trial of navigation services and follow up',
    year: '2024',
  },
];

function pubmedXml(trials = pubmed): string {
  return `<PubmedArticleSet>${trials
    .map(
      (trial) =>
        `<PubmedArticle><MedlineCitation><PMID Version="1">${trial.id}</PMID><Article>` +
        `<ArticleTitle>${trial.title}</ArticleTitle><Abstract><AbstractText>${abstract(trial.title)}</AbstractText></Abstract>` +
        `<ArticleDate DateType="Electronic"><Year>${trial.year}</Year><Month>04</Month><Day>07</Day></ArticleDate>` +
        `<Journal><JournalIssue><PubDate><Year>${trial.year}</Year></PubDate></JournalIssue></Journal></Article>` +
        `<MeshHeadingList><PublicationType>Randomized Controlled Trial</PublicationType></MeshHeadingList>` +
        `</MedlineCitation><PubmedData><ArticleIdList><ArticleId IdType="doi">10.1000/nav.${trial.id}</ArticleId>` +
        `</ArticleIdList></PubmedData></PubmedArticle>`,
    )
    .join('')}</PubmedArticleSet>`;
}

function sourcesFor(scenario: SkillEvalScenarioV3): MockSource[] {
  const task = PUBLIC_RESEARCH_CASES.find((item) => item.id === scenario.id)!;
  if (scenario.skill === 'factual-research') {
    if (task.id.endsWith('1-individual'))
      return [
        {
          id: 'state-department',
          url: task.sources[0]!.url,
          contentType: 'text/html',
          body:
            '<html><body>United States passport renew eligibility: adults can renew by mail or online under certain conditions; ' +
            'some people must use an in-person application. A valid passport from the eligible period and age requirements apply.</body></html>',
        },
        {
          id: 'usagov',
          url: task.sources[1]!.url,
          contentType: 'text/html',
          body:
            '<html><body>How to renew an adult passport: whether you can renew online or by mail depends on your eligibility. ' +
            'Read all passport renewal rules and restrictions before applying to the State Department.</body></html>',
        },
      ];
    return [
      {
        id: 'node-releases',
        url: task.sources[0]!.url,
        contentType: 'text/html',
        body:
          '<html><body>Node.js previous releases: v18 is end-of-life, v22 is supported. ' +
          'All release lines, security periods, and dated maintenance windows are reported on this official page.</body></html>',
      },
      {
        id: 'node-schedule',
        url: task.sources[1]!.url,
        contentType: 'text/plain',
        body: JSON.stringify({
          v18: { start: '2022-04-19', end: '2025-04-30' },
          v22: { start: '2024-04-24', end: '2027-04-30' },
          note: 'The official Node.js lifecycle schedule.',
        }),
      },
    ];
  }
  if (task.id.endsWith('1-individual'))
    return [
      {
        id: 'arxiv-routellm',
        url: task.sources[0]!.url,
        contentType: 'application/atom+xml',
        body: arxivBody(routeLlm),
      },
      {
        id: 'arxiv-record-routellm',
        url: task.sources[1]!.url,
        contentType: 'application/atom+xml',
        body: arxivBody(routeLlm),
      },
      {
        id: 'arxiv-routerbench',
        url: task.sources[2]!.url,
        contentType: 'application/atom+xml',
        body: arxivBody(routerBench),
      },
      {
        id: 'arxiv-record-routerbench',
        url: task.sources[3]!.url,
        contentType: 'application/atom+xml',
        body: arxivBody(routerBench),
      },
    ];
  const search: MockSource = {
    id: 'pubmed-search',
    url: task.sources[0]!.url,
    contentType: 'application/json',
    body: JSON.stringify({
      esearchresult: {
        count: '2',
        idlist: pubmed.map((trial) => trial.id),
        note: 'Public randomized controlled trial search results.',
      },
    }),
  };
  const details: MockSource = {
    id: 'pubmed-trials',
    url: `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=${pubmed.map((trial) => trial.id).join(',')}&retmode=xml`,
    contentType: 'application/xml',
    body: pubmedXml(),
  };
  const metadata: MockSource = {
    id: 'europepmc-trials',
    url:
      'https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=' +
      encodeURIComponent(pubmed.map((trial) => `EXT_ID:${trial.id}`).join(' OR ')) +
      '&format=json&pageSize=10',
    contentType: 'application/json',
    body: JSON.stringify({
      resultList: {
        result: pubmed.map((trial) => ({
          id: trial.id,
          source: 'MED',
          title: trial.title,
          firstPublicationDate: `${trial.year}-04-01`,
        })),
      },
      note: 'Europe PMC search results and indexed study identity.',
    }),
  };
  const control: MockSource = {
    id: 'invalid-eutils-endpoint',
    url: 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/definitely-not-an-endpoint',
    contentType: 'application/json',
    status: 400,
    body: JSON.stringify({ error: "Invalid eutil name 'definitely-not-an-endpoint'" }),
  };
  return [search, details, metadata, control];
}

function transport(sources: MockSource[]) {
  const visits: string[] = [];
  return {
    visits,
    request: async (url: string): Promise<Response> => {
      visits.push(url);
      const source = sources.find((item) => item.url === url);
      const response = new Response(source?.body ?? 'Missing source', {
        status: source?.status ?? (source ? 200 : 404),
        headers: { 'content-type': source?.contentType ?? 'text/plain' },
      });
      // Native fetch sets Response.url. Model it explicitly so redirect checks
      // cannot mistakenly pass from a Response whose origin was never verified.
      Object.defineProperty(response, 'url', { value: url, configurable: true });
      return response;
    },
  };
}

function greenReport(scenario: SkillEvalScenarioV3, sources: MockSource[]) {
  const task = PUBLIC_RESEARCH_CASES.find((item) => item.id === scenario.id)!;
  const boundary = {
    selectedSkill: scenario.skill,
    broaderSkill: 'research',
    adjacentSkill: task.neighbor,
    scope: `Authoritative evidence is bounded to ${task.scope}, with current validation against publisher metadata.`,
    exclusions: [
      'Exclude unrelated commercial claims and source identities that do not independently match this research question.',
    ],
  };
  const base = {
    schemaVersion: 1,
    scenarioId: scenario.id,
    checkedAt: TIME,
    boundary,
    sources: sources.map((source) => ({
      id: source.id,
      url: source.url,
      retrievedAt: TIME,
      status: source.status ?? 200,
      sha256: sha(source.body),
      lastModified: null,
      excerpts: [excerpt(source.body)],
    })),
  };
  if (scenario.skill === 'factual-research') {
    return {
      ...base,
      findings: task.id.endsWith('1-individual')
        ? [
            {
              id: 'adult-renewal-conditional',
              value: 'conditional',
              effectiveDate: '2026-10-09',
              sourceIds: ['state-department', 'usagov'],
              explanation:
                'Both government sources describe online and mail renewal, with eligibility conditions and limits requiring an alternative application.',
            },
          ]
        : [18, 22].map((major) => ({
            id: `node-v${major}-supported`,
            value: major === 22,
            effectiveDate: major === 18 ? '2025-04-30' : '2027-04-30',
            sourceIds: ['node-schedule', 'node-releases'],
            explanation: `The official Node.js schedule and release page both identify v${major}; the effective EOL boundary determines support status.`,
          })),
    };
  }
  const first = task.id.endsWith('1-individual');
  const studies = first
    ? [routeLlm, routerBench].map((study) => ({
        id: study.id,
        title: study.title,
        published: study.published,
        sourceIds: [
          `arxiv-${study === routeLlm ? 'routellm' : 'routerbench'}`,
          `arxiv-record-${study === routeLlm ? 'routellm' : 'routerbench'}`,
        ],
        publicationStatus: 'preprint',
        access: 'abstract-only',
        design:
          'Observational benchmark study and quantitative comparisons of model routing approaches.',
        comparator:
          'Individual model baselines and existing routing rules evaluated on common query sets.',
        outcomes:
          'Reported model answer quality, routing decisions, benchmark coverage, and cost tradeoffs.',
        qualityLimitations:
          'Preprint only, with no independent replication here and benchmark data that may not reflect live user distribution.',
        abstractExcerpt: study.abstract.slice(0, 100),
      }))
    : pubmed.map((trial) => ({
        id: trial.id,
        title: trial.title,
        published: `${trial.year}-04-07`,
        sourceIds: ['pubmed-trials', 'europepmc-trials'],
        publicationStatus: 'indexed-randomized-trial',
        access: 'abstract-only',
        design:
          'Randomized trial of clinical navigation interventions across participating patient groups.',
        comparator:
          'Routine clinical care without additional navigator support for eligible referrals.',
        outcomes:
          'Referral timing, completion rate, and observed care engagement in the stated study population.',
        qualityLimitations:
          'Population and clinical intervention differ from software systems; abstract-only reporting limits assessment of bias and measurement.',
        abstractExcerpt: abstract(trial.title).slice(0, 100),
      }));
  const searches = first
    ? sources
        .filter((source) => !source.id.includes('record'))
        .map((source) => ({
          sourceId: source.id,
          url: source.url,
          total: 1,
          includedIds: [source.id.includes('routellm') ? routeLlm.id : routerBench.id],
          exclusions: [
            'Unrelated records omitted because they do not match the named primary study and its dated research scope.',
          ],
        }))
    : [
        {
          sourceId: 'pubmed-search',
          url: sources[0]!.url,
          total: 2,
          includedIds: pubmed.map((trial) => trial.id),
          exclusions: [
            'Review and exclude non-randomized, mismatched, or non-primary publications from the larger index.',
          ],
        },
      ];
  return {
    ...base,
    studies,
    searches,
    synthesis: {
      evidenceWeight:
        'Direct primary scholarly metadata and abstracts show a limited quantitative contribution and do not replace independent full-text review.',
      agreement:
        'Records agree on the identities, titles, dates, and research questions for the selected publications.',
      disagreement:
        'The comparison and measured outcomes vary across studies; no numerical equivalence or universal applicability is claimed.',
      applicability:
        'This patient-navigation clinical RCT evidence is indirect for LLM routing and software agent systems, and should not be generalized to language models.',
      gaps: 'Full texts were not independently retrieved, leaving risk of bias, external validity, and unpublished results uncertain.',
    },
  };
}

function writeReports(root: string, scenario: SkillEvalScenarioV3, sources: MockSource[]) {
  writeFixtureFile(
    root,
    'research.json',
    `${JSON.stringify(greenReport(scenario, sources), null, 2)}\n`,
  );
  writeFixtureFile(
    root,
    'result.md',
    `# Research findings\n\nDirect source verification was performed against ${sources[0]!.url} and independently ` +
      'against matching source metadata. Each citation and its evidence comes from the observed body and dated publication records. ' +
      'All claims remain conditional on eligibility and dated source availability; an inaccessible source is unverified. ' +
      'The evidence limits include abstract access and no claim that clinical evidence directly validates language-model routing.\n',
  );
  writeFixtureFile(
    root,
    'verification.md',
    '# Verification\n\nThe positive path reads HTTP 200 source bodies and records exact response digests. ' +
      'The negative path injects a 503 outage and confirms the scorer fails closed. ' +
      'The recovery path fetches an authoritative response after that simulated transient error. ' +
      'Only the harness can record whether these measured checks actually passed; no full text or live certificate is claimed here.\n',
  );
}

describe('public research V5 real-source scorer contract', () => {
  const packages = loadV5SkillPackages().packages;
  const scenarios = PUBLIC_RESEARCH_CASES.map((item) =>
    buildSkillEvalSuiteV3(
      packages.find((skill) => skill.sidecar.name === item.skill)!,
    ).scenarios.find((scenario) => scenario.id === item.id)!,
  );

  test('all four open-source tasks precede fail-closed external gates', () => {
    const readiness = auditSkillEvalExecutionReadiness(
      packages,
      BUILTIN_SKILL_EVAL_MATERIALIZERS,
      BUILTIN_SKILL_EVAL_SCORERS,
    );
    for (const scenario of scenarios) {
      const row = readiness.find((item) => item.scenarioId === scenario.id)!;
      expect(row.ready, scenario.id).toBe(true);
      expect(row.materializerId, scenario.id).toContain('live-authoritative-http');
      expect(row.deterministicScorerId, scenario.id).toContain('live-source-and-scholarly');
    }
  }, 90_000);

  test('literature contract selection has only the live public-research materializer and scorer', () => {
    const literature = scenarios.filter((scenario) => scenario.skill === 'literature-research');
    expect(literature).toHaveLength(2);
    for (const scenario of literature) {
      expect(
        EXTERNAL_ENVIRONMENT_SKILL_EVAL_MATERIALIZERS.filter((item) => item.matches(scenario)),
      ).toEqual([]);
      expect(
        EXTERNAL_ENVIRONMENT_SKILL_EVAL_SCORERS.filter((item) =>
          item.scenarioIds.includes(scenario.id),
        ),
      ).toEqual([]);
      expect(
        BUILTIN_SKILL_EVAL_MATERIALIZERS.filter((item) => item.matches(scenario)),
      ).toEqual(PUBLIC_RESEARCH_SKILL_EVAL_MATERIALIZERS);
      expect(
        BUILTIN_SKILL_EVAL_SCORERS.filter((item) => item.scenarioIds.includes(scenario.id)),
      ).toEqual(PUBLIC_RESEARCH_SKILL_EVAL_SCORERS);
    }
  });

  for (const scenario of scenarios) {
    test(`${scenario.id} fails without evidence, accepts complete cross-source proof and rejects tampering`, async () => {
      const root = mkdtempSync(join(tmpdir(), 'kory-public-research-test-'));
      roots.push(root);
      const materializer = PUBLIC_RESEARCH_SKILL_EVAL_MATERIALIZERS.find((item) =>
        item.matches(scenario),
      )!;
      const scorer = PUBLIC_RESEARCH_SKILL_EVAL_SCORERS.find((item) =>
        item.scenarioIds.includes(scenario.id),
      )!;
      expect(scorer).toBeDefined();
      await materializer.materialize(root, scenario);
      const sources = sourcesFor(scenario);
      const { request, visits } = transport(sources);
      const options = { request, now: () => new Date(TIME) };
      const red = await scorePublicResearchRuntime(scenario, root, options);
      expect(red.passed, red.evidence.join('\n')).toBe(false);
      expect(red.integrityFailure, scenario.id).toBe(false);
      writeReports(root, scenario, sources);
      const green = await scorePublicResearchRuntime(scenario, root, options);
      expect(green.passed, green.evidence.join('\n')).toBe(true);
      expect(green.quality).toBe(1);
      expect(green.verification).toBe(1);
      expect(green.evidence.join('\n')).toContain(
        'CONTROLLED TEST TRANSPORT (not certified live evidence)',
      );
      expect(visits.length).toBeGreaterThanOrEqual(sources.length * 2);
      const candidate = greenReport(scenario, sources);
      candidate.sources[0]!.sha256 = '0'.repeat(64);
      writeFixtureFile(root, 'research.json', `${JSON.stringify(candidate)}\n`);
      const badProvenance = await scorePublicResearchRuntime(scenario, root, options);
      expect(badProvenance.passed).toBe(false);
      expect(badProvenance.evidence.join('\n')).toContain('direct HTTPS provenance: fail');
      writeFixtureFile(root, 'README.md', 'Task replaced with an invented offline answer.\n');
      const tampered = await scorePublicResearchRuntime(scenario, root, options);
      expect(tampered.passed).toBe(false);
      expect(tampered.integrityFailure).toBe(true);
    }, 20_000);
  }

  test('bad source status and redirect fail closed, never certify unavailable research', async () => {
    const scenario = scenarios[0]!;
    const root = mkdtempSync(join(tmpdir(), 'kory-public-research-fail-'));
    roots.push(root);
    PUBLIC_RESEARCH_SKILL_EVAL_MATERIALIZERS[0]!.materialize(root, scenario);
    writeReports(root, scenario, sourcesFor(scenario));
    const outage = await scorePublicResearchRuntime(scenario, root, {
      request: async () => new Response('Source unavailable', { status: 503 }),
      now: () => new Date(TIME),
    });
    expect(outage.passed).toBe(false);
    expect(outage.evidence.join('\n')).toContain('Status: unverified');
    const spoofed = await scorePublicResearchRuntime(scenario, root, {
      request: async () =>
        new Response(
          '<html><body>passport renewal mail online restrictions and ' +
            'all eligibility requirements described by a simulated fake endpoint from an unknown third-party origin.</body></html>',
          { headers: { 'content-type': 'text/html' } },
        ),
      now: () => new Date(TIME),
    });
    expect(spoofed.passed).toBe(false);
    expect(spoofed.evidence.join('\n')).toContain(
      'untrusted redirect or unverifiable response URL',
    );
  });

  test('same-host redirects fail closed when the report requires the exact requested URL', async () => {
    const scenario = scenarios[0]!;
    const root = mkdtempSync(join(tmpdir(), 'kory-public-research-redirect-'));
    roots.push(root);
    PUBLIC_RESEARCH_SKILL_EVAL_MATERIALIZERS[0]!.materialize(root, scenario);
    writeReports(root, scenario, sourcesFor(scenario));

    const redirected = await scorePublicResearchRuntime(scenario, root, {
      request: async (url: string) => {
        const source = sourcesFor(scenario)[0]!;
        const response = new Response(source.body, {
          status: 200,
          headers: { 'content-type': source.contentType },
        });
        Object.defineProperty(response, 'url', {
          value: `${new URL(url).origin}/en/passports/redirected.html`,
          configurable: true,
        });
        return response;
      },
      now: () => new Date(TIME),
    });

    expect(redirected.passed).toBe(false);
    expect(redirected.evidence.join('\n')).toContain(
      'untrusted redirect or unverifiable response URL',
    );
  });

  test('PubMed grouped evidence, the negative control row and alternate documented fields use actual source bytes', async () => {
    const scenario = scenarios.find(
      (item) => item.id === 'literature-research-full-task-2-individual',
    )!;
    const root = mkdtempSync(join(tmpdir(), 'kory-pubmed-alternative-'));
    roots.push(root);
    PUBLIC_RESEARCH_SKILL_EVAL_MATERIALIZERS[0]!.materialize(root, scenario);
    const readme = readFixtureText(root, 'README.md');
    for (const field of [
      'pubmed-trials',
      'europepmc-trials',
      'invalid-eutils-endpoint',
      'includedIds',
      'exclusions',
      'indexed-randomized-trial',
      'abstract-only',
      'indirect',
    ]) {
      expect(readme).toContain(field);
    }

    const otherId = '33991003';
    const base = sourcesFor(scenario);
    base[0]!.body = JSON.stringify({
      esearchresult: {
        count: '12',
        idlist: [pubmed[0]!.id, otherId, pubmed[1]!.id],
        note: 'The public trial search returned these source identifiers for independent study screening and verification.',
      },
    });
    const { request } = transport(base);
    const options = { request, now: () => new Date(TIME) };
    writeReports(root, scenario, base);
    const report: any = greenReport(scenario, base);
    report.searches = [
      {
        sourceId: 'pubmed-search',
        url: base[0]!.url,
        total: 12,
        includedIds: pubmed.map((study) => study.id),
        excludedAlternatives: [
          {
            ids: [otherId],
            reason: 'A nonprimary report is outside this focused review and was excluded.',
          },
        ],
      },
    ];
    const write = (value: unknown) =>
      writeFixtureFile(root, 'research.json', `${JSON.stringify(value, null, 2)}\n`);
    write(report);
    const accepted = await scorePublicResearchRuntime(scenario, root, options);
    expect(accepted.passed, accepted.evidence.join('\n')).toBe(true);
    expect(accepted.quality).toBe(1);
    expect(accepted.evidence.join('\n')).toContain('invalid-eutils-endpoint: HTTP 400');

    // The grouped path is the supported path: a fifth source row fails coverage.
    const extraRow = structuredClone(report);
    extraRow.sources.push({
      id: 'pubmed-mesh-search',
      url: base[0]!.url,
      status: 200,
      retrievedAt: TIME,
      sha256: sha(base[0]!.body),
      lastModified: null,
      excerpts: [excerpt(base[0]!.body)],
    });
    write(extraRow);
    const extraScore = await scorePublicResearchRuntime(scenario, root, options);
    expect(extraScore.passed).toBe(false);
    expect(extraScore.evidence.join('\n')).toContain(
      'all required sources uniquely represented: fail',
    );

    const forged = structuredClone(report);
    forged.sources.find((row: { id: string }) => row.id === 'europepmc-trials').sha256 =
      '0'.repeat(64);
    write(forged);
    const forgedScore = await scorePublicResearchRuntime(scenario, root, options);
    expect(forgedScore.passed).toBe(false);
    expect(forgedScore.evidence.join('\n')).toContain(
      'europepmc-trials direct HTTPS provenance: fail',
    );

    const misdated = structuredClone(report);
    misdated.studies[0].published = '2023-01-01';
    write(misdated);
    const misdatedScore = await scorePublicResearchRuntime(scenario, root, options);
    expect(misdatedScore.passed).toBe(false);
    expect(misdatedScore.evidence.join('\n')).toContain(
      `${pubmed[0]!.id} verified identity, version, publication and abstract status: fail`,
    );

    const excludedUnknown = structuredClone(report);
    excludedUnknown.searches[0].excludedAlternatives[0].ids = ['99999999'];
    write(excludedUnknown);
    const excludedScore = await scorePublicResearchRuntime(scenario, root, options);
    expect(excludedScore.passed).toBe(false);
    expect(excludedScore.evidence.join('\n')).toContain(
      'pubmed-search search count, URL and eligibility: fail',
    );

    const badStatus = transport(
      base.map((source) =>
        source.id === 'pubmed-trials' ? { ...source, status: 503 } : source,
      ),
    );
    write(report);
    const unavailable = await scorePublicResearchRuntime(scenario, root, {
      ...options,
      request: badStatus.request,
    });
    expect(unavailable.passed).toBe(false);
    expect(unavailable.evidence.join('\n')).toContain('Status: unverified');
  }, 20_000);
});
