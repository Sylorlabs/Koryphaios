import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFixtureFile } from '../../eval/skills/skill-eval-fixture-helpers';
import {
  buildSkillEvalSuiteV3,
  type SkillEvalScenarioV3,
} from '../../eval/skills/skill-eval-harness';
import {
  MARKET_RESEARCH_CASES,
  MARKET_RESEARCH_SKILL_EVAL_MATERIALIZERS,
  MARKET_RESEARCH_SKILL_EVAL_SCORERS,
  scoreMarketResearchRuntime,
} from '../../eval/skills/skill-eval-market-research-runtime';
import { loadV5SkillPackages } from '../skill-packages';

// All response bodies in this file are CONTROLLED TEST FIXTURES. Injected
// responses must never be treated as actual vendor prices or Census evidence.
const TIME = '2026-10-09T23:35:00.000Z';
const PUBLISHED = 'Published: 2026-09-30';
const PRICE_QUOTE =
  'Standard $5 per 1000 events monthly with 100000 included events for data reporting customers.';
const DIMENSIONS = [
  'users',
  'jobs',
  'substitutes',
  'capability',
  'constraints',
  'pricing',
  'distribution',
  'adoption',
  'switching-costs',
  'differentiation',
];
const CHILDREN = [
  'market-strategy',
  'marketing-strategy',
  'pricing-monetization',
  'procurement-vendor-evaluation',
];
const names: Record<string, string> = {
  posthog: 'PostHog',
  mixpanel: 'Mixpanel',
  amplitude: 'Amplitude',
};
const roots: string[] = [];
const hash = (body: string) => createHash('sha256').update(body).digest('hex');
const excerpt = (body: string) =>
  body
    .replace(/<[^>]*>/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 155);

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface ControlledSource {
  id: string;
  url: string;
  kind: string;
  body: string;
  contentType: string;
}

const packageForSkill = loadV5SkillPackages().packages.find(
  (item) => item.sidecar.name === 'market-competitive-research',
)!;
const scenarios = MARKET_RESEARCH_CASES.map((task) =>
  buildSkillEvalSuiteV3(packageForSkill).scenarios.find((item) => item.id === task.id)!,
);

function setup(scenario: SkillEvalScenarioV3): string {
  const root = mkdtempSync(join(tmpdir(), 'kory-market-research-v5-'));
  roots.push(root);
  const materializer = MARKET_RESEARCH_SKILL_EVAL_MATERIALIZERS.find((item) =>
    item.matches(scenario),
  );
  expect(materializer).toBeDefined();
  materializer!.materialize(root, scenario);
  return root;
}

function controlledSources(scenario: SkillEvalScenarioV3): ControlledSource[] {
  const task = MARKET_RESEARCH_CASES.find((item) => item.id === scenario.id)!;
  return task.sources.map((spec) => {
    if (spec.kind === 'census-data') {
      const label =
        spec.naics === '541511'
          ? 'Custom Computer Programming Services'
          : 'Computer Systems Design Services';
      const count = spec.naics === '541511' ? '1120' : '530';
      const receipts = spec.naics === '541511' ? '403200' : '207000';
      return {
        id: spec.id,
        url: spec.url,
        kind: spec.kind,
        contentType: 'application/json',
        body: JSON.stringify([
          ['NAME', 'NAICS2022_LABEL', 'ESTAB', 'RCPTOT', 'NAICS2022', 'us'],
          ['United States', label, count, receipts, spec.naics, '1'],
        ]),
      };
    }
    if (spec.kind === 'census-context') {
      return {
        id: spec.id,
        url: spec.url,
        kind: spec.kind,
        contentType: 'text/html',
        body:
          `<html><body><h1>Economic Census data</h1><p>The 2022 Economic Census publishes ` +
          `US industry establishment counts and receipts classified by NAICS codes, ` +
          `which do not directly count buyers of agent technology.</p><p>${PUBLISHED}</p></body></html>`,
      };
    }
    const name = names[spec.vendor!]!;
    let body: string;
    if (spec.kind === 'pricing') {
      body =
        `<html><body><h1>${name} pricing</h1><p>${PRICE_QUOTE}</p>` +
        `<p>The ${name} Standard plan may have eligibility and contract restrictions ` +
        `that require confirmation before purchasing.</p><p>${PUBLISHED}</p></body></html>`;
    } else if (spec.kind === 'product') {
      body =
        `<html><body><h1>${name} analytics</h1><p>${name} analytics documentation ` +
        `describes event funnels, retention analysis, cohorts, instrumentation and ` +
        `limitations for the product team's evaluation.</p><p>${PUBLISHED}</p></body></html>`;
    } else {
      body =
        `<html><body><h1>${name} terms</h1><p>${name} terms identify ` +
        `commercial contract requirements and customer responsibilities for ` +
        `privacy, data handling and service access.</p><p>${PUBLISHED}</p></body></html>`;
    }
    return { id: spec.id, url: spec.url, kind: spec.kind, body, contentType: 'text/html' };
  });
}

