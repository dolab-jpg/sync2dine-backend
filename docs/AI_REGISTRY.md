# AI registry (reviewed)

**Evidence:** [`_generated/ai-surfaces-discovered.json`](./_generated/ai-surfaces-discovered.json)  
**Behavioural SoT:** active runtime under `server/`.  
**Phone detail:** [`PHONE_ARCHITECTURE.md`](./PHONE_ARCHITECTURE.md) ù **Sally:** [`SALLY_ARCHITECTURE.md`](./SALLY_ARCHITECTURE.md)

Classifications: `phone_brain` | `web_persona` | `channel_adapter` | `domain_agent` | `llm_worker` | `orchestrator` | `staff_mode` | `configuration` | `alias` | `user_label` | `disabled` | `quarantined` | `historical` | `non_ai`

---

## Deployable / live conversational surfaces

| Id | Display | Class | Purpose | Domain | Entry | Prompts | Tools surface | Callers / channels | Auth | Status | Ready |
|----|---------|-------|---------|--------|-------|---------|----------------|-------------------|------|--------|-------|
| `judie` | Judie | phone_brain | Diner ordering & bookings | `brains/judie`, `phone/` | `brains/judie/index.ts` ? `phone/vapi-assistant.ts` ? `phone/vapi-routes.ts` | `phone/phone-brain.ts`, `phone/british-voice.ts`, `phone/phone-prompt.ts` | `phone_judie` | Vapi DID `aria`; FE kiosk | DID?org | live | yes |
| `sally` | Sally sales | phone_brain | SaaS sales closer | `brains/sally`, `phone/sally-sales-phone.ts`, `sally/` | `brains/sally/index.ts` | `sally/prompts.ts`, phone overlay | `phone_sally_sales` | Vapi DID `sally`; CRM dial | platform org | live | yes |
| `sally_staff` | Sally staff | staff_mode | PIN inbox/CRM on Sally DID | same brain | Sally when identity staff/foreman | staff blocks in phone packs | `phone_sally_staff` | Same Sally line | PIN + identity | live | yes |
| `cynthia_phone` | Cynthia (construction) | phone_brain | Builder Diddies construction CRM | `brains/cynthia/`, `phone/phone-brain.ts` | `brains/cynthia/index.ts` ? Vapi | branded `phone-brain` prompt | `phone_brain` tools | Vapi DID purpose `cynthia` | DID?org + PIN staff | live | yes (BrainId `cynthia`) |
| `cynthia` | Cynthia (web) | web_persona | Staff ops chat / overlay | `ai/` | `ai/orchestrator-handler.ts`, `ai/cynthia-routes.ts`, `/api/ai/orchestrate`, `/api/ai/staff` | `ai/orchestrator-prompt.ts` | `orch_*` packs | FE Cynthia UI | session auth | live | yes |
| `cyrus` | Cyrus | channel_adapter | Legacy customer widget/portal transport (prefer Cynthia brand) | `ai/cyrus-*` | `ai/cyrus-routes.ts`, `/api/cyrus/*`, `/api/ai/cyrus` | FE `personas/cyrus.ts`; BE fallback copy | orchestrator `cyrus`/`customer` | widgets, portal, WA path | channel | live | yes (alias) |
| `sally_web` | Sally Web | web_persona | Marketing Ask Sync2Dine chat | `sally/web-chat.ts` | `POST /api/sally/web` | `sally/prompts.ts` `buildSallyWebPrompt` | `sally_web` | `sally-widget.js`, hero | public CORS | live | yes |
| `channel_inbound` | Channel inbound | channel_adapter | Shared LLM turn for WA / portal / softphone voice | `ai/channel-inbound-handler.ts` | callers below | Studio + british voice | orchestrator + channel actions | WA, cyrus, phone-webhook | channel | live | yes |
| `foreman` | UK Foreman | domain_agent | Site/builder ops persona | FE `personas/ukForeman.ts` + BE orch mode | `/api/ai/orchestrate` mode `foreman` | `buildForemanSystemPrompt` | `FOREMAN_TOOLS` | construction FE | staff | live | yes (construction) |
| `project_ai` | Project AI | domain_agent | Project-scoped chat | `project-ai-handler.ts` | `/api/ai/project` | project prompt builder | project packs | Project AI panel | staff | live | yes |
| `planning_ai` | Planning AI | domain_agent | UK planning workflow | `planning-ai-handler.ts` | `/api/ai/planning` | planning prompts | `PLANNING_TOOLS` | planning UI | staff | live | yes |
| `building_control_ai` | Building Control AI | domain_agent | Regs search / compliance | `building-control-handler.ts` | `/api/ai/building-control` | BC KB | BC tools | BC UI | staff | live | yes |
| `transfer_assistant` | Transfer brief | channel_adapter | Briefs human after Judie transfer | `phone/transfer-numbers.ts` | Vapi transfer | transferAssistant string | none | Judie transfer | ù | live | partial (legacy copy) |

