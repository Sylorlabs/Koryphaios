import { createHash } from 'node:crypto';
import type {
  SkillEvalDeterministicScore,
  SkillEvalDeterministicScorer,
  SkillEvalFixtureMaterializer,
} from './skill-eval-execution';
import type { SkillEvalScenarioV3 } from './skill-eval-harness';
import { fixtureTextEquals, readFixtureText, writeFixtureFile } from './skill-eval-fixture-helpers';

/**
 * Open-world market evaluation. The fixture specifies a decision and authoritative
 * starting points, never prices, market totals, or an answer key. The scorer
 * independently fetches those sources again. A controlled test transport is
 * deliberately incapable of certifying a live evaluation.
 *
 * The paired same-model runs and blind quality review belong to the V5 runner.
 */
type HttpRequest = (url: string, init: RequestInit) => Promise<Response>;
type Vendor = 'posthog' | 'mixpanel' | 'amplitude';
type SourceKind = 'pricing' | 'product' | 'terms' | 'census-context' | 'census-data';
type MarketKind = 'vendor-comparison' | 'market-sizing';

interface SourceSpec {
  id: string;
  url: string;
  kind: SourceKind;
  vendor?: Vendor;
  format: 'html' | 'json';
  identity: readonly string[];
  naics?: string;
}

interface MarketCase {
  id: string;
  /** SHA-256 of the original task's prompt, requirements, six check assertions,
   * scorer definitions, required evidence and required artifacts. */
  scenarioContractSha256: string;
  kind: MarketKind;
  startingState: string;
  neighbor: 'factual-research' | 'literature-research';
  question: string;
  scope: string;
  sources: readonly SourceSpec[];
}

const census = (naics: string): SourceSpec => ({
  id: `census-${naics}`,
  url: `https://api.census.gov/data/2022/ecnbasic?get=NAME%2CNAICS2022_LABEL%2CESTAB%2CRCPTOT&for=us%3A%2A&NAICS2022=${naics}`,
  kind: 'census-data',
  format: 'json',
  identity: [naics, 'ESTAB', 'RCPTOT'],
  naics,
});

function freezeDeep<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

export const MARKET_RESEARCH_CASES: readonly MarketCase[] = freezeDeep([
  {
    id: 'market-competitive-research-full-task-1-individual',
    scenarioContractSha256: '15be532e1ff719ebdba4b31c1322d6e449f3db4451fb339c330b397ffa12052e',
    kind: 'vendor-comparison',
    startingState: 'https://posthog.com/pricing',
    neighbor: 'factual-research',
    question: 'Compare PostHog, Mixpanel and Amplitude for a US product team with 25 users and approximately 2,000,000 monthly product events. Establish a buying decision, normalize published pricing and plan terms, and distinguish vendor assertions, adoption proxies and unknowns.',
    scope: 'Current first-party product, pricing and legal terms; 25 user seats, 2 million monthly events; no unsupported customer counts, market share or inferred price guarantees.',
    sources: [
      { id: 'posthog-pricing', url: 'https://posthog.com/pricing', kind: 'pricing', vendor: 'posthog', format: 'html', identity: ['PostHog', 'pricing'] },
      { id: 'posthog-product', url: 'https://posthog.com/docs/product-analytics', kind: 'product', vendor: 'posthog', format: 'html', identity: ['PostHog', 'analytics'] },
      { id: 'posthog-terms', url: 'https://posthog.com/terms', kind: 'terms', vendor: 'posthog', format: 'html', identity: ['PostHog', 'terms'] },
      { id: 'mixpanel-pricing', url: 'https://mixpanel.com/pricing/', kind: 'pricing', vendor: 'mixpanel', format: 'html', identity: ['Mixpanel', 'pricing'] },
      { id: 'mixpanel-product', url: 'https://docs.mixpanel.com/docs/what-is-mixpanel', kind: 'product', vendor: 'mixpanel', format: 'html', identity: ['Mixpanel', 'analytics'] },
      { id: 'mixpanel-terms', url: 'https://mixpanel.com/legal/terms-of-use/', kind: 'terms', vendor: 'mixpanel', format: 'html', identity: ['Mixpanel', 'terms'] },
      { id: 'amplitude-pricing', url: 'https://amplitude.com/pricing', kind: 'pricing', vendor: 'amplitude', format: 'html', identity: ['Amplitude', 'pricing'] },
      { id: 'amplitude-product', url: 'https://amplitude.com/docs/analytics', kind: 'product', vendor: 'amplitude', format: 'html', identity: ['Amplitude', 'analytics'] },
      { id: 'amplitude-terms', url: 'https://amplitude.com/terms', kind: 'terms', vendor: 'amplitude', format: 'html', identity: ['Amplitude', 'terms'] },
    ],
  },
  {
    id: 'market-competitive-research-full-task-2-individual',
    scenarioContractSha256: '0409f34168c29378b5854a80d7be61e330bba056df6f8544666b43c143bf488c',
    kind: 'market-sizing',
    startingState: 'https://www.census.gov/programs-surveys/economic-census/data.html',
    neighbor: 'literature-research',
    question: 'Bound a US market opportunity for an enterprise agent harness. Use actual 2022 Economic Census NAICS establishment counts as explicitly indirect industry proxies, then show transparent top-down and bottom-up opportunity calculations. Do not convert adjacent industries into direct agent-harness adoption or TAM; public-company revenue requires separate SEC filing evidence.',
    scope: 'United States, 2022 Economic Census NAICS 541511 and 541512 industry proxy; current retrieval as-of date; business-model assumptions disclosed and calculated, with public-company figures excluded unless separately verified against SEC filings.',
    sources: [
      { id: 'census-context', url: 'https://www.census.gov/programs-surveys/economic-census/data.html', kind: 'census-context', format: 'html', identity: ['Economic Census', 'data'] },
      census('541511'),
      census('541512'),
    ],
  },
]);

