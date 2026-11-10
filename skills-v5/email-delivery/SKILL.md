---
name: email-delivery
description: Engineer transactional and bulk email delivery across authentication, reputation, suppression, templates, retries, idempotency, provider boundaries, observability, failover, and deliverability verification. Use when a request involves email delivery, SendGrid, SES, bounces, suppression, unsubscribe, retries, or inbox placement.
---

# Email Delivery

## Responsibility

Own the delivery contract from the logical notification through provider submission, recipient state, feedback events, and evidence of what happened. Cover transactional versus marketing stream separation, sender identity, SPF, DKIM, DMARC, suppression and unsubscribe rules, template and locale behavior, bounce and complaint ingestion, rate limits, retries, provider failover, duplicate prevention, privacy, and deliverability verification.

Keep generic webhook transport, API design, or application business logic in their specialist skills when email semantics are not the focus.

## Investigation workflow

### 1. Establish the actual mail path

Inventory the message class, sending provider or providers, stream or pool, visible `From`, envelope sender or `Return-Path`, DKIM signing domain and selector, SPF identity, DMARC policy and alignment, sending volume, rate controls, template version, locale, event ingestion path, suppression store, and any failover path.

Record which facts are observed, inferred, simulated, stale, or unavailable. Do not fill missing provider evidence with a plausible story.

### 2. Separate the evidence layers

Treat these as different observations:

- Submission or SMTP acceptance: the provider or receiving server accepted responsibility for the message at that step.
- Authentication: received headers or equivalent evidence show SPF, DKIM, and DMARC results for the identities that were actually used.
- Delivery events: provider events report a bounce, complaint, deferred state, or another provider defined outcome.
- Mailbox delivery and placement: independent mailbox observation shows whether a message arrived and whether it was placed in inbox, spam, another folder, or nowhere observable.

Provider acceptance does not prove mailbox delivery or inbox placement. A provider delivered event is not a substitute for an independently observed mailbox result when placement is the question.

### Delivery state and durable identity

- Assign one durable logical notification identity to the product event, scoped to the tenant and recipient identity. Keep a separate attempt identity for each provider submission and preserve provider message or event identifiers as evidence. Include the template version, locale, stream, and message fingerprint needed to detect an accidental parameter change.
- Write the logical notification and its delivery policy to durable state before queueing work. Use an outbox, lease, or equivalent restart safe claim so a worker crash cannot silently lose the notification or release it for an unbounded duplicate send.
- Make the state model explicit. At minimum distinguish queued, in flight, accepted, unknown, deferred, delivered event, bounced, complained, suppressed, cancelled, and exhausted or operator review states. Provider acceptance is not a mailbox delivered state, and an ambiguous timeout is unknown until reconciliation resolves it.
- Keep an append only attempt and event history beside the current derived state. Define the precedence and allowed transitions for duplicate, late, and contradictory provider events instead of relying on arrival order. A later complaint may change recipient policy without erasing the earlier delivery evidence.
- On restart, recover expired leases and reconcile unknown or in flight attempts before creating a new provider attempt. If the provider cannot look up an ambiguous submission, preserve the unknown state and use the documented operator or reconciliation path rather than guessing that the send failed.

### Provider boundaries and idempotency

- Keep provider adapters responsible for authentication, request and response translation, provider status taxonomy, account or pool identity, provider limits, and provider specific message and event identifiers. Keep the logical notification, suppression, consent, retry budget, and audit policy independent of the provider.
- Record provider, account, region or pool when relevant, API or SMTP version, credential or configuration revision, and the adapter version for every attempt. Do not let one provider's status names, retry guarantees, event ordering, or idempotency behavior leak into the core state model.
- Do not assume that an email provider honors an idempotency key, how long it retains one, or whether it scopes it by account, endpoint, or message. Verify those semantics from the actual provider contract. Enforce local idempotency with the logical notification and a stable request fingerprint when provider support is absent, bounded, or unknown.
- Reusing an idempotency key with a different recipient, body, sender, template, or other material parameter is an error. A provider timeout after submission is an ambiguous outcome, not permission to submit a fresh request to another provider.
- Treat provider failover as a routing decision with its own policy and evidence. It is allowed only after suppression, consent, retry budget, and the first provider outcome have been checked. If the first outcome is unknown and duplicate delivery is not explicitly acceptable, hold for reconciliation or operator review.

