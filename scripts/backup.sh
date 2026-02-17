#!/usr/bin/env bash
# Koryphaios Backup and Restore Script

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DATA_DIR="${DATA_DIR:-$PROJECT_ROOT/.koryphaios}"
BACKUP_DIR="${BACKUP_DIR:-$PROJECT_ROOT/backups}"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# ─── Backup Function ────────────────────────────────────────────────────────

backup() {
    local backup_name="${1:-koryphaios-backup-$TIMESTAMP}"
    local backup_path="$BACKUP_DIR/$backup_name.tar.gz"

    log_info "Starting backup..."

    # Create backup directory
    mkdir -p "$BACKUP_DIR"

    # Check if data directory exists
    if [ ! -d "$DATA_DIR" ]; then
        log_error "Data directory not found: $DATA_DIR"
        exit 1
    fi

    # Count sessions
    local session_count=$(find "$DATA_DIR/sessions" -name "*.json" ! -name "*.messages.json" 2>/dev/null | wc -l || echo 0)
    log_info "Found $session_count sessions"

    # Create tarball
    log_info "Creating backup: $backup_path"
    tar -czf "$backup_path" \
        -C "$PROJECT_ROOT" \
        .koryphaios \
        koryphaios.json \
        .env 2>/dev/null || true

    # Get backup size
    local backup_size=$(du -h "$backup_path" | cut -f1)
    log_info "Backup created successfully: $backup_path ($backup_size)"

    echo ""
    echo "Backup saved to: $backup_path"
}

# ─── Restore Function ───────────────────────────────────────────────────────

restore() {
    local backup_file="$1"

    if [ -z "$backup_file" ]; then
        log_error "Usage: $0 restore <backup-file.tar.gz>"
        echo ""
        echo "Available backups:"
        ls -lh "$BACKUP_DIR"/*.tar.gz 2>/dev/null || echo "  (none found)"
        exit 1
    fi

    if [ ! -f "$backup_file" ]; then
        log_error "Backup file not found: $backup_file"
        exit 1
    fi

    log_warn "This will overwrite existing data. Continue? (yes/no)"
    read -r confirm
    if [ "$confirm" != "yes" ]; then
        log_info "Restore cancelled"
        exit 0
    fi

    log_info "Starting restore from: $backup_file"

    # Create backup of current state first
    if [ -d "$DATA_DIR" ]; then
        local safety_backup="$BACKUP_DIR/pre-restore-$TIMESTAMP.tar.gz"
        log_info "Creating safety backup: $safety_backup"
        tar -czf "$safety_backup" -C "$PROJECT_ROOT" .koryphaios 2>/dev/null || true
    fi

    # Extract backup
    log_info "Extracting backup..."
    tar -xzf "$backup_file" -C "$PROJECT_ROOT"

    log_info "Restore complete!"
    log_info "Please restart the server for changes to take effect"
}

# ─── List Backups ───────────────────────────────────────────────────────────

list_backups() {
    log_info "Available backups in $BACKUP_DIR:"
    echo ""

    if [ ! -d "$BACKUP_DIR" ] || [ -z "$(ls -A "$BACKUP_DIR"/*.tar.gz 2>/dev/null)" ]; then
        echo "  (no backups found)"
        exit 0
    fi

    ls -lh "$BACKUP_DIR"/*.tar.gz
}

# ─── Main ───────────────────────────────────────────────────────────────────

case "${1:-help}" in
    backup)
        backup "$2"
        ;;
    restore)
        restore "$2"
        ;;
    list)
        list_backups
        ;;
    help|*)
        cat << EOF
Koryphaios Backup and Restore Tool

Usage:
  $0 backup [name]           Create a new backup
  $0 restore <file>          Restore from backup
  $0 list                    List available backups
  $0 help                    Show this help

Examples:
  $0 backup                      # Create backup with timestamp
  $0 backup before-upgrade       # Create named backup
  $0 restore backups/koryphaios-backup-20260215_120000.tar.gz
  $0 list                        # Show all backups

EOF
        ;;
esac