function respond(
  source: ControlledSource,
  overrides: {
    status?: number;
    body?: string;
    url?: string;
    contentType?: string;
  } = {},
): Response {
  const response = new Response(overrides.body ?? source.body, {
    status: overrides.status ?? 200,
    headers: { 'content-type': overrides.contentType ?? source.contentType },
  });
  // A real fetch sets Response.url. It must be explicit in a test double so
  // origin checks cannot pass for a URL-less response.
  Object.defineProperty(response, 'url', {
    value: overrides.url ?? source.url,
    configurable: true,
  });
  return response;
}

function transport(
  sources: ControlledSource[],
  change?: (source: ControlledSource, attempt: number) => Parameters<typeof respond>[1],
) {
  const visits: string[] = [];
  const request = async (url: string): Promise<Response> => {
    visits.push(url);
    const source = sources.find((row) => row.url === url);
    if (!source)
      return respond(
        { id: 'missing', url, kind: '', body: 'Not found', contentType: 'text/plain' },
        { status: 404 },
      );
    return respond(source, change?.(source, visits.filter((item) => item === url).length));
  };
  return { request, visits };
}

function candidate(scenario: SkillEvalScenarioV3, sources: ControlledSource[]) {
  const task = MARKET_RESEARCH_CASES.find((item) => item.id === scenario.id)!;
  const base = {
    schemaVersion: 1,
    scenarioId: scenario.id,
    checkedAt: TIME,
    boundary: {
      selectedSkill: 'market-competitive-research',
      broaderSkill: 'research',
      children: CHILDREN,
      adjacentSkill: task.neighbor,
      scope: `The buyer decision is limited to ${task.scope}; each unverified adjacent claim is expressly excluded.`,
      exclusions: [
        'Generic factual or literature research cannot substitute for the market decision and evaluation scope.',
      ],
    },
    decision: {
      buyer:
        'US enterprise product team responsible for analytics tooling and software procurement',
      question: task.question,
      users: 25,
      monthlyEvents: 2_000_000,
      geography: 'US',
      dimensions: DIMENSIONS,
      sequence: [
        'Define decision makers and decision criteria first',
        'Retrieve identifiable sources with dates and quoted provenance',
        'Normalize measurement, uncertainty, contract and adoption boundaries',
      ],
      assumptions:
        'The published source evidence and the deliberately assumed buyer context must remain clearly separate.',
    },
    sources: sources.map((source) => ({
      id: source.id,
      url: source.url,
      finalUrl: source.url,
      status: 200,
      retrievedAt: TIME,
      sha256: hash(source.body),
      lastModified: null,
      publishedOn: source.kind === 'census-data' ? null : '2026-09-30',
      effectiveOn: null,
      dateExcerpt: source.kind === 'census-data' ? null : PUBLISHED,
      excerpts: [excerpt(source.body)],
    })),
    claims: sources.map((source) => ({
      id: source.id,
      dimension:
        source.kind === 'pricing'
          ? 'pricing'
          : source.kind === 'product'
            ? 'capability'
            : source.kind === 'terms'
              ? 'constraints'
              : 'adoption',
      status:
        source.kind === 'census-data'
          ? ('proxy' as const)
          : source.kind === 'census-context'
            ? ('source-fact' as const)
            : ('vendor-assertion' as const),
      statement: `The cited ${source.id} controlled test evidence concerns the source identity and its stated factual domain.`,
      sourceIds: [source.id],
      quotes: [{ sourceId: source.id, text: excerpt(source.body) }],
      limitations:
        'This controlled source body cannot establish unrelated customer adoption, market share or other unsupported market figures.',
    })),
    synthesis: {
      facts:
        'Published documents supply only source observations within the named buyer context and verification date; product assertions are vendor claims.',
      inferences:
        'Contract suitability and addressable buyer share are analyst inferences constrained by explicit scope and uncertain source applicability.',
      unknowns:
        'Actual negotiated discounts, installation overhead, user adoption, vendor market shares and future plan changes remain unverified unknowns.',
      adoptionBoundary:
        'Industry proxies and vendor marketing copy cannot independently prove enterprise adoption or comparative market share.',
      decision:
        'Collect authoritative documents and customer requirements, verify conflicts and assumptions, then issue a qualified procurement recommendation.',
    },
  };
  if (task.kind === 'vendor-comparison')
    return {
      ...base,
      comparisons: (['posthog', 'mixpanel', 'amplitude'] as const).map((vendor) => ({
        vendor,
        plan: 'Standard',
        pricingQuote: PRICE_QUOTE,
        billingUnit: 'event' as const,
        priceUsd: 5,
        unitSize: 1000,
        includedEvents: 100000,
        estimatedMonthlyUsd: 9500,
        estimateStatus: 'calculated' as const,
        assumptions:
          'The monthly estimate assumes a single explicitly quoted event tier, and excludes enterprise discounts or platform fees.',
        distribution:
          'Product teams may onboard through documentation and self service, subject to procurement approval.',
        switchingCosts:
          'Event taxonomy, SDK instrumentation and downstream queries may need migration and quality validation.',
        differentiation:
          'Feature breadth, integrations, analytics workflows and contractual risk require separate confirmation.',
        adoptionStatus: 'vendor-assertion' as const,
        adoptionLimitations:
          'Vendor marketing does not establish user counts, realized market share or customer adoption independently.',
        reconciledSourceIds: [`${vendor}-pricing`, `${vendor}-product`, `${vendor}-terms`],
        agreement:
          'The three company pages are first-party sources for quoted pricing, analytics capabilities and governing legal terms.',
        conflicts:
          'Pricing and contractual rights can differ by account, region, plan revision or volume tier.',
        uncertainty:
          'Negotiated price, available credits, data retention settings and actual workload eligibility remain uncertain.',
      })),
    };
  const markets = [
    {
      naics: '541511',
      label: 'Custom Computer Programming Services',
      establishments: 1120,
      receiptsThousandsUsd: 403200,
    },
    {
      naics: '541512',
      label: 'Computer Systems Design Services',
      establishments: 530,
      receiptsThousandsUsd: 207000,
    },
  ];
  return {
    ...base,
    marketRows: markets.map((row) => ({
      ...row,
      sourceYear: 2022,
      geography: 'US',
      sourceIds: ['census-context', `census-${row.naics}`],
      applicability: 'indirect-proxy' as const,
      limitations:
        'The Economic Census describes adjacent service industry establishments, not measured agent harness deployment or buying intent.',
    })),
    sizing: {
      sourceEstablishments: 1650,
      topDown: {
        addressableFraction: 0.1,
        annualSpendPerAccountUsd: 10000,
        annualOpportunityUsd: 1650000,
        assumptions:
          'Assume ten percent of adjacent establishments could potentially qualify, which is not an observed adoption rate.',
      },
      bottomUp: {
        reachableAccounts: 200,
        qualificationFraction: 0.2,
        annualContractValueUsd: 6000,
        annualOpportunityUsd: 240000,
        assumptions:
          'Assume two hundred prospect accounts, one in five qualifying, and six thousand dollars in annual contract value.',
      },
      overlapAndCategoryLimitations:
        'Both adjacent industries are only an indirect proxy for agent harness customers. Their actual technology adoption cannot be inferred from establishments, and overlap with true buyers is unknown.',
      noUnverifiedPublicCompanyFinancials: true,
    },
  };
}

