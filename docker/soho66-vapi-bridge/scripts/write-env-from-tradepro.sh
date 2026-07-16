#!/usr/bin/env bash
set -euo pipefail
ROOT="${1:-/var/www/vhosts/b-diddies.com/tradepro-sip-bridge}"
API_ENV=/etc/tradepro-api.env
# Live phone line currently lives in tradepro-app data (password present)
SYNC_CANDIDATES=(
  /var/www/vhosts/b-diddies.com/tradepro-app/server/data/synced-data.json
  /var/www/vhosts/b-diddies.com/tradepro-backend/server/data/synced-data.json
)

set -a
# shellcheck disable=SC1090
. "$API_ENV"
set +a

SYNC=""
for p in "${SYNC_CANDIDATES[@]}"; do
  if [ -f "$p" ]; then SYNC="$p"; break; fi
done
[ -n "$SYNC" ] || { echo "No synced-data.json"; exit 1; }

eval "$(python3 - <<PY
import json
d=json.load(open("$SYNC"))
lines=d.get("phoneLines") or []
aria=next((l for l in lines if (l.get("purpose") or "")=="aria"), lines[0] if lines else None)
if not aria:
  raise SystemExit("no phone line in $SYNC")
print(f"USER_N={aria.get('sipUsername') or ''!r}")
print(f"PASS={aria.get('sipPassword') or ''!r}")
dom=(aria.get("sipDomain") or "sbc.soho66.co.uk").strip()
# prefer SBC for NAT (Soho66 current guidance)
if dom.startswith("sip."):
  dom="sbc.soho66.co.uk"
print(f"DOMAIN={dom!r}")
print(f"DID={(aria.get('did') or '')!r}")
PY
)"

[ -n "$USER_N" ] && [ -n "$PASS" ] || { echo "Missing SIP user/pass"; exit 1; }

CRED="${VAPI_SIP_CREDENTIAL_ID:?missing VAPI_SIP_CREDENTIAL_ID}"
REGION="${VAPI_REGION:-us}"
if [ "$REGION" = "eu" ]; then
  AI_HOST="${CRED}.sip.eu.vapi.ai"
else
  AI_HOST="${CRED}.sip.vapi.ai"
fi

DID_RAW="${DID:-${SOHO66_FROM_NUMBER:-02037453233}}"
DID_E164="$(python3 - <<PY
raw="${DID_RAW}".strip()
digits=''.join(c for c in raw if c.isdigit())
if raw.startswith('+'):
  print(''.join(raw.split())); raise SystemExit
if digits.startswith('44'):
  print('+'+digits)
elif digits.startswith('0'):
  print('+44'+digits[1:])
else:
  print('+'+digits)
PY
)"

EXTERNAL_IP="$(ip -4 route get 1.1.1.1 | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}')"

cat > "$ROOT/.env" <<EOF
EXTERNAL_IP=${EXTERNAL_IP}
SOHO66_SIP_USERNAME=${USER_N}
SOHO66_SIP_PASSWORD=${PASS}
SOHO66_SIP_DOMAIN=${DOMAIN}
SOHO66_SIP_PORT=8060
VAPI_INBOUND_USER=${DID_E164}
AI_SIP_HOST=${AI_HOST}
AI_SIP_PORT=5060
AI_SIP_TRANSPORT=udp
EOF

chmod 600 "$ROOT/.env"
echo "Wrote $ROOT/.env user=${USER_N} domain=${DOMAIN} ai=${AI_HOST} did=${DID_E164} ip=${EXTERNAL_IP}"
