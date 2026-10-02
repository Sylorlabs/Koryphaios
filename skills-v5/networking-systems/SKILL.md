---
name: networking-systems
description: Diagnose network paths with packet and control-plane evidence. Use when connectivity, DNS, routing, transport, MTU, NAT, firewalls, proxies, or TLS handshakes determine failure; use linux-systems for host process state and network-service-backend for application protocol logic.
---

# Networking Systems

Start from the actual failing source and walk the path layer by layer. A network diagnosis is only as good as its vantage point: DNS, source-address selection, routes, NAT, stateful filters, tunnels, load balancers, TLS and application timeouts can differ by host, namespace, region, address family and direction.

## Workflow

1. **Pin the exact flow.** Record failing source environment/namespace/region, destination hostname and resolved IPs, port, address family, transport, application protocol, timestamp and expected path. Compare with a known-good source when available instead of treating the network as one global state.
2. **Resolve DNS from the failing vantage.** Inspect search/stub/recursive/authoritative behavior as relevant, A/AAAA/CNAME answers, TTLs, split-horizon views and cache state. Query the expected resolver directly when useful. Do not flush broad caches before preserving the bad answer or proving cache involvement.
3. **Verify source address and route selection.** Check the chosen source IP/interface, route/policy table, VRF/VPN/tunnel and next hop for each address family. Account for asymmetric return paths; a correct forward route does not prove replies can return.
4. **Check link/neighbor state only where it can matter.** Validate interface/neighbor/NDP/ARP state and effective MTU on the relevant segment. Do not chase layer-2 state for a remote routed failure without evidence.
5. **Probe the real transport and port.** ICMP echo is not a substitute for TCP or UDP service reachability. For TCP, distinguish SYN timeout, reset/refusal, completed handshake, retransmission and established-but-no-data states. For UDP, no response may mean loss, filtering or a silent application, so use protocol-aware evidence when possible.
6. **Separate connection establishment from data transfer.** A TCP three-way handshake can succeed while payload stalls because of MTU, firewall, proxy, TLS or application behavior. Record where bytes stop moving rather than labeling every timeout “connectivity.”
7. **Test MTU and PMTUD explicitly.** Compare interface/tunnel MTUs, encapsulation overhead and packet traces when small requests work but larger transfers stall. Look for ICMP Packet Too Big/fragmentation-needed behavior and repeated retransmissions. Prefer restoring correct PMTUD or a justified path/MSS configuration over adding retries.
8. **Trace stateful filtering and NAT in both directions.** Verify source/destination tuples before and after NAT, security-group/firewall/NACL rules, state tracking/conntrack, ephemeral ports and return policy. A one-way allow rule is insufficient for stateless filters or asymmetric paths.
9. **Model load balancers and proxies as path hops.** Record listener/address family/port, health checks, backend target/port, source-IP/NAT behavior, idle/connect/request timeouts and any Proxy Protocol or forwarded metadata contract. A healthy LB frontend does not prove its backend path is healthy.
10. **Follow the actual TLS transport.** For TLS over TCP, distinguish TCP reachability from the TLS handshake. QUIC integrates TLS over UDP: inspect the UDP path, QUIC version, and CRYPTO handshake rather than requiring a TCP connection. In either case verify hostname/SNI, certificate chain/name/time, trust roots, ALPN, and TLS version. Never disable certificate verification as the permanent fix.
11. **Use packet captures and flow logs at useful boundaries.** Capture only the relevant tuple/time window and minimize sensitive payload collection. Align clocks and compare both directions so missing SYN-ACKs, retransmissions, resets, ICMP errors or NAT rewrites can be localized.
12. **Assign timeout/retry ownership.** Identify client, proxy/LB, NAT/firewall idle, TLS and backend timeouts before increasing retries. Retries can amplify load and obscure packet-loss or MTU failures.
13. **Change the narrowest network control.** Stage DNS, route, firewall, NAT, MTU or LB changes with explicit TTL/propagation/state implications. Preserve the old path/configuration until new-path reachability, transport, TLS and application probes pass from representative sources.
14. **Verify both success and recovery.** Re-run the original failing flow, compare working/failing address families and directions, validate timeouts/large transfers where relevant and prove rollback if the new route/DNS/filter/LB path regresses.

## Boundaries

- `linux-systems` owns Linux process/socket/namespace/kernel state. `networking-systems` owns the routed/DNS/transport packet path and composes with host evidence when the fault crosses that boundary.
- `network-service-backend` owns application protocol/listener/service behavior. A TCP/TLS path that reaches the service successfully shifts HTTP/gRPC/custom-protocol semantics to that skill.
- `edge-cdn` owns CDN edge selection, cache behavior, edge/origin policy and CDN-specific TLS/origin routing. This skill owns the generic DNS/IP/transport underlay and path evidence.
- `infrastructure-security` and security-specialist skills own policy/threat design. This skill verifies firewall/NAT/network enforcement and connectivity without weakening controls broadly.
- Cloud-provider skills own provider-specific control-plane configuration; this skill supplies the network-path model and protocol evidence used to verify those changes.
- Generic HTTP handler bugs, systemd process failures, certificate issuance workflows or cache-policy tuning do not activate this skill unless the current failure is specifically on the network/DNS/transport/TLS path.

Use [the maintained source map](references/sources.md) before relying on protocol-version, dual-stack, DNS, PMTUD or TLS behavior.
