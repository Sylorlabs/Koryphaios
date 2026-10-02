# Source map

These sources ground `functional-verification` in requirement-linked, objective, operationally representative evidence. Domain-specific platform contracts still come from the product or protocol being verified.

## Qualification basis

- Package authorship is independent from empirical qualification; the audit/evaluation ledger is authoritative for qualification status.
- Hierarchy: broader verification.
- Routing: five positive, five near-neighbor negative, three compound/ambiguous, and three adversarial held-out cases through the real resolver.
- Full-task evaluation: two individual scenarios with six falsifiable checks, same-model skill/no-skill pairing, regression retention, and blind semantic judging.
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

## Maintained sources

- **NASA Software Engineering Handbook: SWE-034 Acceptance Criteria**: https://swehb.nasa.gov/spaces/7150/pages/16450634/SWE-034+-+Acceptance+Criteria
  - Use: acceptance criteria precede the verdict; obtained results are compared with expected results and documented; acceptance testing establishes fitness for use.
  - Version scope: NASA handbook page available 2026-09-05.
  - Verified: 2026-09-05; refresh after 90 days.

- **NASA Software Engineering Handbook: SWE-067 Verify Implementation**: https://swehb.nasa.gov/spaces/SWEHBVB/pages/32604539/SWE-067+-+Verify+Implementation
  - Use: verify requirements under operationally representative conditions, exercise actual interfaces when possible, and include fault/recovery and resource-related requirements when they are part of the contract.
  - Version scope: NASA handbook guidance available 2026-09-05.
  - Verified: 2026-09-05; refresh after 90 days.

- **NASA Software Engineering Handbook: SWE-141 Independent Verification and Validation**: https://swehb.nasa.gov/spaces/SWEHBVC/pages/50888971/SWE-141+-+Software+Independent+Verification+and+Validation
  - Use: objective acceptance criteria, nominal/off-nominal conditions, test-environment fidelity, and traceability from behavior to evidence.
  - Version scope: NASA handbook guidance available 2026-09-05.
  - Verified: 2026-09-05; refresh after 90 days.

- **IEEE Computer Society: SWEBOK Guide v4**: https://www.computer.org/education/bodies-of-knowledge/software-engineering
  - Use: software testing and V&V terminology, test levels, requirements relationships, and professional lifecycle context.
  - Version scope: SWEBOK Guide v4 material available 2026-09-05.
  - Verified: 2026-09-05; refresh after 180 days.

- **NIST IR 8397: Guidelines on Minimum Standards for Developer Verification of Software**: https://csrc.nist.gov/pubs/ir/8397/final
  - Use: verification should combine techniques according to risk rather than rely on one test type or one success signal.
  - Version scope: NISTIR 8397 final publication.
  - Verified: 2026-09-05; refresh after 180 days.

## Interpretation rules

- The product's actual behavioral contract and acceptance criteria decide what must be observed; generic test taxonomies do not substitute for them.
- Prefer the real supported interface and fresh post-change state for claims that depend on runtime behavior.
- Treat simulator, mock, fixture, or internal instrumentation output as bounded evidence and label fidelity limits explicitly.
- Keep functional correctness separate from specialized security, accessibility, reliability, visual, and performance claims unless their own oracle is actually exercised.