const CASE_BY_ID = new Map(MARKET_RESEARCH_CASES.map((item) => [item.id, item]));
const CHILDREN = freezeDeep(['market-strategy', 'marketing-strategy', 'pricing-monetization', 'procurement-vendor-evaluation']);
const DIMENSIONS = freezeDeep(['users', 'jobs', 'substitutes', 'capability', 'constraints', 'pricing', 'distribution', 'adoption', 'switching-costs', 'differentiation']);
const FALSIFIABLE_CHECKS = freezeDeep(['scope-and-hierarchy', 'operating-contract', 'execution-invariant', 'verification-discipline', 'anti-pattern-resistance', 'evidence-and-uncertainty']);
const MAX_BYTES = 1_500_000;
const TIMEOUT_MS = 10_000;
const FRESH_MS = 30 * 60_000;
const FUTURE_SKEW_MS = 2 * 60_000;
const SHA256 = /^[a-f0-9]{64}$/u;
const DATE = /^\d{4}-\d{2}-\d{2}$/u;

interface Retrieved {
  spec: SourceSpec;
  body: string;
  sha256: string;
  retrievedAt: string;
  finalUrl: string;
  lastModified: string | null;
  contentType: string;
  attempts: number;
  elapsedMs: number;
}

interface ReportSource {
  id?: string;
  url?: string;
  finalUrl?: string;
  status?: number;
  retrievedAt?: string;
  sha256?: string;
  lastModified?: string | null;
  publishedOn?: string | null;
  effectiveOn?: string | null;
  dateExcerpt?: string | null;
  excerpts?: string[];
}

interface Claim {
  id?: string;
  dimension?: string;
  status?: 'source-fact' | 'vendor-assertion' | 'proxy' | 'inference' | 'unknown';
  statement?: string;
  sourceIds?: string[];
  quotes?: Array<{ sourceId?: string; text?: string }>;
  limitations?: string;
}

interface VendorComparison {
  vendor?: Vendor;
  plan?: string;
  pricingQuote?: string;
  billingUnit?: 'event' | 'seat' | 'custom' | 'unknown';
  priceUsd?: number | null;
  unitSize?: number | null;
  includedEvents?: number | null;
  estimatedMonthlyUsd?: number | null;
  estimateStatus?: 'calculated' | 'unavailable';
  assumptions?: string;
  distribution?: string;
  switchingCosts?: string;
  differentiation?: string;
  adoptionStatus?: 'vendor-assertion' | 'proxy' | 'unknown';
  adoptionLimitations?: string;
  reconciledSourceIds?: string[];
  agreement?: string;
  conflicts?: string;
  uncertainty?: string;
}

interface MarketRow {
  naics?: string;
  label?: string;
  sourceYear?: number;
  geography?: string;
  sourceIds?: string[];
  establishments?: number;
  receiptsThousandsUsd?: number | null;
  applicability?: 'indirect-proxy';
  limitations?: string;
}

interface Sizing {
  sourceEstablishments?: number;
  topDown?: {
    addressableFraction?: number;
    annualSpendPerAccountUsd?: number;
    annualOpportunityUsd?: number;
    assumptions?: string;
  };
  bottomUp?: {
    reachableAccounts?: number;
    qualificationFraction?: number;
    annualContractValueUsd?: number;
    annualOpportunityUsd?: number;
    assumptions?: string;
  };
  overlapAndCategoryLimitations?: string;
  noUnverifiedPublicCompanyFinancials?: boolean;
}

interface MarketReport {
  schemaVersion?: number;
  scenarioId?: string;
  checkedAt?: string;
  boundary?: {
    selectedSkill?: string;
    broaderSkill?: string;
    children?: string[];
    adjacentSkill?: string;
    scope?: string;
    exclusions?: string[];
  };
  decision?: {
    buyer?: string;
    question?: string;
    users?: number;
    monthlyEvents?: number;
    geography?: string;
    dimensions?: string[];
    sequence?: string[];
    assumptions?: string;
  };
  sources?: ReportSource[];
  claims?: Claim[];
  comparisons?: VendorComparison[];
  marketRows?: MarketRow[];
  sizing?: Sizing;
  synthesis?: {
    facts?: string;
    inferences?: string;
    unknowns?: string;
    adoptionBoundary?: string;
    decision?: string;
  };
}

