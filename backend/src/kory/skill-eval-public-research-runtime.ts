import { createHash } from 'node:crypto';
import type {
  SkillEvalDeterministicScore,
  SkillEvalDeterministicScorer,
  SkillEvalFixtureMaterializer,
} from './skill-eval-execution';
import type { SkillEvalScenarioV3 } from './skill-eval-harness';
import { fixtureTextEquals, readFixtureText, writeFixtureFile } from './skill-eval-fixture-helpers';

/**
 * Public research is an OPEN evidence task. The fixture contains questions and URLs,
 * never copied answers or a sealed corpus. Each score independently retrieves the
 * authoritative records over HTTPS and checks candidate quotations against the
 * returned bytes. A failed/blocked source is an unverified task, not a pass.
 *
 * The pairs and blind comparisons are owned by runPairedSkillEvaluationV3. This
 * module owns the four domain exercises and their deterministic evidence checks.
 */
type ResearchKind = 'factual' | 'literature';
type SourceFormat = 'html' | 'json' | 'atom' | 'xml';
type HttpRequest = (url: string, init: RequestInit) => Promise<Response>;

interface SourceSpec {
  id: string;
  url: string;
  format: SourceFormat;
  identity: string[];
}

interface ResearchCase {
  id: string;
  skill: 'factual-research' | 'literature-research';
  kind: ResearchKind;
  startingState: string;
  neighbor: string;
  question: string;
  scope: string;
  sources: SourceSpec[];
}

const PUBMED_QUERY =
  '"patient navigation"[Title/Abstract] AND "randomized controlled trial"[Publication Type]';
const pubmedSearchUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${encodeURIComponent(PUBMED_QUERY)}&retmode=json&retmax=10`;

export const PUBLIC_RESEARCH_CASES: readonly ResearchCase[] = [
  {
    id: 'factual-research-full-task-1-individual',
    skill: 'factual-research',
    kind: 'factual',
    startingState: 'https://travel.state.gov/en/passports/renew-replace.html',
    neighbor: 'literature-research',
    question:
      'Verify, as of the run date, whether an eligible adult can renew a US passport online or by mail, and which conditions make the statement incomplete.',
    scope:
      'US adult passport renewal, eligibility and methods as of the evaluation date; distinguish application in person from renewal.',
    sources: [
      {
        id: 'state-department',
        url: 'https://travel.state.gov/en/passports/renew-replace.html',
        format: 'html',
        identity: ['passport', 'renew'],
      },
      {
        id: 'usagov',
        url: 'https://www.usa.gov/renew-adult-passport',
        format: 'html',
        identity: ['passport', 'renew'],
      },
    ],
  },
  {
    id: 'factual-research-full-task-2-individual',
    skill: 'factual-research',
    kind: 'factual',
    startingState: 'https://nodejs.org/en/about/previous-releases',
    neighbor: 'market-competitive-research',
    question:
      'Verify the support/EOL status and dated EOL boundaries of Node.js 18 and 22 on the evaluation date. Resolve stale release-status claims using the Node.js release schedule and the project release page.',
    scope:
      'Node.js official release lifecycle; distinguish EOL dates from latest binary release dates.',
    sources: [
      {
        id: 'node-releases',
        url: 'https://nodejs.org/en/about/previous-releases',
        format: 'html',
        identity: ['Node.js', '18', '22'],
      },
      {
        id: 'node-schedule',
        url: 'https://raw.githubusercontent.com/nodejs/Release/main/schedule.json',
        format: 'json',
        identity: ['"v18"', '"v22"', '"end"'],
      },
    ],
  },
  {
    id: 'literature-research-full-task-1-individual',
    skill: 'literature-research',
    kind: 'literature',
    startingState: 'https://arxiv.org/',
    neighbor: 'factual-research',
    question:
      'Review 2024 onward evidence on routing among language models, comparing RouteLLM and RouterBench. Separate reported benchmark findings, limitations, and preprint from peer-review status.',
    scope:
      'Technical LLM routing, 2024-01-01 through the run date; eligible primary research on routing and evaluation, not market comparisons.',
    sources: [
      {
        id: 'arxiv-routellm',
        url: 'https://export.arxiv.org/api/query?search_query=all%3ARouteLLM&start=0&max_results=10',
        format: 'atom',
        identity: ['<feed', '2406.18665', '<entry>'],
      },
      {
        id: 'openalex-routellm',
        url: 'https://api.openalex.org/works?search=RouteLLM&per-page=10',
        format: 'json',
        identity: ['"results"', 'RouteLLM'],
      },
      {
        id: 'arxiv-routerbench',
        url: 'https://export.arxiv.org/api/query?search_query=all%3ARouterBench&start=0&max_results=10',
        format: 'atom',
        identity: ['<feed', '2403.12031', '<entry>'],
      },
      {
        id: 'openalex-routerbench',
        url: 'https://api.openalex.org/works?search=RouterBench&per-page=10',
        format: 'json',
        identity: ['"results"', 'RouterBench'],
      },
    ],
  },
  {
    id: 'literature-research-full-task-2-individual',
    skill: 'literature-research',
    kind: 'literature',
    startingState: 'https://pubmed.ncbi.nlm.nih.gov/',
    neighbor: 'market-competitive-research',
    question:
      'Test how far randomized evidence on patient navigation/referral routing can inform agent-routing claims. Retrieve primary randomized trial records from PubMed, verify study identities independently, and explicitly mark this clinical evidence as indirect for LLM-agent routing.',
    scope:
      'PubMed randomized patient-navigation studies through the evaluation date; clinical navigation is an indirect analogue, not a trial of LLM agent routing.',
    sources: [
      {
        id: 'pubmed-search',
        url: pubmedSearchUrl,
        format: 'json',
        identity: ['"esearchresult"', '"idlist"'],
      },
    ],
  },
] as const;

interface FetchResult {
  spec: SourceSpec;
  body: string;
  status: number;
  digest: string;
  fetchedAt: string;
  lastModified: string | null;
  elapsedMs: number;
  attempts: number;
}

export interface PublicResearchRuntimeOptions {
  /** A test transport. Only the default path performs certifying public HTTPS retrieval. */
  request?: HttpRequest;
  now?: () => Date;
}

interface ResearchReport {
  schemaVersion?: number;
  scenarioId?: string;
  checkedAt?: string;
  boundary?: {
    selectedSkill?: string;
    broaderSkill?: string;
    adjacentSkill?: string;
    scope?: string;
    exclusions?: string[];
  };
  sources?: Array<{
    id?: string;
    url?: string;
    retrievedAt?: string;
    status?: number;
    sha256?: string;
    lastModified?: string | null;
    excerpts?: string[];
  }>;
  findings?: Array<{
    id?: string;
    value?: boolean | string;
    effectiveDate?: string;
    sourceIds?: string[];
    explanation?: string;
  }>;
  searches?: Array<{
    sourceId?: string;
    url?: string;
    total?: number;
    observedTotal?: number;
    includedIds?: string[];
    exclusions?: string[];
    excludedAlternatives?: Array<{ ids?: string[]; reason?: string }>;
  }>;
  studies?: Array<{
    id?: string;
    title?: string;
    published?: string;
    sourceIds?: string[];
    publicationStatus?: string;
    access?: string;
    design?: string;
    comparator?: string;
    outcomes?: string;
    qualityLimitations?: string | string[];
    abstractExcerpt?: string;
  }>;
  synthesis?: {
    evidenceWeight?: string;
    agreement?: string;
    disagreement?: string;
    applicability?: string;
    gaps?: string;
  };
}

interface ScholarlyStudy {
  id: string;
  title: string;
  published: string;
  abstract: string;
  sourceIds: string[];
  status: 'preprint' | 'indexed-randomized-trial';
  access: 'abstract-only';
  doi?: string;
}

interface RuntimeEvidence {
  sources: FetchResult[];
  factual?: Record<string, { value: boolean | string; effectiveDate: string; sourceIds: string[] }>;
  searchTotals?: Record<string, number>;
  searchIds?: Record<string, string[]>;
  studies?: ScholarlyStudy[];
}

const CASE_BY_ID = new Map(PUBLIC_RESEARCH_CASES.map((item) => [item.id, item]));
const RETRIEVAL_TIMEOUT_MS = 9_000;
const MAX_SOURCE_BYTES = 1_500_000;
const MAX_REPORT_AGE_MS = 30 * 60_000;
const MAX_FUTURE_SKEW_MS = 2 * 60_000;
const SHA256 = /^[a-f0-9]{64}$/u;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;

function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function fixturePacket(task: ResearchCase): string {
  return json({
    schemaVersion: 1,
    scenarioId: task.id,
    skill: task.skill,
    sourceOfRecord: task.startingState,
    question: task.question,
    scope: task.scope,
    broaderSkill: 'research',
    adjacentSkill: task.neighbor,
    sources: task.sources,
    constraints: [
      'Use fresh, actually retrieved authoritative HTTPS responses; source snippets and unverified mirrors do not count.',
      'Record UTC retrieval timestamps, sha256 of raw HTTP bodies, actual excerpts and source publication/effective dates.',
      'Every consequential claim needs a source trace and a second independent check where specified.',
      'Document negative, interruption and recovery behavior. An HTTP error or inaccessible source means unverified, not success.',
      'A blind paired comparison is produced by the outer evaluator, not by this candidate.',
    ],
  });
}

function readme(task: ResearchCase): string {
  const literatureContract =
    task.kind === 'literature'
      ? `For literature, write \`searches[]\` with \`sourceId\`, exact \`url\`, integer \`total\` (or \`observedTotal\`), \`includedIds[]\`, and \`exclusions[]\` (substantial reason strings) or \`excludedAlternatives[]\` (objects containing \`ids[]\` and \`reason\`). Record each included study in \`studies[]\` with \`id\`, \`title\`, \`published\` (YYYY-MM-DD backed by the source), \`sourceIds[]\`, \`publicationStatus\`, \`access\`, \`design\`, \`comparator\`, \`outcomes\`, \`qualityLimitations\`, and \`abstractExcerpt\`. Quality limitations may be a substantial string or an array of specific strings. Publication status may be \`preprint\` / \`indexed-randomized-trial\` or a detailed, source-consistent description. Access may be \`abstract-only\` or prose explicitly stating that only the abstract was assessed. Synthesis requires \`evidenceWeight\`, \`agreement\`, \`disagreement\`, \`applicability\`, and \`gaps\`. Do not infer peer review from indexing or a preprint.\n\n`
      : '';
  const pubmedContract =
    task.id === 'literature-research-full-task-2-individual'
      ? `For the patient-navigation exercise, the mandatory \`pubmed-search\` response returns up to ten IDs. Select two distinct eligible primary randomized trials from those observed IDs; explain exclusions and incomplete screening. Verify both trial identities independently. Either report the dynamically constructed \`pubmed-trials\` (PubMed XML for the selected comma-separated IDs) AND \`europepmc-trials\` (Europe PMC JSON lookup for those IDs), or use individual \`pubmed-<PMID>\` XML and \`crossref-<PMID>\` DOI metadata for EACH selected study. The latter URLs must be derived from the PubMed IDs and DOI in the primary XML, and Crossref must agree on DOI, title and journal-article type. Report the exact HTTP bodies/hashes for whichever path you actually fetched; unused alternate endpoints need not appear in your source list. An extra \`pubmed-mesh-search\` with a reproducible PubMed randomized-navigation query is allowed if its search count and exclusions are also reported. A measured invalid E-utilities request may be recorded as \`invalid-eutils-endpoint\` with HTTP 400, but it must be labeled as a negative control and never cited for a study claim. Exact dates from PubMed ArticleDate are preferred to guessed January 1 dates. Human patient navigation remains INDIRECT evidence for LLM-agent routing.\n\n`
      : '';
  return `# Live public research exercise\n\n${task.question}\n\n${task.scope}\n\nUse the URLs/searches in \`research-task.json\` as starting points. You must make real HTTPS requests during this turn. Crosscheck what each record establishes, including publication/version status and retrieval date. Do not edit the task packet. A blocked, empty, or inconsistent primary source must be reported as unverified, never filled with fictional findings.\n\nWrite \`research.json\`, \`result.md\`, and \`verification.md\`. The JSON must have \`schemaVersion:1\`, \`scenarioId\`, \`checkedAt\` (UTC), and \`boundary:{selectedSkill,broaderSkill:'research',adjacentSkill,scope,exclusions}\`. In \`sources[]\` include a row per retrieved source with exact \`id\`, \`url\`, \`status\`, \`retrievedAt\`, lowercase SHA-256 \`sha256\` of the raw HTTP response, HTTP \`lastModified\` (or null), and at least one substantial verbatim \`excerpts[]\` quote from its body. Cite the same records in the readable report. Scoring independently refetches all claimed sources over HTTPS and requires byte-identical response hashes with recent retrieval timestamps (within 30 minutes); an unverified changed source fails closed.\n\n${task.kind === 'factual' ? 'For factual claims provide findings[] with id, value, effectiveDate (YYYY-MM-DD), sourceIds, and explanation. The passport case uses id "adult-renewal-conditional" and value "conditional". The Node case uses ids "node-v18-supported" and "node-v22-supported" with boolean values and the EOL date from the official release schedule.' : literatureContract}\n\n${pubmedContract}In \`verification.md\`, explain how you checked the positive path, a source-blocked/incorrect negative path, and a recovery attempt; clearly distinguish performed measurements from hypothetical procedures. Paired skill/no-skill evidence belongs to the outer harness.\n`;
}

