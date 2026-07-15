# Vapi managed SIP (TradePro Aria)

Replaces the local `sip-bridge` RTP stack for production-quality two-way audio.

## Why

Home NAT/UPnP + custom RTP pacing causes one-way/no-reply calls. Vapi hosts SIP signalling and media; TradePro keeps Cyrus brain, tools, and memory via webhooks.

## Setup

1. Create a **Vapi EU** account → [dashboard.vapi.ai](https://dashboard.vapi.ai) (use EU org for UK numbers).
2. Copy the **Private API key** into `tradepro-backend/.env`:

```env
VAPI_PRIVATE_KEY=••••
VAPI_REGION=eu
VAPI_WEBHOOK_BASE_URL=https://YOUR_PUBLIC_HTTPS_HOST
VOICE_PROVIDER=vapi
```

3. Expose TradePro API publicly (tunnel for pilot):

```powershell
# example
cloudflared tunnel --url http://127.0.0.1:3001
# then set VAPI_WEBHOOK_BASE_URL to the https URL
```

4. Provision Soho66 trunk + DID into Vapi:

```powershell
cd tradepro-backend
npm run vapi:setup
```

This reads the Aria line from `server/data/synced-data.json` (`1005090093@sbc.soho66.co.uk:8060`) and writes `VAPI_PHONE_NUMBER_ID` / `VAPI_SIP_CREDENTIAL_ID` into `.env`.

5. Restart API (`npm run dev`). Do **not** need the local SIP bridge when `VOICE_PROVIDER=vapi`.

6. Place a call:

```http
POST /api/calls/outbound
{ "to": "+447576442345", "template": "lead_callback" }
```

## British voice

Set a female British ElevenLabs voice:

```env
ELEVENLABS_API_KEY=••••
VAPI_ELEVENLABS_VOICE_ID=••••
```

Also paste the ElevenLabs key into Vapi dashboard → Integrations if required by your org.

## Soho66 REGISTER caveat

Some Soho66 accounts expect SIP REGISTER from a softphone/UA. Vapi BYO trunks often dial with digest auth **without** REGISTER. If outbound fails with auth/401:

1. Keep your Soho66 DID
2. Add a proper BYOC trunk (Telnyx / DIDLogic)
3. Forward/port the Soho66 number, or migrate CLI
4. Re-run setup against that trunk — **do not** go back to custom RTP

Inbound later: Soho66 Routing Wizard → external SIP URI  
`sip:+442037453233@<credentialId>.sip.eu.vapi.ai`

## Rollback

```env
VOICE_PROVIDER=local_realtime
# or TELEPHONY_PROVIDER=soho66 without VOICE_PROVIDER=vapi
```

Then start `npm run sip-bridge:dev` again.

## Webhooks

`POST /webhooks/vapi` handles:

- `assistant-request` → `buildPhoneBrainPrompt()`
- `tool-calls` → existing customer/phone tools (idempotent)
- `transcript` / `end-of-call-report` → Call Centre + Cyrus thread