function writeCandidate(
  root: string,
  scenario: SkillEvalScenarioV3,
  sources: ControlledSource[],
  edit?: (report: any) => void,
): void {
  const report = candidate(scenario, sources);
  edit?.(report);
  writeFixtureFile(root, 'market-research.json', `${JSON.stringify(report, null, 2)}\n`);
  writeFixtureFile(
    root,
    'result.md',
    `# Controlled market research evidence\n\nSources include ${new URL(MARKET_RESEARCH_CASES.find((item) => item.id === scenario.id)!.startingState).hostname} and each named authoritative domain. ` +
      'The claim ledger connects exact quotations to source identities and data provenance. ' +
      'This is a controlled test of validation rules, not actual public source evidence. ' +
      'The buyer decision, capability, pricing, switching costs, adoption, substitute options and distribution are considered separately. ' +
      'Any unknowns and inferred market share remain unverified; indirect proxy scope is explicit.\n',
  );
  writeFixtureFile(
    root,
    'verification.md',
    '# Controlled verification\n\nHTTP 200 responses reproduce original quoted bytes and hashes; negative tests inject HTTP 503 service outages. ' +
      'The scorer independently checks failure behavior and successful recovery after a retry against the configured test transport. ' +
      'The controlled responses and recovery do not certify live first-party evidence, which must be independently fetched.\n',
  );
}