function scenarioCase(scenario: SkillEvalScenarioV3): ResearchCase | null {
  const task = CASE_BY_ID.get(scenario.id);
  if (
    !task ||
    scenario.skill !== task.skill ||
    scenario.environment.kind !== 'public-web' ||
    scenario.environment.startingState !== task.startingState
  )
    return null;
  return task;
}

function sourceFormatOkay(format: SourceFormat, contentType: string): boolean {
  switch (format) {
    case 'html':
      return /(?:text\/html|application\/xhtml\+xml)/iu.test(contentType);
    case 'json':
      return /(?:application\/json|text\/plain|application\/.*\+json)/iu.test(contentType);
    case 'atom':
      return /(?:application\/atom\+xml|text\/xml|application\/xml)/iu.test(contentType);
    case 'xml':
      return /(?:text\/xml|application\/xml)/iu.test(contentType);
  }
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function normalize(value: string): string {
  return value
    .replace(
      /&(?:amp|quot|apos|lt|gt);/gu,
      (entity) =>
        ({ '&amp;': '&', '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>' })[entity] ??
        entity,
    )
    .replace(/<[^>]*>/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function sameTitle(a: string, b: string): boolean {
  const clean = (value: string) =>
    normalize(value)
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, ' ')
      .trim();
  return clean(a) === clean(b);
}

function extractTag(xml: string, tag: string): string {
  const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'iu').exec(xml);
  return normalize(match?.[1] ?? '');
}

async function boundedText(response: Response): Promise<string> {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_SOURCE_BYTES)
    throw new Error('authoritative response exceeds byte budget');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('authoritative response has no body');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      bytes += value.byteLength;
      if (bytes > MAX_SOURCE_BYTES) throw new Error('authoritative response exceeds byte budget');
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const all = Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    bytes,
  );
  return new TextDecoder('utf-8', { fatal: true }).decode(all);
}

function validateSourceUrl(spec: SourceSpec, response: Response): void {
  const requested = new URL(spec.url);
  if (requested.protocol !== 'https:') throw new Error(`non-HTTPS evidence URL: ${spec.id}`);
  const resolved = response.url ? new URL(response.url) : null;
  if (
    !resolved ||
    resolved.protocol !== 'https:' ||
    resolved.href !== requested.href ||
    resolved.username ||
    resolved.password
  )
    throw new Error(`untrusted redirect or unverifiable response URL for ${spec.id}`);
}

function validateSource(spec: SourceSpec, response: Response, body: string): void {
  validateSourceUrl(spec, response);
  const contentType = response.headers.get('content-type') ?? '';
  if (!sourceFormatOkay(spec.format, contentType))
    throw new Error(`${spec.id}: unexpected content type ${contentType || '(missing)'}`);
  if (
    body.length < 90 ||
    spec.identity.some((term) => !body.toLowerCase().includes(term.toLowerCase()))
  )
    throw new Error(`${spec.id}: missing authoritative content identity`);
}

async function fetchSource(
  spec: SourceSpec,
  request: HttpRequest,
  now: () => Date,
): Promise<FetchResult> {
  const began = performance.now();
  let lastFailure = 'unavailable';
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await request(spec.url, {
        redirect: 'follow',
        cache: 'no-store',
        signal: AbortSignal.timeout(RETRIEVAL_TIMEOUT_MS),
        headers: { Accept: spec.format === 'json' ? 'application/json' : '*/*' },
      });
      if (response.status !== 200) {
        lastFailure = `${spec.id}: HTTP ${response.status} from ${spec.url}`;
        if (attempt < 2 && [429, 500, 502, 503, 504].includes(response.status)) continue;
        throw new Error(lastFailure);
      }
      const body = await boundedText(response);
      validateSource(spec, response, body);
      return {
        spec,
        body,
        status: response.status,
        digest: hash(body),
        fetchedAt: now().toISOString(),
        lastModified: response.headers.get('last-modified'),
        elapsedMs: Math.round(performance.now() - began),
        attempts: attempt,
      };
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
      if (
        attempt < 2 &&
        !/untrusted redirect|content type|content identity|byte budget|HTTP 4\d\d/iu.test(
          lastFailure,
        )
      )
        continue;
      break;
    }
  }
  throw new Error(`${spec.id}: ${lastFailure}`);
}

/** A declared failed request can be audited, but cannot establish any scholarly claim. */
async function fetchNegativeControl(request: HttpRequest, now: () => Date): Promise<FetchResult> {
  const spec: SourceSpec = {
    id: 'invalid-eutils-endpoint',
    url: 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/definitely-not-an-endpoint',
    format: 'json',
    identity: [],
  };
  const began = performance.now();
  const response = await request(spec.url, {
    redirect: 'follow',
    cache: 'no-store',
    signal: AbortSignal.timeout(RETRIEVAL_TIMEOUT_MS),
  });
  validateSourceUrl(spec, response);
  if (response.status !== 400)
    throw new Error('Negative E-utilities control did not return HTTP 400');
  const body = await boundedText(response);
  if (!/invalid eutil name/iu.test(body))
    throw new Error('Negative control did not identify invalid E-utilities endpoint');
  return {
    spec,
    body,
    status: 400,
    digest: hash(body),
    fetchedAt: now().toISOString(),
    lastModified: response.headers.get('last-modified'),
    elapsedMs: Math.round(performance.now() - began),
    attempts: 1,
  };
}

function parseJson(body: string): Record<string, any> {
  const value: unknown = JSON.parse(body);
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('source JSON is not an object');
  return value as Record<string, any>;
}

function fetched(sources: FetchResult[], id: string): FetchResult {
  const match = sources.find((source) => source.spec.id === id);
  if (!match) throw new Error(`missing independently fetched ${id}`);
  return match;
}

function sourceDate(value: unknown): string {
  if (typeof value !== 'string' || !ISO_DATE.test(value) || !Number.isFinite(Date.parse(value)))
    throw new Error('missing or invalid authoritative ISO date');
  return value;
}

