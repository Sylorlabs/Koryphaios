# ADR 001: Agent Orchestration and Resilience

## Status
Accepted

## Context
Koryphaios requires a reliable way to orchestrate multiple AI agents across various providers. LLM APIs are prone to rate limits (429), temporary outages, and varying performance. We need a system that ensures task completion even when primary models or providers fail.

## Decision
We implemented a hierarchical Manager-Worker architecture with a central resilience hub in the `ProviderRegistry`.

### 1. Hierarchical Delegation
- **Manager (Kory)**: Responsible for intent classification, planning, and task delegation.
- **Workers**: Domain-specific specialists (UI, Backend, Test) that execute concrete tasks.
- **Critic Gate**: An automated audit agent that verifies worker output before finalizing tasks.

### 2. Provider Resilience (Circuit Breaker)
We implemented a global `CircuitBreaker` in the `ProviderRegistry`:
- **Tracking**: Failures are tracked per-provider.
- **State**: After a threshold of failures (default: 5), the provider's circuit opens, and it is skipped for a timeout period (default: 5 minutes).
- **Half-Open**: After the timeout, one request is allowed through to test recovery.

### 3. Resilient Execution (`executeWithRetry`)
The `ProviderRegistry` now provides a unified `executeWithRetry` method:
- **Fallback Chains**: Models can have configured fallback chains (e.g., GPT-4 -> Claude Sonnet -> Gemini Flash).
- **Automatic Failover**: If a primary provider fails or the circuit is open, the system automatically tries the next model in the fallback chain or another available provider.
- **Streaming Compatibility**: Resilience is implemented using async generators to maintain real-time streaming to the UI.

### 4. Domain-Specific Routing
Worker domain assignments (UI, Backend, etc.) are decoupled from logic and stored in configuration, allowing for project-specific optimization without code changes.

## Consequences
- **Pros**: Significant increase in reliability; better handling of rate limits; clearer separation of concerns.
- **Cons**: Increased complexity in the routing layer; potential for increased token costs if fallback models are more expensive (mitigated by chain ordering).
