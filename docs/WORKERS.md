# Workers and background runtime (reviewed)

**Evidence:** [`_generated/workers-discovered.json`](./_generated/workers-discovered.json)  
**Boot SoT:** `server/index.ts` listen callback.

## Booted from `server/index.ts`

| Name | Module | Trigger | Side effects | Disable / gate | Verify |
|------|--------|---------|--------------|----------------|--------|
| `initDataFromSupabase` | `data-store.ts` | once at listen | hydrate cache from Supabase | ù | boot logs |
| `ensureBdiddiesHomeOrg` | `organizations.ts` | once | ensure home org | ù | org exists |
| `startMailboxPoller` | `mailbox/imapSyncService.ts` | interval (~60s) | IMAP sync | stop process / mailbox config | mailbox UI |
| `startOutboundWorker` | `outbound-worker.ts` | loop | place queued calls; Vapi health gate; pause after consecutive silent outbound; re-queues `needs_retry` via `enqueueSallyRetryLeads`; DNC cancel | ù | outbound queue |
| `startConnectorQueueWorker` | `connectors/outbound-queue.ts` | ~30s | POS/partner push | ù | connector tests |
| `startSalesBrainWorker` | `sales-brain/worker.ts` | loop | score calls | `DISABLE_SALES_BRAIN_WORKER=1` | `/api/sales-brain` |
| `startSallyKnowledgeWorker` | `sally-product-kb/worker.ts` | loop | KB index | ù | `/api/sally-knowledge` |
| `warmSallyKnowledgeCache` | `sally-product-kb/inject.ts` | once (void) | warm cache | ù | boot |
| `startScheduledMessageWorker` | `scheduled-message-worker.ts` | dynamic import | scheduled msgs | ù | scheduled sends |
| `startWeeklyBillingWorker` | `billing/weekly-billing-worker.ts` | dynamic import | weekly billing | ù | billing routes |
| `startCodeFixWorker` | `code-fix-handler.ts` | dynamic import | self-heal queue | ù | `/api/ai/code-fix` |
| `initWWebClient` | `whatsapp-web-client.ts` | dynamic import | WA Web.js session | fail soft on error | `/api/whatsapp-web` |

## Other background / event surfaces

| Kind | Module | Notes |
|------|--------|-------|
| HTTP upgrade | `whatsapp-web-browser-login` | WS for QR browser login |
| Webhook processors | `whatsapp-webhook`, `phone-webhook`, `vapi-routes`, Stripe webhook | request-driven, not interval |
| Vapi tool-calls | `vapi-routes` | per-call |
| Self-heal loop | inside code-fix worker | concurrency limits in handler |
| **API health watchdog (VPS cron)** | `scripts/api-health-watchdog.sh` | Outside Node ù every 1m probes `:3011/health`, auto-restarts, emails/SMS/Trae using `server/data/ops-contacts.json`. Install via `install-api-health-watchdog.sh` (also from `restart-sync2dine-api.sh`). |
| **SIP registration watchdog (VPS cron)** | `scripts/sip-reg-watchdog.sh` | Outside Node ó every 2m runs `docker exec tradepro-sip-bridge asterisk -rx 'pjsip show registrations'`, compares to bridge `lines.json` via `scripts/sip-reg-watchdog.mts` + `parseRegistrationStatuses`. After 2 consecutive bad statuses per line: plain-English SMS/email/webhook (900s cooldown). Recovery alert once. State: `/tmp/sync2dine-sip-watchdog.state`. Install via `install-api-health-watchdog.sh`. |

## Failure behaviour

- Dynamic imports use `.catch` / soft fail for WhatsApp init.
- Workers generally log and continue; treat missing disable env as ùalways onù unless documented above.

## Related

- Routes: [`ROUTE_MAP.md`](./ROUTE_MAP.md)
- AI worker personas: [`AI_REGISTRY.md`](./AI_REGISTRY.md) (`sales_brain`, `sally_product_kb`)
