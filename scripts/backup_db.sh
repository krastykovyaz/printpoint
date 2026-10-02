#!/bin/bash
# Nightly backup of orders.db. sqlite3 .backup is used instead of a file copy
# because the database runs in WAL mode: recent rows live in orders.db-wal,
# so copying orders.db alone can produce an empty or stale backup.
set -euo pipefail

DB=/root/printpoint/data/orders.db
BACKUP_DIR=/root/backups
KEEP_DAYS=7

# Open the database as the user that owns it, so sqlite never leaves root-owned
# -wal/-shm files behind that the app could not write to afterwards.
OWNER=$(stat -c %U "$DB")
TMP="$(dirname "$DB")/.backup-tmp.db"

mkdir -p "$BACKUP_DIR"
runuser -u "$OWNER" -- sqlite3 "$DB" ".backup '$TMP'"
mv "$TMP" "$BACKUP_DIR/printpoint-orders-$(date +%F).db"
find "$BACKUP_DIR" -name 'printpoint-orders-*.db' -mtime "+$KEEP_DAYS" -delete
