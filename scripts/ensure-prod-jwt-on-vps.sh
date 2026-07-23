#!/usr/bin/env bash
set -euo pipefail
ENV=/var/www/vhosts/sync2dine.io/sync2dine-backend/.env
touch "$ENV"

ensure_kv() {
  local key="$1"
  local value="$2"
  if grep -q "^${key}=" "$ENV"; then
    sed -i "s/^${key}=.*/${key}=${value}/" "$ENV"
  else
    echo "${key}=${value}" >> "$ENV"
  fi
}

ensure_kv NODE_ENV production
ensure_kv SYNC2DINE_ENV production

NEED_SECRET=0
if ! grep -q '^JWT_SECRET=' "$ENV"; then
  NEED_SECRET=1
elif grep -q '^JWT_SECRET=$' "$ENV"; then
  NEED_SECRET=1
elif grep -Eq '^JWT_SECRET=(tradepro-dev-jwt-secret-change-in-production|sync2dine-dev-jwt-secret-change-in-production)$' "$ENV"; then
  NEED_SECRET=1
fi

if [ "$NEED_SECRET" = "1" ]; then
  SECRET="$(openssl rand -hex 32)"
  ensure_kv JWT_SECRET "$SECRET"
  echo "jwt_secret_rotated"
else
  echo "jwt_secret_present"
fi

grep -E '^(NODE_ENV|SYNC2DINE_ENV|PORT|JWT_SECRET)=' "$ENV" | sed -E 's/(JWT_SECRET=).*/\1***redacted***/'
