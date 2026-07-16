#!/usr/bin/env bash
set -euo pipefail
set -a; . /etc/tradepro-api.env; set +a
KEY="$VAPI_PRIVATE_KEY"
AID="$VAPI_ASSISTANT_ID"
VOICE="${VAPI_ELEVENLABS_VOICE_ID:-EQx6HGDYjkDpcli6vorJ}"
curl -sS -X PATCH "https://api.vapi.ai/assistant/$AID" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d "$(python3 - <<'PY'
import json, os
print(json.dumps({
  "name": "Cynthia Builder Diddies Phone",
  "firstMessage": "Hi, Cynthia from Builder Diddies here â€” how can I help?",
  "model": {
    "provider": "openai",
    "model": os.environ.get("VAPI_LLM_MODEL") or "gpt-4o",
    "messages": [{
      "role": "system",
      "content": (
        "You are Cynthia for Builder Diddies (UK bathroom / construction). "
        "Never say TradePro on the phone unless the caller does. "
        "Speak warm British Cockney-lite English, short spoken replies. Never American."
      ),
    }],
  },
  "voice": {
    "provider": "11labs",
    "voiceId": os.environ.get("VOICE", "EQx6HGDYjkDpcli6vorJ"),
    "model": os.environ.get("ELEVENLABS_MODEL_ID") or "eleven_turbo_v2_5",
    "stability": 0.35,
    "similarityBoost": 0.8,
    "style": 0.45,
    "optimizeStreamingLatency": 3,
  },
  "serverUrl": "https://app.b-diddies.com/webhooks/vapi",
}))
PY
)" | python3 -c 'import sys,json;d=json.load(sys.stdin); print(d.get("name"), (d.get("voice") or {}).get("voiceId"), d.get("firstMessage"), d.get("message"))'
