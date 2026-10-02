# Skill Maker standard

Use this reference when creating, materially revising, reviewing, or qualifying an agent skill. The goal is a small package that changes agent behavior for a durable reason and can prove that change under realistic conditions.

## Existence test

A skill should exist only when the responsibility is reusable and the guidance materially changes decisions. Require at least one of these reasons:

- Durable domain knowledge that a capable general model may not know or may apply inconsistently.
- A decision boundary that prevents recurring scope, authority, lifecycle, state, or evidence errors.
- A repeated workflow where concise guidance reliably improves task success.
- A fragile mechanical step where a deterministic helper materially reduces error.

Reject the proposal when it merely restates generic competence, captures one incident, duplicates an existing package, encodes a temporary workaround as universal policy, or exists only to improve a routing metric.

Before adding a package, compare the proposed responsibility against neighboring skills. Prefer strengthening an existing package when the new guidance shares the same professional responsibility and trigger boundary. Split only when the responsibilities have distinct invocation conditions, distinct decision rules, or materially different evidence requirements.

## Domain and invocation contract

Define the skill before writing instructions:

- Responsibility: the professional outcome the skill owns.
- Domain: the concepts, artifacts, systems, or media it understands.
- Activation: realistic requests that need this guidance.
- Exclusions: close requests that should route elsewhere.
- Neighbors: skills that could reasonably compete for the same prompt.
- Inputs: information the agent needs to apply the guidance.
- Outputs: observable artifacts, decisions, or state the skill should improve.

When the host stores routing metadata separately from prose, treat every routing surface as one contract. A scope revision is incomplete until the description, activation, exclusions, positive and negative examples, neighbor declarations, and hierarchy fields agree. Stale broad metadata can defeat an otherwise correct prose boundary.

- When an evaluation task, source package, sidecar, fixture, or catalog names adjacent skill identifiers, preserve those identifiers exactly in the routing boundary and metadata when they define ownership. Generic labels such as specialist workflow are insufficient when the named neighbor distinction is itself part of the routing contract.
- Failure modes: recurring mistakes the guidance is intended to prevent.
- Evidence: observations that can establish whether the skill helped.

The description must discriminate among nearby responsibilities with ordinary user language. Do not turn the description into a keyword catalog. Automatic invocation should follow user intent and task evidence. Explicit manager assignment may force a skill for a worker or critic, but the runtime must record that assignment and the exact delivered revision.

When the host supports explicit user invocation, route it through the same resolver and delivery path used for ordinary skill selection. Manual invocation must work for skills that require explicit use, must preserve the exact requested skill identity, and must remain independently testable from automatic routing.

## Instruction design

Assume the agent already knows common engineering and reasoning practices. Every paragraph must earn its context cost by changing a decision, preserving a nonobvious invariant, preventing a demonstrated failure, or providing necessary domain knowledge.

Prefer principles with observable consequences over giant recipes. Match specificity to risk. Open work should state outcomes and decision criteria. Fragile work may define a tighter sequence when deviation creates a concrete failure.

Use progressive disclosure. Keep the common responsibility, boundaries, and essential workflow in `SKILL.md`. Move conditional modes, long examples, schemas, source detail, and deep troubleshooting into references that the entry point links at the moment they become relevant.

Use deterministic scripts for repeated mechanics when they improve reliability. Keep reasoning and authority decisions in the agent contract. A script must not silently expand filesystem, network, tool, or external action authority.

Do not hide weak guidance behind length. Remove generic advice, duplicated policy, motivational prose, speculative edge cases, exhaustive catalogs, and examples that do not clarify a real boundary.

Treat the caller's explicit task contract as a hard boundary around skill guidance. Required artifact names, public interfaces, schemas, field names, commands, machine formats, and acceptance evidence remain exact unless the task explicitly asks to change them. A skill may improve how the work is done, but it must not rename, reshape, or substitute a required contract merely because a domain convention looks cleaner.

For machine readable output, syntactic completeness is part of correctness. Finish the smallest required valid artifact before adding optional explanation or secondary evidence. When context or output budget is tight, preserve required fields and parseability first, then omit optional detail. A semantically strong artifact that is truncated or cannot be parsed has failed the task contract.

## Agent behavior quality

A skill must make the requested work more reliable without turning the agent into an intrusive project owner. Preserve the task boundary, existing product decisions, and authorization already present in the conversation or task contract.

- Stay inside the requested outcome. Do not expand a focused task into an unrelated refactor, architecture change, cleanup pass, or feature set merely because broader work would look cleaner.
- Preserve repository and product decisions unless evidence shows that one blocks the requested outcome. Prefer the smallest coherent change that fits the existing system.
- Treat existing authorization as durable for the authorized work. Do not ask the user to repeat approval for a step they already approved unless a new side effect, authority boundary, or irreversible action is introduced.
- When the requested mechanism fails, diagnose the failure and make the limitation visible. Do not silently replace it with a fallback, reduced behavior, different implementation, or fake success state.
- Continue authorized work through a concrete result and relevant evidence. Do not stop after a plan, scaffold, placeholder, or partial fix when the requested outcome can still be completed.
- Load only skills, references, and context that can change a decision for the current task. Extra context must earn its cost through a clear responsibility or evidence need.
- Make any default that materially changes behavior visible in the contract or result. Do not hide a consequential choice behind an unspecified reasonable default.
- Require observable evidence for success claims. A skill must not certify its own result from intention, generated prose, a clean looking diff, or a fallback path that was never shown to satisfy the requested behavior.
- Correct the demonstrated cause or contract defect. Broad edits that merely make a symptom disappear are not evidence of a valid fix.

