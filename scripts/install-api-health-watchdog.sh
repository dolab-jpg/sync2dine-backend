#!/usr/bin/env bash
# Idempotently install cron entries for api-health-watchdog.sh and sip-reg-watchdog.sh
set -euo pipefail

BE="${SYNC2DINE_BACKEND_DIR:-/var/www/vhosts/sync2dine.io/sync2dine-backend}"
API_WATCH="$BE/scripts/api-health-watchdog.sh"
SIP_WATCH="$BE/scripts/sip-reg-watchdog.sh"
API_MARKER="sync2dine-api-health-watchdog"
SIP_MARKER="sync2dine-sip-reg-watchdog"

chmod +x "$API_WATCH" "$SIP_WATCH" "$BE/scripts/restart-sync2dine-api.sh" 2>/dev/null || true

api_line="* * * * * SYNC2DINE_BACKEND_DIR=$BE /bin/bash $API_WATCH >>/tmp/sync2dine-api-watchdog.log 2>&1"
sip_line="*/2 * * * * SYNC2DINE_BACKEND_DIR=$BE /bin/bash $SIP_WATCH >>/tmp/sync2dine-sip-watchdog.log 2>&1"

if command -v crontab >/dev/null 2>&1; then
  existing=$(crontab -l 2>/dev/null || true)
  filtered=$(printf '%s\n' "$existing" | grep -v "$API_MARKER" | grep -v "$SIP_MARKER" | grep -v "api-health-watchdog.sh" | grep -v "sip-reg-watchdog.sh" || true)
  printf '%s\n%s # %s\n%s # %s\n' "$filtered" "$api_line" "$API_MARKER" "$sip_line" "$SIP_MARKER" | crontab -
  echo "watchdog_cron_installed api+sip"
else
  echo "WARNING: crontab not available — install manually:"
  echo "  $api_line # $API_MARKER"
  echo "  $sip_line # $SIP_MARKER"
  exit 0
fi
