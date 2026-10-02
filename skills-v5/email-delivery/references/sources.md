# Source map

This map keeps SMTP transport, sender authentication, DMARC policy, and one-click unsubscribe as distinct concepts. The standards define protocol behavior; mailbox-provider reputation and inbox placement remain operational outcomes that must be measured separately.

## Adopted principles

- SMTP reply classes define transport outcomes and provide the basis for distinguishing temporary from permanent delivery failures.
- SPF authorizes hosts to use domain identities for SMTP `HELO` or `MAIL FROM`; DKIM authenticates a domain's cryptographic responsibility for a message. They are complementary, not interchangeable.
- DMARC evaluates alignment between the visible author domain and authenticated SPF or DKIM identities, then adds published policy and reporting semantics.
- RFC 8058 one-click unsubscribe uses specific headers and requires a valid DKIM signature covering them when that mechanism is used.

## Conditional or non-adopted recipes

- Provider-specific suppression lists, warmup controls, bounce taxonomies, and reputation dashboards are conditional operational tools and are not mandated here.
- RFC 8058 is adopted only when one-click unsubscribe is required by the mail class, receiver ecosystem, or policy. It does not define whether a product message is transactional or marketing.
- No failover provider, DNS host, template engine, or sending library is required.

## Verification scope

Verify actual DNS records and received-message authentication results, SMTP or provider outcome classes, bounce and complaint ingestion, suppression enforcement, duplicate prevention, and unsubscribe behavior. Inbox placement remains unverified unless observed at the mailbox boundary.

## Primary sources

- RFC 5321, SMTP: https://www.rfc-editor.org/rfc/rfc5321
  - Existing source retained from 2026-09-04 for SMTP transaction and reply semantics.
- RFC 7208, SPF: https://www.rfc-editor.org/rfc/rfc7208.html
  - Adopted for SMTP identity authorization.
  - Verified 2026-09-06.
- RFC 6376, DKIM: https://www.rfc-editor.org/rfc/rfc6376.html
  - Adopted for DKIM signing and verification semantics.
  - Verified 2026-09-06.
- RFC 9989, DMARC: https://www.rfc-editor.org/rfc/rfc9989.html
  - Adopted as the current DMARC standard reference.
  - Verified 2026-09-06.
- RFC 8058, One-Click Unsubscribe: https://www.rfc-editor.org/rfc/rfc8058.html
  - Conditional reference for one-click unsubscribe headers and DKIM coverage.
  - Verified 2026-09-06.