## Prose standard

Authored skill prose must not use dash punctuation or avoidable prose compounds. Rewrite the sentence so the meaning is natural without the mark. Do not mechanically delete characters.

Preserve exact technical material when changing it would alter meaning or syntax. This includes code, command flags, identifiers, package names, file paths, links, versions, dates, mathematical signs, literal source quotations, and machine formats. Exact source literals such as an ISO 8601 date remain exact even when their punctuation would be avoided in prose. When a source, sidecar, evaluator, fixture, or neighboring skill supplies an exact machine identifier, preserve that identifier character for character everywhere it is referenced. Do not normalize a technical identifier to satisfy the prose rule. Use the maintained prose checker, then inspect every reported location semantically.

The no dash rule applies to authored prose in entry points and maintained references. Technical syntax remains exact.

## Routing tests

Routing quality must be tested independently from task quality. Build held out cases that resemble real requests and real confusion:

- Clear positive requests.
- Close negative requests owned by a neighbor.
- Ambiguous requests where two skills could plausibly apply.
- Compound requests where multiple skills may be correct.
- Negated requests that mention the skill while explicitly excluding its work.
- Historical text or quoted examples that must not activate live work.
- Requests about fixed artifacts where surrounding work should select the correct broader responsibility.
- Documentation only requests that should not imply implementation work.

Pairwise boundary tests are required for skills with plausible neighbors. Preserve every material routing failure as a regression case.

Run the host's real resolver after changing the routing contract. Test ordinary paraphrases rather than only exact trigger wording. Explicit activation metadata should express discriminating responsibility concepts broadly enough to cover natural wording without collapsing into generic domain words. If the real resolver still misses a positive or selects a neighbor case, the routing repair is incomplete even when the authored examples look correct.

Treat activation phrases as bounded retrieval keys, not miniature policy sentences. Cover the common noun and verb forms of the responsibility and the main decision objects that real users mention. Prefer several precise phrases over one long literal string. Do not rely on the prose description or an evidence label to compensate for missing activation coverage when the host resolver uses explicit metadata. If a central decision object must route an ordinary request, give it a host recognized activation key and verify that key through the real resolver. In phrase matched hosts, choose the shortest discriminating key that still identifies the responsibility. Two to four content words is a useful default for a routing key. Avoid optional glue words such as `and`, `or`, `the`, and `a` when common user phrasing drops them or replaces them with punctuation. Use separate precise keys when materially different surface forms remain necessary. Longer phrases are acceptable when shorter forms collide with neighbors, but every extra word should be justified by observed precision rather than by stylistic preference. Include a stable responsibility concept when several specific states share the same owned decision. For example, `release readiness` can complement `readiness gates` when users naturally request a readiness plan and neighbor tests show that the broader phrase stays precise.

## Real task evaluation

Static validation proves packaging, not usefulness. Test realistic complete tasks with observable outcomes.

For each important scenario, compare candidate and baseline arms with the same model, tools, starting snapshot, task, budget, environment, and stopping policy. The only intentional difference should be the candidate skill context. Record unavoidable harness differences explicitly.

For stochastic models, begin with repeated trials in both arms. Five trials per arm is a useful starting point when cost permits. Increase trials when outcomes are noisy or the decision is consequential. A single win or loss is evidence about one run, not a general skill verdict.

Track task success and material operating cost. Useful measures include tokens, elapsed time, tool calls, retries, files changed, scope violations, and verifier failures. Do not claim superiority from a proxy that does not represent the responsibility the skill owns.

For important skills, repeat a smaller evaluation on another capable model or provider class. A skill that only works with one model may still be useful, but its qualification must state that boundary.

## Evaluator stack

Use three layers when the task warrants them:

1. Deterministic or runtime checks for objective state and exact invariants.
2. Blind semantic review for qualities such as clarity, judgment, communication, architecture, or visual fit that cannot be reduced to state checks.
3. Direct review of disagreements to diagnose the skill, model, fixture, or verifier.

Blind review must hide the candidate or baseline identity and the intended winner. Persist evaluator identity, evidence considered, and any information that could break blindness.

The critic must review the actual artifact and fresh evidence. When a worker received skills, the critic must receive a host generated delivery record with skill name, revision hash, and delivered guidance. Receipt proves delivery only. The critic must separately judge adherence and whether the guidance improved, harmed, or failed to affect the result.

