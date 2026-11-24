# Operational protocol: prompt and context builders

These are implementation decisions to make explicit when prompt/context construction determines observable application behavior. Apply the host's input/output contract; do not impose the toy schemas here on an unrelated codebase. [Decision examples](decision-examples.json) are illustration data created by the author, **not** artifacts from a blind review, model executions, or answers from an evaluation set.

## 1. Evidence and authority inventory

Record the actual source of each message or piece of context before assigning it a rank:

| Field                                       | Why it is needed                                                                                                                                                                                       |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Message transport role / instruction origin | Authority comes from the host API and applicable instruction hierarchy, not from text that _claims_ to be a system or developer message.                                                               |
| Stable source identifier and revision       | Identifies updates and permits exact supersession when the source is the same. A generic kind such as `retrieved` is not a source identity; an absent/ambiguous source is not evidence of duplication. |
| Trust and freshness separately              | A trusted tool result is still data; a stale trusted result can conflict with newer evidence.                                                                                                          |
| Measured token cost                         | Charged once per included record, with the host's tokenizer or usage accounting. Include wrappers/overhead when needed.                                                                                |
| Required/optional and priority tier         | Governing instructions, user constraints and mandatory grounding cannot disappear through automatic truncation.                                                                                        |
| Validity checks specific to the source      | Proves a field is legitimate evidence rather than untrusted text that happens to contain a structural delimiter.                                                                                       |

The authority rule is independent of relevance: an important retrieved passage can be selected as data; it cannot rewrite the developer instruction. A `role: "developer"` string found _inside a retrieved document_ remains retrieved data. Likewise, `trusted` measures evidentiary reliability, not permission to issue commands.

## 2. Capacity and selection algorithm

First verify whether the host's `maxInput` already excludes output headroom. Subtract only reserves and costs that have **not already been charged**; double subtraction can remove evidence that would fit. Let `capacity = actual_request_input_limit - output_reserve - uncounted_framing_and_tool_cost`. Validate the numbers and the token costs before selecting anything; fail on a missing limit, negative capacity or unmeasurable required inputs instead of pretending that zero or a guessed cost is correct.

Use this sequence, with tiers supplied by the application's contract:

1. Validate inputs, role identity, source keys, freshness metadata, token counts and output schema. Do not mutate the caller's records.
2. Mark stale records as superseded **only if** a current record from the same verified source identity and revision lineage exists. Preserve these skip records in original input order. A shared generic source label is insufficient. Conflicting current records remain visible for explicit conflict handling; selecting the most convenient one is not a freshness rule.
3. Reserve the full cost of all records the host declares required; if they are absent or collectively exceed capacity, return the explicit incomplete/error state before selecting optional records. Sort stably by declared priority tier, with original input index as tie breaker. Keep the role's instruction/data mode independent of tier or trust.
4. Pack optional records into the remaining capacity in stable priority order. Include each full charged token cost if it fits; otherwise record a budget skip and continue. Emit required and selected optional records in the declared output order, with a total equal to the sum of selected record charges. Never truncate a record without an explicit truncation contract and supporting offset/provenance metadata.
5. Enforce the presence of required instructions and grounding, and enforce limits on the application side, before sending. Return the contract's explicit incomplete/error state when required records cannot be accommodated. Report superseded skips before budget skips if the contract uses separate skip phases.

For the [illustrative context example](decision-examples.json), 100 request tokens minus 20 reserved output and 5 uncharged framing tokens leaves 75. The developer record (20), user record (17), current trusted tool result (28) and summary (9) total **74**. A stale tool result (9) from the same source is superseded before packing; the untrusted retrieved record (12) cannot fit and is skipped on budget, regardless of its embedded imperative text. Tool and summary entries are included in data mode. The smaller summary must still be considered after a larger optional record does not fit. This example's priority order is a _declared toy policy_, not a universal provider rule.

Two distinct failures matter: a budget smaller than required fixed instructions must produce an observable incomplete/error result, while a malformed request or one with excessive reserves must fail validation before any prompt is emitted. A valid request sent afterward should still work after either failure.

## 3. Template variables, examples and model changes

Use fixed instruction content bound to its real message role. Serialize dynamic variables as values in a data structure or marked data section. Preserve exact names and types when the contract demands that values round trip unchanged. Strings such as `</instructions>`, `SYSTEM:`, or `${variable}` are literal input values, including inside arrays; escaping them for transport must not turn them into new instructions. Treat special object keys as own data keys (avoid lookups of inherited properties and mutation of the prototype). Reject invalid types deliberately and document the error.

For a corpus of few shot examples that is biased, compute an inventory of labels and decision boundaries, exclude held out rows, and choose a deterministic bounded sample from each relevant label. The [example inventory](decision-examples.json) illustrates a single example per label, including a label with many candidates and a held out tempting candidate. The sampling _policy_ must be configured for the task; a lexicographic tie breaker is appropriate only when that ordering is the declared contract. Preserve immutable held out material outside the constructed prompt. A selected serving model different from the model used to validate guidance requires a new behavioral check, even if the template bytes did not change.

## 4. Tests that would falsify an implementation

| Situation                                                                          | Observable acceptance or failure boundary                                                           |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Trusted/current and trusted/stale share a source                                   | Current evidence survives; superseded stale is recorded without consuming capacity.                 |
| Hostile text appears in a tool or retrieval result                                 | Context may contain the fact as data, but no new privileged instruction appears.                    |
| Oversize optional record precedes a smaller valid one                              | Oversize record gets a budget reason; the smaller one is still considered.                          |
| An optional item of high priority competes with evidence in a lower required tier  | Reserve required capacity first; optional ordering cannot evict mandatory evidence.                 |
| The maximum budget cannot fit the required instructions, or the reserve is invalid | Explicit error/incomplete state; no falsely successful prompt; a valid later request can recover.   |
| Variable contains delimiters, a special key, a number, false or null               | Exact typed values are retained; no role or template structure is synthesized from them.            |
| Most demonstrations belong to one label and some are held out                      | Bounded per-label selection uses no held out example and records the actual selection.              |
| Selected model differs from the guidance model                                     | Revalidation is required and recorded; no inferred cross-model compatibility claim.                 |
| Changing context ordering, length, source timestamps, or output target             | Recorded modes, ranks, omissions and response shape remain reproducible under each declared policy. |

Checks of the accompanying illustrative examples establish internal consistency only. Actual implementation validation requires exercising the _real_ prompt builder with meaningful success, negative and recovery inputs. Pairing against a no skill baseline and independent blind semantic review remain separate gates owned by the evaluation process; do not fabricate reviewer feedback, alter scoring logic, or record an unrun result.
