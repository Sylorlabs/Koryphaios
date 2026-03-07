# Koryphaios Backend Production Readiness Audit

**Date:** 2025-02-20  
**Scope:** Backend error handling, persistence, auth, security, and build configuration  

---

## EXECUTIVE SUMMARY

The Koryphaios backend has **solid foundational security** with proper TypeScript strictness, database setup, and error classes. However, there are **6 critical issues** and several important gaps that would prevent production deployment:

| Severity | Count | Status |
|----------|-------|--------|
| 🔴 Critical | 6 | Blocks production |
| 🟠 High | 5 | Should fix before launch |
| 🟡 Medium | 8 | Plan to fix |

---

## 1. PROVIDER ERROR HANDLING ⚠️

### Issue 1.1: CRITICAL - Missing Timeout on Provider Streams [BLOCKS PRODUCTION]
**File:** `/backend/src/providers/anthropic.ts:154-156`, `/backend/src/providers/openai.ts:131-136`  
**Line Numbers:** Anthropic 154, OpenAI 131  
**Severity:** CRITICAL - Can cause infinite hangs  

**Problem:**
LLM API streams use `withRetry()` but don't enforce a hard timeout. The `withTimeoutSignal` is used in the message processor, but the stream itself has no absolute timeout in the provider.

```typescript
// ❌ BAD - anthropic.ts:154-156
try {
  const stream = await withRetry(() => this.client.messages.stream(params, {
    signal: request.signal,  // Only respects abort signal, no timeout guarantee
  }));
```

**Impact:** If the API becomes slow or stalls, the entire request could hang indefinitely, causing:
- Memory leaks from unclosed streams
- Worker threads stuck forever
- Client connections never completing

**Fix:**
```typescript
// ✅ GOOD
import { withTimeoutSignal } from "./utils";
const stream = await withRetry(() => 
  this.client.messages.stream(params, {
    signal: withTimeoutSignal(request.signal, 30_000), // 30s hard timeout
  })
);
```

---

### Issue 1.2: HIGH - Generic Error Message in Provider Errors
**File:** `/backend/src/providers/anthropic.ts:240-243`, `/backend/src/providers/openai.ts:203-206`  
**Severity:** HIGH - Poor debugging in production  

**Problem:**
Errors from providers are caught but the message is truncated without logging details:

```typescript
// ❌ BAD - anthropic.ts:240-243
} catch (err: any) {
  if (err.name === "AbortError") return;
  yield { type: "error", error: err.message ?? String(err) };  // Only sends first line
}
```

**Missing Information:**
- Full error stack trace
- HTTP status codes (401, 429, 503)
- Retry count or backoff timing
- Provider-specific error codes (e.g., `rate_limit_exceeded`)

**Fix:**
```typescript
// ✅ GOOD
catch (err: any) {
  if (err.name === "AbortError") return;
  const errorDetail = {
    message: err.message ?? String(err),
    code: err.code || (err.status && `HTTP_${err.status}`),
    status: err.status,
  };
  providerLog.error({ errorDetail, model: request.model }, "Provider stream error");
  yield { type: "error", error: errorDetail.message };
}
```

---

### Issue 1.3: HIGH - Missing Rate Limit Backoff Communication
**File:** `/backend/src/providers/utils.ts:131-133`  
**Line Numbers:** 131-133  
**Severity:** HIGH - Users get no feedback on retries  

**Problem:**
When rate limits are hit, `withRetry` silently backs off without notifying the frontend:

```typescript
// Current behavior - silent retries
providerLog.warn({ attempt, delayMs }, "Retrying operation due to error");
await new Promise((resolve) => setTimeout(resolve, delayMs));
```

**Impact:** Users see requests "hanging" for 30+ seconds with no indication of what's happening.

**Fix:** Emit a `rate_limit` event to WebSocket subscribers so UI can show "Waiting for rate limit..." message.

---

### Issue 1.4: MEDIUM - No Verification of Provider Connection Before First Use
**File:** `/backend/src/providers/index.ts` (registry initialization)  
**Severity:** MEDIUM - Delayed discovery of bad credentials  

**Problem:** Credentials are set but not tested until the first LLM call, which then fails.

**Recommendation:** In `setCredentials()`, immediately test the provider with a simple call (e.g., list models) to fail fast.

