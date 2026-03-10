# Troubleshooting Guide

Common issues and solutions for Koryphaios Desktop.

---

## Application Won't Start

### Symptom: App fails to start with config error

**Error:**
```
ConfigError: Invalid configuration: server.port must be a number between 1 and 65535
```

**Solution:**
1. Check `koryphaios.json` for valid port number
2. Verify JSON syntax (use a JSON validator)
3. Check environment variables: `KORYPHAIOS_PORT`, `KORYPHAIOS_HOST`

```bash
# Validate JSON
cat koryphaios.json | jq .

# Check environment
echo $KORYPHAIOS_PORT
```

---

### Symptom: "Port already in use"

**Error:**
```
Error: listen EADDRINUSE: address already in use 0.0.0.0:3000
```

**Solution:**
1. Find process using the port:
```bash
lsof -i :3000
# or
netstat -tlnp | grep :3000
```

2. Kill the process or use a different port:
```bash
kill -9 <PID>
# or
export KORYPHAIOS_PORT=3001
```

---

### Symptom: "No provider API keys found"

**Warning:**
```
No provider API keys found in environment. You'll need to configure providers via the UI.
```

**Solution:**
This is just a warning. Either:

1. Add API keys to `.env`:
```bash
echo "ANTHROPIC_API_KEY=sk-ant-..." >> .env
echo "OPENAI_API_KEY=sk-..." >> .env
```

2. Or configure via the UI after startup at Settings → Provider Hub

---

### Symptom: Environment validation failed

**Error:**
```
TELEGRAM_ADMIN_ID is required when TELEGRAM_BOT_TOKEN is set
```

**Solution:**
If using Telegram integration, both values are required:
```bash
# In .env
TELEGRAM_BOT_TOKEN=your_token
TELEGRAM_ADMIN_ID=123456789
```

Or comment out/remove Telegram config if not using it.

---

## Desktop App Issues

### Symptom: Tauri window doesn't open

**Check:**
1. Backend is running on port 3000
2. No firewall blocking localhost
3. Frontend build exists

**Solution:**
```bash
# Check if backend is running
curl http://localhost:3000/api/health

# Rebuild frontend
bun run --filter frontend build

# Run Tauri dev with verbose logging
cd desktop && cargo tauri dev --verbose
```

---

### Symptom: White/blank window

**Possible Causes:**
1. Frontend build failed
2. CSP blocking resources
3. JavaScript errors

**Solution:**
```bash
# Rebuild frontend
bun run --filter frontend build

# Check for build errors
bun run --filter frontend check

# Open DevTools in the app (Ctrl+Shift+I or Cmd+Option+I)
# Check console for errors
```

---

### Symptom: App crashes on startup

**Solution:**
```bash
# Clean and rebuild
cd desktop/src-tauri
cargo clean
cd ../..
bun run build:desktop

# Or for dev mode
bun run dev:desktop
```

---

## WebSocket Issues

### Symptom: Frontend can't connect to WebSocket

**Check:**
1. Server is running and WebSocket endpoint is active
2. No firewall blocking localhost:3000

**Debugging:**
```bash
# Test WebSocket endpoint manually
curl -i -N -H "Connection: Upgrade" -H "Upgrade: websocket" \
  http://localhost:3000/ws

# Check server logs
# Logs are in the terminal where you ran `bun run dev`
```

**Solution:**
- Verify `ws://localhost:3000/ws` is reachable
- Frontend uses SSE fallback at `/api/events` if WebSocket fails
- Check that backend is actually running: `curl http://localhost:3000/api/health`

---

### Symptom: WebSocket disconnects frequently

**Possible Causes:**
1. Backend restarting
2. Network issues
3. System sleep/wake

**Solution:**
- Check backend logs for crashes
- Restart the app: `bun run dev`
- Disable system sleep during long operations

---

## Provider Authentication

### Symptom: "Provider authentication failed"

