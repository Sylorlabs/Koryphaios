# Disaster Recovery Guide

This document provides procedures for data backup and recovery for Koryphaios Desktop.

## Table of Contents

1. [Backup Strategy](#backup-strategy)
2. [Recovery Procedures](#recovery-procedures)
3. [Data Integrity](#data-integrity)
4. [Monitoring](#monitoring)

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
   - `.koryphaios/universal/` - Universal memory

4. **Git State**
   - `.koryphaios/git/` - Git integration state

### Backup Schedule

| Data Type | Frequency | Retention |
|-----------|-----------|-----------|
| SQLite Database | Every session | 30 days |
| Configuration | On change | 90 days |
| Session Memory | Hourly | 7 days |
| Full Backup | Weekly | 90 days |

### Automated Backup Script

```bash
#!/bin/bash
# backup.sh - Automated backup script for Koryphaios Desktop

BACKUP_DIR="$HOME/.koryphaios/backups"
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
cp -r "$DATA_DIR/universal" "$BACKUP_DIR/$DATE/" 2>/dev/null || true

# Compress backup
tar -czf "$BACKUP_DIR/koryphaios_$DATE.tar.gz" -C "$BACKUP_DIR" "$DATE"
rm -rf "$BACKUP_DIR/$DATE"

# Clean old backups (keep last 30 days)
find "$BACKUP_DIR" -name "koryphaios_*.tar.gz" -mtime +30 -delete

echo "Backup completed: koryphaios_$DATE.tar.gz"
```

### Cloud Storage Integration (Optional)

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
# Close Koryphaios app first

# Restore database
cp /path/to/backup/koryphaios_20240101_120000.tar.gz /tmp/
cd /tmp
tar -xzf koryphaios_20240101_120000.tar.gz
cp koryphaios_20240101_120000/koryphaios.db ~/.koryphaios/
cp koryphaios_20240101_120000/koryphaios.db-wal ~/.koryphaios/ 2>/dev/null || true

# Restart Koryphaios
```

#### WAL Recovery
```bash
# If database is corrupted, recover from WAL
sqlite3 ~/.koryphaios/koryphaios.db "PRAGMA wal_checkpoint(TRUNCATE);"
```

### Configuration Recovery

```bash
# Restore configuration
cp /path/to/backup/koryphaios.json ./koryphaios.json
cp /path/to/backup/.env ./.env

# Verify configuration
bun run check
```

### Session Recovery

```bash
# Restore session memory
cp -r /path/to/backup/memory ~/.koryphaios/
cp -r /path/to/backup/sessions ~/.koryphaios/
cp -r /path/to/backup/universal ~/.koryphaios/
```

### Complete Recovery

```bash
#!/bin/bash
# restore.sh - Complete restore for Koryphaios Desktop

BACKUP_FILE=$1

if [ -z "$BACKUP_FILE" ]; then
  echo "Usage: ./restore.sh <backup_file.tar.gz>"
  exit 1
fi

# Close Koryphaios first

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
cp -r "$TEMP_DIR"/*/universal ~/.koryphaios/ 2>/dev/null || true

# Clean up
rm -rf "$TEMP_DIR"

# Restart Koryphaios
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

## Monitoring

### Health Check

```typescript
// backend/src/routes/health.ts
import { Hono } from "hono";
import { getDb } from "../db/sqlite";

const app = new Hono();

app.get("/health", async (c) => {
  const checks = {
    database: false,
    diskSpace: false,
  };

  // Check database
  try {
    getDb().prepare("SELECT 1").get();
    checks.database = true;
  } catch (error) {
    // Database check failed
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

### Log Files

Koryphaios logs are stored in:
- **macOS**: `~/Library/Logs/Koryphaios/`
- **Windows**: `%APPDATA%\Koryphaios\logs\`
- **Linux**: `~/.config/Koryphaios/logs/`

---

## Testing Recovery Procedures

### Regular Testing Schedule

| Test Type | Frequency | Notes |
|-----------|-----------|-------|
| Backup Verification | Weekly | Verify backup files are created |
| Database Restore Test | Monthly | Test restoring from backup |
| Full Recovery | Quarterly | Complete app recovery test |

### Test Checklist

- [ ] Verify backup files are created
- [ ] Test backup file integrity
- [ ] Restore database from backup
- [ ] Verify configuration restoration
- [ ] Test session data recovery
- [ ] Verify app starts correctly
- [ ] Run health checks
- [ ] Document any issues found
- [ ] Update recovery procedures if needed

---

## Related Documentation

- [BUILD.md](../BUILD.md) - Building the desktop app
- [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) - Common issues
- [desktop/README.md](../desktop/README.md) - Desktop app details
