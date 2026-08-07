# Runtime tool registry (reviewed)

**Evidence:** [`_generated/tools-discovered.json`](./_generated/tools-discovered.json) (~180 unique names).  
**Schemas SoT:** code catalogs (do not paste JSON params here).  
**Change impact:** [`../sync2dine-frontend/docs/CHANGE_IMPACT.md`](../../sync2dine-frontend/docs/CHANGE_IMPACT.md)

## Surfaces

| Surface id | Schema / pack files | Executor / runtime | Personas | Channel | Auth enforcement |
|------------|---------------------|--------------------|----------|---------|------------------|
| `phone_shared` | `phone/tools/catalog.ts` (`PHONE_TOOLS`) | `phone/tools/execute.ts` via `vapi-routes` | Judie (+ Sally pick) | Vapi | tool selector + DID org |
| `phone_customer` | `phone/phone-brain.ts` `PHONE_CUSTOMER_TOOLS` | phone execute / brain | Judie customer | Vapi | identity customer |
| `phone_staff_crm` | `phone/phone-brain.ts` staff CRM tools | phone execute | Sally staff / staff softphone | Vapi | PIN + identity (`phone-auth.ts`) |
| `phone_call_control` | `verifyStaffPhonePin`, `endCall`, `setCallLanguage`, native `voicemail` (Sally) | vapi-routes / native | all phone | Vapi | PIN tool; endCall/voicemail native |
| `phone_judie` | customer + full `PHONE_TOOLS` + language | Judie brain session | Judie | Vapi | DID?restaurant org |
| `phone_sally_sales` | `phone/sally-sales-phone.ts` slim pack | `executeSallySalesPhoneTool` | Sally sales | Vapi | platform org |
| `phone_sally_staff` | sales + `getPhoneSessionChatTools` + receptionist | same + staff | Sally staff | Vapi | PIN + staff identity |
| `sally_receptionist` | `sally-receptionist.ts` | phone/staff execute | Sally staff | Vapi | PIN |
| `sally_bi_full` | `sally/tools.ts` (phone+extended) | Sally web / orch helpers | Sally web / full BI | Web | web filter blocks outbound |
| `sally_web` | `getSallyWebOrchestratorTools` | `sally/web-chat.ts` | Sally Web | `POST /api/sally/web` | public; blocked tools |
| `orch_generic` | `tool-catalog-generic.ts` | orchestrator-handler | staff modes | `/api/ai/orchestrate` | session + role |
| `orch_staff` | `tool-catalog-staff.ts` + contract/project/… | same | Cynthia staff | web | session + role |
| `orch_foreman` | `FOREMAN_TOOLS` | same | foreman | web | session |
| `orch_customer` | `tool-catalog-customer.ts` | same | cyrus/customer | web/widget | channel |
| `orch_planning` | `planning-tools.ts` | planning-ai-handler / orch | planning | web | session |
| `orch_gap` | `gap-closing-tools.ts` | orchestrator + FE `gapToolRuntime` | staff | web | session; gap API HTTP |
| `orch_restaurant` | `restaurant-ai-tools.ts` | orchestrator | staff restaurant | web | session |
| `orch_facade` | `tool-facade.ts` | only if `AI_TOOL_FACADE=true` | staff | web | **env-gated; default OFF** |
| `fe_toolRuntime` | N/A (executor) | `src/app/engine/ai/toolRuntime.ts` | FE staff | browser?API | FE role + BE |
| `fe_gapRuntime` | N/A | `gapToolRuntime.ts` | FE staff | browser?API | FE + BE |

---

## Risk legend

`read` | `write` | `pii` | `comms` | `money` | `auth` | `destructive` | `external`

## High-risk / privileged tools (spot index)

