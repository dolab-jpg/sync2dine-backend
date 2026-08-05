#!/usr/bin/env bash
set -euo pipefail
BE=/var/www/vhosts/sync2dine.io/sync2dine-backend
cd "$BE"
export PATH="/usr/bin:/bin:/opt/plesk/node/24/bin:${PATH:-}"

# Kill only the Sync2Dine API entrypoint (not this script / ssh). The command
# line may use either absolute or relative tsx paths, so also clear the API's
# dedicated port. Without this, a new process can fail EADDRINUSE while the
# health probe accidentally passes against stale code.
pkill -f "$BE/node_modules/.bin/tsx" 2>/dev/null || true
pkill -f "$BE/node_modules/tsx/dist/loader.mjs" 2>/dev/null || true

# Prefer fuser; fall back to lsof (many Plesk hosts lack psmisc/fuser).
if command -v fuser >/dev/null 2>&1; then
  fuser -k 3011/tcp 2>/dev/null || true
elif command -v lsof >/dev/null 2>&1; then
  for pid in $(lsof -tiTCP:3011 -sTCP:LISTEN 2>/dev/null || true); do
    kill -TERM "$pid" 2>/dev/null || true
  done
  sleep 1
  for pid in $(lsof -tiTCP:3011 -sTCP:LISTEN 2>/dev/null || true); do
    kill -KILL "$pid" 2>/dev/null || true
  done
fi
sleep 2

if curl -fsS --max-time 2 http://127.0.0.1:3011/health >/dev/null 2>&1; then
  echo "ERROR: port 3011 is still served by a stale process"
  exit 1
fi

NODE=/opt/plesk/node/24/bin/node
nohup "$NODE" \
  --require ./node_modules/tsx/dist/preflight.cjs \
  --import "file://$BE/node_modules/tsx/dist/loader.mjs" \
  --env-file=.env \
  server/index.ts \
  >/tmp/sync2dine-api.log 2>&1 &
echo "$!" >/tmp/sync2dine-api.pid
echo "spawned pid=$!"
# Keep the outage watchdog cron installed (idempotent).
if [[ -x "$BE/scripts/install-api-health-watchdog.sh" ]]; then
  bash "$BE/scripts/install-api-health-watchdog.sh" || true
fi

for i in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS http://127.0.0.1:3011/health >/tmp/sync2dine-health.json 2>/dev/null; then
    echo "health_ok"
    cat /tmp/sync2dine-health.json
    echo
    exit 0
  fi
  sleep 1
done
echo "health_fail"
tail -n 40 /tmp/sync2dine-api.log || true
exit 1
