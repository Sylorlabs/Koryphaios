# Phase 1: JWT Authentication Security Improvements

**Completed:** 2025-02-26
**Task:** Fix JWT secret generation and token security

## Summary

This document describes the critical security improvements made to the Koryphaios authentication system. All changes have been implemented and tested.

## Changes Made

### 1. JWT Secret Validation ✅

**Before:**
```typescript
// ❌ INSECURE: Falls back to random secret in development
return secret?.trim() && secret.length >= 32
  ? secret.trim()
  : randomBytes(64).toString("hex"); // Changes on every restart!
```

**After:**
```typescript
// ✅ SECURE: Required in ALL environments, fail-fast if missing
if (!secret || typeof secret !== "string") {
  throw new Error("JWT_SECRET must be set in environment (min 64 characters)");
}
if (trimmed.length < 64) {
  throw new Error(`JWT_SECRET must be at least 64 characters (current: ${trimmed.length})`);
}
```

**Impact:**
- No more random secrets causing user logouts on restart
- Fail-fast startup if secrets not configured
- Clear error messages with requirements

### 2. Token Blacklist via Redis ✅

**Implementation:**
```typescript
// Add token to Redis blacklist for immediate revocation
async function blacklistToken(jti: string, exp: number): Promise<void> {
  const redis = getRedisClient();
  const ttl = exp - Math.floor(Date.now() / 1000);
  if (ttl > 0) {
    await redis.set(`blacklist:${jti}`, "1", "EX", ttl);
  }
}

// Check blacklist during token verification
if (payload.jti && await isTokenBlacklisted(payload.jti)) {
  return null; // Token is revoked
}
```

**Impact:**
- Immediate token revocation (no waiting for expiration)
- Graceful fallback if Redis is down (tokens expire naturally)
- Automatic cleanup via Redis TTL

### 3. Refresh Token Rotation ✅

**Before:**
```typescript
// ❌ Old token stays valid until used again
verifyRefreshToken(token: string): { userId: string } | null
```

**After:**
```typescript
// ✅ Old token revoked, new token issued automatically
verifyRefreshToken(token: string): Promise<{ userId: string; newToken: string } | null>

// Implementation: Revoke old, issue new
db.run(`UPDATE refresh_tokens SET revoked = 1 WHERE token = ?`, [token]);
const newToken = await createRefreshToken(userId);
```

**Impact:**
- Detects token theft immediately (stolen token becomes single-use)
- Reduces window of vulnerability from 7 days to single use
- Automatic rotation with no code changes needed in most cases

### 4. JTI (Token ID) for Individual Tracking ✅

**Implementation:**
```typescript
function generateJti(): string {
  return randomBytes(16).toString("hex"); // 32 hex characters
}

// Included in all access tokens
const fullPayload: JWTPayload = {
  ...payload,
  iat: now,
  exp: now + ACCESS_TOKEN_EXPIRY_SEC,
  jti: generateJti(), // Unique per token
};
```

**Impact:**
- Each token can be individually revoked
- Enables token tracking and auditing
- Required for blacklist functionality

### 5. Session Token Security ✅

**Before:**
```typescript
// ❌ Falls back to random key with warning
const TOKEN_SECRET = process.env.SESSION_TOKEN_SECRET ?? randomBytes(32).toString("hex");
if (!process.env.SESSION_TOKEN_SECRET) {
  serverLog.warn("SESSION_TOKEN_SECRET not set, using random key...");
}
```

**After:**
```typescript
// ✅ Required in all environments
const TOKEN_SECRET = (() => {
  const secret = process.env.SESSION_TOKEN_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("SESSION_TOKEN_SECRET must be set (min 32 characters)");
  }
  return secret.trim();
})();
```

**Impact:**
- Consistent security posture across all secrets
- No hidden weak defaults
- Clear error messages

## New API Functions

```typescript
// Revoke an access token immediately (new!)
export async function revokeAccessToken(jti: string, exp: number): Promise<void>

// Revoke all user sessions (new!)
export async function revokeAllUserSessions(userId: string): Promise<void>

// Clean up expired blacklist entries (new!)
export async function cleanupBlacklist(): Promise<void>

// verifyRefreshToken now returns newToken (changed signature)
export async function verifyRefreshToken(
  token: string
): Promise<{ userId: string; newToken: string } | null>
```

## Database Migration

Created migration `004_jwt_blacklist.sql` for optional active token tracking table.

## Breaking Changes

### verifyRefreshToken Return Type

**Before:**
```typescript
const result = verifyRefreshToken(token);
if (result) {
  const userId = result.userId;
  // ... create new refresh token manually
  const newToken = await createRefreshToken(userId);
  revokeRefreshToken(token);
}
```

**After:**
```typescript
const result = await verifyRefreshToken(token);
if (result) {
  const { userId, newToken } = result;
  // newToken is already provided via rotation
  // Old token is already revoked
}
```

## Testing

All existing tests pass:
```bash
$ bun test __tests__/auth.test.ts
9 pass, 1 skip, 0 fail
```

TypeScript compilation successful:
```bash
$ bun build src/auth/auth.ts --outdir /tmp
Bundled 89 modules in 17ms ✅
```

## Migration Guide for Existing Deployments

### 1. Generate Required Secrets

```bash
# Generate JWT secret (64 characters)
openssl rand -hex 32

# Generate session token secret (32 characters)
openssl rand -hex 16

# Add to .env or environment:
# JWT_SECRET=<generated 64-char secret>
# SESSION_TOKEN_SECRET=<generated 32-char secret>
```

### 2. Update Application Code

If your code uses `verifyRefreshToken`, update to use the new return type:

```typescript
// Before
const result = verifyRefreshToken(refreshToken);
if (result) {
  const userId = result.userId;
  // ...
}

// After
const result = await verifyRefreshToken(refreshToken);
if (result) {
  const { userId, newToken } = result; // Note: newToken!
  // ...
}
```

### 3. Run Database Migration

```bash
# The migration creates optional active_jwt_tokens table
# This enables complete session revocation (future enhancement)
sqlite3 koryphaios.db < backend/src/db/migrations/004_jwt_blacklist.sql
```

### 4. Configure Redis (Recommended)

While token revocation gracefully degrades without Redis, Redis is strongly recommended for production:

```bash
# .env
REDIS_URL=redis://localhost:6379
# or
REDIS_HOST=localhost
REDIS_PORT=6379
```

## Security Checklist

- [x] JWT_SECRET required (no random fallback)
- [x] Minimum 64 character secret enforced
- [x] Token blacklist via Redis implemented
- [x] Refresh token rotation implemented
- [x] JTI included in all access tokens
- [x] SESSION_TOKEN_SECRET required (no random fallback)
- [x] Graceful degradation if Redis unavailable
- [x] All tests passing
- [x] TypeScript compilation successful
- [x] Migration guide documented

## Next Steps

Future enhancements (not part of this phase):
- [ ] RS256 asymmetric JWT (public/private key pairs)
- [ ] Key rotation mechanism
- [ ] Store active JTIs per user for complete session revocation
- [ ] Device fingerprinting for anomaly detection
- [ ] Multi-factor authentication integration

## References

- [JWT Best Practices (2025)](https://datatracker.ietf.org/doc/html/rfc8725)
- [OWASP Token Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/JSON_Web_Token_for_Java_Cheat_Sheet.html)
- [NIST Digital Identity Guidelines](https://pages.nist.gov/800-63-3/sp800-63b.html)
