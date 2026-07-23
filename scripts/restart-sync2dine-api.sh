#!/usr/bin/env bash
set -euo pipefail
BE=/var/www/vhosts/sync2dine.io/sync2dine-backend
cd "$BE"

# Kill only the Sync2Dine API entrypoint (not this script / ssh)
pkill -f "$BE/node_modules/.bin/tsx" 2>/dev/null || true
pkill -f "$BE/node_modules/tsx/dist/loader.mjs" 2>/dev/null || true
sleep 2

NODE=/opt/plesk/node/24/bin/node
export PATH="/opt/plesk/node/24/bin:$PATH"
nohup "$NODE" \
  --require ./node_modules/tsx/dist/preflight.cjs \
  --import "file://$BE/node_modules/tsx/dist/loader.mjs" \
  --env-file=.env \
  server/index.ts \
  >/tmp/sync2dine-api.log 2>&1 &
echo "spawned pid=$!"
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
