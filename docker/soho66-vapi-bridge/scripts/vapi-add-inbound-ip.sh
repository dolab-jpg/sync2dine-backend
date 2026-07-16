#!/usr/bin/env bash
# Add VPS IP as inboundEnabled gateway on existing BYO SIP credential (keeps Soho66 outbound).
set -euo pipefail
set -a
. /etc/tradepro-api.env
set +a
KEY="${VAPI_PRIVATE_KEY:-$VAPI_API_KEY}"
CID="$VAPI_SIP_CREDENTIAL_ID"
BASE=https://api.vapi.ai
IP="$(ip -4 route get 1.1.1.1 | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}')"
DOMAIN="${SOHO66_SIP_DOMAIN:-sbc.soho66.co.uk}"
PORT="${SOHO66_SIP_PORT:-8060}"

# Load SIP user/pass from bridge .env
set -a
. /var/www/vhosts/b-diddies.com/tradepro-sip-bridge/.env
set +a

echo "PATCH credential $CID inbound IP=$IP + outbound $DOMAIN:$PORT"

# Get current credential for name
curl -sS -H "Authorization: Bearer $KEY" "$BASE/credential/$CID" -o /tmp/cred.json
python3 - <<PY
import json,urllib.request,os
key=os.environ["VAPI_PRIVATE_KEY"] if "VAPI_PRIVATE_KEY" in os.environ else open("/etc/tradepro-api.env").read()
PY

curl -sS -X PATCH "$BASE/credential/$CID" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d "$(python3 - <<PY
import json, os
ip="$IP"
domain="$DOMAIN"
port=int("$PORT")
user=os.environ["SOHO66_SIP_USERNAME"]
password=os.environ["SOHO66_SIP_PASSWORD"]
body={
  "gateways": [
    {
      "ip": ip,
      "inboundEnabled": True,
      "outboundEnabled": False,
      "netmask": 32,
    },
    {
      "ip": domain,
      "port": port,
      "inboundEnabled": False,
      "outboundEnabled": True,
      "outboundProtocol": "udp",
    },
  ],
  "outboundAuthenticationPlan": {
    "authUsername": user,
    "authPassword": password,
  },
  "outboundLeadingPlusEnabled": True,
}
print(json.dumps(body))
PY
)" -o /tmp/cred-patch.json

python3 - <<'PY'
import json
d=json.load(open("/tmp/cred-patch.json"))
print("id", d.get("id"))
print("msg", d.get("message") or d.get("error"))
for i,g in enumerate(d.get("gateways") or []):
  print(f"gw{i}", g)
PY
