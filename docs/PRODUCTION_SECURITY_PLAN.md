# Production Security Implementation Plan

Based on research of industry best practices from HashiCorp Vault, AWS Secrets Manager, Redis rate limiting patterns, and gVisor sandboxing.

---

## Phase 1: Enterprise-Grade Secrets Management

### 1.1 Envelope Encryption Architecture
**Current Problem**: Static seed encryption is vulnerable

**Solution**: Implement envelope encryption with pluggable key providers

```
┌─────────────────────────────────────────────────────────────┐
│                    Envelope Encryption                       │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  Data Encryption Key (DEK) - per secret                     │
│  └── Random 256-bit AES-GCM key                              │
│      └── Encrypted by Key Encryption Key (KEK)              │
│          └── KEK stored in external KMS/Vault               │
│                                                              │
│  Storage: {encryptedDEK, encryptedData, kekVersion}         │
└─────────────────────────────────────────────────────────────┘
```

**Implementation**:
- [ ] Create `backend/src/crypto/envelope.ts`
- [ ] Support multiple KMS backends:
  - Local (development only - with warning)
  - AWS KMS
  - HashiCorp Vault
  - Azure Key Vault
  - GCP Cloud KMS
- [ ] Key rotation support (versioned KEKs)
- [ ] Automatic DEK rotation every 90 days
- [ ] Migration path from old encryption

**Files to Create**:
```
backend/src/crypto/
├── envelope.ts           # Core envelope encryption
├── providers/
│   ├── index.ts
│   ├── local.ts          # Local master key (dev warning)
│   ├── aws-kms.ts        # AWS KMS integration
│   ├── vault.ts          # HashiCorp Vault
│   ├── azure-kv.ts       # Azure Key Vault
│   └── gcp-kms.ts        # GCP Cloud KMS
└── rotation.ts           # Key rotation logic
```

### 1.2 Secrets Lifecycle Management
**Features**:
- [ ] Secret versioning (keep last N versions)
- [ ] Automatic rotation schedules
- [ ] Secret validation (check if API key is still valid)
- [ ] Audit logging for all secret access
- [ ] Emergency revocation (instantly invalidate all tokens)

---

## Phase 2: Multi-Factor Rate Limiting System

