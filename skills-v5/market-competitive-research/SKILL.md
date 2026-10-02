---
name: market-competitive-research
description: Assess markets, competitors, substitutes, pricing, adoption, and differentiation with dated, claim-level evidence. Use when researching a market, vendor landscape, or competitor comparison; not for a single fact-check, literature review, repository tracing, or primary user research.
---

# Market Competitive Research

Start from the buyer or strategic decision, not from a vendor list. Define segment, geography, use case, company size, deployment constraints, time horizon, and the comparison axes that matter before collecting evidence.

## Workflow

1. Define the market question and as-of date. Separate direct competitors, adjacent alternatives, substitutes, and the status quo; do not treat every product sharing a keyword as comparable.
2. Build a claim ledger. Use first-party product/docs/pricing pages for current product facts, regulator filings or audited reports for public-company financial facts, official statistics for market structure where applicable, and independent evidence for customer experience or adoption. Label vendor claims as vendor claims when they are not independently verified.
3. Normalize comparison units before ranking. For price, record plan, billing cadence, included usage, overage/metering rules, minimum commitments, currency/tax assumptions, and enterprise/custom-quote unknowns. Do not compare a seat price with consumption pricing as if they are the same economic unit.
4. Verify capability scope. Distinguish generally available, preview/beta, legacy, add-on, region/plan-specific, and announced-but-not-shipped features. A landing-page checkbox is weaker evidence than current product documentation.
5. Assess adoption and traction with multiple signals when possible. Separate measured customers/revenue/usage from proxies such as search interest, reviews, stars, job posts, social activity, or web traffic. Never convert one proxy into a market-share claim.
6. Analyze differentiation around buyer jobs, constraints, switching costs, distribution, ecosystem, and economics rather than feature count. Keep observed facts separate from inferred positioning or strategy.
7. Preserve uncertainty and contradictions. Resolve differences by source date, product edition, geography, metric definition, and evidence ownership; otherwise show the disagreement.
8. Return an evidence-backed landscape or comparison with source dates, normalized assumptions, unknowns, material risks, and decision-relevant implications. Avoid false precision in market size or adoption estimates.

## Boundaries

- Use `factual-research` when the center of gravity is one discrete current claim rather than a market comparison.
- Use `literature-research` for scholarly evidence quality and state-of-the-art synthesis.
- Use `research` for broad external research that is not specifically about markets, buyers, competitors, substitutes, or positioning.
- Use `market-strategy` for choosing strategic positioning, market entry, segmentation, or competitive moves after the evidence is established.
- Use `pricing-monetization` for designing the user's pricing architecture, packaging, willingness-to-pay research, or monetization model; this skill can supply competitor pricing evidence.
- Use `procurement-vendor-evaluation` when the task is a formal vendor-selection process with requirements, scoring, security/legal review, and procurement controls.
- Use `repository-research` for truths established from the local codebase or runtime, and `user-research` for primary interviews or fieldwork.

## Failure and recovery

- If a vendor hides enterprise pricing, record `custom/unknown` and model scenarios only with explicit assumptions.
- If sources disagree, preserve the as-of/version boundary instead of averaging them.
- If a market-size source uses a mismatched category, geography, or year, do not force it into TAM/SAM/SOM arithmetic.
- If only vendor-authored evidence supports a differentiation claim, label confidence accordingly.
- If the requested market does not have defensible public evidence, return bounded unknowns and the highest-value evidence gaps.

Use [the maintained source map](references/sources.md) when refreshing methodology or source provenance.
