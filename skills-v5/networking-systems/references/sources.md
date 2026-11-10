# Source map

`networking-systems` is individually authored for V5; empirical qualification is tracked separately in the audit/evaluation ledger. Network diagnosis must follow the actual source, address family and protocol path. Standards define wire semantics, but resolver, firewall, VPN, load-balancer and operating system implementations still need environment-specific verification.

## Qualification basis

- Package authorship is independent from empirical qualification; the audit/evaluation ledger is authoritative for qualification status.
- Hierarchy: broader network-service-backend.
- Routing: five positive, five near-neighbor negative, three compound/ambiguous, and three adversarial held out cases through the real resolver.
- Full-task evaluation: two individual scenarios with six falsifiable checks, same-model skill/no skill pairing, regression retention, and blind semantic judging.
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

## Maintained sources

- **RFC 9293: Transmission Control Protocol**: https://www.rfc-editor.org/rfc/rfc9293
  - Scope: Internet Standard TCP specification, published 2022-08.
  - Use: current connection/state/segment/retransmission semantics; obsoletes the original RFC 793 specification.
  - Verified: 2026-09-05; refresh after 365 days.
- **RFC 8200: IPv6**: https://www.rfc-editor.org/rfc/rfc8200
  - Scope: Internet Standard IPv6 specification.
  - Use: IPv6 addressing/packet/network-layer behavior. Pair with source-specific route and implementation evidence.
  - Verified: 2026-09-05; refresh after 365 days.
- **RFC 8201: Path MTU Discovery for IPv6**: https://www.rfc-editor.org/rfc/rfc8201
  - Scope: Internet Standard IPv6 PMTUD.
  - Use: Packet Too Big-driven path-MTU behavior and black-hole failure modes where transport can establish but larger traffic stalls.
  - Verified: 2026-09-05; refresh after 365 days.
- **RFC 1034: DNS Concepts and Facilities**: https://www.rfc-editor.org/rfc/rfc1034
  - Scope: foundational DNS standard with later updates.
  - Use: resolver/name-server/cache/zone concepts. Apply later RFC updates and implementation docs for modern operational details.
  - Verified: 2026-09-05; refresh after 365 days.
- **RFC 1035: DNS Implementation and Specification**: https://www.rfc-editor.org/rfc/rfc1035
  - Scope: foundational DNS protocol specification with later updates.
  - Use: messages and resource-record behavior; source-specific resolver/cache evidence remains required.
  - Verified: 2026-09-05; refresh after 365 days.
- **RFC 8305: Happy Eyeballs Version 2**: https://www.rfc-editor.org/rfc/rfc8305
  - Scope: dual-stack connection-attempt algorithm guidance.
  - Use: explain how differing IPv4/IPv6 path quality and client attempt/fallback behavior can produce intermittent or source-specific dual-stack symptoms.
  - Verified: 2026-09-05; refresh after 365 days.
- **RFC 8446: TLS 1.3**: https://www.rfc-editor.org/rfc/rfc8446
  - Scope: TLS 1.3 Internet Standard.
  - Use: TLS handshake/protocol semantics; separate TCP reachability for TLS-over-TCP from QUIC's integrated handshake. Certificate trust/name validation remains necessary.
  - Verified: 2026-09-05; refresh after 365 days.

## Interpretation rules

- **RFC 9001: Using TLS to Secure QUIC**: https://www.rfc-editor.org/rfc/rfc9001.html. Sections 3 and 4 opened 2026-09-06; refresh within 365 days. Adopt the cooperative TLS/QUIC handshake model and adapt path diagnosis to UDP and QUIC CRYPTO frames. Reject TCP establishment as a prerequisite for all TLS traffic. This does not mandate QUIC or change inherited RFC verification dates.

- Every network claim is specific to its vantage. Record source environment, destination, address family, port, transport, time and expected path before comparing evidence.
- Preserve bad DNS/cache state before flushing anything. Compare resolver path, answers and TTLs from failing and working sources.
- A route is directional; verify source address selection and the return path. Stateful and stateless filters/NAT can make asymmetry decisive.
- Ping is not a service probe. Test the actual TCP/UDP port/protocol and distinguish timeout, reset, handshake success and established-but-stalled data transfer.
- Small transfers succeeding does not rule out a network fault. PMTUD/MTU black holes can allow TCP/TLS handshakes and then stall larger payloads.
- Treat firewall/NAT/LB/proxy as explicit hops with actual tuples, state, listeners/backends and timeout ownership. Do not broaden access or retries before localizing the boundary.
- TLS over TCP and QUIC need different transport probes. Keep certificate verification enabled for the final solution and verify SNI/name/chain/trust/ALPN rather than masking the issue.
- Packet captures/flow logs should be narrowly scoped, clock-aligned and checked in both directions; collect the minimum payload necessary.
- Stage DNS/route/firewall/MTU/LB changes with TTL/state/propagation awareness and preserve a tested rollback path.
