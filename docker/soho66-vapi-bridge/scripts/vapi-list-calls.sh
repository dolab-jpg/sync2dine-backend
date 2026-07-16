#!/usr/bin/env bash
set -euo pipefail
set -a; . /etc/tradepro-api.env; set +a
KEY="${VAPI_PRIVATE_KEY}"
curl -sS -H "Authorization: Bearer $KEY" "https://api.vapi.ai/call?limit=5" -o /tmp/vapi-calls.json
python3 - <<'PY'
import json
d=json.load(open("/tmp/vapi-calls.json"))
calls=d if isinstance(d,list) else d.get("data") or d.get("calls") or []
if isinstance(d, dict) and not calls:
  print(json.dumps(d, indent=2)[:1500])
for c in (calls[:5] if isinstance(calls,list) else []):
  print("---")
  print("id", c.get("id"))
  print("status", c.get("status"), "type", c.get("type"))
  print("started", c.get("startedAt"), "ended", c.get("endedAt"))
  print("endedReason", c.get("endedReason"))
  print("assistantId", c.get("assistantId"))
  print("stereoRecordingUrl", bool(c.get("stereoRecordingUrl") or c.get("recordingUrl")))
  m=c.get("messages") or []
  print("messages", len(m))
  if m:
    print(" first", str(m[0])[:200])
PY
