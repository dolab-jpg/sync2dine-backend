#!/usr/bin/env bash
# Make inbound use same Cynthia+Lizzie stack as working outbound.
set -euo pipefail
set -a; . /etc/tradepro-api.env; set +a
KEY="$VAPI_PRIVATE_KEY"
BASE=https://api.vapi.ai
PID="$VAPI_PHONE_NUMBER_ID"
AID="$VAPI_ASSISTANT_ID"
VOICE="${VAPI_ELEVENLABS_VOICE_ID:-${ELEVENLABS_VOICE_ID:-EQx6HGDYjkDpcli6vorJ}}"
WEBHOOK="https://app.b-diddies.com/webhooks/vapi"

echo "Updating assistant $AID (Lizzie $VOICE) + phone $PID serverUrl=$WEBHOOK"

curl -sS -X PATCH "$BASE/assistant/$AID" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d "$(python3 - <<PY
import json, os
voice=os.environ.get("VOICE","EQx6HGDYjkDpcli6vorJ")
webhook=os.environ.get("WEBHOOK")
print(json.dumps({
  "name": "Cynthia TradePro Phone",
  "firstMessage": "Hi, Cynthia from TradePro here â€” how can I help?",
  "model": {
    "provider": "openai",
    "model": os.environ.get("VAPI_LLM_MODEL") or "gpt-4o",
    "messages": [{
      "role": "system",
      "content": (
        "You are Cynthia for TradePro UK. Speak warm British Cockney-lite English, "
        "short spoken replies. Never American. Real CRM tools arrive via webhook tools."
      ),
    }],
  },
  "voice": {
    "provider": "11labs",
    "voiceId": voice,
    "model": os.environ.get("ELEVENLABS_MODEL_ID") or "eleven_turbo_v2_5",
    "stability": 0.35,
    "similarityBoost": 0.8,
    "style": 0.45,
    "optimizeStreamingLatency": 3,
  },
  "serverUrl": webhook,
  "silenceTimeoutSeconds": 45,
  "responseDelaySeconds": 0.4,
}))
PY
)" | python3 -c 'import sys,json;d=json.load(sys.stdin); print("asst", d.get("id"), d.get("name"), (d.get("voice") or {}).get("voiceId"), d.get("message"))'

VOICE="$VOICE" WEBHOOK="$WEBHOOK" \
curl -sS -X PATCH "$BASE/phone-number/$PID" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d "{\"assistantId\":\"$AID\",\"serverUrl\":\"$WEBHOOK\"}" \
  | python3 -c 'import sys,json;d=json.load(sys.stdin); print("phone", d.get("id"), "assistantId", d.get("assistantId"), "serverUrl", d.get("serverUrl"), d.get("message"))'

# Prove signed webhook works on canonical path
SEC="$VAPI_SERVER_SECRET"
curl -sS -o /tmp/wh2.json -w "webhooks/vapi http=%{http_code}\n" -X POST \
  -H "Content-Type: application/json" \
  -H "x-vapi-secret: $SEC" \
  http://127.0.0.1:3001/webhooks/vapi \
  -d '{"message":{"type":"assistant-request","call":{"id":"probe-in","type":"inboundPhoneCall","customer":{"number":"+447700900999"}}}}'
python3 -c 'import json;d=json.load(open("/tmp/wh2.json")); a=d.get("assistant") or {}; print("probe keys", list(d.keys())[:5], "voice", (a.get("voice") or {}).get("voiceId"), "err", d.get("error"))'