export interface MarketResearchRuntimeOptions {
  /** Unit-test injection: never certifies external/public sources. */
  request?: HttpRequest;
  now?: () => Date;
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function taskPacket(task: MarketCase): string {
  return json({
    schemaVersion: 1,
    id: task.id,
    skill: 'market-competitive-research',
    kind: task.kind,
    sourceOfRecord: task.startingState,
    broaderSkill: 'research',
    children: CHILDREN,
    adjacentSkill: task.neighbor,
    question: task.question,
    scope: task.scope,
    dimensions: DIMENSIONS,
    scenarioChecks: FALSIFIABLE_CHECKS,
    sources: task.sources,
    rules: [
      'Retrieve actual first-party/public HTTPS sources; record raw-body sha256, UTC fetch time, final URL and substantial verbatim excerpts.',
      'Publication/effective dates must be explicitly present in a quoted source; otherwise use null, with retrieval as-of date separately.',
      'Reconcile prices, included events/seats, contracts, product scope and uncertainty across sources; never invent a price or adoption percentage.',
      'Distinguish source facts, vendor claims, indirect proxies, inference and unknowns. Market sizing assumptions are not observed market facts.',
      'Verify a real negative/outage and retry if performed; never claim an outage test happened on the strength of a hypothetical plan.',
      'Paired no-skill/skill runs and blind review belong to the independent evaluation runner.',
    ],
  });
}

function readme(task: MarketCase): string {
  const domain = task.kind === 'vendor-comparison'
    ? 'Write comparisons[] for PostHog, Mixpanel and Amplitude (one each): vendor, plan, pricingQuote, billingUnit (event/seat/custom/unknown), priceUsd, unitSize, includedEvents, estimatedMonthlyUsd, estimateStatus, assumptions, distribution, switchingCosts, differentiation, adoptionStatus, adoptionLimitations, reconciledSourceIds, agreement, conflicts and uncertainty. A calculated estimate must use a price and unit actually quoted by the vendor, normalized to 25 seats or 2,000,000 events; otherwise the estimate MUST be null and status unavailable. Add nine claim-ledger records with IDs <vendor>-pricing, <vendor>-product, <vendor>-terms, each with the appropriate exact source ID and a raw-body excerpt. Vendor materials do not independently establish adoption or market share.'
    : 'Write marketRows[] for 2022 NAICS 541511 and 541512: sourceYear, geography, label, observed establishments and receiptsThousandsUsd (null if suppressed), sourceIds, applicability=indirect-proxy and limitations. Add a claim ledger record for each code and the Census documentation. Write sizing with sourceEstablishments, topDown (addressableFraction, annualSpendPerAccountUsd, annualOpportunityUsd, assumptions), bottomUp (reachableAccounts, qualificationFraction, annualContractValueUsd, annualOpportunityUsd, assumptions), overlapAndCategoryLimitations, and noUnverifiedPublicCompanyFinancials=true. No public company revenue can be used without a verifiable SEC filing; adjacent NAICS industries are not observed agent-harness adoption or a definitive TAM.';
  return `# V5 live market competitive research\n\n${task.question}\n\n${task.scope}\n\nThe input \`market-task.json\` and this README are immutable. Make real HTTPS requests to the listed authoritative sources during the run. Unavailable/invalid sources leave the evaluation unverified. Never replace an unavailable page with search snippets, model memory, a mock or a guessed date. Preserve any disagreement rather than selecting a convenient claim.\n\nWrite \`market-research.json\`, \`result.md\` and \`verification.md\`. The structured report requires schemaVersion=1, scenarioId, checkedAt (UTC), boundary { selectedSkill:'market-competitive-research', broaderSkill:'research', children, adjacentSkill, scope, exclusions }, and decision { buyer, question, users:25, monthlyEvents:2000000, geography:'US', dimensions, sequence, assumptions } for comparison (US geography and decision structure also required for sizing; sizing need not assume seats/events).\n\nEvery required sources[] record must have id, requested url, finalUrl, status=200, retrievedAt, sha256 of the actual HTTP response body, HTTP lastModified or null, excerpts[] verbatim from the returned body, and publishedOn/effectiveOn/dateExcerpt when such a date actually appears; otherwise explicitly record null. Provide claims[] { id, dimension, status, statement, sourceIds, quotes:[{sourceId,text}], limitations } grounded in those bytes.\n\n${domain}\n\nAdd synthesis {facts,inferences,unknowns,adoptionBoundary,decision} distinguishing supported observations from assumptions. In verification.md report performed positive retrieval, a real or explicitly controlled negative outage and the measured recovery attempt with status/attempts and outcome. A written claim of recovery is not independent verification; the evaluator performs its own fault controls. Cite the source domains in result.md and explicitly label unknowns and proxies.\n`;
}

function scenarioCase(scenario: SkillEvalScenarioV3): MarketCase | null {
  const task = CASE_BY_ID.get(scenario.id);
  if (!task || scenario.skill !== 'market-competitive-research' ||
    scenario.category !== 'full-task' || !scenario.expectedSelection || !scenario.heldOut ||
    scenario.environment?.kind !== 'public-web' ||
    scenario.environment.startingState !== task.startingState ||
    !Array.isArray(scenario.falsifiableChecks) ||
    scenario.falsifiableChecks.length !== FALSIFIABLE_CHECKS.length ||
    !FALSIFIABLE_CHECKS.every((id) => scenario.falsifiableChecks.some((check) => check.id === id)) ||
    createHash('sha256').update(JSON.stringify([
      scenario.prompt, scenario.environment.requirements, scenario.falsifiableChecks,
      scenario.scorers, scenario.requiredEvidence, scenario.requiredArtifacts,
    ])).digest('hex') !== task.scenarioContractSha256) return null;
  return task;
}

function normalize(text: string): string {
  return text.replace(/<[^>]*>/gu, ' ')
    .replace(/&(?:amp|quot|apos|nbsp|lt|gt);/gu, (entity) =>
      ({ '&amp;': '&', '&quot;': '"', '&apos;': "'", '&nbsp;': ' ', '&lt;': '<', '&gt;': '>' })[entity] ?? entity)
    .replace(/\s+/gu, ' ').trim();
}

function text(value: unknown, min = 30): boolean {
  return typeof value === 'string' && normalize(value).length >= min &&
    !/\b(?:todo|placeholder|lorem ipsum)\b/iu.test(value);
}

function fresh(value: unknown, now: Date): boolean {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/u.test(value)) return false;
  const epoch = Date.parse(value);
  return Number.isFinite(epoch) && epoch >= now.getTime() - FRESH_MS && epoch <= now.getTime() + FUTURE_SKEW_MS;
}

