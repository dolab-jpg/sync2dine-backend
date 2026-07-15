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

## Voice mode

| Env | Default | Meaning |
|-----|---------|---------|
| `VOICE_MODE` | `realtime` | OpenAI Realtime speech-to-speech (one live session, full duplex G.711) |
| `VOICE_MODE=pipeline` | — | Fallback: Whisper STT → Cyrus GPT → TTS μ-law (half duplex) |
| `REALTIME_MODEL` | `gpt-realtime` | Realtime model id (GA) |
| `REALTIME_VOICE` | `coral` | Female Realtime voice; British/Cockney accent forced in session instructions |

Realtime keeps RTP flowing both ways (helps NAT) and uses the same Cyrus brain + tools + memory as chat.

## API

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/health` | Health (`voiceMode` included) |
| POST | `/lines/register` | SIP REGISTER |
| DELETE | `/lines/{lineId}` | Unregister |
| GET | `/lines` | Status |
| POST | `/calls` | Outbound INVITE → Realtime (or pipeline) conversation |

## TradePro wiring

```
TELEPHONY_PROVIDER=soho66
SOHO66_SIP_BRIDGE_URL=http://127.0.0.1:3100
WEBHOOK_BASE_URL=http://127.0.0.1:3001
VOICE_MODE=realtime
REALTIME_MODEL=gpt-realtime
REALTIME_VOICE=coral
```

Phone line must be `purpose: aria`, then **Register all lines**. Place:

```http
POST /api/calls/outbound
{ "to": "+447576442345", "template": "lead_callback" }
```

Bridge calls TradePro:

- `POST /api/agent/realtime/session` — instructions, tools, org API key
- `POST /api/agent/realtime/tool` — Cyrus/phone tool execution
- `POST /api/agent/realtime/transcript` — persist into Call Centre + Cyrus conversation thread
