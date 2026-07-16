#!/usr/bin/env bash
set -euo pipefail
set -a; . /etc/tradepro-api.env; set +a
ID="${1:-019f6831-1ea3-7668-980d-7d62e212830f}"
curl -sS -H "Authorization: Bearer $VAPI_PRIVATE_KEY" "https://api.vapi.ai/call/$ID" | python3 -c '
import sys,json
d=json.load(sys.stdin)
for k in ("id","status","type","endedReason","assistantId","phoneNumberId"):
  print(k, d.get(k))
# dump error-ish fields
for k,v in d.items():
  if "error" in k.lower() or "reason" in k.lower() or "fail" in k.lower():
    print(k, v)
print("artifactKeys", list((d.get("artifact") or {}).keys())[:20])
'
# local agent active?
curl -sS -o /tmp/agent.json -w "agent_http=%{http_code}\n" http://127.0.0.1:3001/api/agent/settings || true
python3 -c 'import json;d=json.load(open("/tmp/agent.json")); print("isActive", d.get("isActive"), d)' 2>/dev/null || cat /tmp/agent.json | head -c 400
# probe webhook
curl -sS -o /tmp/wh.json -w "wh=%{http_code}\n" -X POST http://127.0.0.1:3001/api/vapi/webhook \
  -H "Content-Type: application/json" \
  -d '{"message":{"type":"assistant-request","call":{"id":"test","type":"inboundPhoneCall","customer":{"number":"+447576442345"}}}}'
head -c 500 /tmp/wh.json; echo