async function boundedText(response: Response): Promise<{ body: string; digest: string }> {
  const length = response.headers.get('content-length');
  if (length !== null && Number(length) > MAX_BYTES) throw new Error('source exceeds size limit');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('source has no response body');
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_BYTES) throw new Error('source exceeds size limit');
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = Buffer.concat(chunks, total);
  return {
    body: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    digest: createHash('sha256').update(bytes).digest('hex'),
  };
}

function validateResponse(spec: SourceSpec, response: Response, body: string): void {
  const expected = new URL(spec.url);
  const final = response.url ? new URL(response.url) : null;
  if (!final || final.protocol !== 'https:' || final.host !== expected.host ||
    final.username || final.password || expected.protocol !== 'https:')
    throw new Error(`${spec.id}: untrusted redirect or unverifiable HTTPS origin`);
  const mime = response.headers.get('content-type') ?? '';
  if (!(spec.format === 'json' ? /(?:application\/json|application\/[^;]+\+json)/iu : /(?:text\/html|application\/xhtml\+xml)/iu).test(mime))
    throw new Error(`${spec.id}: invalid source content type ${mime || '(missing)'}`);
  if (body.length < 90 || spec.identity.some((token) => !body.toLowerCase().includes(token.toLowerCase())))
    throw new Error(`${spec.id}: authoritative source identity/content absent`);
}

async function retrieve(spec: SourceSpec, request: HttpRequest, now: () => Date): Promise<Retrieved> {
  const started = performance.now();
  let failure = 'no HTTP response';
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await request(spec.url, {
        cache: 'no-store',
        redirect: 'follow',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { Accept: spec.format === 'json' ? 'application/json' : 'text/html,application/xhtml+xml' },
      });
      if (response.status !== 200) {
        failure = `${spec.id}: HTTP ${response.status}`;
        if (attempt < 2 && [429, 500, 502, 503, 504].includes(response.status)) continue;
        throw new Error(failure);
      }
      const { body, digest } = await boundedText(response);
      validateResponse(spec, response, body);
      return {
        spec, body, sha256: digest,
        retrievedAt: now().toISOString(),
        finalUrl: response.url,
        lastModified: response.headers.get('last-modified'),
        contentType: response.headers.get('content-type') ?? '',
        attempts: attempt,
        elapsedMs: Math.round(performance.now() - started),
      };
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
      if (attempt < 2 && !/identity|size limit|content type|untrusted redirect|HTTP 4\d\d/iu.test(failure)) continue;
      break;
    }
  }
  throw new Error(`${spec.id}: ${failure}`);
}

async function retrieveAll(task: MarketCase, request: HttpRequest, now: () => Date): Promise<Retrieved[]> {
  const sources: Retrieved[] = [];
  for (const spec of task.sources) sources.push(await retrieve(spec, request, now));
  if (task.kind === 'market-sizing') for (const source of sources.filter((item) => item.spec.kind === 'census-data')) censusRow(source);
  return sources;
}

function from(sources: Retrieved[], id: string): Retrieved {
  const found = sources.find((source) => source.spec.id === id);
  if (!found) throw new Error(`missing evaluator source ${id}`);
  return found;
}

function censusRow(source: Retrieved): { code: string; label: string; establishments: number; receipts: number | null } {
  const data: unknown = JSON.parse(source.body);
  if (!Array.isArray(data) || data.length !== 2 || !Array.isArray(data[0]) || !Array.isArray(data[1]))
    throw new Error(`${source.spec.id}: expected one authentic Census data row`);
  const header = data[0] as unknown[];
  const values = data[1] as unknown[];
  const field = (name: string): unknown => values[header.indexOf(name)];
  const code = field('NAICS2022');
  const label = field('NAICS2022_LABEL');
  const count = field('ESTAB');
  const receipts = field('RCPTOT');
  if (code !== source.spec.naics || typeof label !== 'string' || label.length < 8 ||
    !/^(?:0|[1-9]\d*)$/u.test(String(count)) ||
    field('us') !== '1') throw new Error(`${source.spec.id}: NAICS/geography/count mismatch`);
  if (Number(count) < 1 || !Number.isSafeInteger(Number(count)))
    throw new Error(`${source.spec.id}: invalid establishment count`);
  const money = /^(?:0|[1-9]\d*)$/u.test(String(receipts)) ? Number(receipts) : null;
  if (money !== null && !Number.isSafeInteger(money)) throw new Error(`${source.spec.id}: invalid receipts`);
  return { code: source.spec.naics!, label, establishments: Number(count), receipts: money };
}

