# ADR-003: Security Improvements

## Status

Accepted (2026-02-16)

## Context

The original security implementation had several critical vulnerabilities:

1. **Hardcoded Salt**: The encryption salt was hardcoded as `"koryphaios-v1-salt"`, defeating the purpose of salting
2. **Ephemeral Keys**: Without `KORY_APP_SECRET`, encryption keys were regenerated on every restart, making encrypted data unreadable
3. **Token Exposure**: Root authentication tokens were printed to stdout where they could be captured in logs
4. **Weak Command Validation**: Command blocking used simple string matching, easily bypassed
5. **CORS Fallback**: Invalid origins were silently substituted with the first allowed origin

## Decision

### Encryption Key Management

We implemented a tiered key management system:

```
Priority:
1. KORY_APP_SECRET environment variable → derive key with unique salt
2. Key file at .koryphaios/.keys → persist key across restarts
3. Fallback: Generate ephemeral key (with warning)
```

Keys are stored in a file with mode 0o600 (owner read/write only).

### Token Security

Root tokens are now:
- Written to `.koryphaios/.root-token` with restricted permissions
- NOT printed to console
- Include expiration time (24 hours)
- File path is logged, not the token itself

### Command Validation

Switched from blacklist to pattern-based validation:

```typescript
const DESTRUCTIVE_PATTERNS = [
  /\brm\s+(-[rf]+\s+|)-rf\s+\/\s*$/i,  // rm -rf /
  /\bmkfs\b/i,                          // mkfs
  /:\(\)\s*\{\s*:\|\:&\s*\}\s*;:/i,     // Fork bomb
  // ... more patterns
];
```

This catches command obfuscation attempts and more destructive patterns.

### CORS Strictness

Invalid origins now return an empty string (which browsers reject), rather than silently substituting:

```typescript
const allowedOrigin = origin && ALLOWED_ORIGINS.has(origin)
    ? origin
    : ""; // Browser will reject
```

## Consequences

### Positive

- **Key persistence**: Encrypted data survives restarts
- **Token confidentiality**: Tokens cannot be captured from logs
- **Better command filtering**: Pattern matching catches more attacks
- **Clearer security boundaries**: CORS failures are explicit

### Negative

- **Key file management**: Need to protect `.koryphaios/.keys` file
- **Token file access**: Users must read token from file, not copy from console

### Operational Changes

1. Add `.koryphaios/.keys` and `.koryphaios/.root-token` to `.gitignore`
2. Set `KORY_APP_SECRET` for production deployments
3. Restrict file permissions on `.koryphaios/` directory

## Implementation Notes

### Backward Compatibility

The decryption function handles both v1 (legacy) and v2 (current) formats:

```typescript
if (ciphertext.startsWith("v1:")) {
    return decryptV1(ciphertext); // Legacy support
}
if (!ciphertext.startsWith("v2:")) {
    return ciphertext; // Plaintext fallback
}
```

### Rate Limiter Cleanup

Added `cleanup()` method to prevent memory leaks:

```typescript
limiter.cleanup(); // Remove expired entries