# Error Monitoring System

## Overview

Koryphaios now has a comprehensive error monitoring system that captures ALL frontend console errors and logs them to the backend, making debugging much easier.

## How It Works

### Frontend (`frontend/src/lib/utils/error-monitor.ts`)
- Intercepts `console.error()` and `console.warn()` calls
- Captures window `error` events
- Captures `unhandledrejection` events (unhandled promises)
- Batches errors and sends them to the backend every 1 second
- Also logs to the browser console for immediate visibility

### Backend (`/api/debug/log-error`)
- Receives error batches from the frontend
- Logs them with structured logging including:
  - Timestamp
  - Error type (error/warn/unhandledrejection)
  - Message
  - Stack trace
  - Source URL, line, and column numbers
  - User agent

## What You See

### In Browser DevTools Console:
```
[ERROR MONITOR] Initialized - all console errors will be logged
[ERROR MONITOR] TypeError: Cannot read property 'foo' of undefined { timestamp: ..., type: 'error', ... }
```

### In Backend Logs:
```json
[05:43:18] ERROR: Frontend error: TypeError: Cannot read property 'foo' of undefined
    source: "frontend"
    timestamp: "2026-02-17T05:43:18.123Z"
    type: "error"
    message: "TypeError: Cannot read property 'foo' of undefined"
    stack: "TypeError: Cannot read property 'foo'..."
```

## Viewing Errors

### Real-time Backend Logs:
```bash
# Watch the backend logs
tail -f /tmp/backend-direct.log | grep "Frontend"

# Or use the monitoring script
./scripts/monitor-errors.sh
```

### Check Specific Error Patterns:
```bash
# Find all frontend errors in last run
grep "Frontend" /tmp/backend-direct.log

# Find specific error types
grep "unhandledrejection" /tmp/backend-direct.log
```

## Current Server Status

**Backend:** ✅ Running on http://localhost:3001
- Health check: http://localhost:3001/api/health
- Auth token displayed on startup
- Logs to: `/tmp/backend-direct.log`

**Frontend:** ✅ Running on http://localhost:5174
- Vite dev server
- Error monitoring active on page load

## Testing The System

Open browser console and run:
```javascript
// This will be captured and logged to backend
console.error("Test error from console");

// This will also be captured
throw new Error("Test uncaught error");

// Unhandled promise rejection
Promise.reject("Test rejection");
```

All of these will appear in:
1. Browser DevTools console (with `[ERROR MONITOR]` prefix)
2. Backend logs (searchable with `grep "Frontend"`)

## Benefits

1. **Complete Visibility:** See ALL errors, not just the ones you check for
2. **Persistent Logs:** Backend logs are saved, browser console clears on refresh
3. **Stack Traces:** Full stack traces captured for debugging
4. **Batched:** Efficient - errors are sent in batches, not one-by-one
5. **Production Ready:** Can be enabled in production to catch real user errors

## Files

- `frontend/src/lib/utils/error-monitor.ts` - Frontend monitor
- `frontend/src/routes/+layout.svelte` - Initializes on app load
- `backend/src/server.ts` (line ~847) - Backend endpoint `/api/debug/log-error`
- `scripts/monitor-errors.sh` - Helper script to watch errors

## Next Steps

You can now:
1. Open http://localhost:5174 in your browser
2. Open DevTools console
3. Any errors will be logged to both console and backend
4. Check backend logs with: `tail -f /tmp/backend-direct.log | grep Frontend`

**Whatever you see in the console, I can now see in the backend logs!**
