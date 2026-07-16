#!/bin/bash
set -euo pipefail

: "${EXTERNAL_IP:?EXTERNAL_IP required}"
: "${SOHO66_SIP_USERNAME:?SOHO66_SIP_USERNAME required}"
: "${SOHO66_SIP_PASSWORD:?SOHO66_SIP_PASSWORD required}"
: "${SOHO66_SIP_DOMAIN:=sbc.soho66.co.uk}"
: "${SOHO66_SIP_PORT:=8060}"
: "${AI_SIP_HOST:?AI_SIP_HOST required}"
: "${AI_SIP_PORT:=5060}"
: "${AI_SIP_TRANSPORT:=udp}"
: "${VAPI_INBOUND_USER:?VAPI_INBOUND_USER required}"

export EXTERNAL_IP SOHO66_SIP_USERNAME SOHO66_SIP_PASSWORD SOHO66_SIP_DOMAIN SOHO66_SIP_PORT
export AI_SIP_HOST AI_SIP_PORT AI_SIP_TRANSPORT VAPI_INBOUND_USER

echo "=== TradePro Soho66 â†’ Vapi SIP Bridge ==="
echo "Soho66: ${SOHO66_SIP_USERNAME}@${SOHO66_SIP_DOMAIN}:${SOHO66_SIP_PORT}"
echo "Vapi:   sip:${VAPI_INBOUND_USER}@${AI_SIP_HOST}:${AI_SIP_PORT}"
echo "NAT IP: ${EXTERNAL_IP}"
echo "========================================="

envsubst '${EXTERNAL_IP} ${SOHO66_SIP_USERNAME} ${SOHO66_SIP_PASSWORD} ${SOHO66_SIP_DOMAIN} ${SOHO66_SIP_PORT} ${AI_SIP_HOST} ${AI_SIP_PORT} ${AI_SIP_TRANSPORT} ${VAPI_INBOUND_USER}' \
  < /opt/config/pjsip.conf.tmpl \
  > /etc/asterisk/pjsip.conf

python3 - <<'PY'
import os, socket, re
path = "/etc/asterisk/pjsip.conf"
domain = os.environ["SOHO66_SIP_DOMAIN"]
ips = []
try:
    for *_, sa in socket.getaddrinfo(domain, None):
        ip = sa[0]
        if ":" not in ip and ip not in ips:
            ips.append(ip)
except Exception as e:
    print("WARN: resolve", domain, e)
text = open(path).read()
# Drop placeholder hostname match line
text = re.sub(r"(?m)^match=.*SOHO66.*\n?", "", text)
text = re.sub(r"(?m)^match=" + re.escape(domain) + r"\n?", "", text)
block = "[soho66-identify]\ntype=identify\nendpoint=soho66-endpoint\n"
for ip in ips:
    block += f"match={ip}\n"
text2 = re.sub(
    r"\[soho66-identify\][\s\S]*?(?=\n\[|\Z)",
    block + "\n",
    text,
    count=1,
)
open(path, "w").write(text2)
print("soho66 identify IPs:", ips or "(none â€” using registration line=yes)")
PY

envsubst '${EXTERNAL_IP}' \
  < /etc/asterisk/rtp.conf.tmpl \
  > /etc/asterisk/rtp.conf

envsubst '${VAPI_INBOUND_USER} ${AI_SIP_HOST}' \
  < /opt/config/extensions.conf \
  > /etc/asterisk/extensions.conf
cp /opt/config/modules.conf /etc/asterisk/modules.conf
chown -R asterisk:asterisk /etc/asterisk/ || true

echo "Config written, starting Asterisk..."
exec asterisk -f -vvv
