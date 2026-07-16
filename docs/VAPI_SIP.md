# Vapi managed SIP (Cynthia phone)

Production phone AI path: Soho66 SIP ↔ Vapi (media) ↔ Builder Diddies webhooks ↔ Cynthia brain, tools, and memory.

There is **no sip-bridge / local_realtime rollback**. Cynthia phone AI requires `VOICE_PROVIDER=vapi`.

## Why

Home NAT/UPnP + custom RTP pacing caused one-way/no-reply calls. Vapi hosts SIP signalling and media; Builder Diddies keeps Cynthia brain, tools, and memory via webhooks.

## Setup

1. Create a **Vapi EU** account → [dashboard.vapi.ai](https://dashboard.vapi.ai) (use EU org for UK numbers).
2. Copy the **Private API key** into `tradepro-backend/.env`:

```env
VAPI_PRIVATE_KEY=••••
VAPI_REGION=eu
VAPI_WEBHOOK_BASE_URL=https://YOUR_PUBLIC_HTTPS_HOST
VOICE_PROVIDER=vapi
```

3. Expose the Builder Diddies API publicly (tunnel for pilot):

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

This reads the Cynthia AI line (`purpose: aria` compat alias) from `server/data/synced-data.json` and writes `VAPI_PHONE_NUMBER_ID` / `VAPI_SIP_CREDENTIAL_ID` into `.env`.

5. Restart API (`npm run dev`). Local SIP bridge is **not** used for AI answering.

6. Place a call:

```http
POST /api/calls/outbound
{ "to": "+447576442345", "template": "lead_callback" }
```

## British voice (proven live path) + per-language map

Live phone TTS is **ElevenLabs through Vapi** (`provider: '11labs'`). **English stays Lizzie** — not local STT/TTS or Chatterbox.

```env
ELEVENLABS_API_KEY=••••
VAPI_ELEVENLABS_VOICE_ID=EQx6HGDYjkDpcli6vorJ
ELEVENLABS_VOICE_ID=EQx6HGDYjkDpcli6vorJ
ELEVENLABS_MODEL_ID=eleven_turbo_v2_5
# Optional non-English overrides only — never override en / Lizzie
# VAPI_ELEVENLABS_VOICE_ID_ES=…  or  VAPI_ELEVENLABS_VOICE_MAP={"es":"…"}
```

Per-language defaults live in `server/phone-voices.ts` (es Aerisita, pl Aleksandra, ru Klava, uk Kira, zh Zicai, fa Laura, sq Veronica). Call start uses `getVapiVoiceConfigForLang`. Mid-call: `setCallLanguage` persists preference + best-effort voice PATCH. Identity is always **Cynthia**. See frontend `docs/VOICE_SETUP.md` + `APPLICATION_MASTER.md` §16.5.

Also paste the ElevenLabs key into Vapi dashboard → Integrations if required by your org.

Retest baseline: outbound to staff mobile + PIN, then inbound from a second phone; English first reply must be Cockney Lizzie. Mid-call: ask for Spanish/Polish → must keep speaking (not list-and-stop); back to English → Lizzie.

## Soho66 REGISTER caveat

Some Soho66 accounts expect SIP REGISTER from a softphone/UA. Vapi BYO trunks often dial with digest auth **without** REGISTER. If outbound fails with auth/401:

1. Keep your Soho66 DID
2. Add a proper BYOC trunk (Telnyx / DIDLogic)
3. Forward/port the Soho66 number, or migrate CLI
4. Re-run setup against that trunk — **do not** use custom RTP / sip-bridge for AI

**Inbound (same Soho66 credentials, no new SIP account):**  
Soho66 Routing Wizard → forward DID to Vapi SIP URI (region must match `VAPI_REGION`):

- US: `sip:+442037453233@<VAPI_SIP_CREDENTIAL_ID>.sip.vapi.ai`
- EU: `sip:+442037453233@<VAPI_SIP_CREDENTIAL_ID>.sip.eu.vapi.ai`

Production example (`VAPI_REGION=us`):  
`sip:+442037453233@563da08a-0170-40ab-9738-7531b1c7501e.sip.vapi.ai`

If Soho66 still rings an IP phone / voicemail first, Cynthia never sees the call — change that route to the URI above. Softphone registration is optional and separate.

## Webhooks

`POST /webhooks/vapi` handles:

- `assistant-request` → `buildPhoneBrainPrompt()` (Cynthia identity)
- `tool-calls` → existing customer/phone tools (idempotent)
- `transcript` / `end-of-call-report` → Call Centre + Cynthia customer threads