function lifecycleEvidence(sources: FetchResult[], now: Date): RuntimeEvidence['factual'] {
  const schedule = parseJson(fetched(sources, 'node-schedule').body);
  const listing = normalize(fetched(sources, 'node-releases').body);
  if (!/\bv18\b/iu.test(listing) || !/\bv22\b/iu.test(listing))
    throw new Error('Node release page does not independently identify both major versions');
  const result: NonNullable<RuntimeEvidence['factual']> = {};
  for (const major of [18, 22]) {
    const record = schedule[`v${major}`];
    if (!record || typeof record !== 'object')
      throw new Error(`Node v${major} missing from official schedule`);
    const end = sourceDate(record.end);
    const start = sourceDate(record.start);
    if (Date.parse(end) <= Date.parse(start))
      throw new Error(`Node v${major} invalid lifecycle interval`);
    result[`node-v${major}-supported`] = {
      value: now.getTime() < Date.parse(`${end}T23:59:59.999Z`),
      effectiveDate: end,
      sourceIds: ['node-schedule', 'node-releases'],
    };
  }
  return result;
}

function passportEvidence(sources: FetchResult[], now: Date): RuntimeEvidence['factual'] {
  const government = normalize(fetched(sources, 'state-department').body).toLowerCase();
  const independent = normalize(fetched(sources, 'usagov').body).toLowerCase();
  const mentionsMethods = (text: string) =>
    /\bonline\b/iu.test(text) && /\bmail\b/iu.test(text) && /\brenew/iu.test(text);
  if (!mentionsMethods(government) || !mentionsMethods(independent))
    throw new Error('passport methods were not corroborated on both government pages');
  return {
    'adult-renewal-conditional': {
      value: 'conditional',
      effectiveDate: now.toISOString().slice(0, 10),
      sourceIds: ['state-department', 'usagov'],
    },
  };
}

function arxivEntries(body: string): Array<{
  id: string;
  title: string;
  published: string;
  abstract: string;
}> {
  return [...body.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/giu)].map((match) => {
    const entry = match[1]!;
    const absoluteId = extractTag(entry, 'id');
    const id = /\/abs\/(\d{4}\.\d{4,5})(?:v\d+)?/u.exec(absoluteId)?.[1] ?? '';
    return {
      id,
      title: extractTag(entry, 'title'),
      published: extractTag(entry, 'published').slice(0, 10),
      abstract: extractTag(entry, 'summary'),
    };
  });
}

function atomTotal(body: string): number {
  const count = /<opensearch:totalResults>(\d+)<\/opensearch:totalResults>/iu.exec(body)?.[1];
  if (!count) throw new Error('arXiv search count absent');
  return Number(count);
}

function scholarlyEvidence(
  sources: FetchResult[],
  now: Date,
): Pick<RuntimeEvidence, 'studies' | 'searchTotals'> {
  const studies: ScholarlyStudy[] = [];
  const searchTotals: Record<string, number> = {};
  for (const [stem, id] of [
    ['routellm', '2406.18665'],
    ['routerbench', '2403.12031'],
  ] as const) {
    const arxivId = `arxiv-${stem}`;
    const openalexId = `openalex-${stem}`;
    const feed = fetched(sources, arxivId).body;
    const index = parseJson(fetched(sources, openalexId).body);
    const arxiv = arxivEntries(feed).find((entry) => entry.id === id);
    const results = index.results;
    if (!arxiv || !Array.isArray(results) || arxiv.abstract.length < 90)
      throw new Error(`${stem}: primary abstract or secondary scholarly search missing`);
    const corroborating = results.find(
      (work: any) =>
        typeof work?.title === 'string' &&
        sameTitle(work.title, arxiv.title) &&
        (String(work.doi ?? '')
          .toLowerCase()
          .endsWith(`arxiv.${id}`) ||
          JSON.stringify(work.ids ?? {}).includes(id)),
    );
    if (
      !corroborating ||
      !sourceDate(arxiv.published) ||
      !sourceDate(corroborating.publication_date)
    )
      throw new Error(`${stem}: arXiv study identity not corroborated by OpenAlex`);
    if (arxiv.published < '2024-01-01' || Date.parse(arxiv.published) > now.getTime())
      throw new Error(`${stem}: paper outside the specified research window`);
    if (
      Math.abs(Date.parse(arxiv.published) - Date.parse(corroborating.publication_date)) >
      366 * 86_400_000
    )
      throw new Error(`${stem}: conflicting publication identity/dates`);
    searchTotals[arxivId] = atomTotal(feed);
    searchTotals[openalexId] = Number(index.meta?.count);
    if (!Number.isSafeInteger(searchTotals[openalexId]) || searchTotals[openalexId] < 1)
      throw new Error(`${stem}: invalid OpenAlex search count`);
    studies.push({
      id,
      title: arxiv.title,
      published: arxiv.published,
      abstract: arxiv.abstract,
      sourceIds: [arxivId, openalexId],
      status: 'preprint',
      access: 'abstract-only',
    });
  }
  return { studies, searchTotals };
}

function pubmedSearch(body: string): { ids: string[]; total: number } {
  const search = parseJson(body).esearchresult;
  const ids = search?.idlist;
  const total = Number(search?.count);
  if (
    !Array.isArray(ids) ||
    ids.length < 2 ||
    ids.length > 10 ||
    new Set(ids).size !== ids.length ||
    !Number.isSafeInteger(total) ||
    total < ids.length ||
    ids.some((id) => typeof id !== 'string' || !/^\d{5,10}$/u.test(id))
  )
    throw new Error('PubMed did not return at least two verifiable primary trial identifiers');
  return { ids, total };
}

function exactArticleDate(xml: string): string | null {
  const date = /<ArticleDate\b[^>]*>([\s\S]*?)<\/ArticleDate>/iu.exec(xml)?.[1];
  if (!date) return null;
  const year = extractTag(date, 'Year');
  const month = extractTag(date, 'Month').padStart(2, '0');
  const day = extractTag(date, 'Day').padStart(2, '0');
  const value = `${year}-${month}-${day}`;
  return ISO_DATE.test(value) &&
    !Number.isNaN(Date.parse(value)) &&
    new Date(`${value}T00:00:00Z`).toISOString().startsWith(value)
    ? value
    : null;
}

function pubmedDetails(ids: string[]): [SourceSpec, SourceSpec] {
  const joined = ids.join(',');
  const query = ids.map((id) => `EXT_ID:${id}`).join(' OR ');
  return [
    {
      id: 'pubmed-trials',
      url: `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=${joined}&retmode=xml`,
      format: 'xml',
      identity: ['<PubmedArticle', '<ArticleTitle', '<PMID'],
    },
    {
      id: 'europepmc-trials',
      url: `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${encodeURIComponent(query)}&format=json&pageSize=10`,
      format: 'json',
      identity: ['"resultList"', '"result"'],
    },
  ];
}

