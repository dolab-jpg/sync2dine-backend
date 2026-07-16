#!/usr/bin/env bash
# Clear static assistantId so inbound uses serverUrl assistant-request (same as working outbound).
set -euo pipefail
set -a; . /etc/tradepro-api.env; set +a
KEY="$VAPI_PRIVATE_KEY"
PID="$VAPI_PHONE_NUMBER_ID"
BASE=https://api.vapi.ai
curl -sS -X PATCH "$BASE/phone-number/$PID" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"assistantId":null}' | python3 -c 'import sys,json;d=json.load(sys.stdin); print("assistantId", d.get("assistantId"), "serverUrl", d.get("serverUrl"), "msg", d.get("message"))'