**Error in UI:**
```
Provider 'anthropic' authentication failed: Invalid API key
```

**Solution:**
1. Verify API key format:
   - Anthropic: `sk-ant-api03-...`
   - OpenAI: `sk-...` or `sk-proj-...`
   - Gemini: Alphanumeric string

2. Test API key manually:
```bash
# Anthropic
curl https://api.anthropic.com/v1/messages \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{"model":"claude-3-5-sonnet-20241022","max_tokens":10,"messages":[{"role":"user","content":"Hi"}]}'

# OpenAI
curl https://api.openai.com/v1/models \
  -H "Authorization: Bearer $OPENAI_API_KEY"
```

3. Check for rate limits or account issues
4. Verify baseUrl in `koryphaios.json` if using custom endpoint

---

### Symptom: Provider connects but models don't work

**Check:**
1. Account has access to the model
2. Model ID is correct (e.g., `claude-sonnet-4-20250514` not `claude-4-sonnet`)
3. No billing issues

**Debugging:**
```bash
# Check provider status
curl http://localhost:3000/api/providers

# Check agent configuration
cat koryphaios.json | jq .agents
```

---

## Memory Issues

### Symptom: "JavaScript heap out of memory"

**Error:**
```
FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory
```

**Solution:**
1. Increase Node.js memory limit:
```bash
# Export before running
export NODE_OPTIONS='--max-old-space-size=2048'  // 2GB

# Then start the app
bun run dev
```

2. Check for memory leaks:
```bash
# Monitor memory usage
# On macOS: Activity Monitor
# On Linux: htop or top
# On Windows: Task Manager
```

---

### Symptom: High memory usage

**Possible Causes:**
1. Too many sessions in memory
2. Large context/messages not cleaned up
3. WebSocket connections leaking

**Solution:**
1. Clean up old sessions:
```bash
# Manual cleanup (be careful!)
rm .koryphaios/sessions/*.json
# Keep last 100 sessions or implement auto-cleanup
```

2. Monitor session count:
```bash
curl http://localhost:3000/api/sessions | jq '. | length'
```

3. Restart the app to clear memory

---

## File System Issues

### Symptom: "Permission denied" writing to .koryphaios

**Error:**
```
Error: EACCES: permission denied, open '.koryphaios/sessions/abc123.json'
```

**Solution:**
```bash
# Check permissions
ls -la .koryphaios/

# Fix ownership
chown -R $USER:$USER .koryphaios/

# Fix permissions
chmod -R 755 .koryphaios/
```

---

### Symptom: Session data corruption

**Error:**
```
Failed to parse session file: Unexpected end of JSON input
```

**Solution:**
1. Identify corrupted file:
```bash
# Find invalid JSON files
find .koryphaios/sessions -name "*.json" -exec sh -c 'jq . "$1" > /dev/null 2>&1 || echo "$1"' _ {} \;
```

2. Remove or restore:
```bash
# Move to backup
mv corrupted-file.json corrupted-file.json.bak

# Or delete if not needed
rm corrupted-file.json
```

3. Restart the app (it will recreate if needed)

---

## Build Issues

### Symptom: TypeScript compilation errors

**Error:**
```
error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'
```

**Solution:**
```bash
# Clean and rebuild
rm -rf backend/build frontend/.svelte-kit
bun install
bun run build

# Type check first
bun run typecheck
```

---

### Symptom: Tauri build fails

**Error:**
```
failed to run custom build command
```

**Solution:**
```bash
# Clean Tauri build
cd desktop/src-tauri
cargo clean

# Rebuild from project root
cd ../..
bun run build:desktop
```

---

### Symptom: Dependency conflicts

**Error:**
```
error: Dependency conflict detected
```

**Solution:**
```bash
# Clear lock file and reinstall
rm bun.lock
bun install

# Or force update
bun update
```

---

## Agent/Model Issues

