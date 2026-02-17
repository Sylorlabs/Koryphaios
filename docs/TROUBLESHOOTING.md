# Troubleshooting Guide

Common issues and solutions for Koryphaios.

---

## Server Won't Start

### Symptom: Server fails to start with config error

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

## WebSocket Issues

### Symptom: Frontend can't connect to WebSocket

**Check:**
1. Server is running and WebSocket endpoint is active
2. CORS origin is allowed
3. No reverse proxy blocking WebSocket upgrade

**Debugging:**
```bash
# Test WebSocket endpoint manually
curl -i -N -H "Connection: Upgrade" -H "Upgrade: websocket" \
  http://localhost:3000/ws

# Check server logs
pm2 logs koryphaios-backend
# or
journalctl -u koryphaios-backend -f
```

**Solution:**
- Verify `ws://localhost:3000/ws` is reachable
- Check nginx/Caddy config includes WebSocket upgrade headers
- Frontend should use SSE fallback at `/api/events` if WebSocket fails

---

### Symptom: WebSocket disconnects frequently

**Possible Causes:**
1. Reverse proxy timeout too short
2. Client network issues
3. Server memory/resource limits

**Solution:**

For nginx:
```nginx
location /ws {
    proxy_read_timeout 86400;  # 24 hours
    proxy_send_timeout 86400;
    # ... other config
}
```

For Caddy (automatic handling, but check):
```caddyfile
koryphaios.example.com {
    @websocket {
        header Connection Upgrade
        header Upgrade websocket
    }
    reverse_proxy @websocket localhost:3000
}
```

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
# In PM2 ecosystem.config.js
env: {
  NODE_OPTIONS: '--max-old-space-size=2048'  // 2GB
}

# Or export directly
export NODE_OPTIONS="--max-old-space-size=2048"
```

2. Check for memory leaks:
```bash
# Monitor memory usage
pm2 monit

# Check system memory
free -h
```

3. Restart periodically if needed:
```javascript
// In PM2 config
max_memory_restart: '1G'
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

3. Implement session limits in code (future enhancement)

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

3. Restart server (it will recreate if needed)

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

# Or restart server
pm2 restart koryphaios-backend
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
top
htop

# Monitor network
iftop
nethogs

# Check file I/O
iotop
```

**Solution:**
1. Optimize session storage (move to database)
2. Add caching layer
3. Use CDN for static assets
4. Scale horizontally with load balancer

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
pm2 restart koryphaios-backend
```

---

## Logs & Debugging

### Viewing Logs

**PM2:**
```bash
# All logs
pm2 logs

# Specific app
pm2 logs koryphaios-backend

# Last 100 lines
pm2 logs --lines 100

# Follow errors only
pm2 logs --err
```

**Systemd:**
```bash
# Follow logs
journalctl -u koryphaios-backend -f

# Last 50 lines
journalctl -u koryphaios-backend -n 50

# Filter by time
journalctl -u koryphaios-backend --since "1 hour ago"
```

**Direct (development):**
```bash
# Run server directly to see all output
cd backend
bun run src/server.ts
```

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

Always include logs when asking for help:
```bash
pm2 logs koryphaios-backend --lines 100 > logs.txt
```

### System Information

```bash
# Gather system info
uname -a
bun --version
node --version
free -h
df -h
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
| Server won't start | Check `koryphaios.json`, validate port |
| WebSocket fails | Check CORS, reverse proxy config |
| Provider auth fails | Verify API key, test manually |
| High memory | Clean old sessions, restart server |
| Slow performance | Check provider API latency, resources |
| Bot not responding | Verify token, admin ID, polling enabled |

---

**Last Updated:** 2026-02-15
**Version:** 0.1.0
