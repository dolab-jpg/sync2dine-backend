# Sally architecture (Sync2Dine)

Source of truth for Sally responsibilities after the Phase-4 audit. Live product: **https://app.sync2dine.io**.

## One business intelligence, multiple channel adapters

| Layer | Owns | Path |
|-------|------|------|
| **Shared sales BI** | Identity, sales OS, offer facts, objection playbook, SaaS product/pricing helpers | `server/sally/sales-os.ts`, `server/sally/offer.ts`, `server/sally/tools.ts`, `server/sally/execute.ts` |
| **Sally Phone (sales)** | Vapi session, spoken overlays, close script, call tools, transfers | `server/brains/sally`, `server/phone/sally-sales-phone.ts`, `server/phone/vapi-*` |
| **Sally Phone (staff)** | 4-digit PIN, CRM/inbox tools on Sally line | Same brain with `staffMode` + `verifyStaffPhonePin` |
| **Sally Web** | Anonymous marketing chat, CORS, session history, web-safe tool subset | `server/sally-web-routes.ts`, `server/sally/web-chat.ts`, `buildSallyWebPrompt` |
| **Staff app AI** | Logged-in company ops (Cynthia) — **not** Sally | `server/ai/orchestrator/*`, `/api/cynthia` |
| **Judie** | Diner ordering phone — **not** Sally | `server/brains/judie`, Judie purpose lines |

Cynthia / Builder Diddies are separate historical concepts. Do not treat them as Sync2Dine Sally SoT.

## Shared (must not diverge)

- `SALLY_SALES_OS` — `server/sally/sales-os.ts`
- Offer / pricing facts — `getSallyOfferTerms` + `formatOfferFactsBlock` in `server/sally/offer.ts` (backed by `sally-offer-store` + saas packages)
- Objection playbook — `formatObjectionPlaybook` in `offer.ts`
- Sales tool schemas + `executeSallyTool` — `server/sally/tools.ts` + `execute.ts`
- Product knowledge inject — `server/sally-product-kb/` (approved Atmosphere talking points seeded via `ensureApprovedAtmosphereTalkingPoints` / `atmosphere-talking-points.ts`; prices still only via `getOfferTerms`)
- **Trust Engine** — `server/sally/trust-engine.ts` (live principle + after-call scores via Sales Brain ? CRM `sallyTrust`)
- **Venue dial windows** — `server/sally/dial-windows.ts` + `scheduleVenueCallback` / `updateVenueProfile`
- **Relationship memory** — `server/sally/relationship-memory.ts` (injected on phone + `recallAccountMemory`)

### Atmosphere sales language (phone + web)

Atmosphere is a **product SKU**, not a brain (`AI_REGISTRY.md`). Outbound Sally may cite:

- exclusive keyword/brand soundtrack (not Spotify);
- seating vs kitchen moods;
- controllable announcements;
- multi-week staff training while service runs;
- proven track record helping venues increase sales (evidence language — no invented ROI % / no identical-result guarantees).

Authoritative phone USPs live in `buildOfferTermsPayload().usps.atmosphere` (`phone/sally-sales-phone.ts`). Capability claims are **sales service proposition** — they do **not** prove an in-app Atmosphere control dashboard exists in Sync2Dine staff UI (landing remains THIN).

## Channel-specific (must stay separate)

| Concern | Phone | Web |
|---------|-------|-----|
| Runtime | Vapi tool-calls webhook | `POST /api/sally/web` |
| Prompt overlay | Voice, close script, staff PIN block, sales-brain inject | Anonymous visitor rules, Atmosphere-first, no outbound blast |
| Tools | Full Sally phone set + optional staff CRM tools | `getSallyWebOrchestratorTools()` (blocks outbound/provision/CRM blast) |
| Auth | DID route + optional staff PIN | Public CORS allowlist + rate limit |
| Session | Call id / party phone | `web_*` session history in memory |
| Speech / transfers | Yes | No |

## Request path — Sally Web

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

## Request path — Sally Phone

```
Vapi webhook ? phone/vapi-routes
  ? brains/sally buildSession (prompt + tools)
  ? tool-calls ? executeSallySalesPhoneTool / phone tools
```

## Anti-patterns

- Do not route Sally Web through Cynthia `handleOrchestrator` staff mode.
- Do not edit FE `server-legacy/` for Sally prompts.
- Do not invent a third copy of offer prices in phone overlays — import `formatOfferFactsBlock` from `sally/offer.ts`.
