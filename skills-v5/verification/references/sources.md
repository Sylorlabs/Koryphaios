# Verification source map

`verification` is an individually researched V5 candidate. The sources below bound its evidence discipline; they do not by themselves qualify the skill. Promotion still requires paired same-model skill/no skill outcomes and independent blind evaluation.

## Authoritative and first-party sources

### NASA NPR 7150.2D: Software Engineering Requirements, Chapter 4

- URL: https://nodis3.gsfc.nasa.gov/displayDir.cfm?Internal_ID=N_PR_7150_002D_&page_name=Chapter4
- Type: `spec`
- Scope: NPR 7150.2D Chapter 4 as available 2026-09-04.
- Applied pattern: verification is tied to specified requirements and acceptance criteria; test/verification plans identify methods, environments, criteria, and records; results are evaluated and recorded; target-platform or high-fidelity execution is preferred where the claim depends on runtime behavior.
- Boundary: NASA's assurance process is intentionally rigorous and project-specific. Kory adopts the claim-to-requirement and observable-evidence principles proportionally; it does not import NASA lifecycle ceremony into ordinary repository tasks.
- Refresh: 180 days or on directive revision.

### NISTIR 8397: Guidelines on Minimum Standards for Developer Verification of Software

- URL: https://csrc.nist.gov/pubs/ir/8397/final
- Type: `spec`
- Scope: Final publication, October 2021; publication page rechecked 2026-09-04.
- Applied pattern: different techniques expose different defect classes, so a verification plan should choose evidence according to the claim and risk rather than equating one passing check with overall correctness.
- Boundary: the document enumerates minimum developer-verification techniques; it is not evidence that every technique is required for every Kory task.
- Refresh: 365 days or on NIST update or supersession.

### OpenAI: Introducing Codex

- URL: https://openai.com/index/introducing-codex/
- Type: `official-docs`
- Scope: OpenAI Codex workflow guidance as available 2026-09-04.
- Applied pattern: agent work should leave reviewable verification evidence such as test, lint, type-check, and terminal outputs; a generated success claim is not a substitute for validating the work.
- Boundary: product behavior and recommended workflows can change quickly. Use this source as first-party agent-operation guidance, not a software-verification standard.
- Refresh: 60 days or on material Codex workflow changes.

### Anthropic: Claude Code power-user tips

- URL: https://support.claude.com/en/articles/14554000-claude-code-power-user-tips
- Type: `official-docs`
- Scope: Claude Code verification guidance as available 2026-09-04.
- Applied pattern: verification should exercise the relevant real surface for the domain, such as a browser, simulator, or test suite, rather than using one universal proxy.
- Boundary: this is first-party operational advice for Claude Code, not a normative verification specification.
- Refresh: 60 days or on material guidance changes.

## High-signal community patterns

### obra/superpowers: `verification-before-completion`

- URL: https://github.com/obra/superpowers/blob/main/skills/verification-before-completion/SKILL.md
- Type: `community-pattern`
- Revision inspected: `b36e0829c6d0140e93cfef2ca599b1b07d4a7797`
- License: MIT.
- Applied pattern: require fresh evidence for the exact completion claim; do not infer one gate from another; where a new regression test is part of the evidence, establish that it meaningfully distinguishes the failure from the corrected state.
- Additional operational signal: Superpowers issue #1754 documented a concrete false-verification pattern where HTTP 200 did not prove that a provider switch actually took effect. Kory generalizes the lesson to “verify the observable discriminator, not merely transport success.”
- Boundary: community workflow evidence is useful for failure modes and operating discipline, never authority over project contracts or official specifications.
- Refresh: 90 days.

### SCOS-Lab: Eval-Verdict Vocabulary v0.2 public draft

- URL: https://github.com/scos-lab/semantic-tension-language/blob/main/spec/eval-verdict-vocabulary.md
- Type: `community-pattern`
- Revision inspected: `1ead7b0733252dff3729692de64792c1cdbd5d65`
- File license: CC BY 4.0.
- Applied pattern: distinguish a tool-reported success from independently observed state; validate an instrument before trusting consequential absence or zero readings; use independent views for completeness claims; preserve reproducible evidence; keep a bounded `confirmed` / `refuted` / `inconclusive` verdict vocabulary.
- Boundary: this is a recent public draft built from reported operational incidents, not an industry standard. Kory adopts only the general evidence-safety patterns that are independently compatible with the authoritative sources above.
- Refresh: 90 days or on draft revision.

## Interpretation and conflict rules

- Project requirements, acceptance criteria, supported commands, and actual runtime behavior are the ground truth for the task. External workflow sources do not override them.
- Prefer the NASA/NIST formal principles when a community convention conflicts with them; prefer current first-party product documentation for provider-specific behavior.
- A passing test proves only the behavior, environment, and surface it exercised. It is not automatically a release, deployment, accessibility, security, reliability, visual, or performance verdict.
- Fresh evidence means evidence collected after the latest relevant state change. Stored success text, another agent's report, or a prior run is provenance, not current proof.
- “Real target surface” is claim-dependent: the shipped CLI for a CLI claim, the actual state store for a persistence claim, the rendered runtime for a presentation claim, and so on.
- When the relevant surface is unavailable or the oracle cannot distinguish the claimed outcome, record the result as inconclusive rather than weakening the claim.
