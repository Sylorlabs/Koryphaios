# Disaster Recovery Guide

This document provides comprehensive procedures for disaster recovery and business continuity for Koryphaios.

## Table of Contents

1. [Backup Strategy](#backup-strategy)
2. [Recovery Procedures](#recovery-procedures)
3. [Data Integrity](#data-integrity)
4. [High Availability Setup](#high-availability-setup)
5. [Monitoring and Alerting](#monitoring-and-alerting)
6. [Testing Recovery Procedures](#testing-recovery-procedures)

---

## Backup Strategy

### What to Backup

1. **Database Files**
   - SQLite database: `.koryphaios/koryphaios.db`
   - WAL files: `.koryphaios/koryphaios.db-wal`, `.koryphaios/koryphaios.db-shm`

2. **Configuration Files**
   - `koryphaios.json` - Main configuration
   - `.env` - Environment variables (encrypted API keys)

3. **Session Data**
   - `.koryphaios/memory/` - Agent memory and snapshots
   - `.koryphaios/sessions/` - Session backups (if enabled)

4. **Git State**
   - `.koryphaios/git/` - Git integration state

### Backup Schedule

| Data Type | Frequency | Retention |
|-----------|-----------|-----------|
| SQLite Database | Every 5 minutes | 30 days |
| Configuration | On change | 90 days |
| Session Memory | Hourly | 7 days |
| Full Backup | Daily | 90 days |

### Automated Backup Script

```bash
#!/bin/bash
# backup.sh - Automated backup script

BACKUP_DIR="/backups/koryphaios"
DATE=$(date +%Y%m%d_%H%M%S)
DATA_DIR=".koryphaios"

# Create backup directory
mkdir -p "$BACKUP_DIR/$DATE"

# Backup SQLite database (with WAL checkpoint)
sqlite3 "$DATA_DIR/koryphaios.db" "PRAGMA wal_checkpoint(TRUNCATE);"
cp "$DATA_DIR/koryphaios.db" "$BACKUP_DIR/$DATE/"
cp "$DATA_DIR/koryphaios.db-wal" "$BACKUP_DIR/$DATE/" 2>/dev/null || true

# Backup configuration
cp koryphaios.json "$BACKUP_DIR/$DATE/"
cp .env "$BACKUP_DIR/$DATE/"

# Backup memory and sessions
cp -r "$DATA_DIR/memory" "$BACKUP_DIR/$DATE/" 2>/dev/null || true
cp -r "$DATA_DIR/sessions" "$BACKUP_DIR/$DATE/" 2>/dev/null || true

# Compress backup
tar -czf "$BACKUP_DIR/koryphaios_$DATE.tar.gz" -C "$BACKUP_DIR" "$DATE"
rm -rf "$BACKUP_DIR/$DATE"

# Clean old backups (keep last 30 days)
find "$BACKUP_DIR" -name "koryphaios_*.tar.gz" -mtime +30 -delete

echo "Backup completed: koryphaios_$DATE.tar.gz"
```

### Cloud Storage Integration

#### AWS S3
```bash
# Upload backup to S3
aws s3 cp "$BACKUP_DIR/koryphaios_$DATE.tar.gz" \
  s3://your-bucket/koryphaios/backups/
```

#### Google Cloud Storage
```bash
# Upload backup to GCS
gsutil cp "$BACKUP_DIR/koryphaios_$DATE.tar.gz" \
  gs://your-bucket/koryphaios/backups/
```

---

## Recovery Procedures

### Database Recovery

#### From Backup
```bash
# Stop the server
bun run stop

# Restore database
cp /backups/koryphaios/koryphaios_20240101_120000.tar.gz /tmp/
cd /tmp
tar -xzf koryphaios_20240101_120000.tar.gz
cp koryphaios_20240101_120000/koryphaios.db ~/.koryphaios/
cp koryphaios_20240101_120000/koryphaios.db-wal ~/.koryphaios/ 2>/dev/null || true

# Restart server
bun run dev
```

#### WAL Recovery
```bash
# If database is corrupted, recover from WAL
sqlite3 ~/.koryphaios/koryphaios.db "PRAGMA wal_checkpoint(TRUNCATE);"
```

### Configuration Recovery

```bash
# Restore configuration
cp /backups/koryphaios/latest/koryphaios.json ./koryphaios.json
cp /backups/koryphaios/latest/.env ./.env

# Verify configuration
bun run check
```

### Session Recovery

```bash
# Restore session memory
cp -r /backups/koryphaios/latest/memory ~/.koryphaios/
cp -r /backups/koryphaios/latest/sessions ~/.koryphaios/
```

### Complete System Recovery

```bash
#!/bin/bash
# restore.sh - Complete system restore

BACKUP_FILE=$1

if [ -z "$BACKUP_FILE" ]; then
  echo "Usage: ./restore.sh <backup_file.tar.gz>"
  exit 1
fi

# Stop all services
bun run stop || true
docker-compose down || true

# Extract backup
TEMP_DIR=$(mktemp -d)
tar -xzf "$BACKUP_FILE" -C "$TEMP_DIR"

# Restore files
cp "$TEMP_DIR"/*/koryphaios.db ~/.koryphaios/
cp "$TEMP_DIR"/*/koryphaios.db-wal ~/.koryphaios/ 2>/dev/null || true
cp "$TEMP_DIR"/*/koryphaios.json ./koryphaios.json
cp "$TEMP_DIR"/*/.env ./.env
cp -r "$TEMP_DIR"/*/memory ~/.koryphaios/ 2>/dev/null || true
cp -r "$TEMP_DIR"/*/sessions ~/.koryphaios/ 2>/dev/null || true

# Clean up
rm -rf "$TEMP_DIR"

# Restart services
bun run dev

echo "Restore completed successfully"
```

---

## Data Integrity

### Database Integrity Checks

```bash
# Run integrity check
sqlite3 ~/.koryphaios/koryphaios.db "PRAGMA integrity_check;"

# Check for foreign key violations
sqlite3 ~/.koryphaios/koryphaios.db "PRAGMA foreign_key_check;"

# Verify database
sqlite3 ~/.koryphaios/koryphaios.db "PRAGMA quick_check;"
```

### Automated Integrity Monitoring

```typescript
// backend/src/monitoring/integrity-check.ts
import { getDb } from "../db/sqlite";
import { serverLog } from "../logger";

export async function runIntegrityCheck(): Promise<boolean> {
  const db = getDb();
  
  try {
    const result = db.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
    
    if (result.integrity_check === "ok") {
      serverLog.info("Database integrity check passed");
      return true;
    } else {
      serverLog.error({ result }, "Database integrity check failed");
      return false;
    }
  } catch (error) {
    serverLog.error({ error }, "Failed to run integrity check");
    return false;
  }
}

export async function checkDatabaseSize(): Promise<void> {
  const db = getDb();
  
  const result = db.prepare(`
    SELECT page_count * page_size as size
    FROM pragma_page_count(), pragma_page_size()
  `).get() as { size: number };
  
  const sizeMB = result.size / (1024 * 1024);
  serverLog.info({ sizeMB }, "Database size");
  
  if (sizeMB > 1000) {
    serverLog.warn({ sizeMB }, "Database size exceeds 1GB, consider vacuuming");
  }
}

export async function vacuumDatabase(): Promise<void> {
  const db = getDb();
  serverLog.info("Starting database vacuum");
  
  const start = Date.now();
  db.exec("VACUUM;");
  const duration = Date.now() - start;
  
  serverLog.info({ duration }, "Database vacuum completed");
}
```

### Data Validation

```typescript
// Validate session data
export async function validateSessions(): Promise<number> {
  const db = getDb();
  
  const orphanedMessages = db.prepare(`
    SELECT COUNT(*) as count
    FROM messages m
    LEFT JOIN sessions s ON m.session_id = s.id
    WHERE s.id IS NULL
  `).get() as { count: number };
  
  if (orphanedMessages.count > 0) {
    serverLog.warn({ count: orphanedMessages.count }, "Found orphaned messages");
    
    // Clean up orphaned messages
    db.prepare(`
      DELETE FROM messages
      WHERE session_id NOT IN (SELECT id FROM sessions)
    `).run();
  }
  
  return orphanedMessages.count;
}
```

---

## High Availability Setup

### Redis Cluster for Distributed State

```yaml
# docker-compose.yml with Redis
version: '3.8'

services:
  koryphaios:
    image: koryphaios:latest
    environment:
      - REDIS_ENABLED=true
      - REDIS_HOST=redis
      - REDIS_PORT=6379
    depends_on:
      - redis
    restart: unless-stopped

  redis:
    image: redis:7-alpine
    command: redis-server --appendonly yes --requirepass ${REDIS_PASSWORD}
    volumes:
      - redis_data:/data
    restart: unless-stopped

  redis-sentinel:
    image: redis:7-alpine
    command: redis-sentinel /etc/redis/sentinel.conf
    volumes:
      - ./redis/sentinel.conf:/etc/redis/sentinel.conf
    depends_on:
      - redis
    restart: unless-stopped

volumes:
  redis_data:
```

### Load Balancer Configuration

```nginx
# nginx.conf - Load balancer configuration
upstream koryphaios_backend {
    least_conn;
    server koryphaios-1:3000 max_fails=3 fail_timeout=30s;
    server koryphaios-2:3000 max_fails=3 fail_timeout=30s;
    server koryphaios-3:3000 max_fails=3 fail_timeout=30s;
}

server {
    listen 80;
    server_name koryphaios.example.com;

    location / {
        proxy_pass http://koryphaios_backend;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        
        # WebSocket timeout
        proxy_read_timeout 86400;
    }
}
```

### Database Replication

For production, consider migrating from SQLite to PostgreSQL with replication:

```typescript
// Migration to PostgreSQL
import { Pool } from 'pg';

const pool = new Pool({
  host: process.env.PG_HOST,
  port: parseInt(process.env.PG_PORT || '5432'),
  database: process.env.PG_DATABASE,
  user: process.env.PG_USER,
  password: process.env.PG_PASSWORD,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});
```

---

## Monitoring and Alerting

### Health Check Endpoints

```typescript
// backend/src/routes/health.ts
import { Hono } from "hono";
import { getDb } from "../db/sqlite";
import { getRedis } from "../state/redis-client";

const app = new Hono();

app.get("/health", async (c) => {
  const checks = {
    database: false,
    redis: false,
    providers: false,
    diskSpace: false,
  };

  // Check database
  try {
    getDb().prepare("SELECT 1").get();
    checks.database = true;
  } catch (error) {
    // Database check failed
  }

  // Check Redis
  try {
    const redis = getRedis();
    if (redis) {
      await redis.ping();
      checks.redis = true;
    }
  } catch (error) {
    // Redis check failed
  }

  // Check disk space
  const stats = await import('fs').then(fs => fs.promises.statfs('.koryphaios'));
  const freeSpacePercent = (stats.bfree / stats.blocks) * 100;
  checks.diskSpace = freeSpacePercent > 10;

  const allHealthy = Object.values(checks).every(Boolean);
  
  return c.json({
    status: allHealthy ? "healthy" : "degraded",
    checks,
    timestamp: new Date().toISOString(),
  }, allHealthy ? 200 : 503);
});

export default app;
```

### Alerting Rules

```yaml
# prometheus/alerts.yml
groups:
  - name: koryphaios
    interval: 30s
    rules:
      - alert: HighErrorRate
        expr: rate(http_requests_total{status=~"5.."}[5m]) > 0.05
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "High error rate detected"
          description: "Error rate is {{ $value }} errors/sec"

      - alert: DatabaseConnectionFailed
        expr: koryphaios_database_up == 0
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "Database connection failed"

      - alert: RedisConnectionFailed
        expr: koryphaios_redis_up == 0
        for: 1m
        labels:
          severity: warning
        annotations:
          summary: "Redis connection failed"

      - alert: DiskSpaceLow
        expr: koryphaios_disk_free_percent < 10
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Disk space is low"
```

---

## Testing Recovery Procedures

### Regular Testing Schedule

| Test Type | Frequency | Owner |
|-----------|-----------|-------|
| Backup Verification | Daily | Automated |
| Database Restore Test | Weekly | DevOps |
| Full Disaster Recovery | Monthly | DevOps |
| Failover Test | Quarterly | DevOps |

### Test Checklist

- [ ] Verify backup files are created
- [ ] Test backup file integrity
- [ ] Restore database from backup
- [ ] Verify configuration restoration
- [ ] Test session data recovery
- [ ] Verify all services start correctly
- [ ] Run health checks
- [ ] Test with sample requests
- [ ] Document any issues found
- [ ] Update recovery procedures if needed

### Test Results Template

```markdown
# Disaster Recovery Test - [Date]

## Test Summary
- **Date:** [Date]
- **Tester:** [Name]
- **Test Type:** [Backup/Database/Full]
- **Result:** [Pass/Fail]

## Test Steps
1. [Step 1]
2. [Step 2]
...

## Issues Found
- [Issue 1]
- [Issue 2]

## Recommendations
- [Recommendation 1]
- [Recommendation 2]

## Next Test Date
[Date]
```

---

## Emergency Contacts

| Role | Name | Email | Phone |
|------|------|-------|-------|
| Primary DevOps | | | |
| Secondary DevOps | | | |
| Database Admin | | | |
| System Admin | | | |

---

## Related Documentation

- [Deployment Guide](./DEPLOYMENT.md)
- [Architecture](./ARCHITECTURE.md)
- [Troubleshooting](./TROUBLESHOOTING.md)