### Structured implementation contracts

When a task supplies an exact input/output contract, implement its field names, value types, policy strings, enum tokens, and output ordering literally. Treat a configured policy such as a bounded retry or failover that preserves state as its stated value, not as a boolean flag; a descriptive string must not silently become an operating gap. Return only the specified keys in output that machines can parse. Put richer experiment details into separately requested artifacts rather than adding fields to a fixed schema.

Test the promised negative paths as well as the success path, especially unavailable mailbox observations, missing or malformed authentication evidence, policy controls represented by strings, and DNS changes whose fault surface is unproven. A passing synthetic decision function does not establish live provider acceptance or mailbox placement.

### 3. Form evidence bounded hypotheses

Evaluate authentication, reputation, complaints, bounces, stream mixing, volume changes, pacing, content or message construction, template defects, and provider specific behavior as separate dimensions.

Comparative evidence such as Gmail inbox placement and Microsoft junk placement can justify a Microsoft specific placement hypothesis. It does not by itself prove the cause is reputation, content, DNS, or any other one mechanism.

Keep hypotheses labeled as inferred or unresolved until the corresponding evidence is observed. Do not turn a mailbox specific placement pattern into a resolved reputation diagnosis.

Order causal experiments by their prerequisites. First collect and validate the DNS records and received authentication results. If DMARC or the aligned SPF/DKIM path fails, localize that fault and run a bounded authentication control before trying to isolate mailbox provider reputation or message content. Keep the existing Gmail/Microsoft placement observations and metrics, but defer a separate seed experiment specific to the provider while authentication is unresolved or misaligned; otherwise the authentication defect confounds the placement comparison. Once authentication is stable, compare seed cohorts with identities, content, and volume held constant. Encode this dependency explicitly when implementing a diagnostic decision tree so an observed mailbox split does not independently schedule a placement experiment in the branch where authentication failed.

Preserve the observed identities while diagnosing. Do not rewrite `From`, `Return-Path`, or DKIM domains merely to make alignment look simpler.

### 4. Choose the corrective surface from evidence

An alignment boolean is a symptom, not proof that DNS is the broken surface. Recommend a DNS change only when the investigation identifies a DNS record defect or a DNS controlled identity configuration that explains the observed failure. A failed DMARC result can instead originate in provider configuration, envelope identity, signing identity, forwarding behavior, or another part of the mail path.

Before changing DNS, capture the current records and received authentication results, identify the exact record or identity mismatch, define the expected post change result, and define rollback.

### 5. Run bounded experiments

Change one material variable at a time where practical. For each experiment record:

- hypothesis and observed baseline;
- exact change and the cohort, stream, provider, domain, or volume bound;
- success metrics and failure metrics;
- stop condition and rollback;
- evidence needed before expanding the change.

Useful experiments include controlled seed cohorts, a bounded volume ramp, one message construction variant with authentication held constant, or a stream separation change with stable identities. Do not treat a warmup schedule or content rewrite as universally correct without evidence from the actual case.

## Operating contract

### Streams and sender identity

- Separate transactional and marketing traffic when their consent, unsubscribe, reputation, pacing, retry, or risk policies differ. If they intentionally share infrastructure, state why the shared reputation and policy boundary is acceptable.
- Keep the visible `From`, envelope sender or `Return-Path`, DKIM signing domain, SPF authorization path, and DMARC alignment explicit for every sending route.
- Keep stream, provider, domain, and tenant ownership observable enough to diagnose one route without guessing about another.

### Suppression and unsubscribe

- Define which events create suppression, its scope, reason, source event, timestamp, and audit history. Permanent bounce and complaint outcomes must not be weakened by later duplicate or softer events.
- Check suppression before any provider call so failover cannot bypass it.
- Marketing or other mail subject to unsubscribe requirements must have an explicit unsubscribe policy. Verify one click behavior when the selected ecosystem or policy requires RFC 8058 semantics.
- Treat a corrected address as a distinct recipient identity. Explicit unsuppression must name the exact address and retain the prior audit history.

### Bounce and complaint events

- Ingest the provider events that materially change delivery state. Authenticate and replay protect their transport through the webhook specialist when needed, then apply email state transitions here.
- Deduplicate stable event identifiers and make transitions safe under duplicate and out of order delivery.
- Map provider specific event names into product semantics such as temporary failure, permanent failure, complaint, suppression, and success without erasing the original provider evidence.

