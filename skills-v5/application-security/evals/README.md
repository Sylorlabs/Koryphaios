# Local evaluation contract

From the repository root, with the repository's installed Bun and dependencies:

```sh
bun test skills-v5/application-security/evals/local-checks.test.ts
bun test backend/src/kory/__tests__/skill-eval-evidence-contract-regressions.test.ts --test-name-pattern application-security
bun test backend/src/kory/__tests__/skill-eval-appsec-coverage.test.ts
```

The first command validates this package, resolves its routing corpus using in-memory revisions from the current compiler templates and the resolver's explicit injection interface, and verifies that both registered scorers reject the vulnerable starters. It does not seed global skills or certify global catalog readiness. The other commands exercise existing scorer controls. They run offline, clean temporary fixtures, and do not record evaluation runs. The optional saved-candidate replay in the desktop coverage test reads an existing archive and explicitly skips when it is absent.

## What is executable today

The registered implementations live in `backend/src/kory/skill-eval-pilot-fixtures.ts`. This package describes the intended full-task contract; those component fixtures only implement part of it.

| Scenario     | Registered materializer / scorer                                                                                         | Current runtime evidence                                                                                                                                                                                                                                                |
| ------------ | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Media import | `application-security/media-import-boundaries@4` / `application-security/media-import-boundaries-scorer@4`               | Supplied URL/resolved-IP hop arrays; real temporary directory and escaping-directory-link checks; archive metadata thresholds; shell-free invocation descriptors with supported quality options and punctuation; one bearer-header/control-character diagnostic sample. |
| Desktop sync | `application-security/desktop-sync-client-boundaries@2` / `application-security/desktop-sync-client-boundaries-scorer@3` | JSON command rejection; real authorized-root path checks; two invalid queue shapes and one valid sync entry; credential-handle serialization; export-eligibility predicate; `access_token` and bare `refresh` diagnostic samples.                                       |

Registration is not full-task readiness. The scorers run public/hidden component tests plus text-pattern regression-coverage heuristics; the declared `falsifiableChecks` are not individually executed or scored by these scorers. A green result therefore does not prove every assertion. In particular, test labels or comments matching coverage patterns are not evidence that the corresponding denial assertions ran. The existing import scorer control also replaces the supplied public test, so it is a scorer-compatibility control, not proof of regression retention.

## Required negative and recovery oracles

Use a permitted control alongside each rejection. Record commands, exact inputs, observed outcomes, and missing integration points; proposed cases are not observed results.

| Boundary              | Permitted control                                                | Negative/recovery observation required beyond current scorer coverage                                                                                                                                                                                                           |
| --------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Outbound fetch        | Public HTTPS URL resolving and connecting to a permitted address | Userinfo, malformed schemes, private redirects, IPv6/mapped addresses, hop overflow, and a changed DNS/connected destination fail before unsafe connection; no sensitive headers cross an untrusted origin. `203.0.113.10` is documentation-only, not a public success control. |
| Files/archive         | Nested target beneath an existing temporary root                 | Traversal, existing leaf/ancestor link escape, and link replacement cannot create outside-root files. Enforce expanded-byte/depth/count ceilings during extraction, not just against supplied metadata.                                                                         |
| Converter             | Documented quality option and punctuation-bearing operands       | Unsupported flags and leading-option operands cannot widen effects. Confirm actual parser semantics and execution; `shell: false` and argv membership alone do not prove this.                                                                                                  |
| Resources             | At-limit input under a numeric, unit-bearing policy              | Overflow and invalid/non-finite metadata fail closed. Enforce body/output/log byte, time, memory, and process limits at their runtime boundaries. Distinguish supplied ceilings from proposed defaults.                                                                         |
| Diagnostics           | Useful non-sensitive context survives                            | Full bearer headers plus multiple credential classes/bare aliases across delimiters/newlines leave no secret fragments; controls are removed and UTF-8 byte caps hold after redaction.                                                                                          |
| Durable state/session | Valid sync/open-path queue and fresh export                      | Malformed operation-specific fields, expired/revoked sessions, future/null/stale reauthentication, and failed staging/persistence cannot regain authority. Inspect durable state, cleanup/quarantine, restart restoration, and a later valid retry.                             |

## Remaining evidence blockers

- The import fixture has no HTTP transport/connected-peer seam, ZIP parser/extractor, native converter execution, durable job writer, or cleanup/retry pipeline. The desktop fixture has no deep-link/IPC transport, OS credential store, durable queue writer, or renewal/restart lifecycle. Those integration claims remain unverified even when the component scorer passes.
- The registered scorers do not enforce the complete numeric-limit, multi-credential, leading-option, permitted-operation, denied-side-effect, or recovery matrix above. Correcting the backend materializers/scorers is outside a package-only edit.
- The original routing negative about role/resource permissions asserts only absence of this skill; it does not establish that `authorization-security` is selected. The added explicit authorization-review negative requires that specialist and tests direct ownership separately from inherited guidance.
- The resolver also infers the application-security domain from authorization requests. The sidecar's explicit “only entitlement policy” exclusion handles that scope restriction; removal of the broad activation alone cannot prevent every authorization-only false positive. General inference changes belong to the resolver, outside this package.
- Package version, instructions, routing cases, and task contracts changed. Historical routing/pair/blind-review records must be matched to the exact revision and evaluation contract before reuse. These local checks produce no fresh same-model pair, independent blind judgment, or promotion evidence.
