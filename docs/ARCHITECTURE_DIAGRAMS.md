# Sync2Dine backend architecture diagrams (code-verified)

Generated 2026-07-23 from `server/index.ts`, `server/brains/index.ts`, domain folders.  
Do not treat quarantine or FE archives as runtime.

## HTTP dispatch (mount order)

Sequential handlers in `server/index.ts`. First match wins; `/api/ai/*` is the final API catch-all before 404.

```mermaid
flowchart TB
  req[HTTP_request]
  req --> wa[whatsapp_webhook]
  wa --> phone[phone_webhook]
  phone --> vapi[phone_vapi_routes]
  vapi --> agent[ai_agent_routes]
  agent --> projects[project_routes]
  projects --> bc[building_control]
  bc --> studio[ai_studio]
  studio --> sb[sales_brain]
  sb --> sk[sally_product_kb]
  sk --> audit[conversation_audit]
  audit --> bank[banking]
  bank --> mail[mailbox]
  mail --> cal[calendar]
  cal --> msg[messages]
  msg --> price[price_research]
  price --> contracts[contracts]
  contracts --> stripe[stripe]
  stripe --> auth[auth]
  auth --> org[org_keys_integrations_billing]
  org --> platform[platform]
  platform --> leads[leads]
  leads --> orders[orders_menu_reservations]
  orders --> conn[connectors]
  conn --> cyrus[cyrus_routes]
  cyrus --> cynthia[cynthia_routes]
  cynthia --> sallyWeb[sally_web_routes]
  sallyWeb --> channel[channel_routes]
  channel --> misc[credentials_push_wweb_gap_activity]
  misc --> aiCatch["/api/ai/* ai_proxy"]
  aiCatch --> notFound[404]
```

Not mounted: `server/analytics-routes.ts`.

## Phone brain selection

Verified from `server/brains/index.ts`.

```mermaid
flowchart TD
  meta[callMeta_campaign_persona]
  meta --> sallyCheck{isSallySalesCall}
  sallyCheck -->|yes| sally[brain_sally]
  sallyCheck -->|no| cynthiaCheck{persona_or_purpose_cynthia}
  cynthiaCheck -->|yes| cynthia[brain_cynthia]
  cynthiaCheck -->|no| judie[brain_judie_default]
  note[persona_lizzie_maps_to_judie]
  judie --- note
```

## Sally layers

Verified from `docs/SALLY_ARCHITECTURE.md` paths that exist in tree: `server/sally/*`, `server/phone/sally-sales-phone.ts`, `server/brains/sally`.

```mermaid
flowchart TB
  subgraph shared [Shared_Sally_BI]
    offer[sally_offer.ts]
    salesOs[sally_sales_os.ts]
    tools[sally_tools.ts]
    exec[sally_execute.ts]
    kb[sally_product_kb]
  end
  subgraph phoneAdapt [Phone_adapter]
    brainS[brains_sally]
    salesPhone[sally_sales_phone.ts]
    vapiR[phone_vapi_routes.ts]
  end
  subgraph webAdapt [Web_adapter]
    webRoutes[sally_web_routes.ts]
    webChat[sally_web_chat.ts]
  end
  brainS --> salesPhone
  salesPhone --> offer
  salesPhone --> tools
  salesPhone --> exec
  vapiR --> brainS
  webRoutes --> webChat
  webChat --> offer
  webChat --> tools
  webChat --> exec
  kb --> brainS
  kb --> webChat
```

## Boot workers

Started after `listen` in `server/index.ts`.

```mermaid
flowchart LR
  boot[server_listen]
  boot --> hydrate[initDataFromSupabase]
  boot --> homeOrg[ensureBdiddiesHomeOrg]
  boot --> imap[mailbox_poller]
  boot --> outbound[outbound_worker]
  boot --> connQ[connector_queue]
  boot --> sbW[sales_brain_worker]
  boot --> skW[sally_kb_worker_and_warm]
  boot --> sched[scheduled_message_worker]
  boot --> week[weekly_billing_worker]
  boot --> cfix[code_fix_worker]
  boot --> wweb[whatsapp_web_client]
```

## Quarantine boundary

```mermaid
flowchart LR
  live[phone_vapi_routes.ts]
  stub[phone_phone_orchestrator.ts_throws]
  q[_quarantine_forks]
  index[server_index.ts]
  index --> live
  index -.->|not_imported| q
  index -.->|not_on_Vapi_path| stub
```
