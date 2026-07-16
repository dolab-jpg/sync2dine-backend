# Soho66 → Vapi REGISTER bridge

Minimal Asterisk Docker service (adapted from [sipgate/sip-bridge](https://github.com/sipgate/sip-bridge)).

- **REGISTERs** to Soho66 as the AI SIP user (`sbc.soho66.co.uk:8060`)
- Bridges inbound INVITEs to the existing Vapi phone URI (ElevenLabs Lizzie / Cynthia)
- Keeps voice quality on Vapi (same stack as outbound)
- No TradePro browser softphone required for AI answer

## Deploy (VPS)

```bash
cd /var/www/vhosts/b-diddies.com/tradepro-sip-bridge   # or this folder
bash write-env-from-tradepro.sh   # builds .env from Soho66 line + VAPI_* (never commit .env)
docker compose up -d --build
docker exec tradepro-sip-bridge asterisk -rx 'pjsip show registrations'
```

Only **one** REGISTER on that Soho66 username — log out VOIS on the same account while the bridge owns inbound.

Production live path: keep Soho66 Routing Wizard as **Ring my IP phone**. Staff human transfer: Call Centre transfer numbers → mobile.