function pubmedStudy(
  record: string,
  id: string,
  sourceIds: string[],
  fallbackDate = '',
): ScholarlyStudy {
  if (extractTag(record, 'PMID') !== id || !/randomi[sz]ed controlled trial/iu.test(record))
    throw new Error(`PubMed ${id} has no primary randomized study record`);
  const title = extractTag(record, 'ArticleTitle');
  const abstract = [...record.matchAll(/<AbstractText(?:\s[^>]*)?>([\s\S]*?)<\/AbstractText>/giu)]
    .map((match) => normalize(match[1]!))
    .join(' ');
  const year = /<PubDate>([\s\S]*?)<\/PubDate>/iu.exec(record)?.[1] ?? '';
  const date = extractTag(year, 'Year') || fallbackDate.slice(0, 4);
  const published =
    exactArticleDate(record) ??
    (ISO_DATE.test(fallbackDate) && fallbackDate.startsWith(date) ? fallbackDate : `${date}-01-01`);
  const doi = /<ArticleId\b[^>]*IdType=["']doi["'][^>]*>([^<]+)<\/ArticleId>/iu.exec(record)?.[1];
  if (
    !title ||
    !/^[12]\d{3}$/u.test(date) ||
    !Number.isFinite(Date.parse(published)) ||
    !published.startsWith(date) ||
    abstract.length < 90
  )
    throw new Error(`PubMed ${id}: trial title, date, or primary abstract unverified`);
  return {
    id,
    title,
    published,
    abstract,
    sourceIds,
    status: 'indexed-randomized-trial',
    access: 'abstract-only',
    doi: doi ? normalize(doi) : undefined,
  };
}

function pubmedEvidence(
  sources: FetchResult[],
  ids: string[],
  total: number,
): Pick<RuntimeEvidence, 'studies' | 'searchTotals'> {
  const xml = fetched(sources, 'pubmed-trials').body;
  const metadata = parseJson(fetched(sources, 'europepmc-trials').body);
  const secondary = metadata.resultList?.result;
  if (!Array.isArray(secondary)) throw new Error('Europe PMC results are missing');
  const records = [...xml.matchAll(/<PubmedArticle\b[^>]*>([\s\S]*?)<\/PubmedArticle>/giu)].map(
    (match) => match[1]!,
  );
  const studies: ScholarlyStudy[] = [];
  for (const id of ids) {
    const record = records.find((article) => extractTag(article, 'PMID') === id);
    const index = secondary.find((work: any) => String(work.id) === id && work.source === 'MED');
    if (!record || !index) throw new Error(`PubMed ${id} has no corroborated study record`);
    const study = pubmedStudy(
      record,
      id,
      ['pubmed-trials', 'europepmc-trials'],
      String(index.firstPublicationDate ?? ''),
    );
    if (!sameTitle(study.title, asText(index.title)))
      throw new Error(`PubMed ${id}: Europe PMC title contradicts the primary study`);
    studies.push(study);
  }
  return { studies, searchTotals: { 'pubmed-search': total } };
}

async function individualPubmedEvidence(
  ids: string[],
  total: number,
  sources: FetchResult[],
  request: HttpRequest,
  now: () => Date,
): Promise<Pick<RuntimeEvidence, 'studies' | 'searchTotals'>> {
  const studies: ScholarlyStudy[] = [];
  for (const id of ids) {
    const pubmedId = `pubmed-${id}`;
    const crossrefId = `crossref-${id}`;
    const spec: SourceSpec = {
      id: pubmedId,
      url: `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=${id}&retmode=xml`,
      format: 'xml',
      identity: ['<PubmedArticle', '<ArticleTitle', '<PMID', id],
    };
    const result = await fetchSource(spec, request, now);
    const records = [
      ...result.body.matchAll(/<PubmedArticle\b[^>]*>([\s\S]*?)<\/PubmedArticle>/giu),
    ];
    if (records.length !== 1)
      throw new Error(`PubMed ${id}: individual response is not one primary article`);
    const study = pubmedStudy(records[0]![1]!, id, [pubmedId, crossrefId]);
    if (!study.doi) throw new Error(`Crossref ${id} cannot be tied to a PubMed DOI`);
    sources.push(result);
    const crossrefSpec: SourceSpec = {
      id: crossrefId,
      url: `https://api.crossref.org/works/${encodeURIComponent(study.doi)}`,
      format: 'json',
      identity: ['"message"', '"DOI"'],
    };
    const corroboration = await fetchSource(crossrefSpec, request, now);
    const message = parseJson(corroboration.body).message;
    if (
      String(message?.DOI ?? '').toLowerCase() !== study.doi.toLowerCase() ||
      message?.type !== 'journal-article' ||
      !sameTitle(asText(message?.title?.[0]), study.title)
    )
      throw new Error(
        `Crossref ${id} did not independently corroborate DOI, title and journal type`,
      );
    sources.push(corroboration);
    studies.push(study);
  }
  return { studies, searchTotals: { 'pubmed-search': total } };
}

async function independentEvidence(
  task: ResearchCase,
  request: HttpRequest,
  now: () => Date,
  report: ResearchReport | null,
): Promise<RuntimeEvidence> {
  // Sequential retrieval bounds remote load and makes the PubMed metadata lookup depend
  // on identifiers returned by PubMed itself, not on candidate-supplied URLs.
  const sources: FetchResult[] = [];
  for (const spec of task.sources) sources.push(await fetchSource(spec, request, now));
  if (task.id === 'factual-research-full-task-1-individual') {
    return { sources, factual: passportEvidence(sources, now()) };
  }
  if (task.id === 'factual-research-full-task-2-individual') {
    return { sources, factual: lifecycleEvidence(sources, now()) };
  }
  if (task.id === 'literature-research-full-task-1-individual') {
    return { sources, ...scholarlyEvidence(sources, now()) };
  }
  const { ids: searchIds, total } = pubmedSearch(fetched(sources, 'pubmed-search').body);
  const chosen = report?.studies?.map((row) => row.id ?? '') ?? [];
  // The task asks for two eligible primary trials among the ten returned IDs,
  // not necessarily the first two (which may be protocols or secondary reports).
  const ids =
    chosen.length === 2 &&
    new Set(chosen).size === 2 &&
    chosen.every((id) => searchIds.includes(id))
      ? chosen
      : searchIds.slice(0, 2);
  const claimedSources = report?.sources ?? [];
  if (claimedSources.length > 10) throw new Error('Too many declared scholarly sources');
  const claimedIds = new Set(claimedSources.map((row) => row.id));
  const individual =
    ids.every((id) => claimedIds.has(`pubmed-${id}`) && claimedIds.has(`crossref-${id}`)) &&
    !claimedIds.has('pubmed-trials') &&
    !claimedIds.has('europepmc-trials');
  if (!individual) {
    for (const spec of pubmedDetails(ids)) sources.push(await fetchSource(spec, request, now));
  }
  const primary = individual
    ? await individualPubmedEvidence(ids, total, sources, request, now)
    : pubmedEvidence(sources, ids, total);
  const totals = { ...primary.searchTotals };
  const observedIds: Record<string, string[]> = { 'pubmed-search': searchIds };
  for (const claim of claimedSources) {
    const id = claim.id ?? '';
    if (id === 'pubmed-mesh-search') {
      const url = claim.url ?? '';
      const parsed = new URL(url);
      const query = parsed.searchParams.get('term') ?? '';
      if (
        parsed.origin !== 'https://eutils.ncbi.nlm.nih.gov' ||
        parsed.pathname !== '/entrez/eutils/esearch.fcgi' ||
        parsed.searchParams.get('db') !== 'pubmed' ||
        parsed.searchParams.get('retmode') !== 'json' ||
        parsed.searchParams.get('retmax') !== '10' ||
        !/patient navigation|care coordination/iu.test(query) ||
        !/randomized controlled trial/iu.test(query)
      )
        throw new Error('Unrecognized supplemental PubMed search');
      const spec: SourceSpec = {
        id,
        url,
        format: 'json',
        identity: ['"esearchresult"', '"idlist"'],
      };
      const response = await fetchSource(spec, request, now);
      sources.push(response);
      const search = pubmedSearch(response.body);
      totals[id] = search.total;
      observedIds[id] = search.ids;
    } else if (/^pubmed-\d{5,10}$/u.test(id)) {
      if (individual) continue;
      const pmid = id.slice('pubmed-'.length);
      const study = primary.studies?.find((item) => item.id === pmid);
      if (!study) throw new Error(`Unselected PubMed identity ${pmid}`);
      const spec: SourceSpec = {
        id,
        url: `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=${pmid}&retmode=xml`,
        format: 'xml',
        identity: ['<PubmedArticle', '<ArticleTitle', `<PMID`, pmid],
      };
      const response = await fetchSource(spec, request, now);
      if (
        !sameTitle(extractTag(response.body, 'ArticleTitle'), study.title) ||
        extractTag(response.body, 'PMID') !== pmid ||
        (study.doi && !response.body.includes(study.doi))
      )
        throw new Error(`PubMed ${pmid} individual record contradicts independently fetched study`);
      sources.push(response);
    } else if (/^crossref-\d{5,10}$/u.test(id)) {
      if (individual) continue;
      const pmid = id.slice('crossref-'.length);
      const study = primary.studies?.find((item) => item.id === pmid);
      if (!study?.doi) throw new Error(`Crossref ${pmid} cannot be traced to a primary DOI`);
      const spec: SourceSpec = {
        id,
        url: `https://api.crossref.org/works/${encodeURIComponent(study.doi)}`,
        format: 'json',
        identity: ['"message"', '"DOI"'],
      };
      const response = await fetchSource(spec, request, now);
      const message = parseJson(response.body).message;
      if (
        String(message?.DOI ?? '').toLowerCase() !== study.doi.toLowerCase() ||
        message?.type !== 'journal-article' ||
        !sameTitle(asText(message?.title?.[0]), study.title)
      )
        throw new Error(
          `Crossref ${pmid} did not independently corroborate DOI, title and journal type`,
        );
      sources.push(response);
    } else if (id === 'invalid-eutils-endpoint') {
      sources.push(await fetchNegativeControl(request, now));
    }
  }
  return { sources, ...primary, searchTotals: totals, searchIds: observedIds };
}

function fresh(value: unknown, now: Date): boolean {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/u.test(value)) return false;
  const epoch = Date.parse(value);
  return (
    Number.isFinite(epoch) &&
    epoch <= now.getTime() + MAX_FUTURE_SKEW_MS &&
    epoch >= now.getTime() - MAX_REPORT_AGE_MS
  );
}