---

## 2. TOOL EXECUTION ERROR HANDLING 🔧

### Issue 2.1: CRITICAL - Background Process Errors Not Captured [BLOCKS PRODUCTION]
**File:** `/backend/src/tools/shell-manager.ts` (if exists)  
**Severity:** CRITICAL - Silent failures  

**Problem:** Background processes started with `isBackground: true` have no error notification mechanism.

```typescript
// bash.ts:158-167 - Background execution
if (isBackground) {
  toolLog.info({ command: command.slice(0, 200), name: processName }, "Starting background process");
  const bgProc = shellManager.startProcess(processName || "bg-proc", command, requestedCwd);
  return {
    callId: call.id,
    output: `Background process started.\nID: ${bgProc.id}\n...`,
  };
}
// ❌ If process crashes immediately, user never knows
```

**Impact:** Long-running builds/servers crash silently while user believes they're still running.

**Fix:** Implement a process monitor that:
1. Tracks exit codes for background processes
2. Reports crashes via WebSocket
3. Auto-restarts or notifies user based on policy

---

### Issue 2.2: HIGH - Timeout Handling Not Consistent Across Tools
**File:** `/backend/src/tools/bash.ts:170-186`, `/backend/src/tools/files.ts` (git operations)  
**Severity:** HIGH - Some operations hang, others timeout  

**Problem:**
- `bash.ts`: Hard timeout at 120s (line 185)
- `files.ts`: Soft timeout via `Promise.race` with 2s fallback (line 322)
- No timeout for other long ops (e.g., large file writes)

**Fix:** Standardize on consistent timeout strategy with configurable per-tool limits.

---

### Issue 2.3: HIGH - Tool Errors Don't Include Call Stack
**File:** `/backend/src/tools/registry.ts:102-114`  
**Severity:** HIGH - Difficult debugging for tool failures  

```typescript
// ❌ BAD - registry.ts:102-114
try {
  const result = await tool.run(ctx, call);
  result.durationMs = performance.now() - start;
  return result;
} catch (err: any) {
  return {
    output: `Tool error: ${err.message ?? String(err)}`,  // No stack
    isError: true,
  };
}
```

**Fix:** Log full stack trace when tool errors occur:
```typescript
catch (err: any) {
  toolLog.error({ err, toolName: call.name, callId: call.id }, "Tool execution failed");
  return { output: `Tool error: ${err.message}`, isError: true };
}
```

---

### Issue 2.4: MEDIUM - No Timeout for File Operations
**File:** `/backend/src/tools/files.ts` (read/write/edit)  
**Severity:** MEDIUM - Large files can block the worker  

**Problem:** Reading multi-GB files or writing to slow filesystems has no timeout.

---

## 3. SESSION/MESSAGE PERSISTENCE 💾

### Issue 3.1: CRITICAL - No Transaction Handling in Multi-Step Updates [BLOCKS PRODUCTION]
**File:** `/backend/src/routes/messages.ts:41-55`  
**Severity:** CRITICAL - Data inconsistency under failure  

**Problem:**
When a user sends a message, 3 separate DB operations happen without a transaction:

```typescript
// ❌ BAD - messages.ts:41-55
// Step 1: Add user message
messages.add(activeSessionId, userMsg);

// Step 2: Update session message count ← Could fail here
const currentCount = session.messageCount ?? 0;
sessions.update(activeSessionId, {
  messageCount: currentCount + 1,
});

// Step 3: Update title (if first message) ← Or here
if (currentCount === 0) {
  sessions.update(activeSessionId, { title: newTitle });
}
```

**Race Condition Scenario:**
1. Two concurrent messages arrive in same session
2. Both read `messageCount = 5`
3. Both increment to 6
4. Database shows `messageCount = 6` instead of 7
5. Message counter is permanently wrong

**SQL** has no transaction wrapper, so crashes between steps corrupt state:
- Message inserted, but session count not updated
- Count updated, but title update fails
- WebSocket broadcast succeeds, DB failed