const options = (request: ReturnType<typeof transport>['request']) => ({
  request,
  now: () => new Date(TIME),
});
const failedChecks = (evidence: string[]) => evidence.filter((line) => line.endsWith(': fail'));

describe('market competitive research V5 public-source contract', () => {
  test('source/task definitions and exported scorer contracts are deeply immutable', () => {
    expect(Object.isFrozen(MARKET_RESEARCH_CASES)).toBe(true);
    expect(Object.isFrozen(MARKET_RESEARCH_SKILL_EVAL_SCORERS)).toBe(true);
    expect(Object.isFrozen(MARKET_RESEARCH_SKILL_EVAL_MATERIALIZERS)).toBe(true);
    for (const task of MARKET_RESEARCH_CASES) {
      expect(Object.isFrozen(task)).toBe(true);
      expect(Object.isFrozen(task.sources)).toBe(true);
      for (const source of task.sources) expect(Object.isFrozen(source)).toBe(true);
    }
    expect(scenarios.map((item) => item?.id)).toEqual(MARKET_RESEARCH_CASES.map((item) => item.id));
    expect(MARKET_RESEARCH_SKILL_EVAL_SCORERS[0]!.scenarioIds).toEqual(
      scenarios.map((item) => item.id),
    );
  });

  for (const scenario of scenarios) {
    test(`${scenario.id}: refuses empty and tampered evidence, but validates all controlled proof except live certification`, async () => {
      const root = setup(scenario);
      const sources = controlledSources(scenario);
      const stub = transport(sources);
      const empty = await scoreMarketResearchRuntime(scenario, root, options(stub.request));
      expect(empty.passed).toBe(false);
      expect(empty.quality).toBeLessThan(0.7);

      writeCandidate(root, scenario, sources);
      const checked = await scoreMarketResearchRuntime(scenario, root, options(stub.request));
      expect(checked.passed).toBe(false);
      expect(checked.verification).toBe(0);
      expect(failedChecks(checked.evidence), checked.evidence.join('\n')).toEqual([
        'authoritative public HTTPS transport, not a controlled test double: fail',
      ]);
      expect(checked.evidence.join('\n')).toContain(
        'outage rejected=true; retry succeeded=true; attempts=2',
      );
      expect(stub.visits.length).toBeGreaterThanOrEqual(sources.length * 2);

      writeCandidate(root, scenario, sources, (report) => {
        report.sources[0].sha256 = '0'.repeat(64);
      });
      const forgedHash = await scoreMarketResearchRuntime(scenario, root, options(stub.request));
      expect(forgedHash.evidence.join('\n')).toContain('independent raw-byte provenance: fail');
      expect(forgedHash.passed).toBe(false);

      writeCandidate(root, scenario, sources, (report) => {
        report.sources[0].publishedOn = '2026-10-07';
      });
      const forgedDate = await scoreMarketResearchRuntime(scenario, root, options(stub.request));
      expect(forgedDate.evidence.join('\n')).toContain('source dates not fabricated: fail');

      writeCandidate(root, scenario, sources, (report) => {
        report.sources[0].effectiveOn = '2026-09-30';
      });
      const mislabeledDate = await scoreMarketResearchRuntime(
        scenario,
        root,
        options(stub.request),
      );
      expect(mislabeledDate.evidence.join('\n')).toContain('source dates not fabricated: fail');

      writeCandidate(root, scenario, sources, (report) => {
        report.claims[0].quotes[0].text = 'Manufactured quotation with zero traceability.';
      });
      const bogusQuote = await scoreMarketResearchRuntime(scenario, root, options(stub.request));
      expect(bogusQuote.evidence.join('\n')).toContain(
        'trace, classification and uncertainty: fail',
      );

      writeFixtureFile(root, 'README.md', 'Modified immutable task instructions.\n');
      const mutated = await scoreMarketResearchRuntime(scenario, root, options(stub.request));
      expect(mutated.integrityFailure).toBe(true);
      expect(mutated.passed).toBe(false);
    }, 20_000);

    test(`${scenario.id}: scenario drift, invalid media, foreign origin and outages fail closed`, async () => {
      const root = setup(scenario);
      const sources = controlledSources(scenario);
      writeCandidate(root, scenario, sources);
      const alteredScenario = structuredClone(scenario);
      alteredScenario.prompt += ' An unauthorized change.';
      expect(MARKET_RESEARCH_SKILL_EVAL_MATERIALIZERS[0]!.matches(alteredScenario)).toBe(false);
      const unauthorized = await scoreMarketResearchRuntime(
        alteredScenario,
        root,
        options(transport(sources).request),
      );
      expect(unauthorized.integrityFailure).toBe(true);

      for (const mismatch of [
        { status: 503 },
        { contentType: 'text/plain' },
        { url: 'https://untrusted.example.org/research' },
        {
          body: 'A sufficiently long unrelated HTML response that contains none of the required publisher identity or topic signals. '.repeat(
            2,
          ),
        },
      ]) {
        const bad = transport(sources, (source) => (source.id === sources[0]!.id ? mismatch : {}));
        const scored = await scoreMarketResearchRuntime(scenario, root, options(bad.request));
        expect(scored.passed).toBe(false);
        expect(scored.verification).toBe(0);
        expect(scored.evidence.join('\n')).toContain('Authoritative HTTPS verification failed:');
        expect(scored.evidence.join('\n')).toContain('UNVERIFIED:');
      }

      const transient = transport(sources, (source, attempt) =>
        source.id === sources[0]!.id && attempt === 1 ? { status: 503 } : {},
      );
      const recovered = await scoreMarketResearchRuntime(
        scenario,
        root,
        options(transient.request),
      );
      expect(failedChecks(recovered.evidence), recovered.evidence.join('\n')).toEqual([
        'authoritative public HTTPS transport, not a controlled test double: fail',
      ]);
      expect(recovered.evidence.join('\n')).toContain('attempts=2');
    }, 20_000);

    test(`${scenario.id}: malformed candidate structures fail without crashing`, async () => {
      const root = setup(scenario);
      const sources = controlledSources(scenario);
      writeCandidate(root, scenario, sources, (report) => {
        report.claims = [null];
      });
      const nullClaim = await scoreMarketResearchRuntime(
        scenario,
        root,
        options(transport(sources).request),
      );
      expect(nullClaim.passed).toBe(false);
      writeCandidate(root, scenario, sources, (report) => {
        report.sources[0].dateExcerpt = 42;
      });
      const malformedDate = await scoreMarketResearchRuntime(
        scenario,
        root,
        options(transport(sources).request),
      );
      expect(malformedDate.passed).toBe(false);
      expect(malformedDate.evidence.join('\n')).toContain('source dates not fabricated: fail');
    });
  }

  test('vendor price fabrication and unproved normalization cannot pass', async () => {
    const scenario = scenarios[0]!;
    const root = setup(scenario);
    const sources = controlledSources(scenario);
    writeCandidate(root, scenario, sources, (report) => {
      report.comparisons[0].priceUsd = 9;
      report.comparisons[0].estimatedMonthlyUsd = 17100;
    });
    const fabricated = await scoreMarketResearchRuntime(
      scenario,
      root,
      options(transport(sources).request),
    );
    expect(fabricated.evidence.join('\n')).toContain(
      'first-party price quotation and defensible normalization: fail',
    );

    writeCandidate(root, scenario, sources, (report) => {
      report.comparisons[0].unitSize = 10000;
      report.comparisons[0].estimatedMonthlyUsd = 950;
    });
    const falseUnit = await scoreMarketResearchRuntime(
      scenario,
      root,
      options(transport(sources).request),
    );
    expect(falseUnit.evidence.join('\n')).toContain(
      'first-party price quotation and defensible normalization: fail',
    );

    writeCandidate(root, scenario, sources, (report) => {
      report.comparisons[0].estimateStatus = 'unavailable';
      report.comparisons[0].estimatedMonthlyUsd = null;
      report.comparisons[0].priceUsd = 300;
    });
    const fakeUnknown = await scoreMarketResearchRuntime(
      scenario,
      root,
      options(transport(sources).request),
    );
    expect(fakeUnknown.evidence.join('\n')).toContain(
      'first-party price quotation and defensible normalization: fail',
    );
  });

  test('Census row identity, geography, vintage, and arithmetic are independently checked', async () => {
    const scenario = scenarios[1]!;
    const root = setup(scenario);
    const sources = controlledSources(scenario);
    writeCandidate(root, scenario, sources, (report) => {
      report.marketRows[0].sourceYear = 2021;
      report.sizing.topDown.annualOpportunityUsd += 7000;
    });
    const wrongVintage = await scoreMarketResearchRuntime(
      scenario,
      root,
      options(transport(sources).request),
    );
    expect(wrongVintage.evidence.join('\n')).toContain(
      'official 2022 Census row, date, units and NAICS scope: fail',
    );
    expect(wrongVintage.evidence.join('\n')).toContain(
      'top-down model uses published establishments and explicit assumed spend: fail',
    );

    const corrupted = sources.map((source) =>
      source.id === 'census-541512'
        ? {
            ...source,
            body: source.body.replace('"1"', '"6"'),
          }
        : source,
    );
    const wrongGeography = await scoreMarketResearchRuntime(
      scenario,
      root,
      options(transport(corrupted).request),
    );
    expect(wrongGeography.passed).toBe(false);
    expect(wrongGeography.evidence.join('\n')).toContain('NAICS/geography/count mismatch');
  });
});
