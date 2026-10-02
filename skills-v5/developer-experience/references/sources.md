# Source map

Developer experience is the lived experience of people using technical products and engineering systems to accomplish developer work. This package owns the coherent developer journey when several technical surfaces contribute to the same outcome; it does not replace the specialists that own each surface.

## Maintained interpretation

- Begin with the developer's role, intended job, existing knowledge, runtime and security constraints, ecosystem conventions, and cost of failure. Map first setup and first useful result through repeat use, diagnosis, change, upgrade, rollback, and removal before optimizing a local snippet.
- Use the DevEx lenses of feedback loops, cognitive load, and flow as diagnostic dimensions, not as a universal score. Shorter feedback is valuable only when the response is trustworthy and actionable; reducing visible steps is not an improvement when it hides ownership, state, permissions, cost, or failure semantics.
- Treat API or SDK concepts as part of a larger journey. Keep naming, resource or object identity, lifecycle, state transitions, side effects, retryability, limits, compatibility, and version assumptions coherent and inspectable. `api-contract-design` owns the normative API contract when that is the task.
- Diagnostics are product interfaces. Preserve the failed operation and relevant resource or location, distinguish invalid input from permission, rate, connection, or service failures, expose stable diagnostic identifiers when available, and preserve indeterminate outcomes instead of falsely reporting success or failure. `content-error-design` owns wording systems; `debugging` owns root-cause investigation.
- Technical documentation should serve the developer's current need. Tutorials support learning, how-to guides support a concrete goal, reference states technical facts, and explanation builds understanding. Examples must be runnable, version-scoped, explicit about prerequisites and permissions, and include cleanup or teardown when the task creates durable state. `instructional-communication` owns document production when documentation itself is the primary task.
- For command-line tools, preserve human discoverability and useful state feedback without sacrificing automation and composability. `terminal-interface` owns terminal-specific interaction, stream, TTY, keyboard, and rendering behavior.
- Compatibility is part of the experience. Classify breaking changes deliberately, give advance migration information, keep old behavior supported for the declared window when the product promises one, test the upgraded integration, and provide rollback or removal paths appropriate to the product.
- Measure change with multiple signals tied to the intended outcome. Pair developer-reported friction or satisfaction with task evidence and relevant system measures. SPACE cautions against treating one activity or output metric as developer productivity; the same discipline applies here. When observed representative task performance is the claim, route the study to `usability-evaluation`.

## Community-pattern review

The Command Line Interface Guidelines provide strong cross-tool patterns for human-first CLI design, discoverable help, composability, clear state changes, machine-readable output, and recovery-oriented interaction. Kory imports these only when a terminal surface is part of the developer journey; it does not universalize terminal conventions to APIs, IDEs, SDKs, or graphical tools.

Diátaxis is useful for separating learning, goal-oriented directions, reference, and explanation so technical documentation does not force one format to serve incompatible needs. Kory treats it as a documentation pattern, not a requirement that every developer product create four rigid documentation sections.

## Verification record

- DX authors' DevEx research summary, including feedback loops, cognitive load, flow state, and mixed qualitative/system measurement: inspected 2026-09-04; recheck within 180 days.
- Microsoft Research record for the ACM SPACE framework: inspected 2026-09-04; recheck within 365 days.
- Google Cloud API Design Guide: official living guide, last updated 2026-08-26 when inspected; recheck within 90 days.
- GitHub REST API breaking-change guidance for API version `2026-03-10`: inspected 2026-09-04; recheck within 90 days.
- Stripe error-handling documentation: inspected 2026-09-04; recheck within 90 days.
- Command Line Interface Guidelines: community guidance inspected 2026-09-04; recheck within 180 days.
- Diátaxis start-here guidance: community documentation framework inspected 2026-09-04; recheck within 180 days.
