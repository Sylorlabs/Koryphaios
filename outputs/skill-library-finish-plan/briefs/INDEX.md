# Koryphaios skill library V5: parallel long horizon work orders

Twelve briefs, one per skill group, covering all 182 packages exactly once with no overlap. Each brief is a self contained prompt for one long running subagent that owns a whole sector of the library, not one slice of one skill.

Generated from `outputs/skill-v5-promotion/audit.json` at 2026-11-07T19:53:55Z.

## Groups

| Brief | Skills | Ready now | Environment blocked | Scope |
| --- | --- | --- | --- | --- |
| A-language-runtimes.md | 15 | 3 | 2 | Language and runtime engineering across TypeScript, Python, Go, Java, Kotlin, C, C++, Rust, Swift, .NET, Ruby, PHP, shells, and compilers |
| B-backend-and-apis.md | 14 | 0 | 0 | Backend, HTTP, GraphQL, gRPC, distributed and event driven services, payments, webhooks |
| C-data-stores-and-search.md | 19 | 4 | 0 | Databases, data pipelines, analytics, statistics, embeddings, vector search, indexing |
| D-frontend-and-interfaces.md | 21 | 3 | 4 | Frameworks, visual and interaction design, accessibility, terminals, usability |
| E-native-mobile-and-devices.md | 15 | 1 | 13 | iOS, Android, Expo, desktop shells, computer use, firmware, robotics, GPU, native windows |
| F-security-and-crypto.md | 16 | 2 | 0 | Application, cloud, infrastructure, supply chain security, crypto, identity, AI safety |
| G-cloud-and-operations.md | 16 | 3 | 0 | AWS, GCP, Azure, Terraform, containers, Kubernetes, CI, SRE, incident response |
| H-agentic-and-llm.md | 14 | 2 | 2 | Agent systems, retrieval, evaluation, fine tuning, media generation |
| I-verification-and-debugging.md | 15 | 8 | 0 | Debugging, concurrency, performance, property testing, release planning |
| J-architecture-and-research.md | 13 | 4 | 1 | Architecture, planning, implementation, repository research, literature review |
| K-product-and-business.md | 20 | 10 | 0 | Product, program, pricing, strategy, finance, contracts, communication |
| L-skill-system-and-routing.md | 4 | 2 | 0 | Skill authoring, routing, dash free writing, plan mode |

## How to launch

Give each subagent exactly one brief file path plus this one instruction:

> Read `outputs/skill-library-finish-plan/briefs/<GROUP>.md` completely and execute it as your standing assignment. Write your running report to the report path named in the brief. Do not stop at a plan.

Launch all twelve at once. They are designed to be independent: separate skill directories, separate staged evidence directories, and separate report files.

## Coordinator duties that stay with one agent

These cannot be parallelised without corrupting the record:

1. **Ledger ingestion.** `.koryphaios/skills/evaluations.json` has a single writer. Subagents stage evidence only. Run the importer serially, only after inspecting a staged review or run for provenance, schema validity, and semantic sanity.
2. **Shared gate changes.** Changes to `backend/src/kory/skill-evaluations.ts`, `skill-eval-execution.ts`, or the routing corpus change how every package is judged. Accept one change at a time, re-run `bun run scripts/report-skill-v5-promotion-inventory.ts`, and confirm the change does not move any unrelated package.
3. **Refusal log.** Collect every action a subagent refused or that a safety layer refused, and keep it out of the evidence record.
4. **Disagreement resolution.** When two groups touch the same shared fixture, the coordinator decides and records the decision.

## Standing invariants

- No threshold change, no exclusion widening, no reclassification of a failure.
- No fabricated run, review, timestamp, hash, device, or source.
- Historical negatives stay in the ledger permanently.
- A skill edit invalidates its paired evidence, because the revision hash covers the sidecar and source. A source date or URL refresh does not.
- Skill prose carries no dash punctuation.

## State at the time of writing

Static quality is green: 0 errors, 0 warnings, 0 stale sources, 0 dash findings, 182 individually authored packages. Promotion stands at 42 ready, 120 blocked, 20 insufficient evidence.

Two supporting pieces already exist in this working tree and are referenced by the briefs:

- `scripts/kory-logfare-stateless-reviewer` plus `.ts`: a stage only independent reviewer adapter for the logfare OpenAI compatible endpoint, model `deepseek-v4.1-flash-1017`. It reads the sealed prompt on stdin and emits the completion envelope with a bound output hash. Verified: it produces a valid adjudication envelope, resolves its credential independently of the caller working directory, retries bounded empty completions, and correctly preferred the stronger of two synthetic artifacts.
- `outputs/skill-library-finish-plan/`: source verification evidence for 94 previously stale sources, the refresh decision record, and the gate snapshots.