function sourceChecks(report: MarketReport, sources: Retrieved[], now: Date): Array<[string, boolean]> {
  const rows = Array.isArray(report.sources) ? report.sources : [];
  const checks: Array<[string, boolean]> = [
    ['complete unique first-party source ledger', rows.length === sources.length && new Set(rows.map((row) => row.id)).size === sources.length],
  ];
  for (const source of sources) {
    const record = rows.find((row) => row.id === source.spec.id);
    checks.push([`${source.spec.id} independent raw-byte provenance`, !!record &&
      record.url === source.spec.url && record.finalUrl === source.finalUrl &&
      record.status === 200 && fresh(record.retrievedAt, now) &&
      SHA256.test(record.sha256 ?? '') && record.sha256 === source.sha256 &&
      (record.lastModified ?? null) === source.lastModified]);
    checks.push([`${source.spec.id} source excerpts are actual response bytes`, !!record &&
      Array.isArray(record.excerpts) && record.excerpts.length >= 1 && record.excerpts.length <= 8 &&
      record.excerpts.every((quote) => text(quote, 25) && normalize(source.body).includes(normalize(quote))) &&
      new Set(record.excerpts).size === record.excerpts.length]);
    const declared = [
      [record?.publishedOn ?? null, /\b(?:published|posted)\b/iu],
      [record?.effectiveOn ?? null, /\b(?:effective|in force)\b/iu],
    ] as const;
    checks.push([`${source.spec.id} source dates not fabricated`, declared.every(([date, label]) =>
      date === null || (typeof date === 'string' && DATE.test(date) &&
        !Number.isNaN(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date &&
        text(record?.dateExcerpt, 10) && normalize(source.body).includes(normalize(record!.dateExcerpt!)) &&
        label.test(record!.dateExcerpt!) &&
        normalize(record!.dateExcerpt!).includes(date))) &&
      !!record && Object.hasOwn(record, 'publishedOn') && Object.hasOwn(record, 'effectiveOn') &&
      Object.hasOwn(record, 'dateExcerpt') &&
      (record.dateExcerpt === null || (typeof record.dateExcerpt === 'string' &&
        normalize(source.body).includes(normalize(record.dateExcerpt))))]);
  }
  return checks;
}

function claimChecks(report: MarketReport, sources: Retrieved[], requiredIds: string[]): Array<[string, boolean]> {
  const claims = Array.isArray(report.claims) ? report.claims : [];
  const checks: Array<[string, boolean]> = [
    ['required claims and unique claim identities', claims.length >= requiredIds.length &&
      claims.length <= 28 && new Set(claims.map((claim) => claim.id)).size === claims.length &&
      requiredIds.every((id) => claims.some((claim) => claim.id === id))],
  ];
  for (const claim of claims) {
    const ids = claim.sourceIds ?? [];
    const quotes = claim.quotes ?? [];
    const sourcesExist = Array.isArray(ids) && ids.length >= 1 && ids.length <= 4 &&
      new Set(ids).size === ids.length && ids.every((id) => sources.some((source) => source.spec.id === id));
    const anchored = sourcesExist && Array.isArray(quotes) && quotes.length >= ids.length &&
      quotes.length <= 6 && ids.every((id) => quotes.some((quote) => quote.sourceId === id)) &&
      quotes.every((quote) => ids.includes(quote.sourceId ?? '') && text(quote.text, 24) &&
        normalize(from(sources, quote.sourceId!).body).includes(normalize(quote.text!)));
    const compatibleStatus = ['source-fact', 'vendor-assertion', 'proxy', 'inference', 'unknown'].includes(claim.status ?? '') &&
      ((claim.status !== 'inference' && claim.status !== 'proxy' && claim.status !== 'unknown') ||
        text(claim.limitations, 30));
    checks.push([`claim ${claim.id ?? '(missing)'} trace, classification and uncertainty`,
      text(claim.id, 8) && text(claim.dimension, 4) && text(claim.statement, 35) &&
      sourcesExist && anchored && compatibleStatus]);
  }
  return checks;
}

function close(actual: unknown, expected: number, absoluteTolerance = 0.01): boolean {
  return typeof actual === 'number' && Number.isFinite(actual) &&
    Math.abs(actual - expected) <= Math.max(absoluteTolerance, Math.abs(expected) * 1e-7);
}

function quotedAmount(quote: string, amount: number): boolean {
  if (!Number.isFinite(amount) || amount < 0 || amount > 1_000_000) return false;
  return [...quote.matchAll(/\$\s*(\d+(?:,\d{3})*(?:\.\d+)?)/gu)]
    .some((match) => close(Number(match[1]!.replaceAll(',', '')), amount, 1e-8));
}

function comparisonChecks(report: MarketReport, sources: Retrieved[]): Array<[string, boolean]> {
  const checks: Array<[string, boolean]> = [];
  const comparisons = Array.isArray(report.comparisons) ? report.comparisons : [];
  checks.push(['complete three-vendor comparison', comparisons.length === 3 &&
    new Set(comparisons.map((row) => row.vendor)).size === 3]);
  for (const vendor of ['posthog', 'mixpanel', 'amplitude'] as const) {
    const row = comparisons.find((item) => item.vendor === vendor);
    const pricingSource = from(sources, `${vendor}-pricing`);
    const quote = row?.pricingQuote ?? '';
    const quoteAnchored = text(quote, 20) && normalize(pricingSource.body).includes(normalize(quote));
    const custom = row?.billingUnit === 'custom' || row?.billingUnit === 'unknown';
    const numerical = row?.priceUsd !== null && row?.priceUsd !== undefined;
    const quoteNumeric = numerical && typeof row?.priceUsd === 'number' &&
      quotedAmount(quote, row.priceUsd) &&
      (row.billingUnit === 'event' ? /\bevents?\b/iu.test(quote) :
        row.billingUnit === 'seat' ? /\b(?:seats?|users?)\b/iu.test(quote) : false);
    const includes = row?.includedEvents == null || (Number.isSafeInteger(row.includedEvents) &&
      row.includedEvents >= 0 && new RegExp(`\\b${row.includedEvents}\\b`, 'u').test(quote));
    const validUnitSize = row?.unitSize != null && Number.isSafeInteger(row.unitSize) &&
      row.unitSize >= 1 && row.unitSize <= 1_000_000;
    const unitQuoted = validUnitSize && new RegExp(`\\b${row.unitSize}\\b`, 'u').test(quote);
    const monthlyPrice = /\b(?:month|monthly)\b/iu.test(quote);
    const calculated = !!row && !custom && quoteNumeric && validUnitSize && unitQuoted &&
      monthlyPrice && includes && (row.billingUnit === 'seat' || row.includedEvents != null) &&
      row.estimateStatus === 'calculated' &&
      close(row.estimatedMonthlyUsd,
        (row.billingUnit === 'seat' ? 25 : Math.max(0, 2_000_000 - (row.includedEvents ?? 0)) / row.unitSize!) * row.priceUsd!);
    const unavailable = row?.estimateStatus === 'unavailable' && row.estimatedMonthlyUsd === null &&
      (!numerical || (quotedAmount(quote, row.priceUsd!) && (custom || !calculated)));
    checks.push([`${vendor} first-party price quotation and defensible normalization`, !!row &&
      quoteAnchored && (calculated || unavailable) && text(row.plan, 2) &&
      text(row.assumptions, 40)]);
    checks.push([`${vendor} product/terms reconciliation and adoption boundary`, !!row &&
      Array.isArray(row.reconciledSourceIds) && row.reconciledSourceIds.length === 3 &&
      [`${vendor}-pricing`, `${vendor}-product`, `${vendor}-terms`].every((id) => row.reconciledSourceIds!.includes(id)) &&
      text(row.agreement, 40) && text(row.conflicts, 35) && text(row.uncertainty, 40) &&
      text(row.distribution, 25) && text(row.switchingCosts, 25) && text(row.differentiation, 25) &&
      ['vendor-assertion', 'proxy', 'unknown'].includes(row.adoptionStatus ?? '') &&
      text(row.adoptionLimitations, 35)]);
    for (const kind of ['pricing', 'product', 'terms'] as const) {
      const claim = report.claims?.find((candidate) => candidate.id === `${vendor}-${kind}`);
      checks.push([`${vendor} ${kind} anchored to its owning first-party page`, !!claim &&
        claim.sourceIds?.length === 1 && claim.sourceIds[0] === `${vendor}-${kind}` &&
        claim.quotes?.some((item) => item.sourceId === `${vendor}-${kind}`) === true]);
    }
  }
  return checks;
}

function sizingChecks(report: MarketReport, sources: Retrieved[]): Array<[string, boolean]> {
  const rows = Array.isArray(report.marketRows) ? report.marketRows : [];
  const checks: Array<[string, boolean]> = [
    ['distinct US Census NAICS row boundaries', rows.length === 2 && new Set(rows.map((row) => row.naics)).size === 2],
  ];
  let count = 0;
  for (const naics of ['541511', '541512']) {
    const expected = censusRow(from(sources, `census-${naics}`));
    const row = rows.find((item) => item.naics === naics);
    count += expected.establishments;
    checks.push([`${naics} official 2022 Census row, date, units and NAICS scope`, !!row &&
      row.label === expected.label && row.establishments === expected.establishments &&
      row.receiptsThousandsUsd === expected.receipts && row.sourceYear === 2022 &&
      row.geography === 'US' && row.applicability === 'indirect-proxy' &&
      row.sourceIds?.length === 2 && row.sourceIds.includes(`census-${naics}`) &&
      row.sourceIds.includes('census-context') && text(row.limitations, 55)]);
    const claim = report.claims?.find((item) => item.id === `census-${naics}`);
    checks.push([`${naics} labelled indirect adoption proxy`, claim?.status === 'proxy' &&
      claim.sourceIds?.includes(`census-${naics}`) === true && text(claim.limitations, 45)]);
  }
  const sizing = report.sizing;
  const top = sizing?.topDown;
  const bottom = sizing?.bottomUp;
  checks.push(['top-down model uses published establishments and explicit assumed spend',
    sizing?.sourceEstablishments === count &&
    typeof top?.addressableFraction === 'number' && top.addressableFraction > 0 && top.addressableFraction <= 1 &&
    typeof top.annualSpendPerAccountUsd === 'number' && top.annualSpendPerAccountUsd > 0 &&
    close(top.annualOpportunityUsd, count * top.addressableFraction * top.annualSpendPerAccountUsd) &&
    text(top.assumptions, 50)]);
  checks.push(['bottom-up model exposes independently assumed buyer funnel and contract',
    typeof bottom?.reachableAccounts === 'number' && Number.isSafeInteger(bottom.reachableAccounts) &&
    bottom.reachableAccounts > 0 && bottom.reachableAccounts <= count &&
    typeof bottom.qualificationFraction === 'number' && bottom.qualificationFraction > 0 &&
    bottom.qualificationFraction <= 1 && typeof bottom.annualContractValueUsd === 'number' &&
    bottom.annualContractValueUsd > 0 &&
    close(bottom.annualOpportunityUsd, bottom.reachableAccounts * bottom.qualificationFraction * bottom.annualContractValueUsd) &&
    text(bottom.assumptions, 50)]);
  checks.push(['no SEC-free public company figures or direct adoption claims',
    sizing?.noUnverifiedPublicCompanyFinancials === true &&
    text(sizing.overlapAndCategoryLimitations, 90) &&
    /\b(?:indirect|proxy|not a direct|cannot infer)\b/iu.test(sizing.overlapAndCategoryLimitations ?? '') &&
    /\b(?:agent|harness)\b/iu.test(sizing.overlapAndCategoryLimitations ?? '')]);
  return checks;
}

function narrativeChecks(root: string, task: MarketCase): boolean {
  try {
    const result = readFixtureText(root, 'result.md');
    const verification = readFixtureText(root, 'verification.md');
    return result.length >= 320 && verification.length >= 160 &&
      result.includes(new URL(task.startingState).hostname) &&
      /\b(?:source|citation|provenance)\b/iu.test(result) &&
      /\b(?:unknown|inferred|uncertainty|proxy|unverified)\b/iu.test(result) &&
      /\bnegative\b/iu.test(verification) && /\brecover/iu.test(verification) &&
      /\b(?:HTTP|status|retriev|request)\b/iu.test(verification) &&
      !/\b(?:TODO|placeholder)\b/iu.test(result + verification);
  } catch {
    return false;
  }
}

function parseReport(root: string): MarketReport | null {
  try {
    const data: unknown = JSON.parse(readFixtureText(root, 'market-research.json'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    // Untrusted candidate JSON must fail as an invalid report, never crash the scorer.
    const report = data as MarketReport;
    const record = (value: unknown): boolean => !!value && typeof value === 'object' && !Array.isArray(value);
    for (const field of ['sources', 'claims', 'comparisons', 'marketRows'] as const) {
      const rows = report[field];
      if (rows !== undefined && (!Array.isArray(rows) || !rows.every(record))) return null;
    }
    if (report.sources?.some((row) => (row.excerpts !== undefined &&
          (!Array.isArray(row.excerpts) || !row.excerpts.every((part) => typeof part === 'string'))))) return null;
    if (report.claims?.some((claim) => (claim.sourceIds !== undefined && !Array.isArray(claim.sourceIds)) ||
      (claim.quotes !== undefined && (!Array.isArray(claim.quotes) || !claim.quotes.every(record))))) return null;
    if (report.comparisons?.some((row) => row.pricingQuote !== undefined && typeof row.pricingQuote !== 'string'))
      return null;
    if (report.boundary !== undefined && !record(report.boundary)) return null;
    if (report.decision !== undefined && !record(report.decision)) return null;
    if (report.sizing !== undefined && !record(report.sizing)) return null;
    if (report.synthesis !== undefined && !record(report.synthesis)) return null;
    return report;
  } catch {
    return null;
  }
}

async function measureOutage(spec: SourceSpec, request: HttpRequest, now: () => Date): Promise<{
  rejected: boolean;
  recovered: boolean;
  retryCount: number;
  elapsedMs: number;
}> {
  const offline: HttpRequest = async () => new Response('Measured 503 outage', { status: 503 });
  let rejected = false;
  try { await retrieve(spec, offline, now); } catch { rejected = true; }
  let retryCount = 0;
  const interrupted: HttpRequest = (url, init) => {
    retryCount++;
    return retryCount === 1 ? offline(url, init) : request(url, init);
  };
  try {
    const recovered = await retrieve(spec, interrupted, now);
    return { rejected, recovered: retryCount === 2 && recovered.attempts === 2,
      retryCount, elapsedMs: recovered.elapsedMs };
  } catch {
    return { rejected, recovered: false, retryCount, elapsedMs: 0 };
  }
}

function failed(evidence: string[], integrityFailure = false): SkillEvalDeterministicScore {
  return { passed: false, quality: 0, verification: 0, integrityFailure, evidence };
}

export async function scoreMarketResearchRuntime(
  scenario: SkillEvalScenarioV3,
  root: string,
  options: MarketResearchRuntimeOptions = {},
): Promise<SkillEvalDeterministicScore> {
  const task = scenarioCase(scenario);
  if (!task) return failed([`Invalid or altered market-competitive-research V5 scenario ${scenario.id}`], true);
  if (!fixtureTextEquals(root, 'market-task.json', taskPacket(task)) ||
      !fixtureTextEquals(root, 'README.md', readme(task)))
    return failed(['Immutable market research case/instructions missing or changed'], true);

  const request: HttpRequest = options.request ?? ((url, init) => fetch(url, init));
  const now = options.now ?? (() => new Date());
  const recordedAt = now();
  let observed: Retrieved[];
  try {
    observed = await retrieveAll(task, request, now);
  } catch (error) {
    return failed([
      `Authoritative HTTPS verification failed: ${error instanceof Error ? error.message : String(error)}`,
      'UNVERIFIED: missing, incompatible or unavailable public evidence cannot be replaced with guesses, mock responses or historical prices.',
    ]);
  }

  const report = parseReport(root);
  const requiredClaims = task.kind === 'vendor-comparison'
    ? ['posthog', 'mixpanel', 'amplitude'].flatMap((vendor) =>
      ['pricing', 'product', 'terms'].map((kind) => `${vendor}-${kind}`))
    : ['census-context', 'census-541511', 'census-541512'];
  const checks: Array<[string, boolean]> = [
    ['V5 case and fresh UTC assessment', !!report && report.schemaVersion === 1 &&
      report.scenarioId === task.id && fresh(report.checkedAt, recordedAt)],
    ['market specialist hierarchy excludes near-neighbor research', !!report &&
      report.boundary?.selectedSkill === 'market-competitive-research' &&
      report.boundary.broaderSkill === 'research' && report.boundary.adjacentSkill === task.neighbor &&
      JSON.stringify(report.boundary.children) === JSON.stringify(CHILDREN) &&
      text(report.boundary.scope, 60) && Array.isArray(report.boundary.exclusions) &&
      report.boundary.exclusions.length > 0 && report.boundary.exclusions.every((item) => text(item, 16))],
    ['explicit buyer decision, comparison dimensions and evidence-before-inference sequence', !!report &&
      text(report.decision?.buyer) && text(report.decision?.question, 45) &&
      report.decision?.geography === 'US' &&
      (task.kind === 'market-sizing' || (report.decision?.users === 25 && report.decision.monthlyEvents === 2_000_000)) &&
      Array.isArray(report.decision?.dimensions) && DIMENSIONS.every((item) => report.decision!.dimensions!.includes(item)) &&
      Array.isArray(report.decision?.sequence) && report.decision.sequence.length >= 3 &&
      report.decision.sequence.every((item) => text(item, 20)) && text(report.decision?.assumptions, 40)],
    ['reproducible report with negative and recovery record', narrativeChecks(root, task)],
    ['facts, inferences, unverified adoption and actionable decision separated', !!report &&
      text(report.synthesis?.facts, 55) && text(report.synthesis?.inferences, 55) &&
      text(report.synthesis?.unknowns, 55) && text(report.synthesis?.adoptionBoundary, 55) &&
      text(report.synthesis?.decision, 50)],
  ];
  if (report) {
    try {
      checks.push(...sourceChecks(report, observed, recordedAt));
      checks.push(...claimChecks(report, observed, requiredClaims));
      checks.push(...(task.kind === 'vendor-comparison' ? comparisonChecks(report, observed) : sizingChecks(report, observed)));
    } catch (error) {
      checks.push([`malformed or contradictory candidate evidence: ${error instanceof Error ? error.message : String(error)}`, false]);
    }
  }
  const outage = await measureOutage(observed[0]!.spec, request, now);
  checks.push(['measured unavailable-source negative rejected', outage.rejected]);
  checks.push(['measured HTTP 503 followed by authoritative recovery', outage.recovered]);
  // Injected tests can prove fail-closed logic but cannot award public-source qualification.
  checks.push(['authoritative public HTTPS transport, not a controlled test double', options.request === undefined]);
  const passed = checks.every(([, success]) => !!success);
  return {
    passed,
    quality: checks.filter(([, success]) => success).length / checks.length,
    verification: passed ? 1 : 0,
    integrityFailure: false,
    evidence: [
      `V5 market evaluation UTC ${recordedAt.toISOString()}; transport=${options.request ? 'CONTROLLED TEST, NOT LIVE CERTIFICATION' : 'live public HTTPS'}.`,
      ...observed.map((source) => `${source.spec.id}: HTTP 200 ${source.spec.url} -> ${source.finalUrl}; fetched ${source.retrievedAt}; sha256=${source.sha256}; last-modified=${source.lastModified ?? 'unpublished'}; bytes verified; ${source.elapsedMs}ms; attempts=${source.attempts}.`),
      `Measured negative/recovery: outage rejected=${outage.rejected}; retry succeeded=${outage.recovered}; attempts=${outage.retryCount}; elapsed=${outage.elapsedMs}ms.`,
      ...checks.map(([name, success]) => `${name}: ${success ? 'pass' : 'fail'}`),
    ],
  };
}

export const MARKET_RESEARCH_SKILL_EVAL_MATERIALIZERS: readonly SkillEvalFixtureMaterializer[] = freezeDeep([
  {
    id: 'market-competitive-research/real-public-sources-v1',
    realRuntime: true,
    matches: (scenario) => scenarioCase(scenario) !== null,
    materialize: (destination, scenario) => {
      const task = scenarioCase(scenario);
      if (!task) throw new Error(`Invalid market research materialization ${scenario.id}`);
      writeFixtureFile(destination, 'market-task.json', taskPacket(task));
      writeFixtureFile(destination, 'README.md', readme(task));
    },
  },
]);

export const MARKET_RESEARCH_SKILL_EVAL_SCORERS: readonly SkillEvalDeterministicScorer[] = freezeDeep([
  {
    id: 'market-competitive-research/public-source-reconciliation-v1',
    scenarioIds: MARKET_RESEARCH_CASES.map((task) => task.id),
    score: ({ scenario, workingDirectory }) => scoreMarketResearchRuntime(scenario, workingDirectory),
  },
]);
