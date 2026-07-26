/**
 * Long-form, load-on-selection playbooks for the research, risk, and data
 * branches.  They intentionally name decisions and evidence, not products,
 * operating systems, languages, or hosted services.
 */
export type ResearchRiskPlaybookName =
  | 'application-security'
  | 'infrastructure-security'
  | 'authorization-security'
  | 'supply-chain-security'
  | 'privacy-engineering'
  | 'embedded-device-security'
  | 'language-runtime-security'
  | 'exploratory-data-analysis'
  | 'statistical-inference'
  | 'experimental-analysis'
  | 'operational-data-analysis'
  | 'data-visualization'
  | 'ml-evaluation'
  | 'factual-research'
  | 'literature-research'
  | 'market-competitive-research'
  | 'repository-research';

export interface ProfessionalPlaybook {
  title: string;
  body: string;
}

export const RESEARCH_RISK_SKILL_PLAYBOOKS: Record<ResearchRiskPlaybookName, ProfessionalPlaybook> =
  {
    'application-security': {
      title: 'Application security review',
      body: `## Goal
Establish whether an attacker can cross a meaningful trust boundary, not whether a checklist has familiar words. Begin with the product's actual medium: client application, service, command tool, plugin, protocol, runtime, or a combination. Inventory assets, actors, identities, entry points, state changes, secrets, and explicit security promises. Draw trust boundaries and trace the executable path for each high-value action from input to authorization, persistence, output, and audit.

## Method
For each abuse case, state preconditions, attacker capability, impacted asset, enforcement point, and observable expected denial. Inspect validation at the point where data gains meaning, authorization at every reachable privileged boundary, serialization and parsing at crossings, and error or logging paths for disclosure. Prefer small adversarial reproductions and negative tests over assertions that a library or UI controls access. Check lifecycle edges: creation, mutation, import, retry, concurrency, cancellation, recovery, deletion, and upgrade.

## Evidence and failure modes
Report the threat map, reached enforcement paths, proof of denial, residual exposure, and untested assumptions. Separate a confirmed exploit from design risk and a design risk from speculation. Do not assume browsers, sessions, HTTP, databases, cryptography, or framework defaults. Common failures are protecting only presentation paths, validating only happy-path formats, trusting client-supplied identity, swallowing authorization errors, and calling a dependency's advertised feature an enforced guarantee.`,
    },
    'infrastructure-security': {
      title: 'Infrastructure security review',
      body: `## Goal
Assess the real operating environment and its control planes before prescribing hardening. The environment may be a workstation, isolated appliance, private network, hosted estate, build farm, lab, or hybrid system. Create an inventory of compute, firmware where relevant, identity authorities, administrators, networks, storage, deployment paths, backups, monitoring, and external dependencies. Record what is known from effective configuration and observation, not just intended diagrams.

## Method
Map who can administer each layer and how credentials, privileges, changes, and emergency access move through the system. Test least privilege, segmentation, ingress and egress, service identity, secret storage and rotation, patch and configuration provenance, auditability, alert delivery, backup restoration, and break-glass controls. Focus on paths an attacker or accident can actually take: an exposed listener, inherited administrator role, stale credential, permissive mount, unreviewed deployment change, or untested restore. Validate controls in the deployed state and during failure or recovery, not merely in source configuration.

## Evidence and failure modes
Deliver an environment map, effective-policy evidence, attack paths, prioritized remediation, ownership, and recovery proof. State scope limitations such as unavailable physical access or incomplete telemetry. Do not assume a particular cloud, container system, operating system, or internet exposure. Frequent failures are checking templates instead of live configuration, treating logs as monitoring, ignoring administrative and backup paths, making a universal network rule, and increasing availability risk by removing the only safe recovery route.`,
    },
    'authorization-security': {
      title: 'Authorization security',
      body: `## Goal
Make the subject-resource-action decision explicit, consistent, and enforced where it matters. First inventory subjects (people, services, processes, devices), resources, actions, ownership, tenancy, delegation, role or capability inheritance, administrators, and revocation. Write a compact policy matrix before changing implementation. UI visibility and a routing convention are evidence of convenience, never evidence of authorization.

## Method
Trace every way a sensitive action can be invoked: direct request, API, command, background job, import, event, automation, retry, shared link, and administrative tool. Identify the authoritative subject and resource at that boundary; reject caller-provided scope unless it is independently verified. Define defaults for unknown subjects, missing attributes, stale claims, partial failure, and policy-service unavailability. Test allowed, denied, cross-tenant, indirect-object-reference, delegated, confused-deputy, concurrent-change, stale-session, revocation, and administrator cases. Exercise both the intended interface and alternate invocation paths.

## Evidence and failure modes
Provide the policy matrix, enforcement trace, negative-test artifacts, exceptions, and time-to-revocation behavior. A good result distinguishes authentication, authorization, and audit. Do not equate role names with policy, rely on client-side checks, or silently broaden access when context cannot be resolved. Typical defects are checking only collection access, trusting identifiers supplied by the caller, inconsistent checks in asynchronous workers, inherited privileges without termination rules, and revocation that changes a record but not active authority.`,
    },
    'supply-chain-security': {
      title: 'Supply-chain security',
      body: `## Goal
Determine how a change reaches users and where integrity, provenance, or availability can be lost. Start with a chain map: source repositories and contributors, dependency resolution, generated inputs, build tools, credentials, CI or local build steps, artifact storage, signing or verification, distribution, installation, update, and rollback. Include transitive and operational dependencies, not only package manifests.

## Method
For each handoff, identify the artifact, producer, consumer, mutable names, integrity check, authority to alter it, and recovery path. Verify what the target ecosystem actually supports rather than importing a fashionable control. Examine lock or resolution behavior, source pinning, reproducibility, build isolation, generated-code review, maintainer access, credential scope, artifact identity, update channels, and emergency revocation. Perform a bounded tamper or substitution exercise where safe: demonstrate that altered input, unexpected signer, or changed resolution is rejected or visibly detected.

## Evidence and failure modes
Return the provenance map, dependency inventory, verified versus assumed controls, unsupported gaps, and prioritized mitigations. Do not confuse a checksum with provenance, a signed release with a reproducible build, or an inventory with risk reduction. Common failures include mutable tags, secret-bearing build logs, unreviewed generated artifacts, trusting a registry name instead of content identity, scanning only direct dependencies, and making updates impossible without preserving a secure rollback and patch route.`,
    },
    'privacy-engineering': {
      title: 'Privacy engineering',
      body: `## Goal
Minimize harm from information about people and make the information lifecycle controllable. Begin with a data map, not a compliance label: subjects, fields, inferred attributes, identifiers, sensitivity, collection context, purpose, transformations, recipients, storage locations, access paths, retention, deletion, and exports. Treat linkability and inference as risks even when a field is not obviously identifying by itself.

## Method
For every collection and use, state the decision it enables, the minimum information needed, who can access it, and how that access is enforced. Challenge collection, granularity, retention, replication, and sharing before proposing encryption alone. Verify consent or preference state where relevant, purpose boundaries, access and export behavior, deletion propagation, backup treatment, aggregation thresholds, diagnostics, and incident response. Test representative lifecycle operations with realistic identifiers; confirm that deletion or correction reaches derived stores and caches according to the declared boundary.

## Evidence and failure modes
Report the lifecycle map, necessity rationale, control evidence, residual inferences, and unverified systems. Clearly separate engineering observations from jurisdiction-specific legal conclusions. Do not promise anonymity from weak de-identification or treat a privacy notice as an access control. Recurring failures include logging sensitive inputs, retaining data "just in case", mixing purposes in a shared store, forgotten exports, deletion that only hides a screen, and access reviews that ignore operators and support tooling.`,
    },
    'embedded-device-security': {
      title: 'Embedded and device security',
      body: `## Goal
Assess security and safety at the device's actual physical and operational boundary. Establish deployment context, adversary access, safety consequences, hardware trust anchors, boot path, debug and recovery interfaces, firmware provenance, key custody, storage, peripherals, communications, update process, service tooling, and end-of-life assumptions. Distinguish what was observed on representative hardware from what is inferred from documentation or simulation.

## Method
Trace startup from reset through configuration and code execution; identify when trust is established and what can alter it. Test debug lock state, exposed ports, fault or rollback behavior, secret extraction resistance appropriate to the threat, command authorization, replay resistance, update authenticity, version policy, power-loss recovery, and factory/service flows. Model remote and local attackers separately. For safety-relevant controls, verify fail-safe behavior and make no availability change without considering recovery and maintenance. Use bounded hardware experiments where authorized; a simulator cannot prove physical protections.

## Evidence and failure modes
Deliver the attack-surface map, boot and update trace, physical-versus-simulated evidence, safety constraints, and remediation priority. Do not assume secure boot protects mutable configuration, encrypted storage protects an accessible key, or signed updates prevent downgrades. Common defects are production debug access, shared fleet credentials, unsigned recovery paths, unauthenticated local protocols, update rollback through alternate storage, and security recommendations that strand devices when power or connectivity fails.`,
    },
    'language-runtime-security': {
      title: 'Language and runtime security',
      body: `## Goal
Test the security guarantees a language, compiler, interpreter, virtual machine, loader, or sandbox actually enforces. Write those guarantees precisely: memory safety, type safety, capability confinement, determinism, isolation, resource limits, module integrity, or foreign-interface boundaries. Then trace untrusted input from parsing through representation, lowering, optimization, verification, execution, allocation, scheduling, loading, and native escape hatches.

## Method
Build adversarial examples that target cross-layer disagreement: parser versus evaluator, verifier versus executor, type abstraction versus representation, optimizer versus source semantics, capability check versus delegated operation, and sandbox policy versus host interface. Exercise malformed inputs, integer and length boundaries, aliasing, lifetime errors, concurrency, cancellation, reentrancy, loader precedence, reflection, serialization, resource exhaustion, and error recovery. Validate both success and rejection behavior at the final execution boundary. Use differential, property, fuzz, or reduction techniques when they match the system; preserve minimized reproducers and version context.

## Evidence and failure modes
Report the guarantee model, cross-layer trace, reproducer, observed effect, affected versions, and mitigations. Do not infer safety from language branding, static typing, a verifier's presence, or a passing corpus. Frequent defects are unchecked host calls, unsafe internal representations, capability leakage through callbacks, missing limits, deserialization bypasses, undefined behavior introduced by optimization, and tests that only prove parser rejection rather than runtime confinement.`,
    },
    'exploratory-data-analysis': {
      title: 'Exploratory data analysis',
      body: `## Goal
Learn what the data can support before making explanatory or causal claims. Identify provenance, collection purpose, observation unit, population coverage, schema, units, time zone and interval, identifiers, transformations, missingness, censoring, duplication, sampling, and known instrumentation changes. Preserve the raw boundary and make each transformation reproducible in the medium actually available.

## Method
Profile completeness, cardinality, ranges, distributions, outliers, time coverage, subgroup balance, relationships, and contradictions. Inspect records as well as summaries; a smooth aggregate can hide unit errors, merged populations, retries, or impossible values. Compare alternative reasonable cleaning and aggregation choices, and mark discoveries as hypotheses rather than results. Ask what process generated each field and whether absence, zero, and unknown are distinct. Explore meaningful slices supplied by the domain, but avoid repeated fishing that turns visual surprise into a confident finding.

## Evidence and failure modes
Publish a data-quality profile, transformation log, representative examples, exploration outputs, and open questions. State which dimensions cannot be assessed. Do not assume tabular data, SQL, a notebook, or a particular language. Common failures are silently dropping missing values, treating event rows as people, mixing clock domains, double-counting retries, comparing raw counts with unequal exposure, overfitting a story to an outlier, and presenting exploratory correlations as confirmed effects.`,
    },
    'statistical-inference': {
      title: 'Statistical inference',
      body: `## Goal
Answer a stated population question with uncertainty and assumptions visible. Define the estimand in ordinary language and mathematical terms where useful: population, unit, outcome, comparison, time horizon, and decision consequence. Establish how observations arose—sampling, assignment, dependence, clustering, missingness, censoring, measurement error, and selection—before selecting a model or test.

## Method
Choose an analysis whose assumptions match the data-generating process, then check the assumptions and sensitivity to plausible alternatives. Report effect size with units, interval or posterior uncertainty, sample or effective sample size, relevant subgroup behavior, and practical significance. Handle repeated looks, multiple outcomes, transformations, exclusions, and model selection transparently. Distinguish descriptive pattern, predictive accuracy, association, and causal effect. When assumptions are weak, narrow the claim, use a robust or design-based approach, or say the question is not identified rather than manufacturing precision.

## Evidence and failure modes
Keep a reproducible analysis record with data version, estimand, choices made before outcomes, diagnostics, sensitivity results, and limitations. Do not report a threshold crossing as proof, an interval as a probability statement without its framework, or a large sample as immunity to bias. Frequent failures are undefined denominators, pseudo-replication, ignored dependence, outcome switching, uncorrected multiplicity, confounded comparisons, and using a sophisticated model to conceal an unrepresentative sample.`,
    },
    'experimental-analysis': {
      title: 'Experimental and causal analysis',
      body: `## Goal
Design evidence that can change a decision about an intervention. State the causal question, eligible population, unit of assignment and analysis, intervention, comparator, primary outcome, guardrails, exposure window, meaningful effect, and stopping rule before outcomes whenever possible. Map mechanisms that can contaminate assignment: interference, spillover, noncompliance, attrition, delayed measurement, novelty effects, and concurrent changes.

## Method
Choose randomization, a quasi-experimental design, or an observational strategy only after justifying its identification assumptions. Plan allocation, stratification, sample size or precision, logging, exclusions, missing-data treatment, analysis population, and release safety. Verify assignment and exposure in the actual system; a declared experiment is not evidence that treatment differed. Monitor harm and data integrity without repeatedly declaring victory from noisy interim views. Analyze the predeclared primary question first, then label secondary and exploratory results. For nonrandomized evidence, add falsification, balance, sensitivity, and alternative-comparator checks.

## Evidence and failure modes
Provide the protocol, assignment evidence, exposure diagnostics, outcome lineage, effect and uncertainty, guardrail results, deviations, and sensitivity analysis. Do not call any before/after change an experiment. Common failures are randomizing the wrong unit, leakage between groups, selective stopping, untracked overrides, post-hoc metrics, diluted treatment, underpowered subgroup conclusions, and shipping a statistically detectable but practically harmful effect.`,
    },
    'operational-data-analysis': {
      title: 'Operational data analysis',
      body: `## Goal
Turn production or process evidence into a bounded operational decision. Begin with the decision owner, action, urgency, acceptable risk, baseline, and measure of success. Trace each metric from the event or measurement source through identity, clock, sampling, retry, aggregation, retention, schema evolution, dashboard, and alert. A familiar name such as "availability" or "active user" does not establish comparable meaning.

## Method
Validate event coverage and timing against independent signals where possible. Separate demand changes, configuration changes, deployments, incidents, and instrumentation changes from behavior changes. Compare like exposure, meaningful segments, and stable baselines; inspect both tail behavior and aggregates. Make late, duplicate, missing, and backfilled records visible. Turn a finding into an action only when its threshold, owner, expected effect, and verification plan are clear. If the metric is too weak for the decision, recommend instrumentation or a smaller claim instead of a confident chart.

## Evidence and failure modes
Return metric lineage, data-quality caveats, baseline rationale, segment results, operational recommendation, and follow-up verification. Do not assume a particular telemetry stack, database, or dashboard. Frequent failures are alerting on ratios with changing denominators, comparing releases with unequal traffic, averaging away severe tails, treating retries as demand, using deploy time as exposure time, and reporting an incident correlation as root cause without a supporting trace.`,
    },
    'data-visualization': {
      title: 'Data visualization',
      body: `## Goal
Help a defined reader answer a defined question accurately in the actual display medium. Identify whether they need comparison, trend, distribution, relationship, composition, flow, geography, uncertainty, or exact lookup. Confirm audience expertise, decision urgency, viewing size, interaction capability, accessibility needs, and whether a static artifact, interactive surface, terminal, document, or spoken explanation is appropriate.

## Method
Choose encodings that preserve the relevant differences and avoid implying precision that the data does not have. Label units, population, time window, denominator, transformations, missingness, and uncertainty. Use position and length for precise comparisons before weaker encodings; use a table when exact lookup is the task. Design a calm hierarchy: title states the finding or question, annotations expose important context, and interaction reveals detail without hiding the basic truth. Test with representative reader tasks, including small screens or nonvisual access where applicable.

## Evidence and failure modes
Provide the question-to-encoding rationale, source and transformation boundary, rendered accessibility checks, and task evidence. Do not add charts for decoration or default to dashboards. Recurring failures are truncated axes without warning, dual scales that manufacture correlation, unmarked smoothing, unequal binning, raw counts with unequal exposure, color-only categories, inaccessible hover-only details, maps for nonspatial questions, and visual polish that hides uncertainty or missing data.`,
    },
    'ml-evaluation': {
      title: 'Machine-learning evaluation',
      body: `## Goal
Determine whether a predictive or generative system is safe and useful for its intended deployment task—not whether it wins a convenient aggregate metric. Define users, inputs, outputs, decision rights, automation level, failure costs, unacceptable harms, abstention and escalation behavior, baselines, and release thresholds. Separate model capability from the surrounding workflow, retrieval, tools, prompts, and reviewers.

## Method
Construct a versioned evaluation set representative of deployment conditions, including important slices, rare costly cases, adversarial cases justified by risk, and known ambiguity. Prevent train/test, prompt, retrieval, and evaluator contamination. Predefine rubrics and metrics; use blinded, independent human review where judgment is required, measure agreement, and preserve adjudication rationale. Report aggregate and slice performance, calibration or confidence behavior, robustness, latency or cost where relevant, error taxonomy, and uncertainty. Re-run after model, prompt, tool, data, policy, or environment changes; monitor drift after release.

## Evidence and failure modes
Ship the protocol, dataset provenance and privacy boundary, baseline, scoring artifacts, slice results, failure analysis, and decision record. Do not claim general intelligence from a benchmark, use the same model to author and grade without controls, or hide abstentions. Common failures are leakage, cherry-picked demos, overfitting to a fixed suite, unrepresentative gold answers, aggregate scores that mask harm, and treating an evaluator's preference as ground truth.`,
    },
    'factual-research': {
      title: 'Factual research',
      body: `## Goal
Resolve specific claims with evidence whose authority and time scope match the claim. Break the request into atomic checkable statements, identify which are current, contested, quantitative, definitional, or high consequence, and write what would count as sufficient support. Search is discovery, not proof: prioritize primary records, official publications, original datasets, direct statements, and contemporaneous documentation appropriate to the subject.

## Method
Capture source title, publisher or author, publication and effective dates, exact claim supported, access date, scope, and conflicts. Verify consequential claims independently when feasible, especially when a source has an incentive, unclear methodology, or stale version. Read surrounding context; avoid using a snippet, headline, citation chain, or search ranking as evidence. Reconcile disagreements by checking definitions, populations, dates, measurement, and whether one source is reporting versus interpreting. Clearly label synthesis and inference rather than laundering either into a fact.

## Evidence and failure modes
Return a claim-source trace, concise conclusion, confidence and uncertainty, and what could change the answer. Do not browse by default when the task is repository-local, and do not assume a web source outranks a primary local record. Frequent failures are outdated pages, quoted claims that no longer match their source, unit or denominator drift, copied press language, ambiguous dates, and presenting an unavailable or paywalled source as if its methods were inspected.`,
    },
    'literature-research': {
      title: 'Literature research',
      body: `## Goal
Synthesize what a body of scholarly or technical evidence supports for a defined question, population, intervention or phenomenon, and decision. Set scope before searching: disciplines, date range, languages, publication types, inclusion and exclusion criteria, and the intended level of confidence. Use varied vocabulary and citation paths so a single field's terminology or a convenient database does not define the conclusion.

## Method
For each included work, record question, design, sample or corpus, setting, intervention or comparison, outcome, limitations, conflicts, version status, and relevance to the target context. Weigh evidence by directness, method quality, bias risk, precision, replication, and external validity—not venue prestige or citation count alone. Synthesize convergences, contradictions, effect sizes or mechanisms where comparable, boundary conditions, and unanswered questions. Keep systematic search, rapid scan, expert review, benchmark survey, and opinion distinct. Trace assertions to the work that actually supports them.

## Evidence and failure modes
Provide a search rationale, inclusion record, quality assessment, structured synthesis, and applicability limits. Do not turn a list of papers into consensus, collapse preprints and replications into one strength level, or infer practice guidance from a narrow lab setting without qualification. Common failures are citation cascades, duplicate datasets, publication bias, outcome switching, outdated reviews, inaccessible methods, and confusing technical possibility with demonstrated real-world benefit.`,
    },
    'market-competitive-research': {
      title: 'Market and competitive research',
      body: `## Goal
Help a real customer or product decision by comparing alternatives on the dimensions that shape adoption and outcomes. Define the customer segment, job, constraints, buying context, alternatives including nonconsumption, decision criteria, time horizon, and confidence needed. Build a comparison framework before gathering evidence so feature lists and brand familiarity do not decide the result.

## Method
Collect primary product documentation, observed behavior, pricing and contract terms when public, customer evidence, distribution signals, and credible third-party reporting. Distinguish current shipped capability, announced intent, configurable option, and inferred strategy. Evaluate workflow fit, reliability, integration, migration effort, switching costs, accessibility, support, security posture, ownership, ecosystem, and total operating burden as relevant to the segment. Normalize dates, plans, editions, regions, and definitions. When direct use is possible, run matched tasks; when it is not, state the observation boundary rather than inventing parity.

## Evidence and failure modes
Deliver a dimensioned comparison with sources, dates, confidence, customer-specific implications, and unknowns. Do not rank by popularity, funding, feature count, search position, or a vendor's own categories. Frequent failures are comparing mismatched tiers, treating marketing claims as tests, ignoring migration and support, extrapolating one reviewer to all users, and confusing a competitor's public roadmap with a present capability.`,
    },
    'repository-research': {
      title: 'Repository research',
      body: `## Goal
Answer how the checked-out system actually behaves, not how an architecture diagram or comment says it should behave. Start with the question and a bounded hypothesis. Identify the active entry points, project instructions, build and runtime configuration, source roots, generated outputs, tests, persistence, adapters, and deployment or launch paths. Establish revision, working-tree state, and whether local changes alter the conclusion.

## Method
Trace symbols from definition through callers, transformations, error handling, feature flags, serialization, side effects, and observable output. Cross-check source claims against tests, logs, configuration, and a minimal runtime experiment where safe. Search histories only to explain intent or regressions; history does not prove current behavior. Build a short evidence graph that distinguishes implemented code, reachable configuration, tested behavior, deployed behavior, and planned work. Prefer narrow, reproducible probes over broad speculation and preserve commands, inputs, and relevant output.

## Evidence and failure modes
Report file and symbol traces, revision scope, runtime corroboration, contradictions, and confidence. Do not equate a type or interface with an active implementation, a test double with production behavior, or documentation with a live route. Common failures are tracing only one caller, missing generated or configuration paths, reading stale code, assuming default flags, overlooking error paths, and claiming runtime proof from a build that never exercised the relevant condition.`,
    },
  };