### Retry, rate, and duplicate semantics

- Retry only outcomes classified as transient by the actual provider contract or by a documented conservative mapping. Bound attempts, elapsed time, and total delivery age. Honor `Retry After` when supplied, use bounded jitter, and make the next attempt decision durable.
- Do not retry permanent recipient, policy, authentication, content, or configuration failures without a defined correction and revalidation path. Put exhausted work in a visible dead letter or operator review state with the reason and last evidence.
- Preserve one logical notification identity, request fingerprint, retry budget, and event history across worker restarts and provider changes. A retry is a new attempt, not a new notification.
- Respect provider, account, domain, tenant, stream, and product rate limits. Define queue backpressure, fairness, and deferral behavior. Prevent one provider outage or a burst of `429` responses from becoming a retry storm.

### Provider failover

- Fail over only when the alternate provider sees the same logical notification identity, consent state, suppression state, and retry history needed to preserve delivery semantics.
- Failover must not resend a permanent failure, bypass suppression, reset an exhausted retry budget, or create a second copy after an ambiguous first provider outcome.
- Record the conditions that permit failover and the conditions that require operator review instead.

### Templates and localization

- Version templates and locale content so a delivery result can be tied to the actual message that was sent.
- Exercise missing variables, escaping, Unicode, long content, locale fallback, links, subject and preheader behavior, and any required plain text alternative.
- Render representative target clients and device classes when message construction or client compatibility can affect the result. Choose the client set from actual audience evidence instead of claiming universal coverage.
- Keep secrets and unnecessary full message bodies out of logs. Preserve enough structured metadata to trace the notification, template version, provider, recipient identity reference, and outcome.

### Observability and security

- Emit structured attempt and event records with the logical notification id, attempt id, provider and account, stream, template and locale version, route decision, provider message id, provider event id, outcome class, retry count, queue age, and timestamps. Use a stable redacted or pseudonymous recipient reference rather than an email address in general logs.
- Measure provider acceptance, unknown outcomes, event lag, mailbox or provider delivery events, retry exhaustion, queue age, suppressed send attempts, duplicate sends, complaints, hard bounces, unsubscribe failures, and failover decisions separately. Bound high cardinality labels and retain an auditable event trail for state changes.
- Alert on invariant failures, including a provider call for a suppressed identity, reused idempotency keys with a changed fingerprint, an unknown attempt aging past its reconciliation window, duplicate logical sends, missing provider events, and divergence between provider reports and local state.
- Validate and safely encode addresses, display names, subjects, reply headers, and template variables. Reject CRLF or header injection, escape untrusted HTML, and do not place secrets, password reset tokens, full bodies, unsubscribe tokens, or provider credentials in logs or metrics.
- Protect provider credentials, DKIM private keys, suppression data, event payloads, and rendered content with least privilege access, tenant isolation, retention and deletion rules, and key rotation. Authenticate provider feedback through the webhook specialist before applying the email state transition, and preserve rejected or replayed evidence without treating it as trusted.

### Recovery and change control

- Define recovery for worker crashes, queue loss, provider outage, credential or signing key rotation, event ingestion delay, provider account suspension, and a corrupted or rebuilt suppression store. Recovery must replay from durable notification and event records, not from an untrusted request or a memory only queue.
- Before changing a route, identity, template, pacing policy, provider, or DNS record, capture the last known good configuration and the exact evidence that justifies the change. Roll back by stopping or routing bounded traffic, restoring the known good configuration, and reconciling in flight and unknown attempts; rollback cannot undo mail already submitted.
- After recovery or rollback, recheck suppression before send, idempotency, event ordering, retry budget, authentication, and the relevant acceptance or mailbox evidence before expanding traffic. Keep operator review states visible until a human or an authoritative reconciliation closes them.

## Verification matrix

Verify the changed path with concrete cases. If a live provider or mailbox is unavailable, mark that check unavailable or simulated and do not claim a live result.

Apply the matrix to the controls that are relevant to the current task and state when a row is not applicable. A synthetic fixture, provider event replay, or local test can verify logic without establishing live DNS, provider, mailbox, or client behavior.

### Success path