## Workers / config (not chat personas)

| Id | Class | Purpose | Entry | Status |
|----|-------|---------|-------|--------|
| `sales_brain` | llm_worker | Score calls / insights | `sales-brain/worker.ts`, `/api/sales-brain` | live (disable `DISABLE_SALES_BRAIN_WORKER`) |
| `sally_product_kb` | llm_worker | Product knowledge inject | `sally-product-kb/worker.ts` | live |
| `ai_studio` | configuration | Humour/knowledge/autonomy store | `/api/ai/studio` | live ù **not a chat AI** |
| `company_ai_brain` | configuration | Org LLM keys/providers | `openai-connection.ts`, `llm-connection.ts` | live ù **infra label** |
| `agent_call_centre` | configuration | Lines/voices/TTS API | `/api/agent/*` | live ù **not a brain** |

## Utility LLM routes (no named persona)

`/api/ai/summarize`, `compose-email`, `receipt`, `categorize-transaction`, `transcribe`, `tts`, `render`, `chat`, `estimate`, `code-fix` ù handlers under `ai/` / `code-fix-handler.ts`. Status: live / partial (code-fix).

## Aliases / labels / non-AI

| Id | Class | Maps to | Notes |
|----|-------|---------|-------|
| `lizzie` | alias | `judie` | `brains/index.ts` resolve |
| language friends (Lucùa, Ania, ù) | user_label | Judie session | spoken name only |
| Atmosphere | non_ai | product SKU | landing page, not a brain; Sally outbound may cite approved sales USPs (exclusive soundtrack, zones, announcements, multi-week training, proven sales-lift track record) ? not proof of staff-UI audio controls |
| line purpose `staff` | non_ai | human softphone | not an AI persona |
| Aria | user_label | Judie DID purpose | line purpose `aria` |
| line purpose `cynthia` | user_label | `cynthia_phone` / BrainId `cynthia` | construction DID only |

## Disabled / quarantined / historical

| Id | Class | Path | Notes |
|----|-------|------|-------|
| `phone_orchestrator` | quarantined | `phone/phone-orchestrator.ts` throws; body in `_quarantine/` | **Not** on Vapi path |
| `vapi_routes.vps` / `.local-full` | quarantined | `server/_quarantine/` | not mounted |
| `ivr` | disabled | `phone/ivr-handler.ts` | off unless `IVR_ENABLED=1` |
| Cynthia-on-phone without purpose `cynthia` | historical | VOICE_SETUP / VAPI_SIP / archive | superseded; use purpose `cynthia` for construction brain |

---

## Docs vs code mismatches

| Issue | Detail |
|-------|--------|
| FE `orchestratorMode: 'sally'` | Used in Cynthia sales UI; **not** in BE `OrchestratorMode` ù falls through; does **not** equal Sally Web BI |
| `buildCynthiaPhoneSystemPrompt` | Name says Cynthia; Judie content |
| `phone-webhook` / transfer / IVR / cyrus fallback | Still mention Builder Diddies / Cynthia in places |
| Kiosk `useCynthiaVapiVoice` / Lizzie avatar | Judie runtime; naming drift |
| Atmosphere peer to Judie/Sally in marketing | SKU, not BrainId |
| CAPABILITY ùedit here not thereù | Easy to misread column pairs ù use this registry + TOOL_REGISTRY |

## Related

- Tools: [`TOOL_REGISTRY.md`](./TOOL_REGISTRY.md)
- Workers: [`WORKERS.md`](./WORKERS.md)
- Aliases: [`LEGACY_ALIASES.md`](./LEGACY_ALIASES.md)
- ADR: [`adr/001-phone-brains-sally-judie.md`](./adr/001-phone-brains-sally-judie.md)
