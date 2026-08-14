# Sally architecture (Sync2Dine)

Source of truth for Sally responsibilities after the Phase-4 audit. Live product: **https://app.sync2dine.io**.

## One business intelligence, multiple channel adapters

| Layer | Owns | Path |
|-------|------|------|
| **Shared sales BI** | Identity, sales OS, offer facts, objection playbook, SaaS product/pricing helpers | `server/sally/sales-os.ts`, `server/sally/offer.ts`, `server/sally/tools.ts`, `server/sally/execute.ts` |
| **Sally Phone (sales)** | Vapi session, spoken overlays, close script, call tools, transfers | `server/brains/sally`, `server/phone/sally-sales-phone.ts`, `server/phone/vapi-*` |
| **Sally Phone (staff)** | 4-digit PIN, CRM/inbox tools on Sally line | Same brain with `staffMode` + `verifyStaffPhonePin` |
| **Sally Web** | Anonymous marketing chat, CORS, session history, web-safe tool subset | `server/sally-web-routes.ts`, `server/sally/web-chat.ts`, `buildSallyWebPrompt` |
| **Staff app AI** | Logged-in company ops (Cynthia) ù **not** Sally | `server/ai/orchestrator/*`, `/api/cynthia` |
| **Judie** | Diner ordering phone ù **not** Sally | `server/brains/judie`, Judie purpose lines |

Cynthia / Builder Diddies are separate historical concepts. Do not treat them as Sync2Dine Sally SoT.

## Shared (must not diverge)

- `SALLY_SALES_OS` ù `server/sally/sales-os.ts`
- Offer / pricing facts ù `getSallyOfferTerms` + `formatOfferFactsBlock` in `server/sally/offer.ts` (backed by `sally-offer-store` + saas packages)
- Objection playbook ù `formatObjectionPlaybook` in `offer.ts`
- Sales tool schemas + `executeSallyTool` ù `server/sally/tools.ts` + `execute.ts`
- Product knowledge inject ù `server/sally-product-kb/` (approved Atmosphere talking points seeded via `ensureApprovedAtmosphereTalkingPoints` / `atmosphere-talking-points.ts`; prices still only via `getOfferTerms`)
- **Trust Engine** ù `server/sally/trust-engine.ts` (live principle + after-call scores via Sales Brain ? CRM `sallyTrust`)
- **Venue dial windows** ù `server/sally/dial-windows.ts` + `scheduleVenueCallback` / `updateVenueProfile` / CSV+bulk import scheduling via `server/sally/schedule-outbound.ts`
- **Referral capture** ù live Vapi tool `captureReferralAndQueue` (gatekeeper ? boss number + Sally follow-up brief)
- **Call eligibility** ù `server/sally/call-eligibility.ts` (DNC / consent enforced on enqueue + worker)
- **Relationship memory** ù `server/sally/relationship-memory.ts` (injected on phone + `recallAccountMemory`)
- **Spoken brand** ù `SYNC2DINE_SPOKEN` / `BDIDDIES_COMPANY.spokenCompanyName` in `server/home-org.ts` = **`sync Two dine`**. Phone firstMessage, voicemail, hang-up, and sales-OS pronunciation use this. Written **Sync2Dine** stays in email/CRM/UI. Do not change Judie venue greetings.

### Atmosphere sales language (phone + web)

Atmosphere is a **product SKU**, not a brain (`AI_REGISTRY.md`). Outbound Sally may cite:

- exclusive keyword/brand soundtrack (not Spotify);
- seating vs kitchen moods;
- controllable announcements;
- multi-week staff training while service runs;
- proven track record helping venues increase sales (evidence language ù no invented ROI % / no identical-result guarantees).

Authoritative phone USPs live in `buildOfferTermsPayload().usps.atmosphere` (`phone/sally-sales-phone.ts`). Capability claims are **sales service proposition** ù they do **not** prove an in-app Atmosphere control dashboard exists in Sync2Dine staff UI (landing remains THIN).

