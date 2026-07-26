#!/bin/bash
set -euo pipefail

: "${EXTERNAL_IP:?EXTERNAL_IP required}"
: "${SOHO66_SIP_DOMAIN:=sbc.soho66.co.uk}"
: "${SOHO66_SIP_PORT:=8060}"
: "${AI_SIP_PORT:=5060}"
: "${AI_SIP_TRANSPORT:=udp}"
: "${LINES_JSON_FILE:=/opt/lines.json}"

export EXTERNAL_IP SOHO66_SIP_DOMAIN SOHO66_SIP_PORT AI_SIP_PORT AI_SIP_TRANSPORT LINES_JSON_FILE
export SOHO66_SIP_USERNAME="${SOHO66_SIP_USERNAME:-}"
export SOHO66_SIP_PASSWORD="${SOHO66_SIP_PASSWORD:-}"
export VAPI_INBOUND_USER="${VAPI_INBOUND_USER:-}"
export AI_SIP_HOST="${AI_SIP_HOST:-}"

echo "=== Sync2Dine Soho66 -> Vapi multi-REGISTER bridge ==="
echo "NAT IP: ${EXTERNAL_IP}"
if [ -s "${LINES_JSON_FILE}" ]; then
  echo "Lines file: ${LINES_JSON_FILE} ($(grep -c '"sipUsername"' "${LINES_JSON_FILE}" 2>/dev/null || echo '?') entries)"
else
  echo "Lines file: ${LINES_JSON_FILE} (missing/empty -> single-line env fallback)"
fi
echo "======================================================="

# rtp.conf from template (needs EXTERNAL_IP)
envsubst '${EXTERNAL_IP}' < /etc/asterisk/rtp.conf.tmpl > /etc/asterisk/rtp.conf
cp /opt/config/modules.conf /etc/asterisk/modules.conf

# Generate pjsip.conf + extensions.conf for every SIP line.
python3 /opt/config/generate.py

chown -R asterisk:asterisk /etc/asterisk/ || true

echo "Config written, starting Asterisk..."
exec asterisk -f -vvv