### Symptom: Agent gets stuck "thinking"

**Check:**
1. Provider API is responsive
2. Model hasn't hit context limit
3. No network timeouts

**Solution:**
```bash
# Cancel via API
curl -X POST http://localhost:3000/api/agents/cancel

# Or restart the app
```

---

### Symptom: "Rate limit exceeded"

**Error from provider:**
```
RateLimitError: You exceeded your current quota
```

**Solution:**
1. Check provider dashboard for usage
2. Upgrade plan or wait for reset
3. Configure different model as fallback
4. Add retry logic with backoff (future enhancement)

---

## Performance Issues

### Symptom: Slow response times

**Check:**
1. Provider API latency
2. Database/file I/O performance
3. Network bandwidth
4. CPU/memory resources

**Debugging:**
```bash
# Check system resources
# On macOS: Activity Monitor
# On Linux: htop
# On Windows: Task Manager
```

**Solution:**
1. Optimize session storage (clean up old sessions)
2. Use faster storage (SSD)
3. Close other resource-heavy applications

---

## Telegram Bot Issues

### Symptom: Bot doesn't respond

**Check:**
1. `TELEGRAM_BOT_TOKEN` is correct
2. `TELEGRAM_ADMIN_ID` matches your user ID
3. Bot is running (polling or webhook)

**Get your Telegram user ID:**
```bash
# Send a message to your bot, then:
curl https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates
```

**Solution:**
```bash
# Verify bot token
curl https://api.telegram.org/bot<YOUR_TOKEN>/getMe

# Check polling is enabled
export TELEGRAM_POLLING=true
# Then restart the app
```

---

## Platform-Specific Issues

### macOS: "App is damaged"

**Solution:** Remove quarantine attribute

```bash
xattr -cr /Applications/Koryphaios.app
```

---

### Windows: Build fails with "linker not found"

**Solution:** Install Visual Studio Build Tools with C++ workload

```powershell
# Use winget
winget install Microsoft.VisualStudio.2022.BuildTools --override "--wait --add Microsoft.VisualStudio.Workload.VCTools"
```

---

### Linux: "error while loading shared libraries"

**Solution:** Install missing dependencies

```bash
# Check missing libraries
ldd ./koryphaios | grep "not found"

# Install WebKit (Debian/Ubuntu)
sudo apt install libwebkit2gtk-4.1-0

# Install AppImage dependencies
sudo apt install libfuse2
```

---

## Logs & Debugging

### Viewing Logs

**Development:**
```bash
# Run directly to see all output
bun run dev:backend   # Backend only
bun run dev:desktop   # Full app with Tauri
```

**Log files:**
- Backend logs: Check terminal output
- Tauri logs: Run with `RUST_LOG=debug bun run dev:desktop`

---

### Enable Debug Logging

```bash
# In .env or environment
LOG_LEVEL=debug

# Or in code temporarily
export LOG_LEVEL=trace
```

---

## Getting More Help

### Check the Logs

Always include logs when asking for help. Run the app directly to see full output:
```bash
bun run dev:desktop
```

### System Information

```bash
# Gather system info
uname -a
bun --version
node --version
rustc --version  # For Tauri
```

### Create Issue

When opening an issue, include:
1. Error message (full stack trace)
2. Steps to reproduce
3. Configuration (redact API keys!)
4. System information
5. Logs (last 50-100 lines)

---

## Quick Reference

| Issue | Quick Fix |
|-------|-----------|
| App won't start | Check `koryphaios.json`, validate port |
| White/blank window | Rebuild frontend, check DevTools console |
| WebSocket fails | Check backend is running on port 3000 |
| Provider auth fails | Verify API key, test manually |
| High memory | Clean old sessions, restart app |
| Slow performance | Check provider API latency, close other apps |
| Bot not responding | Verify token, admin ID, polling enabled |

---

**Last Updated:** 2026-03-09  
**Version:** 0.1.0
