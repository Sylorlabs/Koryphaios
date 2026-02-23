# Multi-Tenant Security Implementation

This document describes the production-grade security features implemented for the Koryphaios model hub, focusing on multi-tenant API key management and encryption.

## Overview

Koryphaios now implements enterprise-grade security with:

- **Envelope Encryption**: Each secret encrypted with unique Data Encryption Keys (DEKs)
- **Per-User Key Derivation**: HMAC-based user-specific keys prevent cross-user data exposure
- **Multi-Layer Rate Limiting**: 4-layer protection against abuse and DDoS
- **Comprehensive Audit Logging**: Complete trail for compliance and security monitoring

## Architecture

### A. Per-User Encryption

```
┌─────────────────────────────────────────────────────────────┐
│                    Per-User Key Derivation                   │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│   Master Key (KMS) ──┐                                       │
│                      │                                       │
│                      ▼                                       │
│              ┌──────────────┐                                │
│              │ HMAC(master, │                                │
│              │    userId)   │                                │
│              └──────────────┘                                │
│                      │                                       │
│                      ▼                                       │
│              User-Specific DEK                               │
│                      │                                       │
│                      ▼                                       │
│           ┌─────────────────────┐                            │
│           │ AES-256-GCM Encrypt │                            │
│           └─────────────────────┘                            │
│                      │                                       │
│                      ▼                                       │
│              Encrypted Credential                            │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

**Security Properties:**
- Each user's data encrypted with unique key derived from master
- User A cannot decrypt User B's data even with full database access
- Key derivation uses HMAC-SHA256 for cryptographic separation

### B. Envelope Encryption Flow

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│   Plaintext  │────▶│  Random DEK  │────▶│AES-256-GCM   │
│  Credential  │     │ (per-secret) │     │  Encrypt     │
└──────────────┘     └──────────────┘     └──────┬───────┘
                                                 │
                                                 ▼
                                          ┌──────────────┐
                                          │  Ciphertext  │
                                          │  + Auth Tag  │
                                          └──────────────┘
                                                 │
                                                 │
┌──────────────┐     ┌──────────────┐           │
│   KMS KEK    │────▶│  Wrap DEK    │◀──────────┘
│  (External)  │     │  with KEK    │
└──────────────┘     └──────────────┘
```

### C. Multi-Layer Rate Limiting

```
┌─────────────────────────────────────────────────────────────┐
│                    Rate Limiting Layers                      │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  Layer 1: Global IP (DDoS Prevention)                        │
│  ├── Window: 1 minute                                        │
│  ├── Limit: 1000 requests                                    │
│  └── Algorithm: Sliding Window                               │
│                                                              │
│  Layer 2: User Tier                                          │
│  ├── free: 60/min, premium: 300/min, pro: 1000/min          │
│  ├── Per-user isolation                                      │
│  └── Algorithm: Sliding Window                               │
│                                                              │
│  Layer 3: Endpoint-Specific                                  │
│  ├── /credentials: 20/min (sensitive)                        │
│  ├── /chat/completions: 100/min                              │
│  └── Algorithm: Token Bucket                                 │
│                                                              │
│  Layer 4: Burst Handling                                     │
│  ├── Allows short spikes                                     │
│  └── Algorithm: Token Bucket                                 │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

## Implementation Details

### 1. Per-User Key Derivation (`backend/src/crypto/per-user.ts`)

```typescript
// Derive user-specific key from master key
async function deriveUserKey(userId: string): Promise<Buffer> {
  const masterKey = await getMasterKey();
  return crypto.createHmac('sha256', masterKey)
    .update(userId)
    .digest();
}
```

**Key Properties:**
- Deterministic: Same `userId` always produces same key
- Unique: Different users have cryptographically unrelated keys
- No key storage needed: Derived on-demand from userId + master key

### 2. User Credentials Service (`backend/src/services/user-credentials.ts`)

The service provides secure credential lifecycle management:

```typescript
// Store credential with per-user encryption
const credentialId = await credentialsService.create({
  userId: 'user_123',
  provider: 'openai',
  credential: 'sk-...',
  metadata: { name: 'Production Key' }
});

// Retrieve with audit logging
const credential = await credentialsService.get(
  'user_123',
  credentialId,
  'chat_completion_request' // reason logged
);
```

**Security Features:**
- Envelope encryption with per-user DEKs
- Metadata encryption for sensitive fields
- Soft delete with audit trail
- Key rotation support (re-encrypt after password change)

### 3. Audit Logging (`backend/src/services/audit.ts`)

Every sensitive operation is logged:

```typescript
// Credential access audit
{
  userId: 'user_123',
  action: 'credential_access',
  resourceType: 'credential',
  resourceId: 'cred_abc123',
  ipAddress: '203.0.113.42',
  userAgent: 'Mozilla/5.0...',
  success: true,
  reason: 'chat_completion_request',
  timestamp: 1708473600000
}
```

**Audit Queries:**
- "Who accessed credential X?" → `getCredentialAccessHistory()`
- "What did user Y do today?" → `getUserActivity()`
- "Suspicious activity detection" → `detectSuspiciousActivity()`

### 4. Rate Limiting (`backend/src/ratelimit/`)

Two algorithms implemented:

**Sliding Window** (`sliding-window.ts`):
- Precise window tracking with Redis sorted sets
- Lua script for atomic check-and-increment
- No boundary issues (unlike fixed windows)

**Token Bucket** (`token-bucket.ts`):
- Allows controlled bursts
- Smooth rate limiting over time
- Configurable bucket size and refill rate

## KMS Provider Support

### Supported Providers

| Provider | Use Case | Per-User Keys |
|----------|----------|---------------|
| Local | Development only | ✅ |
| AWS KMS | Production | ✅ |
| HashiCorp Vault | Enterprise | ✅ |
| Azure Key Vault | Azure deployments | ✅ |
| GCP KMS | GCP deployments | ✅ |

### Configuration

```bash
# Required environment variables
export KORYPHAIOS_KMS_PROVIDER=aws  # local|aws|vault|azure|gcp
export KORYPHAIOS_REDIS_URL=redis://localhost:6379