- One representative send reaches provider acceptance with the intended identities.
- Received evidence, when available, shows the expected SPF, DKIM, and DMARC results.
- The selected template and locale render correctly in representative clients.
- Independent mailbox or seed evidence is used when inbox placement is a success criterion.

### Negative paths

- A permanent bounce creates suppression and a later send is blocked before the provider call.
- A complaint applies the required suppression or review policy.
- A transient failure retries within its budget and a permanent failure does not.
- Duplicate and out of order provider events do not weaken suppression or duplicate a logical notification.
- An unsubscribe request prevents future affected marketing sends where unsubscribe applies.
- A rate limit or provider outage follows the defined deferral or failover policy without duplicate delivery or suppression bypass.

### Recovery and rollback

- Verify the controlled path for an address correction or explicit unsuppression, including retained history.
- For message, pacing, routing, identity, or DNS experiments, define the last known good state and the observable condition that causes rollback.
- Stop or roll back when authentication regresses, complaint or hard bounce signals exceed the experiment's chosen bound, placement materially worsens, duplicate sends appear, or suppression and unsubscribe invariants fail.
- After rollback, recheck the same success and negative paths before expanding traffic again.

## Metrics and decision gates

Select thresholds from the product baseline, provider contract, and risk tolerance. Do not invent universal deliverability percentages.

Track the metrics that can falsify the active hypothesis, commonly including provider acceptance rate, temporary and permanent bounce rate, complaint rate, suppression hits, unsubscribe processing failures, retry exhaustion, duplicate sends, queue age or send latency, authentication pass and alignment results, and independent placement rate by mailbox provider and stream when seed evidence exists.

State separately whether the system has achieved transport acceptance, authenticated identity, downstream provider events, observed mailbox delivery, and observed inbox placement. A gain in one is not automatically a gain in the others.

## Source freshness and version boundaries

- Use [the maintained source map](references/sources.md) for protocol facts and record the source URL, version or revision, verification date, and stale age policy for material claims. A stale source is a prompt to recheck, not evidence that the old behavior still applies.
- Provider API, SMTP extension, event, idempotency, rate limit, suppression, and failover semantics are version and account dependent. Record the provider documentation or contract revision and retrieval date with the investigation. Do not turn a generic RFC into a provider guarantee.
- If a source, provider contract, received header, DNS observation, event corpus, or mailbox observation is missing or stale, label the resulting decision unavailable, simulated, inferred, stale, or unresolved and state the revalidation needed before production expansion.

## Failure boundaries

Do not retry permanent bounces indefinitely, let provider failover bypass suppression, send affected marketing mail without the governing consent and unsubscribe behavior, collapse all message classes into one reputation stream without an explicit reason, or call provider acceptance an inbox result. Do not recommend DNS edits from an alignment boolean alone. Do not claim live provider behavior that was not observed.

## Hierarchy and routing

- Broader skills: integration-implementation.
- No narrower bundled child is declared.
- Required skills: verification.

Route here for sender authentication, SMTP or provider delivery states, bounces, complaints, suppressions, unsubscribe semantics, reputation and stream separation, retry policy, failover semantics, template delivery behavior, and duplicate prevention. Route generic callback authenticity and replay handling to `webhook-integration` when the provider event transport itself is the focus.

## Completion evidence

- Current sending routes, stream boundaries, identities, suppression rules, retry and rate behavior, event ingestion, failover contract, and template or locale controls relevant to the task.
- Durable logical notification, attempt, idempotency, provider boundary, observability, security, recovery, and operator review decisions relevant to the task.
- Observed authentication, provider outcome, bounce, complaint, suppression, duplicate prevention, unsubscribe, rendering, and retry evidence for the paths that can be exercised.
- Bounded experiments with baseline, change, cohort, metrics, stop condition, and rollback.
- Separate evidence for provider acceptance and any independently observed mailbox delivery or inbox placement.
- Source or provider contract version, verification date, stale age policy, and explicit revalidation steps for version sensitive claims.
- Explicit labels for live, simulated, inferred, stale, unavailable, and unresolved evidence.
- A completion claim scoped to the controls actually exercised; rows that are unresolved, unavailable, simulated, or not applicable remain explicit instead of being summarized as fully verified.

Use [the maintained source map](references/sources.md) for version sensitive facts and source conflicts.
