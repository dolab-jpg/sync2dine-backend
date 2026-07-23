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

# crypto.ts must NOT use JWT_SECRET. Before any JWT rotation, pin ORG_ENCRYPTION_KEY
# to the material currently used for AES (explicit key, else current JWT, else known-dev).
if ! grep -q '^ORG_ENCRYPTION_KEY=' "$ENV" || grep -q '^ORG_ENCRYPTION_KEY=$' "$ENV"; then
  CURRENT_JWT="$(grep '^JWT_SECRET=' "$ENV" 2>/dev/null | head -1 | cut -d= -f2- || true)"
  if [ -n "${CURRENT_JWT}" ]; then
    ensure_kv ORG_ENCRYPTION_KEY "$CURRENT_JWT"
    echo "org_encryption_key_pinned_from_previous_jwt"
  else
    ensure_kv ORG_ENCRYPTION_KEY "tradepro-dev-encryption-key-change-in-production"
    echo "org_encryption_key_pinned_to_legacy_dev_fallback"
  fi
else
  echo "org_encryption_key_present"
fi

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