function hasText(value: unknown, minimum = 30): boolean {
  return (
    typeof value === 'string' &&
    normalize(value).length >= minimum &&
    !/\b(?:todo|placeholder|lorem ipsum)\b/iu.test(value)
  );
}

function sourceChecks(
  task: ResearchCase,
  report: ResearchReport,
  evidence: RuntimeEvidence,
  now: Date,
): Array<[string, boolean]> {
  const rows = report.sources ?? [];
  const ids = new Set(rows.map((row) => row.id));
  const clinical = task.id === 'literature-research-full-task-2-individual';
  const batch = ids.has('pubmed-trials') && ids.has('europepmc-trials');
  const individual =
    evidence.studies?.every(
      (study) => ids.has(`pubmed-${study.id}`) && ids.has(`crossref-${study.id}`),
    ) ?? false;
  // A report can give grouped PubMed/Europe PMC evidence or independently
  // corroborated PubMed/Crossref records for each selected trial.
  const required = evidence.sources.filter(
    (source) =>
      !clinical || batch || !['pubmed-trials', 'europepmc-trials'].includes(source.spec.id),
  );
  const expected = new Set(required.map((source) => source.spec.id));
  const checks: Array<[string, boolean]> = [
    [
      'all required sources uniquely represented',
      rows.length === required.length &&
        ids.size === rows.length &&
        rows.every((row) => typeof row.id === 'string' && expected.has(row.id)) &&
        (!clinical ||
          ((batch || individual) &&
            ((!ids.has('pubmed-trials') && !ids.has('europepmc-trials')) || batch))),
    ],
  ];
  for (const { spec, body, status, digest, lastModified } of required) {
    const item = rows.find((row) => row.id === spec.id);
    checks.push([
      `${spec.id} direct HTTPS provenance`,
      !!item &&
        item.url === spec.url &&
        item.status === status &&
        fresh(item.retrievedAt, now) &&
        item.sha256 === digest &&
        SHA256.test(item.sha256 ?? '') &&
        (item.lastModified ?? null) === lastModified,
    ]);
    const excerpts = item?.excerpts ?? [];
    checks.push([
      `${spec.id} quotations anchored to fetched bytes`,
      Array.isArray(excerpts) &&
        excerpts.length >= 1 &&
        excerpts.length <= 8 &&
        excerpts.every(
          (quote) => hasText(quote, 28) && normalize(body).includes(normalize(quote)),
        ) &&
        new Set(excerpts).size === excerpts.length,
    ]);
  }
  return checks;
}

