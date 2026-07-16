#!/usr/bin/env bash
set -euo pipefail
set -a
. /etc/tradepro-api.env
set +a
KEY="${VAPI_PRIVATE_KEY:-$VAPI_API_KEY}"
PID="$VAPI_PHONE_NUMBER_ID"
AID="${VAPI_ASSISTANT_ID:-}"

for BASE in https://api.vapi.ai https://api.eu.vapi.ai; do
  echo "=== GET $BASE/phone-number/$PID ==="
  CODE=$(curl -sS -o /tmp/vapi-pn.json -w "%{http_code}" -H "Authorization: Bearer $KEY" "$BASE/phone-number/$PID" || true)
  echo "HTTP $CODE"
  python3 - <<'PY' || true
import json
try:
  d=json.load(open("/tmp/vapi-pn.json"))
except Exception as e:
  print(e); raise SystemExit
print("id", d.get("id"))
print("number", d.get("number"))
print("assistantId", d.get("assistantId"))
print("serverUrl", d.get("serverUrl"))
print("status", d.get("status"))
print("credentialId", d.get("credentialId"))
if d.get("message"): print("msg", d.get("message"))
PY
  if [ "$CODE" = "200" ] && [ -n "$AID" ]; then
    echo "=== PATCH assistantId=$AID ==="
    curl -sS -X PATCH -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
      -d "{\"assistantId\":\"$AID\"}" \
      "$BASE/phone-number/$PID" | python3 -c 'import sys,json; d=json.load(sys.stdin); print("assistantId", d.get("assistantId"), "err", d.get("message"))'
  fi
done