| Name | Surface | Risk | Enforcement | Notes |
|------|---------|------|-------------|-------|
| `verifyStaffPhonePin` | call_control | auth | `phone-auth.ts` runtime | |
| `transferToHuman` | phone_shared | external | Judie allowTransfer | Sally sales `allowTransfer: false` |
| `placeFoodOrder` | phone_shared | money+pii | DID org + order-service | Judie |
| `processRefund` | orch_gap | money | session; gap API | |
| `manageSubscription` / `initiatePayment` | orch_gap | money | session | |
| `sendEmailReply` / `sendSms` / WA tools | email/gap | comms | session / PIN | |
| `requestCodeFix` | orch | write+external | staff | self-heal |
| `provisionRestaurantClient` | sally_bi_full | write | **not on live Vapi sales pack** | web/full only |
| `mergeCustomers` / `closeProject` / `archiveQuote` | orch_gap | destructive | session | |

Full unique name list: `_generated/tools-discovered.json` ? `uniqueNames`.

---

## Phone pack membership (canonical)

**Judie (live Vapi):** `PHONE_CUSTOMER_TOOLS` + full `PHONE_TOOLS` + `setCallLanguage` (+ Vapi `endCall` / optional `transferCall`).

**Sally sales (live Vapi):** `getOfferTerms`, `bookIntegrationMeeting`, `bookDemo` (alias), `sendSalesFollowUp`, `recallAccountMemory`, `setCallObjective`, `researchRestaurantProfile`, `scheduleVenueCallback`, `updateVenueProfile`, `captureReferralAndQueue`, plus picked: `bookCallback`, `captureLead`, `captureMessage`, `classifyCallIntent`, `scheduleAppointment`, plus `endCall`, `setCallLanguage`. Staff mode merges staff CRM + receptionist.

**Sally web:** `sally/tools` filtered by `SALLY_WEB_BLOCKED_TOOLS` (no outbound CRM blast).

---

## Duplicates / aliases

| Names | Note |
|-------|------|
| `bookDemo` ? `bookIntegrationMeeting` | Alias on Sally phone |
| `navigate` vs `navigateTo` | Generic vs customer/nav packs |
| `getMenu` | In `PHONE_TOOLS` and `RESTAURANT_TOOLS` |
| **Two** `getSallyPhoneSessionChatTools` | Slim: `phone/sally-sales-phone.ts` (Vapi). Full: `sally/tools.ts` (web/BI) |

---

## Reachability defects (verified)

| Defect | Detail | Severity |
|--------|--------|----------|
| Allowlist without Vapi schema | `listPendingCallbacks`, `searchLeads` in staff phone allowlists / registry but not assembled into Judie/Sally Vapi chat tools | high — model cannot call |
| Dead pick | `pickPhoneTools('verifyStaffPhonePin')` — PIN tool not in `PHONE_TOOLS`; staff mode adds separately | medium |
| Dual Sally packs | Full exclusive tools (`researchRestaurantProfile`, provision, Stripe checkout, …) **not** on live Vapi sales | document channel correctly |
| Facade default off | `AI_TOOL_FACADE` must be `true` | env |
| FE `orchestratorMode: 'sally'` | Not a BE mode — does not unlock Sally BI tools via Cynthia | mismatch |
| Channel allowlist extras | Some channel-action names may lack orchestrator schemas | review before claiming live |

---

## Permission / security notes

- Phone org isolation: **runtime** DID ? `orgId` (not prompt-only) for Judie orders.
- Staff phone tools: **runtime** PIN + identity (`phone-auth.ts`).
- Web orchestrator: session auth + role gating in handler; treat **prompt-only** role hints as insufficient for money/destructive tools — prefer BE checks in executors.
- Public Sally Web: blocked tool set must stay enforced in code (`SALLY_WEB_BLOCKED_TOOLS`), not prompt alone.
- Flag any new tool that relies only on system-prompt “do not call X” as **security concern**.

---

## Related

- [`AI_REGISTRY.md`](./AI_REGISTRY.md)
- ADR [`005-runtime-tool-ownership.md`](./adr/005-runtime-tool-ownership.md)
- FE executors: `sync2dine-frontend/src/app/engine/ai/toolRuntime.ts`, `gapToolRuntime.ts`