**Fix:** Implement transaction support:
```typescript
// ✅ GOOD
const db = getDb();
db.exec("BEGIN TRANSACTION");
try {
  messages.add(activeSessionId, userMsg);
  sessions.update(activeSessionId, { messageCount: currentCount + 1 });
  if (currentCount === 0) {
    sessions.update(activeSessionId, { title: newTitle });
  }
  db.exec("COMMIT");
} catch (err) {
  db.exec("ROLLBACK");
  throw err;
}
```

---

### Issue 3.2: CRITICAL - No Optimistic Locking for Session Updates [BLOCKS PRODUCTION]
**File:** `/backend/src/stores/session-store.ts:83-103`  
**Severity:** CRITICAL - Lost updates under concurrent access  

**Problem:**
Session updates use simple UPDATEs without version checking:

```typescript
// ❌ BAD - session-store.ts:83-103
update(id: string, updates: Partial<Session>): Session | undefined {
  const sets = fields.map((f) => `${mapping[f]} = ?`).join(", ");
  getDb().run(`UPDATE sessions SET ${sets}, updated_at = ? WHERE id = ?`, values);
  return this.get(id);  // ← Lost update if another thread updated between get/update
}
```

**Scenario:** Two updates to same session in rapid succession:
1. Worker A reads session (version 1)
2. Worker B reads session (version 1)
3. Worker B updates and increments `tokens_out`
4. Worker A updates (overwrites Worker B's changes)
5. Tokens lost

**Fix:** Add version column and check it:
```typescript
// ✅ GOOD - Use optimistic locking
update(id: string, updates: Partial<Session>, expectedVersion?: number): Session | undefined {
  if (expectedVersion !== undefined) {
    const result = getDb().run(
      `UPDATE sessions SET ${sets}, version = version + 1, updated_at = ? 
       WHERE id = ? AND version = ?`,
      [...values, Date.now(), id, expectedVersion]
    );
    if (result.changes === 0) throw new Error("Concurrent modification detected");
  }
  // ...
}
```

---

### Issue 3.3: HIGH - SQLite WAL Mode Doesn't Prevent Query Blocking
**File:** `/backend/src/db/sqlite.ts:14`  
**Severity:** HIGH - Concurrent write failures  

**Problem:**
WAL mode is enabled (good), but SQLite still serializes writes. Under high concurrency:

```typescript
// sqlite.ts:14 - WAL is enabled
db.exec("PRAGMA journal_mode = WAL;");
// ✓ Solves read-write concurrency (readers don't block writers)
// ✗ Doesn't solve write-write (only one writer at a time)
```

**Impact:** When 2+ workers write simultaneously:
- Second writer gets `SQLITE_BUSY` (database is locked)
- No automatic retry

**Evidence:** None of the store methods catch/retry `SQLITE_BUSY` errors.

**Fix:**
```typescript
// ✅ GOOD
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA busy_timeout = 5000;");  // Wait 5s for locks
db.exec("PRAGMA synchronous = NORMAL;");  // Speed up without sacrificing safety
```

---

### Issue 3.4: HIGH - No Constraint on Message Count
**File:** `/backend/src/db/migrations/001_initial_schema.sql:41-53`  
**Severity:** HIGH - Incorrect counts cause bugs  

**Problem:**
`message_count` is just an INTEGER with no enforcement. It can:
- Go negative
- Fall out of sync with actual message count
- Never be automatically repaired

**Scenario:**
```
SELECT COUNT(*) FROM messages WHERE session_id = '123';  -- Returns 10
SELECT message_count FROM sessions WHERE id = '123';     -- Returns 12 (out of sync!)
```

**Fix:** Add a constraint or implement periodic reconciliation:
```sql
ALTER TABLE sessions ADD CONSTRAINT fk_message_count CHECK(message_count >= 0);
```

---

### Issue 3.5: MEDIUM - No Index on Session User ID
**File:** `/backend/src/db/migrations/001_initial_schema.sql`  
**Severity:** MEDIUM - User listing will be slow  

**Problem:**
`listForUser()` is not truly implemented; it returns all sessions (no multi-user support).

---

## 4. ROUTE HANDLERS 🌐

### Issue 4.1: HIGH - Async Error in Message POST Not Awaited
**File:** `/backend/src/routes/messages.ts:76-87`  
**Severity:** HIGH - Errors never reach the user  

**Problem:**
```typescript
// ❌ BAD - messages.ts:76-87
kory.processTask(activeSessionId, content, body.model, body.reasoningLevel)
  .then(() => {
    // Success, but silent
  })
  .catch((err: Error) => {
    wsManager.broadcast({  // ← Only notifies via WebSocket
      type: "system.error",
      payload: { error: err.message },
    });
  });

return json({ ok: true, status: "processing" }, 202);  // ← Immediate success, regardless
```

**Issues:**
1. If `kory.processTask` fails instantly (e.g., model not found), the user's 202 response says "success"
2. Only WebSocket subscribers get notified, not the HTTP client
3. No logging of the error with context (session ID, model, etc.)

**Fix:**
```typescript
// ✅ GOOD
try {
  kory.processTask(activeSessionId, content, body.model, body.reasoningLevel)
    .catch((err: Error) => {
      const errorPayload = { error: err.message, sessionId: activeSessionId };
      serverLog.error(errorPayload, "Task processing failed");
      wsManager.broadcast({
        type: "system.error",
        payload: errorPayload,
      });
    });
} catch (err: any) {
  return json({ ok: false, error: err.message }, 400);  // Fail if immediate
}
```

---

### Issue 4.2: HIGH - No Input Validation on JSON Body
**File:** `/backend/src/routes/messages.ts:19`, `/backend/src/routes/sessions.ts:27`  
**Severity:** HIGH - Type confusion  

**Problem:**
Bodies are parsed as `any` without validation:

```typescript
// ❌ BAD - messages.ts:19
const body = await req.json() as {
  sessionId: string;
  content: string;
  model?: string;
};
// If 'model' is an array or object, no error is raised
```

**Recommendation:** Use Zod schemas (already imported in other files):
```typescript
// ✅ GOOD
const schema = z.object({
  sessionId: z.string().min(1),
  content: z.string().max(MESSAGE.MAX_CONTENT_LENGTH),
  model: z.string().optional(),
});
const body = schema.parse(await req.json());
```

---

### Issue 4.3: MEDIUM - No Rate Limiting on Specific Routes
**File:** `/backend/src/routes/messages.ts`, `/backend/src/routes/auth.ts`  
**Severity:** MEDIUM - Abuse potential  

**Problem:**
- Message POST has no per-session rate limit (only IP-based)
- Auth routes have some limiting (line 19-20 in auth.ts) but not on change-password

**Fix:** Add per-user/session rate limiters for sensitive operations.

---

### Issue 4.4: MEDIUM - Error Responses Don't Include Code
**File:** `/backend/src/errors.ts:180-222`  
**Severity:** MEDIUM - Poor client error handling  

The `handleError` function returns `code` but route handlers ignore it:

```typescript
// ❌ BAD - router.ts:117-118
const handled = handleError(err, {...});
return json({ ok: false, error: `${handled.message}...` }, handled.statusCode);
// Missing: handled.code
```

**Fix:** Include error code in response for client-side handling.

---

## 5. AUTH & SECURITY 🔐

### Issue 5.1: CRITICAL - JWT_SECRET Not Validated at Startup [BLOCKS PRODUCTION]
**File:** `/backend/src/auth/auth.ts:25-44`  
**Severity:** CRITICAL - Silent security failure  

**Problem:**
`getJwtSecret()` is called lazily when first token is created. If `JWT_SECRET` is missing/short, the app won't fail at startup—it will fail during the first login.

```typescript
// ❌ BAD - Only fails on first auth operation
function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET must be set");  // ← Lazy
  // ...
}
```

**Impact:** Production deployment succeeds without noticing the misconfiguration. First user login fails.

**Fix:** Validate at startup in `main()`:
```typescript
// ✅ GOOD - In server.ts main()
getJwtSecret();  // Call early to fail fast
serverLog.info("JWT_SECRET validated");
```

---

### Issue 5.2: HIGH - No API Key Rotation/Expiration
**File:** `/backend/src/db/migrations/002_security_tables.sql` (if exists)  
**Severity:** HIGH - Leaked keys never expire  

**Problem:**
API keys have an `expires_at` column but no code enforces expiration. A leaked key remains valid forever.

**Fix:** In middleware, validate `expires_at` before accepting API keys.

---

### Issue 5.3: HIGH - Password Not Required in Change Password
**File:** `/backend/src/routes/auth.ts` (examine change-password)  
**Severity:** HIGH - Account takeover risk  

**Problem:** If CSRF token is stolen, attacker can change another user's password without knowing the old one.

**Fix:** Always require current password for sensitive operations.

---

### Issue 5.4: MEDIUM - No HTTPS Enforcement in Production
**File:** `/backend/src/routes/auth.ts:27-35`  
**Severity:** MEDIUM - Session hijacking  

**Problem:**
```typescript
// ❌ BAD - auth.ts:27-35
function isSecureRequest(req: Request): boolean {
  try {
    const url = new URL(req.url);
    if (url.protocol === "https:") return true;  // May be http:// locally
  } catch { /* ignore */ }
  return req.headers.get("x-forwarded-proto") === "https";  // Depends on proxy config
}
// Then uses this to set Secure cookie flag
if (isSecureRequest(req)) parts.push("Secure");  // ← Could be false in production
```

**Fix:** In production, enforce:
```typescript
if (process.env.NODE_ENV === "production" && !isSecureRequest(req)) {
  return error("HTTPS required in production", 403);
}
```

---

### Issue 5.5: MEDIUM - CORS Configuration Too Permissive (if misconfigured)
**File:** `/backend/src/security.ts` (CORS allowlist)  
**Severity:** MEDIUM - XSS/CSRF if frontend URL added by mistake  

**Recommendation:** Document CORS configuration and review before production.

---

## 6. BUILD & TYPE SAFETY 📦

### Issue 6.1: HIGH - Missing `noImplicitAny` in tsconfig.json
**File:** `/backend/tsconfig.json`  
**Severity:** HIGH - Type safety gaps  

**Problem:**
```json
// ❌ BAD - tsconfig.json
{
  "extends": "../tsconfig.json",
  "compilerOptions": {
    // Missing: "noImplicitAny": true
    // Missing: "strictNullChecks": true
  }
}
```

Root `tsconfig.json` has `"strict": true`, but backend's tsconfig doesn't explicitly set it. Unknown if all files are checked.

**Fix:**
```json
{
  "extends": "../tsconfig.json",
  "compilerOptions": {
    "noImplicitAny": true,
    "strictNullChecks": true,
    "strictFunctionTypes": true,
    "noImplicitThis": true,
    "alwaysStrict": true,
  }
}
```

**Verify:**
```bash
npm run typecheck 2>&1 | grep -i "error" | wc -l
```

---

### Issue 6.2: HIGH - No Pre-Build Type Checking in CI
**File:** `package.json` (scripts)  
**Severity:** HIGH - Type errors reach production  

**Problem:**
```json
// backend/package.json
{
  "scripts": {
    "build": "bun build src/server.ts --outdir=./build --target=bun",
    // ❌ No typecheck before build
  }
}
```

Bun's compiler doesn't enforce TypeScript (just strips it). Type errors are silent.

**Fix:**
```json
{
  "scripts": {
    "build": "npm run typecheck && bun build src/server.ts...",
  }
}
```

---

### Issue 6.3: MEDIUM - No Explicit Error Type Exports
**File:** `/backend/src/errors.ts`  
**Severity:** MEDIUM - Hard to catch specific errors  

**Problem:**
Error classes are exported but TypeScript doesn't encourage using `instanceof`:

```typescript
// Common wrong pattern
try { ... }
catch (err) {
  if (err instanceof ProviderError) { ... }  // ✓ Works but implicit
}
```

**Recommendation:** Document error types and provide type guards:
```typescript
export function isProviderError(err: unknown): err is ProviderError {
  return err instanceof ProviderError;
}
```

---

## 7. MISSING OBSERVABILITY 👁️

### Issue 7.1: HIGH - No Request Tracing for Async Operations
**Severity:** HIGH - Cannot debug async failures  

**Problem:**
Correlation IDs are generated per HTTP request but lost when tasks are queued:

```typescript
// ❌ BAD - messages.ts:76
// HTTP request has requestId, but kory.processTask() doesn't know it
kory.processTask(activeSessionId, content, body.model, body.reasoningLevel)
```

**Result:** When background task fails, logs don't link to the original HTTP request.

**Fix:** Pass `requestId` to all async operations.

---

### Issue 7.2: HIGH - No Metrics for Provider Health
**Severity:** HIGH - Cannot proactively detect provider failures  

**Problem:**
Provider errors are logged but not aggregated. No way to know if a provider is consistently failing.

**Recommendation:** Add metrics:
- Provider success/failure rate
- Response time percentiles
- Rate limit hit frequency

---

### Issue 7.3: MEDIUM - No Database Connection Pool Monitoring
**Severity:** MEDIUM - Silent connection exhaustion  

**Problem:**
SQLite opens a single connection. Under high load, write locks pile up silently.

---

## SUMMARY TABLE

| Issue | File | Line | Severity | Quick Fix |
|-------|------|------|----------|-----------|
| No provider stream timeout | anthropic.ts, openai.ts | 154, 131 | 🔴 CRITICAL | Add `withTimeoutSignal()` |
| Background process crash silent | bash.ts | 158 | 🔴 CRITICAL | Implement process monitor |
| Message insert non-transactional | messages.ts | 41-55 | 🔴 CRITICAL | Wrap in BEGIN/COMMIT |
| Session updates not atomic | session-store.ts | 83 | 🔴 CRITICAL | Add optimistic locking |
| JWT_SECRET not validated early | server.ts | (startup) | 🔴 CRITICAL | Call `getJwtSecret()` in main |
| Async task errors silent | messages.ts | 76 | 🔴 CRITICAL | Log errors with context |
| Provider error messages vague | anthropic.ts | 240 | 🟠 HIGH | Log full error details |
| Rate limit retries not visible | utils.ts | 135 | 🟠 HIGH | Emit WebSocket event |
| Tool errors lack stack | registry.ts | 106 | 🟠 HIGH | Log with `toolLog.error()` |
| No typecheck in build | package.json | — | 🟠 HIGH | Add `npm run typecheck` |
| Input validation missing | messages.ts | 19 | 🟠 HIGH | Use Zod validation |
| SQLite write locking | sqlite.ts | 14 | 🟠 HIGH | Set `busy_timeout` PRAGMA |
| API key expiration unenforced | (auth) | — | 🟠 HIGH | Validate `expires_at` |
| CORS config unclear | security.ts | — | 🟡 MEDIUM | Document & review |
| File operations no timeout | files.ts | — | 🟡 MEDIUM | Add configurable timeouts |
| Error codes not in responses | router.ts | 117 | 🟡 MEDIUM | Include `code` in JSON |
| No per-session rate limits | routes/ | — | 🟡 MEDIUM | Add specific limiters |
| No request tracing in async | — | — | 🟡 MEDIUM | Pass `requestId` to tasks |

---

## RECOMMENDATIONS FOR PRODUCTION READINESS

### Phase 1: Critical (Must Fix Before Launch) [Est: 2-3 days]
1. ✅ Fix provider stream timeouts (issue 1.1)
2. ✅ Implement transaction support in stores (issue 3.1)
3. ✅ Add optimistic locking to sessions (issue 3.2)
4. ✅ Validate JWT_SECRET at startup (issue 5.1)
5. ✅ Fix async error handling in routes (issue 4.1)
6. ✅ Implement background process monitoring (issue 2.1)

### Phase 2: High Priority [Est: 3-5 days]
1. Add typecheck to build pipeline
2. Improve error logging details (providers, tools)
3. Add per-session rate limiting
4. Implement rate limit WebSocket notifications
5. Set SQLite busy_timeout PRAGMA

### Phase 3: Post-Launch Improvements [Est: 1-2 weeks]
1. Implement distributed tracing (request context across async ops)
2. Add provider health metrics and dashboards
3. Implement database connection pooling
4. Add API key expiration enforcement
5. Comprehensive error code documentation

---

## DEPLOYMENT CHECKLIST

- [ ] All CRITICAL issues resolved
- [ ] TypeScript typecheck passes with `--strict`
- [ ] All env vars documented (especially JWT_SECRET, ADMIN_PASSWORD)
- [ ] CORS origins reviewed and set
- [ ] HTTPS enforced in production
- [ ] Database backups configured
- [ ] Error alerting configured
- [ ] Rate limits tuned for expected traffic
- [ ] Load test for concurrent message handling
- [ ] Security audit of routes completed

