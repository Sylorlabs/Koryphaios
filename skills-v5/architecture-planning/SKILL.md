---
name: architecture-planning
description: Design or revise software architecture by defining responsibilities, boundaries, interfaces, quality attributes, failure modes, and explicit tradeoffs before implementation. Use when the user asks for architecture, system design, component boundaries, or a technical design decision that materially changes system structure.
---

# Architecture Planning

Architecture planning turns requirements and constraints into a bounded structural decision, not a catalog of fashionable components.

## Establish the decision context

- Identify stakeholders, externally observable requirements, quality attributes, regulatory or trust constraints, deployment/runtime facts, existing system boundaries, team/operational constraints, and likely change axes.
- Separate demonstrated constraints from preferences and speculation. Do not optimize for hypothetical scale or extensibility without an explicit scenario.
- Define the decision that actually needs to be made. If the current architecture already satisfies the constraints, say so rather than inventing a redesign.

## Model the architecture

Describe responsibilities and ownership, data/control flow, state and persistence, interfaces/contracts, trust boundaries, lifecycle, failure propagation, observability, deployment topology, and recovery paths at the level needed for the decision.

Use quality scenarios that are falsifiable: stimulus, environment, expected response, and measurable threshold when one exists. Examples include recovery objectives, latency and throughput envelopes, data loss tolerance, compatibility, isolation, operability, and cost constraints.

## Compare alternatives

Compare at least the credible incumbent/minimal option and any materially different alternative against the same decision criteria. Make tradeoffs explicit; architecture choices routinely exchange simplicity, reliability, latency, consistency, operability, cost, and delivery effort.

Prefer the least complex option that satisfies the demonstrated requirements. Record assumptions that would cause the decision to be revisited.

Preserve existing repository and product decisions when they satisfy the demonstrated constraints. Do not turn a focused design question into an unrelated platform rewrite, migration, or abstraction program. If a structural change is necessary, connect it to a stated requirement or measured failure and keep the decision boundary explicit.

## Produce an evolvable decision

Define seams for likely change, migration/coexistence implications when relevant, verification needed before commitment, and rollback or reversal difficulty. Mark irreversible or expensive decisions explicitly. Avoid specifying implementation details that can safely remain local choices.

Keep the decision artifact compact enough to remain complete. When the caller defines an output schema, required fields, or acceptance evidence, preserve that contract exactly and satisfy it before adding optional detail. Prefer a few representative quality scenarios and tradeoffs that discriminate between alternatives over an exhaustive catalog. For structured output, protect syntactic completeness first; additional explanation is useful only after the required artifact can be parsed and verified.

## Routing boundary

`architecture-planning` owns structural system decisions. It composes with, but does not replace:

- `planning` for dependency ordered execution planning.
- `migration-planning` for staged coexistence, backfill, cutover, and rollback of an architectural transition.
- backend topology, cloud, data, security, and platform skills for domain specific constraints.
- `product-management` for product outcome prioritization rather than technical structure.

Do not activate for a small already designed code edit, implementation only work, or an explanation of an architecture concept with no decision to make.

Use [the maintained source map](references/sources.md) for architecture description and tradeoff guidance.