function searchExclusions(
  row: NonNullable<ResearchReport['searches']>[number],
  observedIds: string[] | undefined,
): boolean {
  if (Array.isArray(row.exclusions))
    return row.exclusions.length > 0 && row.exclusions.every((note) => hasText(note, 12));
  const alternatives = row.excludedAlternatives;
  if (!Array.isArray(alternatives) || alternatives.length === 0) return false;
  const ids = alternatives.flatMap((item) => item.ids ?? []);
  return (
    alternatives.every(
      (item) =>
        Array.isArray(item.ids) &&
        item.ids.length > 0 &&
        item.ids.every(
          (id) =>
            typeof id === 'string' &&
            (!observedIds || observedIds.includes(id)) &&
            !row.includedIds?.includes(id),
        ) &&
        hasText(item.reason, 12),
    ) && new Set(ids).size === ids.length
  );
}

function studyLimitations(value: string | string[] | undefined): boolean {
  return typeof value === 'string'
    ? hasText(value, 60)
    : Array.isArray(value) &&
        value.length > 0 &&
        value.every((item) => hasText(item, 16)) &&
        hasText(value.join(' '), 60);
}

function domainChecks(
  task: ResearchCase,
  report: ResearchReport,
  evidence: RuntimeEvidence,
  now: Date,
): Array<[string, boolean]> {
  const checks: Array<[string, boolean]> = [];
  if (task.kind === 'factual') {
    const expected = evidence.factual ?? {};
    const findings = report.findings ?? [];
    checks.push([
      'all factual propositions addressed',
      findings.length === Object.keys(expected).length,
    ]);
    for (const [id, fact] of Object.entries(expected)) {
      const found = findings.find((row) => row.id === id);
      checks.push([
        `${id} independently verified verdict, date and crosscheck`,
        !!found &&
          found.value === fact.value &&
          found.effectiveDate === fact.effectiveDate &&
          fact.sourceIds.every((sourceId) => found.sourceIds?.includes(sourceId)) &&
          found.sourceIds?.length === fact.sourceIds.length &&
          hasText(found.explanation, 45),
      ]);
    }
    return checks;
  }

  const expected = evidence.studies ?? [];
  const studies = report.studies ?? [];
  const searchTotals = evidence.searchTotals ?? {};
  const searches = report.searches ?? [];
  checks.push([
    'complete scholarly search trace',
    searches.length === Object.keys(searchTotals).length,
  ]);
  for (const [id, total] of Object.entries(searchTotals)) {
    const row = searches.find((item) => item.sourceId === id);
    const observedIds = evidence.searchIds?.[id];
    const counts = [row?.total, row?.observedTotal].filter((value) => value !== undefined);
    checks.push([
      `${id} search count, URL and eligibility`,
      !!row &&
        counts.length > 0 &&
        counts.every((value) => value === total) &&
        row.url === fetched(evidence.sources, id).spec.url &&
        Array.isArray(row.includedIds) &&
        new Set(row.includedIds).size === row.includedIds.length &&
        row.includedIds.every((studyId) => !observedIds || observedIds.includes(studyId)) &&
        searchExclusions(row, observedIds),
    ]);
  }
  checks.push([
    'two distinct primary studies selected',
    expected.length === 2 &&
      studies.length === 2 &&
      new Set(studies.map((study) => study.id)).size === 2,
  ]);
  for (const primary of expected) {
    const row = studies.find((study) => study.id === primary.id);
    const clinical = task.id === 'literature-research-full-task-2-individual';
    const referenced = row?.sourceIds ?? [];
    const grouped =
      primary.sourceIds.length === referenced.length &&
      primary.sourceIds.every((sourceId) => referenced.includes(sourceId));
    const individual =
      clinical &&
      [`pubmed-${primary.id}`, `crossref-${primary.id}`].every((sourceId) =>
        referenced.includes(sourceId),
      ) &&
      referenced.every(
        (sourceId) =>
          sourceId === `pubmed-${primary.id}` ||
          sourceId === `crossref-${primary.id}` ||
          searches.some(
            (search) => search.sourceId === sourceId && search.includedIds?.includes(primary.id),
          ),
      );
    const publication = row?.publicationStatus ?? '';
    const status =
      publication === primary.status ||
      (clinical &&
        /\bpublished\b/iu.test(publication) &&
        /\bjournal\b/iu.test(publication) &&
        /\brandomi[sz]ed\b/iu.test(publication) &&
        /\btrial\b/iu.test(publication) &&
        /\bPubMed\b/iu.test(publication) &&
        !/\bpeer.reviewed\b/iu.test(publication));
    const access =
      row?.access === primary.access ||
      (clinical &&
        /\babstract\b/iu.test(row?.access ?? '') &&
        /\b(?:only|full.text.{0,30}not (?:assessed|read|retrieved))\b/iu.test(row?.access ?? ''));
    checks.push([
      `${primary.id} verified identity, version, publication and abstract status`,
      !!row &&
        sameTitle(row.title ?? '', primary.title) &&
        row.published === primary.published &&
        status &&
        access &&
        (grouped || individual) &&
        new Set(referenced).size === referenced.length &&
        row.abstractExcerpt !== undefined &&
        hasText(row.abstractExcerpt, 45) &&
        normalize(primary.abstract).includes(normalize(row.abstractExcerpt)) &&
        (task.id !== 'literature-research-full-task-1-individual' ||
          primary.published >= '2024-01-01') &&
        Date.parse(primary.published) <= now.getTime(),
    ]);
    checks.push([
      `${primary.id} study design, comparator, outcomes and validity assessment`,
      !!row &&
        hasText(row.design) &&
        hasText(row.comparator) &&
        hasText(row.outcomes) &&
        studyLimitations(row.qualityLimitations),
    ]);
    checks.push([
      `${primary.id} included in reproducible searches`,
      searches.some((search) => search.includedIds?.includes(primary.id)),
    ]);
  }
  const synthesis = report.synthesis;
  checks.push([
    'weighted synthesis, conflict, applicability and gaps',
    !!synthesis &&
      hasText(synthesis.evidenceWeight, 55) &&
      hasText(synthesis.agreement, 35) &&
      hasText(synthesis.disagreement, 35) &&
      hasText(synthesis.applicability, 55) &&
      hasText(synthesis.gaps, 40),
  ]);
  if (task.id === 'literature-research-full-task-2-individual') {
    checks.push([
      'clinical-to-LLM transfer limited explicitly',
      /\b(?:indirect|not directly applicable|cannot generalize)\b/iu.test(
        synthesis?.applicability ?? '',
      ) && /\b(?:LLM|language model|software agent)\b/iu.test(synthesis?.applicability ?? ''),
    ]);
  }
  return checks;
}