## Channel-specific (must stay separate)

| Concern | Phone | Web |
|---------|-------|-----|
| Runtime | Vapi tool-calls webhook | `POST /api/sally/web` |
| Prompt overlay | Voice, close script, staff PIN block, sales-brain inject | Anonymous visitor rules, Atmosphere-first, no outbound blast |
| Tools | Full Sally phone set + optional staff CRM tools | `getSallyWebOrchestratorTools()` (blocks outbound/provision/CRM blast) |
| Auth | DID route + optional staff PIN | Public CORS allowlist + rate limit |
| Session | Call id / party phone | `web_*` session history in memory |
| Speech / transfers | Yes | No |

## Request path ù Sally Web

```
POST /api/sally/web
  ? handleSallyWebRoutes (CORS, validate, history)
  ? runSallyWebChat
      ? buildSallyWebPrompt (+ offer facts)
      ? getSallyWebOrchestratorTools
      ? createLLMClientForOrg (Company AI Brain)
      ? executeSallyTool for tool rounds
  ? JSON { reply, toolsUsed, checkoutHandoff, landline }
```

## Request path ù Sally Phone

```
Vapi webhook ? phone/vapi-routes
  ? brains/sally buildSession (prompt + tools + firstMessage with SYNC2DINE_SPOKEN)
  ? tool-calls ? executeSallySalesPhoneTool / phone tools
```

## CRM / Call Centre outbound (live, 2026-08)

Staff **Start calling this list** on `/crm` is Sally outbound, not Judie. It POSTs `/api/campaigns/queue-crm` with `{ allCrm: true, template: 'sally_sales', remapLeeds: false }`.

| Rule | Behaviour |
|------|-----------|
| Who gets queued | Every home-org CRM customer with a plausible UK E.164, pipeline lead/quoted, not DNC. Not Leeds-only. |
| Store | `queueCrmCampaign` reloads customers from Supabase when `allCrm` (`reloadCustomersFromSupabase`) |
| Venue hours | `venueAware: false` on `allCrm` ó unknown hours do **not** become `needs_hours` hold |
| Job meta | `aim: 'sales_outreach'`, `agentPersona: 'sally'` (EOC `isSally` also matches `sally_sales`) |
| Quiet hours | Worker does **not** skip for stored 20:00ñ08:00. Kitchen AlertSettingsPanel quiet hours are unrelated |
| Stale slots | `reclaimStaleDiallingJobs()` before capacity. Missing `startedAt` age = 0 (not Infinity) |
| Failed UK numbers | Skip `!isPlausibleUkE164`. `requeueFailed: true` requeues Vapi 400s after DeepSeek / `toUkE164` fixes |
| Call Centre UI | `/calls` Start/Pause/Stop + capacity only. Running ? queued. `maxOutboundSlots` still 1 |
| Immediate test dial | `POST /api/calls/outbound` (not back of the campaign queue) |
| Bulk CSV | `POST /api/calls/outbound/bulk` ? `queueCsvCampaign` (same scheduler as upload) |

Do **not** treat ìGo live (all lines)î as starting the campaign ó that only SIP-registers Judie/Sally DIDs.

## Request path ó queue all CRM phones

```
/crm Start calling
  ? POST /api/campaigns/queue-crm { allCrm: true, template: sally_sales }
  ? queueCrmCampaign (Supabase reload, skip DNC, venueAware false)
  ? outbound_queue rows (queued)
  ? startOutboundWorker (reclaim stale ? capacity ? Vapi placeCall)
  ? brains/sally firstMessage (ìSally from sync Two dineî)
```

## Anti-patterns

- Do not route Sally Web through Cynthia `handleOrchestrator` staff mode.
- Do not edit FE `server-legacy/` for Sally prompts.
- Do not invent a third copy of offer prices in phone overlays ù import `formatOfferFactsBlock` from `sally/offer.ts`.
