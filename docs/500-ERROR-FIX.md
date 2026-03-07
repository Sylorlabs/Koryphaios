# 500 Error Fix - Configuration Chaos Resolved

## The Problem

The "weird 500 error" was caused by **multiple sources of truth for the server port configuration**:

| File | Port | Purpose |
|------|------|---------|
| `.env` | 3001 | Environment variable |
| `koryphaios.json` | 3002 | Main config file |
| `config/app.config.json` | 3000 | Desktop app config |

This caused:
1. Backend trying to start on port 3001 (from .env)
2. Frontend trying to connect to port 3000 (from app.config.json)
3. Port conflicts when multiple instances tried to start
4. Agents couldn't fix it because they were reading different config files

## The Solution

### 1. Unified Port Configuration

All configuration files now use **port 3000**:

- `.env`: `KORYPHAIOS_PORT=3000`
- `koryphaios.json`: `"port": 3000`
- `config/app.config.json`: `"port": 3000`

### 2. Single Source of Truth

The `config/app.config.json` is now the authoritative configuration file that both Rust (desktop) and TypeScript (backend/frontend) read from.

### 3. Better Error Handling

Added explicit port conflict detection in `backend/src/server.ts`:

```typescript
try {
  server = Bun.serve<WSClientData>({...});
} catch (err: any) {
  if (err?.code === 'EADDRINUSE' || err?.message?.includes('port')) {
    serverLog.fatal({ port: config.server.port }, 
      `Port ${config.server.port} is already in use.`);
    throw new Error(`Port ${config.server.port} is already in use.`);
  }
  throw err;
}
```

### 4. Health Check Endpoint

Added `/api/health` endpoint that returns the actual configured port:

```json
{
  "ok": true,
  "data": {
    "status": "healthy",
    "version": "1.0.0",
    "config": {
      "port": 3000,
      "host": "127.0.0.1"
    }
  }
}
```

### 5. Diagnostic Tool

Run `bun run diagnose` to check configuration consistency:

```
═══════════════════════════════════════════════════════════
  KORYPHAIOS 500 ERROR DIAGNOSTIC
═══════════════════════════════════════════════════════════

1. PORT CONFIGURATION CHECK
───────────────────────────────────────────────────────────
  ✓ .env: port 3000
  ✓ koryphaios.json: port 3000
  ✓ config/app.config.json: port 3000

2. PORT CONSISTENCY CHECK
───────────────────────────────────────────────────────────
  ✓ All configurations use port 3000 (consistent)
```

## Prevention

To prevent this issue in the future:

1. **Always use `bun run diagnose`** before starting the app
2. **Only edit `config/app.config.json`** for configuration changes
3. **The `.env` and `koryphaios.json` files** are now secondary and should match the app config

## Files Modified

- `.env` - Changed port from 3001 to 3000
- `koryphaios.json` - Changed port from 3002 to 3000
- `backend/src/server.ts` - Added port conflict error handling and health endpoint
- `scripts/diagnose-500.ts` - New diagnostic tool
- `package.json` - Added `diagnose` script
