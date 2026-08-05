#!/usr/bin/env bash
# Idempotently install a 1-minute cron entry for api-health-watchdog.sh
set -euo pipefail

BE="${SYNC2DINE_BACKEND_DIR:-/var/www/vhosts/sync2dine.io/sync2dine-backend}"
WATCH="$BE/scripts/api-health-watchdog.sh"
MARKER="sync2dine-api-health-watchdog"

chmod +x "$WATCH" "$BE/scripts/restart-sync2dine-api.sh" 2>/dev/null || true

line="* * * * * SYNC2DINE_BACKEND_DIR=$BE /bin/bash $WATCH >>/tmp/sync2dine-api-watchdog.log 2>&1"

if command -v crontab >/dev/null 2>&1; then
  existing=$(crontab -l 2>/dev/null || true)
  filtered=$(printf '%s\n' "$existing" | grep -v "$MARKER" | grep -v "api-health-watchdog.sh" || true)
  printf '%s\n%s # %s\n' "$filtered" "$line" "$MARKER" | crontab -
  echo "watchdog_cron_installed"
else
  echo "WARNING: crontab not available — install manually: $line"
  exit 0
fi