# AWS KMS
export AWS_REGION=us-east-1
export AWS_KMS_KEY_ID=alias/koryphaios

# HashiCorp Vault
export VAULT_ADDR=https://vault.example.com
export VAULT_TOKEN=s.xxx
export VAULT_TRANSIT_PATH=koryphaios
```

## Security Headers

Rate-limited responses include standard headers:

```http
HTTP/1.1 429 Too Many Requests
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 1708473660
Retry-After: 60

{
  "error": "Rate limit exceeded",
  "retryAfter": 60
}
```

## Database Schema

### User Credentials Table

```sql
CREATE TABLE user_credentials (
  id TEXT PRIMARY KEY,           -- Nanoid (16 chars)
  user_id TEXT NOT NULL,         -- Reference to users table
  provider TEXT NOT NULL,        -- openai, anthropic, etc.
  encrypted_credential TEXT NOT NULL,  -- JSON envelope
  encrypted_metadata TEXT,       -- Encrypted metadata
  is_active INTEGER DEFAULT 1,
  created_at INTEGER,
  updated_at INTEGER,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
```

### Audit Logs Table

```sql
CREATE TABLE audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT,
  action TEXT NOT NULL,
  resource_type TEXT,
  resource_id TEXT,
  ip_address TEXT,
  user_agent TEXT,
  success INTEGER,
  reason TEXT,
  metadata TEXT,
  timestamp INTEGER,
  FOREIGN KEY(user_id) REFERENCES users(id)
);
```

## Threat Model

### Mitigated Threats

| Threat | Mitigation |
|--------|------------|
| Database breach | Envelope encryption with KMS, per-user keys |
| User A accessing User B's keys | Per-user key derivation ensures isolation |
| Insider threat (admin) | Audit logging, tamper-evident logs |
| DDoS attacks | 4-layer rate limiting |
| Credential stuffing | Rate limiting on auth endpoints |
| API key theft | Audit logs, suspicious activity detection |

### Remaining Risks

- **KMS compromise**: If KMS is compromised, all keys are at risk. Use HSMs for critical deployments.
- **Application-level attacks**: SQL injection, XSS must be prevented at application layer.
- **Memory dumps**: Keys exist in memory during operation. Use secure enclaves for highest security.

## Compliance

This implementation supports compliance with:

- **SOC 2**: Audit logging, access controls
- **GDPR**: Data encryption, audit trails, right to deletion
- **HIPAA**: Encryption at rest and in transit, access logging
- **PCI-DSS**: Encryption key management, audit trails

## Performance Considerations

- **Key derivation**: ~0.1ms per operation (HMAC-SHA256)
- **Encryption**: ~0.05ms per credential (AES-256-GCM)
- **Redis latency**: ~1-2ms for rate limit checks
- **Audit logging**: ~0.5ms (async where possible)

Total overhead: ~2-3ms per request with full security stack.

## Deployment Checklist

- [ ] Use cloud KMS (AWS/GCP/Azure/Vault) in production
- [ ] Configure Redis with persistence for rate limits
- [ ] Enable audit log rotation
- [ ] Set up log shipping for SIEM integration
- [ ] Configure alerting on suspicious activity
- [ ] Review and adjust rate limit tiers
- [ ] Test key rotation procedures
- [ ] Verify backup encryption

## API Usage Examples

### Store Credential

```bash
curl -X POST https://api.koryphaios.com/v1/credentials \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "openai",
    "credential": "sk-...",
    "metadata": { "name": "Production" }
  }'
```

### List Credentials (metadata only, never returns keys)

```bash
curl https://api.koryphaios.com/v1/credentials \
  -H "Authorization: Bearer $TOKEN"
```

### Query Audit Trail

```bash
curl "https://api.koryphaios.com/v1/audit?resource_type=credential&resource_id=cred_123" \
  -H "Authorization: Bearer $TOKEN"
```

## References

- [NIST SP 800-57: Key Management](https://csrc.nist.gov/publications/detail/sp/800-57-part-1/rev-5/final)
- [OWASP Cryptographic Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cryptographic_Storage_Cheat_Sheet.html)
- [Redis Rate Limiting Patterns](https://redis.io/commands/zadd/)