function validMarkdown(root: string, task: ResearchCase): boolean {
  try {
    const result = readFixtureText(root, 'result.md');
    const verification = readFixtureText(root, 'verification.md');
    return (
      result.length >= 300 &&
      verification.length >= 150 &&
      task.sources.some((source) => result.includes(new URL(source.url).hostname)) &&
      /\b(?:source|evidence|citation|provenance)\b/iu.test(result) &&
      /\b(?:unverified|unknown|uncertain|limitation|conditional)\b/iu.test(result) &&
      /\bnegative\b/iu.test(verification) &&
      /\brecover/iu.test(verification) &&
      /\b(?:HTTP|status|fetch|retriev|response)\b/iu.test(verification) &&
      !/\bTODO\b/iu.test(result + verification)
    );
  } catch {
    return false;
  }
}

function parseReport(root: string): ResearchReport | null {
  try {
    const parsed: unknown = JSON.parse(readFixtureText(root, 'research.json'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as ResearchReport)
      : null;
  } catch {
    return null;
  }
}

/** HTTP fault controls are executed by the evaluator, not asserted by the candidate. */
async function measuredControls(
  spec: SourceSpec,
  request: HttpRequest,
  now: () => Date,
): Promise<{
  red: boolean;
  recovered: boolean;
  attempts: number;
  elapsedMs: number;
}> {
  let red = false;
  const reject: HttpRequest = async () => new Response('Temporary outage', { status: 503 });
  try {
    await fetchSource(spec, reject, now);
  } catch {
    red = true;
  }
  let attempts = 0;
  const interrupted: HttpRequest = async (url, init) => {
    attempts++;
    if (attempts === 1) return new Response('Temporary outage', { status: 503 });
    return request(url, init);
  };
  try {
    const recovered = await fetchSource(spec, interrupted, now);
    return {
      red,
      recovered: recovered.attempts === 2 && attempts === 2,
      attempts,
      elapsedMs: recovered.elapsedMs,
    };
  } catch {
    return { red, recovered: false, attempts, elapsedMs: 0 };
  }
}

const failure = (evidence: string[], integrityFailure = false): SkillEvalDeterministicScore => ({
  passed: false,
  quality: 0,
  verification: 0,
  integrityFailure,
  evidence,
});

export async function scorePublicResearchRuntime(
  scenario: SkillEvalScenarioV3,
  root: string,
  options: PublicResearchRuntimeOptions = {},
): Promise<SkillEvalDeterministicScore> {
  const task = scenarioCase(scenario);
  if (!task) return failure([`Unsupported public-research scenario ${scenario.id}`], true);
  if (
    !fixtureTextEquals(root, 'research-task.json', fixturePacket(task)) ||
    !fixtureTextEquals(root, 'README.md', readme(task))
  )
    return failure(['Immutable public-research task or instructions missing/modified'], true);

  const report = parseReport(root);
  const request: HttpRequest = options.request ?? ((url, init) => fetch(url, init));
  const now = options.now ?? (() => new Date());
  const recordedAt = now();
  let observed: RuntimeEvidence;
  try {
    observed = await independentEvidence(task, request, now, report);
  } catch (error) {
    return failure([
      `Live authoritative retrieval/identity failed for ${task.id}: ${error instanceof Error ? error.message : String(error)}`,
      'Status: unverified. Do not infer current facts, clinical trial outcomes or publication status from a fixture, cached snippet or mirror.',
    ]);
  }

  const checks: Array<[string, boolean]> = [
    [
      'structured research artifact identifies V5 task and run date',
      !!report &&
        report.schemaVersion === 1 &&
        report.scenarioId === task.id &&
        fresh(report.checkedAt, recordedAt),
    ],
    [
      'specialist/hierarchy scope and exclusions',
      !!report &&
        report.boundary?.selectedSkill === task.skill &&
        report.boundary?.broaderSkill === 'research' &&
        report.boundary?.adjacentSkill === task.neighbor &&
        hasText(report.boundary?.scope, 45) &&
        Array.isArray(report.boundary?.exclusions) &&
        report.boundary.exclusions.length > 0 &&
        report.boundary.exclusions.every((item) => hasText(item, 16)),
    ],
    ['readable cited report and failure/recovery verification', validMarkdown(root, task)],
  ];
  if (report) {
    checks.push(...sourceChecks(task, report, observed, recordedAt));
    checks.push(...domainChecks(task, report, observed, recordedAt));
  }

  // Real upstream recovery is required. Injected 503s are NEGATIVE controls only;
  // the recovery's second HTTP request uses the actual authoritative transport.
  const control = await measuredControls(observed.sources[0]!.spec, request, now);
  checks.push(['measured HTTP outage fails closed', control.red]);
  checks.push(['measured transient outage recovers via authoritative HTTP', control.recovered]);

  const passed = checks.every(([, yes]) => !!yes);
  const evidence = [
    `Source retrieval: ${options.request ? 'CONTROLLED TEST TRANSPORT (not certified live evidence)' : 'live HTTPS'}; evaluation UTC ${recordedAt.toISOString()}.`,
    ...observed.sources.map(
      (source) =>
        `${source.spec.id}: HTTP ${source.status} ${source.spec.url}; fetched ${source.fetchedAt}; sha256 ${source.digest}; ${source.elapsedMs} ms; ${source.attempts} attempt(s); last-modified ${source.lastModified ?? 'undated'}.`,
    ),
    `Red/green controls: injected outage rejected=${control.red}; authoritative retry succeeded=${control.recovered}; attempts=${control.attempts}; elapsed=${control.elapsedMs}ms.`,
    ...checks.map(([name, yes]) => `${name}: ${yes ? 'pass' : 'fail'}`),
  ];
  return {
    passed,
    quality: checks.filter(([, yes]) => !!yes).length / checks.length,
    verification: passed ? 1 : 0,
    integrityFailure: false,
    evidence,
  };
}

export const PUBLIC_RESEARCH_SKILL_EVAL_MATERIALIZERS: readonly SkillEvalFixtureMaterializer[] = [
  {
    id: 'public-research/live-authoritative-http-v2',
    realRuntime: true,
    matches: (scenario) => scenarioCase(scenario) !== null,
    materialize: (destination, scenario) => {
      const task = scenarioCase(scenario);
      if (!task) throw new Error(`Invalid public research materialization ${scenario.id}`);
      writeFixtureFile(destination, 'research-task.json', fixturePacket(task));
      writeFixtureFile(destination, 'README.md', readme(task));
    },
  },
];

export const PUBLIC_RESEARCH_SKILL_EVAL_SCORERS: readonly SkillEvalDeterministicScorer[] = [
  {
    id: 'public-research/live-source-and-scholarly-provenance-v2',
    scenarioIds: PUBLIC_RESEARCH_CASES.map((task) => task.id),
    score: ({ scenario, workingDirectory }) =>
      scorePublicResearchRuntime(scenario, workingDirectory),
  },
];