Critics use their own review guidance. The default `verification` skill owns claim to evidence review. Managers may assign additional critic skills when the task needs specialist judgment. Worker skills do not become critic instructions merely because the critic is reviewing them.

## Verifier calibration

Treat symbolic and deterministic verifiers as instruments, not truth sources. Before relying on a new or changed verifier, calibrate it with:

- More than one valid positive control when multiple correct implementations are possible.
- Realistic negative controls that violate the intended invariant.
- Mutation cases that break one requirement at a time.
- Alternative valid solutions that differ from the fixture author's preferred implementation.
- A retained corpus of prior false rejections and false acceptances.

A verifier that rejects a semantically valid alternative is suspect. A verifier that accepts known broken states is also suspect. Do not grant qualification credit from a suspect verifier until the disputed evidence is reviewed and the instrument is repaired or bounded.

Prefer behavioral calibration over word matching when behavior can be executed. For candidate authored tests, restore a known broken implementation or controlled mutation and require the candidate tests to fail, then restore the valid implementation and require them to pass. Text presence may support review, but it is not proof that a regression test detects the defect it names.

## Causal diagnosis

When the candidate performs worse than the baseline, inspect the actual paired outputs before editing the skill. Determine whether the loss came from the guidance, routing, context pressure, stochastic variation, fixture design, environment, or evaluator.

Use ablation when the cause is unclear. Useful arms include:

- Baseline with no candidate skill.
- Full candidate skill.
- Entry point only.
- References only when meaningful in the harness.
- Workflow guidance only.
- Candidate with the suspected section removed.

Change the smallest causal element supported by evidence. Preserve sections that remain useful. Add the observed regression to the permanent suite.

## Evidence classification

Use behavioral labels that match the strength of current evidence:

- Proven helpful: repeated current paired evidence shows meaningful improvement and no material regression.
- Probably helpful: evidence favors the candidate but sample size or transfer evidence is still limited.
- Neutral: candidate and baseline are materially equivalent on measured outcomes.
- Ineffective: the candidate repeatedly fails to improve the responsibility it claims to own.
- Confirmed harmful: repeated current paired evidence and semantic review show that the guidance causes worse outcomes.
- Verifier suspect: the instrument appears to reject valid work or accept invalid work.
- Insufficient evidence: required paired or semantic evidence is missing.
- Environment blocked: the required runtime or external condition is unavailable.

Do not collapse historical regressions into a current harmful verdict. Do not rewrite a skill solely because an old failure remains in the regression ledger.

## Promotion gate

A revision is ready only when all required evidence is bound to the current revision fingerprint and the current evaluator contract. Require:

- Valid package structure and hierarchy.
- Current source provenance and freshness.
- Clean prose check with semantic review of protected technical material.
- Held out routing coverage across positive, neighboring, ambiguous, compound, negated, and historical cases as applicable.
- At least two realistic complete task scenarios.
- Current paired candidate and baseline evidence for executable scenarios.
- Repeated trials when stochastic variance could change the decision.
- Calibrated deterministic verifiers for objective claims.
- Blind semantic review where objective checks cannot establish quality.
- No unresolved integrity regression.
- No unsupported claim that the skill is superior.

If a required environment is unavailable, record the block separately from skill failure. Do not convert an infrastructure failure into a behavioral loss or qualification credit.

## Review checklist

Before promotion, a reviewer should be able to answer yes to each question:

- Does this responsibility deserve a separate skill?
- Is the invocation boundary clear against its closest neighbors?
- Does every major instruction change a decision or prevent a known failure?
- Is conditional detail disclosed only when needed?
- Are sources current and their adopted guidance traceable?
- Are routing cases realistic and held out?
- Are task evaluations complete enough to exercise the claimed responsibility?
- Are candidate and baseline conditions paired fairly?
- Are stochastic results repeated enough for the decision being made?
- Are verifiers calibrated against valid alternatives and realistic failures?
- Do skills preserve explicit task contracts and finish required machine artifacts in a parseable form?
- Does the skill stay inside the requested scope and preserve existing repository or product decisions unless evidence requires a change?
- Does the skill keep existing authorization instead of repeatedly asking for approval that was already granted?
- Does the skill expose a failed requested mechanism instead of silently substituting a fallback or reduced behavior?
- Does the skill continue authorized work through a concrete result and relevant evidence rather than stopping at a plan, scaffold, or placeholder?
- Does the skill load only context that can change a decision or satisfy an evidence need?
- Are consequential defaults visible rather than hidden behind unspecified reasonable behavior?
- Are success claims supported by observable evidence outside the skill's own assertion?
- Where candidate tests claim regression coverage, do they actually reject a known broken state or mutation?
- Did a semantic reviewer inspect disagreements that could change the verdict?
- Did the critic evaluate worker skill adherence from the delivered revision rather than from memory or package names alone?
- Is authored prose free of dash punctuation while exact technical syntax remains intact?
- Are all observed regressions preserved?
- Is the promotion claim no stronger than the evidence?

If any required answer is no, keep the revision out of the ready state and record the missing gate.
