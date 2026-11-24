# Runtime boundaries and async failure checks

Use this when a change trusts external JavaScript values or wraps asynchronous work with cancellation or a deadline. Adapt to the project's actual public API and runtime; the checks below describe contracts, not an implementation to drop in.

## Turning unknown input into a trusted union

1. Identify the ingress and data owner (HTTP, storage, messages, library calls). Start with `unknown`, including values returned by `JSON.parse`; a successful parse proves only JSON syntax.
2. Validate the root shape (object, non null, expected collection form), discriminant and all fields for that variant. Validate nested arrays/objects, element types, and semantic constraints such as finite numbers or allowed strings where the domain requires them. Prefer a maintained schema library already present in the project or a small explicit parser that returns a typed result.
3. Define outcomes for an unrecognized tag, a recognized tag with malformed fields, and optional/extra fields or older versions. Fail in a documented way before calling business handlers. If quarantining, preserve useful diagnostics without treating the payload as trusted or allowing partial writes.
4. Construct the trusted union only after the checks succeed. Make handlers exhaustive with a `never` assertion on remaining _typed_ variants. A default that silently accepts an unknown tag defeats the boundary; `never` cannot validate arbitrary JavaScript input.

Negative tests should include null, arrays where objects are expected, missing or unknown tags, known tags with an invalid field, invalid nested items, and one compatibility case. For every rejection assert the intended error/quarantine outcome and absence of state changes; for every accepted variant assert its intended dispatch. Run typecheck separately to verify the exhaustive switch, and a runtime test to verify the actual parser.

## Timeout and cancellation ownership

- Establish the policy for the first observed terminal outcome: success, original rejection, caller abort, timeout, or synchronous setup failure. Preserve established error identity/class/name contracts; do not convert all failures into one generic timeout or swallowed rejection.
- Check `callerSignal.aborted` before scheduling or invoking work. When it is aborted, forward `callerSignal.reason` unchanged, including explicit `null`, `false`, or `undefined` if the API permits them; do not use `reason || fallback`. A signal's abort event is dispatched once and never replayed for a late listener.
- For active callers, install the listener for caller abort, timer bookkeeping, and a settlement guard that runs once before invoking the operation. Invoke it synchronously under `try`/`catch` so it can register its own abort listener before the wrapper returns. Deferring the _invocation_ to a microtask creates a cancellation race in the same turn unless the deferred starter rechecks the signal and skips aborted work.
- If the deadline fires, abort a derived controller where the operation accepts a signal, then settle the wrapper. The wrapper settling alone does not stop the underlying work. Attach success and rejection handlers to any returned promise so late results do not change the outcome or become unhandled rejections.
- All terminal paths must remove the caller listener, clear the timer and settle at most once. Track whether the timer was installed independently of the handle value (`0` or `undefined` can be valid in injected clocks). If the test timer fires synchronously during registration, skip starting work and clear its returned handle after registration completes. Handle throws from timer registration and operation invocation without leaked listeners.
- If the underlying operation does not cooperate with cancellation, document its continuing side effects; do not promise that a rejected wrapper forcibly stops it.

## Repeatable negative verification

Use a deterministic clock and instrument the wrapper's timer and abort listeners. Make each test assert the _observed effect_, not just promise resolution:

| Trigger                                                                 | Observable invariant                                                                                         |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Caller already aborted                                                  | Operation never starts; original abort reason propagates; no timer/listener remains.                         |
| Success / original rejection / synchronous throw                        | Result or exact error survives; timer and listeners removed.                                                 |
| Immediate caller abort after invocation                                 | Underlying work had registered its listener and observes abort, including a falsy reason; one final outcome. |
| Timeout                                                                 | Underlying cooperative work sees the derived abort; timeout error contract holds; no active timer/listener.  |
| Competing abort and deadline, in both orders                            | First observed outcome wins; cleanup runs once; later events cannot overwrite the result.                    |
| Late fulfillment or rejection after timeout                             | No duplicate settlement or unhandled rejection; unavoidable late side effects are recorded.                  |
| Timer handle `0` / `undefined`, or immediate firing during registration | Timer teardown is attempted for the installed timer; no operation starts after synchronous timeout.          |

Run the real typecheck and representative runtime tests using the repository's supported runtimes and existing test libraries. Record exact commands, versions and outcomes. Do not replace unresolved runtime test types with ad hoc globals or treat compilation, mocked signals, or a passing happy path as live cancellation evidence.