### 2.1 Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                  Rate Limiting Stack                         │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  Layer 1: Global Protection (DDoS prevention)               │
│  └── 10,000 req/min per IP across all endpoints            │
│      └── Redis + sliding window                             │
│                                                              │
│  Layer 2: User-Based (Authenticated)                        │
│  └── Tiered limits:                                         │
│      ├── Free tier: 60 req/min                             │
│      ├── Standard: 1,000 req/min                           │
│      └── Premium: 10,000 req/min                           │
│                                                              │
│  Layer 3: Endpoint-Specific                                 │
│  └── Expensive operations:                                   │
│      ├── /api/messages (LLM calls): 30 req/min             │
│      ├── /api/git/*: 120 req/min                           │
│      └── /api/sessions/*: 300 req/min                      │
│                                                              │
│  Layer 4: Burst Handling (Token Bucket)                     │
│  └── Allow short bursts while maintaining steady rate      │
│      └── Bucket: 10 tokens, refill 1/sec                   │
└──────────────────────────────────────────────────────────────┘
```

### 2.2 Redis-Backed Distributed Rate Limiter

**Implementation**:
- [ ] Create `backend/src/ratelimit/` module
- [ ] Redis connection pooling
- [ ] Lua scripts for atomic operations
- [ ] Sliding window algorithm (accurate)
- [ ] Token bucket algorithm (burst-friendly)
- [ ] Middleware for automatic application

**Redis Lua Script** (Sliding Window):
```lua
-- KEYS[1]: rate limit key
-- ARGV[1]: window size in milliseconds
-- ARGV[2]: max requests in window
-- ARGV[3]: current timestamp (ms)

local window = tonumber(ARGV[1])
local max_requests = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local window_start = now - window

-- Remove old entries
redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, window_start)

-- Count current entries
local current = redis.call('ZCARD', KEYS[1])

-- Check if allowed
if current < max_requests then
    -- Add current request
    redis.call('ZADD', KEYS[1], now, now .. ':' .. math.random())
    -- Set expiry
    redis.call('PEXPIRE', KEYS[1], window)
    return {1, max_requests - current - 1, window_start + window}
else
    -- Get time until oldest entry expires
    local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
    return {0, 0, tonumber(oldest[2]) + window}
end
```

**Files to Create**:
```
backend/src/ratelimit/
├── index.ts              # Main exports
├── sliding-window.ts     # Sliding window implementation
├── token-bucket.ts       # Token bucket implementation
├── middleware.ts         # Express/Bun middleware
├── redis.ts              # Redis connection & Lua scripts
├── tiers.ts              # Rate limit tiers config
└── headers.ts            # X-RateLimit-* header handling
```

### 2.3 Rate Limit Headers

Standard headers returned with every response:
```
X-RateLimit-Limit: 1000
X-RateLimit-Remaining: 999
X-RateLimit-Reset: 1640995200
X-RateLimit-Policy: sliding-window;window=60;requests=1000
Retry-After: 45          (only on 429 responses)
```

---

## Phase 3: File System Sandboxing

### 3.1 Sandboxing Strategy

```
┌─────────────────────────────────────────────────────────────┐
│              Sandboxing Architecture                         │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  Level 1: Basic (Default for dev)                          │
│  ├── chroot to workspace                                   │
│  ├── seccomp-bpf syscall filtering                         │
│  ├── Capability dropping (CAP_DROP ALL)                    │
│  └── Resource limits (CPU, memory, file size)              │
│                                                              │
│  Level 2: Containerized (Recommended)                      │
│  ├── Docker/Podman container per task                      │
│  ├── Read-only root filesystem                             │
│  ├── tmpfs overlay for writes                              │
│  ├── Network namespace (isolated)                          │
│  └── cgroup limits                                         │
│                                                              │
│  Level 3: gVisor (High security)                           │
│  ├── User-space kernel (Sentry)                            │
│  ├── Gofer process for filesystem                          │
│  ├── OCI-compatible runtime (runsc)                        │
│  └── Syscall interception                                  │
│                                                              │
│  Level 4: MicroVM (Maximum isolation)                      │
│  ├── Firecracker/Kata Containers                           │
│  ├── Dedicated kernel per task                             │
│  ├── 125ms boot time                                       │
│  └── <5MB overhead                                         │
└─────────────────────────────────────────────────────────────┘
```

### 3.2 Implementation Phases

**Phase 3.1: Seccomp-BPF Syscall Filtering**
- [ ] Create `backend/src/sandbox/seccomp.ts`
- [ ] Generate seccomp profiles dynamically
- [ ] Allow only required syscalls:
  - read, write, openat, close
  - stat, fstat, lstat
  - mmap, munmap, mprotect
  - exit, exit_group
  - clock_gettime
- [ ] Block dangerous syscalls:
  - execve, execveat (unless explicitly allowed)
  - ptrace
  - mount, umount
  - setuid, setgid
  - chroot (after setup)

**Phase 3.2: Container Runtime**
- [ ] Create `backend/src/sandbox/container.ts`
- [ ] Docker/Podman integration
- [ ] Image management (pre-built sandbox image)
- [ ] Volume mounting (read-only workspace)
- [ ] Network isolation
- [ ] Resource limits via cgroups

**Phase 3.3: gVisor Integration**
- [ ] Create `backend/src/sandbox/gvisor.ts`
- [ ] runsc runtime configuration
- [ ] Gofer process management
- [ ] Overlay filesystem setup
- [ ] Platform selection (KVM vs ptrace)

**Phase 3.4: MicroVM (Firecracker)**
- [ ] Create `backend/src/sandbox/firecracker.ts`
- [ ] VM lifecycle management
- [ ] vsock communication
- [ ] Snapshot/restore for fast boot
- [ ] Ballooning for memory management

### 3.3 Filesystem Access Controls

**Permission Matrix**:
| Operation | Level 1 | Level 2 | Level 3 | Level 4 |
|-----------|---------|---------|---------|---------|
| Read CWD  | ✓       | ✓       | ✓       | ✓       |
| Write CWD | ✓       | ✓       | ✓       | ✓       |
| Read /etc | ✓       | ✗       | ✗       | ✗       |
| Network   | ✓       | Config  | Config  | Config  |
| /proc     | Limited | Limited | ✗       | ✗       |
| /sys      | ✗       | ✗       | ✗       | ✗       |
| Syscalls  | Filter  | Filter  | Intercept | VM |

**Files to Create**:
```
backend/src/sandbox/
├── index.ts              # Main exports
├── types.ts              # Sandboxing types
├── seccomp.ts            # Seccomp-BPF filtering
├── seccomp-profile.json  # Default seccomp profile
├── container.ts          # Docker/Podman integration
├── gvisor.ts             # gVisor runtime
├── firecracker.ts        # Firecracker microVM
├── filesystem.ts         # Filesystem isolation
├── network.ts            # Network namespace
├── resources.ts          # cgroup/resource limits
└── workspace.ts          # Workspace setup/cleanup
```

---

## Phase 4: Security Monitoring & Observability

### 4.1 Audit Logging

**Events to Log**:
- [ ] Authentication attempts (success/failure)
- [ ] Session creation/deletion
- [ ] Provider credential changes
- [ ] Tool execution (bash, file ops)
- [ ] Rate limit hits
- [ ] Sandbox escapes/attempts
- [ ] Permission denials

**Log Format** (Structured JSON):
```json
{
  "timestamp": "2026-02-20T20:00:00Z",
  "event": "tool.execution",
  "severity": "info",
  "user": { "id": "user_123", "username": "alice" },
  "session": { "id": "sess_456" },
  "tool": { "name": "bash", "command": "ls -la" },
  "sandbox": { "level": "gvisor", "container_id": "abc123" },
  "result": { "success": true, "duration_ms": 150 }
}
```

### 4.2 Real-time Monitoring

**Metrics to Track**:
- Authentication failure rate
- Rate limit hit rate by user/IP
- Sandbox escape attempts
- Tool execution duration
- Provider API error rates
- Suspicious pattern detection

**Alerting Rules**:
- [ ] >10 auth failures from same IP in 5 minutes → Alert
- [ ] Rate limit hit rate >50% for user → Warn
- [ ] Any sandbox escape attempt → CRITICAL
- [ ] Provider error rate >10% → Alert
- [ ] Unusual after-hours activity → Warn

---

## Phase 5: Hardening & Best Practices

### 5.1 Input Validation Hardening
- [ ] Strict Content-Type checking
- [ ] Request size limits (with configurable max)
- [ ] Parameter whitelisting
- [ ] SQL injection prevention (parameterized queries)
- [ ] XSS prevention headers

### 5.2 Network Security
- [ ] TLS 1.3 only (disable older versions)
- [ ] Certificate pinning for provider APIs
- [ ] Egress filtering for sandboxes
- [ ] DNS-over-HTTPS (optional)
- [ ] Mutual TLS for internal services

### 5.3 Dependency Security
- [ ] Automated dependency scanning (Snyk/Dependabot)
- [ ] SBOM generation
- [ ] Vulnerability database integration
- [ ] License compliance checking

---

## Implementation Timeline

| Phase | Duration | Priority |
|-------|----------|----------|
| Phase 1: Secrets Management | 2 weeks | CRITICAL |
| Phase 2: Rate Limiting | 1 week | HIGH |
| Phase 3.1: Seccomp | 3 days | HIGH |
| Phase 3.2: Containers | 1 week | MEDIUM |
| Phase 3.3: gVisor | 1 week | MEDIUM |
| Phase 3.4: MicroVMs | 2 weeks | LOW |
| Phase 4: Monitoring | 1 week | HIGH |
| Phase 5: Hardening | Ongoing | MEDIUM |

**Total Time**: ~6-8 weeks for full implementation

---

## Testing Strategy

### Security Testing
1. **Penetration Testing**:
   - Attempt container escapes
   - Test rate limiting bypasses
   - Try to extract encryption keys
   - Fuzz API endpoints

2. **Chaos Engineering**:
   - Kill sandbox processes mid-execution
   - Network partition scenarios
   - Redis failover testing
   - KMS unavailable scenarios

3. **Load Testing**:
   - 10,000 concurrent users
   - Rate limit stress test
   - Sandbox spawn rate (100/min)

---

## Migration Guide

### From Current to New Encryption
1. Deploy new envelope encryption alongside old
2. Re-encrypt secrets on first access
3. Mark old secrets as "migrated"
4. After 30 days, remove old encryption support

### Rate Limiting Rollout
1. Start in "monitoring mode" (log only, don't block)
2. Gradually enable for non-critical endpoints
3. Full enforcement after 1 week

### Sandboxing Rollout
1. Default to Level 1 (seccomp only)
2. Allow users to opt into higher levels
3. Make Level 2 default after stability proven
4. Higher levels for specific high-risk tasks
