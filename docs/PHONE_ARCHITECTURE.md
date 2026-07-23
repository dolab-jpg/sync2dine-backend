# Phone architecture (runtime SoT)

Follow this document over folder folklore. Live entry: `server/index.ts` → `phone/phone-webhook.ts` + `phone/vapi-routes.ts`.

## Phone personalities

Runtime phone AI is **three brain packages** (`BrainId`: `sally` | `judie` | `cynthia`):

| Personality | BrainId | Line purpose | Role |
|-------------|---------|--------------|------|
| **Judie** | `judie` | `aria` (restaurant DID) | Diner ordering, bookings, transfer-to-human |
| **Sally (sales)** | `sally` | `sally` (platform DID) | Sync2Dine SaaS sales close |
| **Sally (staff)** | `sally` + `identity.kind` staff/foreman | Same Sally DID / staff caller CLI | PIN-gated inbox/CRM/email tools |
| **Cynthia (construction)** | `cynthia` | `cynthia` | Builder Diddies construction CRM (phone-brain tools + Biddies branding) |

Web Cynthia chat is separate (`ai/cynthia-routes.ts`, staff orchestrator) and is **not** the Vapi `cynthia` brain unless a line is purpose `cynthia`.

Legacy aliases: `lizzie` → Judie. Line purpose `staff` = human softphone assignment, **not** an AI persona.

## Routing

```
Inbound DID
  → resolveInboundDidRoute (phone/phone-lines.ts)
  → orgId + linePurpose (aria|sally|staff|cynthia)
  → agentPersona = sally | judie | cynthia
  → buildVapiAssistantForParty (phone/vapi-assistant.ts)
  → buildBrainSession (brains/index.ts)
  → Sally / Judie / Cynthia package
```

- Unknown DID (present, unmatched): fail safe — no menu/org guess.
- Missing DID: optional demo-kitchen fallback for controlled tests only.
- Tool/order `orgId` always from call-resolved context, never from LLM args.
- Until a construction DID is set to `purpose: 'cynthia'`, behaviour stays Judie/Sally as today.

## Live call path (Vapi)

1. Provider webhook → `handleVapiRoutes` (`phone/vapi-routes.ts`)
2. `assistant-request` → DID route → `buildVapiAssistantForParty` → brain session (prompt + tools + voice)
3. Speech: Vapi / Deepgram (STT) + ElevenLabs-style voice config (`phone/phone-voices.ts`)
4. `tool-calls` → Judie tools (`phone-tools` / order-service) or Sally tools (`sally-sales-phone`) or Cynthia/staff tools (`phone-brain` / `phone-tools`)
5. Orders → `orders/order-service.ts` + Supabase orders; CRM/calls → `data-store` + Supabase
6. `end-of-call-report` → transcript/recording metadata, CRM activity, Sally notify, billing hooks
7. Phone usage metering → `phone/phone-billing.ts` + `billing/*` weekly usage

## Orchestrator — two different things

| Name | Path | Used by live phone? |
|------|------|---------------------|
| **Brain session builder** | `brains/*` + `vapi-assistant` | **Yes** — primary phone “orchestration” |
| **Web/staff orchestrator** | `ai/orchestrator-handler.ts` | Staff/Cynthia **chat** + `ai-proxy`; not the Vapi turn loop |
| **Legacy phone orchestrator** | `phone/phone-orchestrator.ts` (`handlePhoneTurn`) | **No** — **throw stub**; archived body in `_quarantine/`. Do not edit for product work. |

Do not conflate `orchestrator-handler` with Vapi personality selection.

## Shared phone infrastructure

| Concern | Location |
|---------|----------|
| DID / lines | `phone/phone-lines.ts`, `data-store` phoneLines |
| Brains | `brains/{sally,judie,cynthia}/`, `brains/index.ts` |
| Shared diner/CRM prompt/tools | `phone/phone-brain.ts`, `phone/phone-tools.ts` |
| Sally sales OS | `phone/sally-sales-phone.ts` (+ root `sally-sales.ts` for web/chat offer) |
| Vapi adapter | `phone/vapi-routes.ts`, `vapi-assistant.ts`, `vapi-client.ts` |
| Telephony adapters | `telephony/` |
| Auth / PIN | `phone/phone-auth.ts` |
| Recordings | `phone/call-recording-*.ts` |
| Transfer | `phone/transfer-numbers.ts` (Judie + Cynthia; Sally `allowTransfer: false`) |
| Product KB (Sally) | `sally-product-kb/` |
| Orders | `orders/` |
| Billing | `billing/` + `phone/phone-billing.ts` |

## Intentionally retained (do not delete)

- Root `server/*.ts` **re-export stubs** → domain folders (compat for imports + boot). Look for `// RE-EXPORT STUB` — edit the domain target.
- `server/_quarantine/*.vps.ts` / `*.local-full.ts` — **stale deploy forks only** (not live mounts; do not edit for product).
- `phone/phone-orchestrator.ts` — throw stub; full body only in `_quarantine/`.
- FE `server-legacy/` — **removed from git**; never restore as API SoT.
- `sally-receptionist.ts` — platform inbox tools used by Sally staff/sales paths

## Separation rules

- Judie never gets Sally sales tools or Cynthia construction branding.
- Cynthia never mounts on `aria` restaurant DIDs (purpose must be `cynthia`).
- Sally sales never warm-transfers (product close path).
- Staff tools on Sally when Sally brain + staff/foreman identity (+ PIN verify).
- Staff/CRM tools on Cynthia via phone-brain + PIN when staff/foreman.
- Restaurant menu/orders scoped to DID-resolved `orgId`.
- Sally model keys use home/platform org; Judie uses restaurant org.
