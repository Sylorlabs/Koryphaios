---
name: email-delivery
description: Engineer transactional and bulk email systems around authentication, reputation, suppression, templates, retries, tracking, privacy, and deliverability. Use when the request specifically requires email delivery, transactional email, sendgrid email, ses email; prefer a narrower child only when its boundary is established.
---

# Email Delivery

## Responsibility

Separate transactional and marketing streams, configure SPF/DKIM/DMARC ownership, stable From/Return-Path domains, suppression/unsubscribe policy, templates, localization, bounce/complaint webhooks, rate limits, retry behavior, and provider failover. Protect recipient data and tracking choices.

## Transferable decisions

- Separate message purpose from transport. Transactional and marketing streams can have different consent, unsubscribe, suppression, and retry policies even when they share a provider.
- Track envelope identity, visible `From`, DKIM signing domain, and DMARC alignment separately. SPF authorization and DKIM signing answer different authentication questions.
- Classify delivery outcomes by retryability. Temporary SMTP failures can justify bounded retry, while permanent recipient or policy failures should follow the product's suppression or operator-review policy.
- Treat provider acceptance, mailbox delivery, and inbox placement as different states. A successful API or SMTP submission does not prove inbox placement.
- Make duplicate prevention part of notification state so a provider timeout or retry cannot create multiple user-visible sends for one logical notification unless duplicates are intentionally acceptable.

## Observable checks

Scope suppression state and history to the exact recipient identity. A hard bounce is permanent for that address; later soft bounces or duplicate events cannot weaken it. An address correction creates a distinct identity without changing the old address's suppression or audit history. Explicit unsuppression affects only the named address and never clears another address's history. Deduplicate stable provider event ids before applying transitions.

- Inspect DNS and a received message's authentication results for SPF, DKIM, and DMARC alignment using the actual sending identities.
- Exercise one temporary failure, one permanent failure, one complaint or suppression event, and one retry of the same logical notification.
- Verify unsubscribe behavior for mail that requires it, including one-click headers when the chosen ecosystem or policy depends on RFC 8058 semantics.
- Render templates with missing, escaped, Unicode, and long content, and verify headers do not leak unintended recipients.
- Report provider acceptance separately from downstream delivery or inbox evidence.

## Failure boundaries

Do not retry permanent bounces indefinitely, send marketing mail without the governing consent and unsubscribe requirements, use one reputation stream for everything without an explicit reason, or log full message bodies unnecessarily. Do not call provider acceptance an inbox-delivery result.

## Hierarchy and routing

- Broader skills: integration-implementation.
- No narrower bundled child is declared.
- Required skills: verification.

Route here for sender authentication, SMTP or provider delivery states, bounces, complaints, suppressions, unsubscribe semantics, reputation separation, and duplicate-send prevention. Route generic callback authenticity and replay handling to `webhook-integration` when the provider event transport itself is the focus.

## Completion evidence

- Sending and envelope identities plus observed SPF, DKIM, and DMARC results.
- Retry, bounce, complaint, suppression, and duplicate-send results for the changed flow.
- Unsubscribe evidence where that mail class requires it.
- Separate provider-acceptance evidence and any independently observed delivery or inbox evidence.

Use [the maintained source map](references/sources.md) for version-sensitive facts and source conflicts.
