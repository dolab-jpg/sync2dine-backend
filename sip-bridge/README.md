# TradePro Soho66 SIP bridge

Minimal REST + SIP bridge expected by `server/telephony/lineRegistry.ts` and `soho66Adapter.ts`.

## Run

```powershell
cd tradepro-backend
# CRITICAL: use your public WAN IP so Soho can send return RTP (not LAN 192.168.x).
# Also forward UDP 10000-10200 + 50670 on the router to this PC if replies stay silent.
$env:SIP_BRIDGE_PUBLIC_IP = "auto"   # or pin e.g. "92.26.87.25"
$env:SIP_BRIDGE_RTP_PORT_BASE = "10000"
node --env-file=.env sip-bridge/server.js
```

HTTP `:3100` — SIP UDP `:50670` (override with `SIP_BRIDGE_PORT` / `SIP_BRIDGE_SIP_PORT`).

## API

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/health` | Health |
| POST | `/lines/register` | SIP REGISTER |
| DELETE | `/lines/{lineId}` | Unregister |
| GET | `/lines` | Status |
| POST | `/calls` | Outbound INVITE → webhook → play μ-law TTS over RTP |

## TradePro wiring

```
TELEPHONY_PROVIDER=soho66
SOHO66_SIP_BRIDGE_URL=http://127.0.0.1:3100
WEBHOOK_BASE_URL=http://127.0.0.1:3001
```

Phone line must be `purpose: aria`, then **Register all lines**. Place:

```http
POST /api/calls/outbound
{ "to": "+447576442345", "template": "lead_callback" }
```

v1 plays the greeting only (no ASR gather yet).
