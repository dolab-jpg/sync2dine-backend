# Workers and background runtime (reviewed)

**Evidence:** [`_generated/workers-discovered.json`](./_generated/workers-discovered.json)  
**Boot SoT:** `server/index.ts` listen callback.

## Booted from `server/index.ts`

| Name | Module | Trigger | Side effects | Disable / gate | Verify |
|------|--------|---------|--------------|----------------|--------|
| `initDataFromSupabase` | `data-store.ts` | once at listen | hydrate cache from Supabase | — | boot logs |
| `ensureBdiddiesHomeOrg` | `organizations.ts` | once | ensure home org | — | org exists |
| `startMailboxPoller` | `mailbox/imapSyncService.ts` | interval (~60s) | IMAP sync | stop process / mailbox config | mailbox UI |
| `startOutboundWorker` | `outbound-worker.ts` | loop | place queued calls; re-queues `needs_retry` via `enqueueSallyRetryLeads`; DNC cancel | — | outbound queue |
| `startConnectorQueueWorker` | `connectors/outbound-queue.ts` | ~30s | POS/partner push | — | connector tests |
| `startSalesBrainWorker` | `sales-brain/worker.ts` | loop | score calls | `DISABLE_SALES_BRAIN_WORKER=1` | `/api/sales-brain` |
| `startSallyKnowledgeWorker` | `sally-product-kb/worker.ts` | loop | KB index | — | `/api/sally-knowledge` |
| `warmSallyKnowledgeCache` | `sally-product-kb/inject.ts` | once (void) | warm cache | — | boot |
| `startScheduledMessageWorker` | `scheduled-message-worker.ts` | dynamic import | scheduled msgs | — | scheduled sends |
| `startWeeklyBillingWorker` | `billing/weekly-billing-worker.ts` | dynamic import | weekly billing | — | billing routes |
| `startCodeFixWorker` | `code-fix-handler.ts` | dynamic import | self-heal queue | — | `/api/ai/code-fix` |
| `initWWebClient` | `whatsapp-web-client.ts` | dynamic import | WA Web.js session | fail soft on error | `/api/whatsapp-web` |

## Other background / event surfaces

| Kind | Module | Notes |
|------|--------|-------|
| HTTP upgrade | `whatsapp-web-browser-login` | WS for QR browser login |
| Webhook processors | `whatsapp-webhook`, `phone-webhook`, `vapi-routes`, Stripe webhook | request-driven, not interval |
| Vapi tool-calls | `vapi-routes` | per-call |
| Self-heal loop | inside code-fix worker | concurrency limits in handler |
| **API health watchdog (VPS cron)** | `scripts/api-health-watchdog.sh` | Outside Node — every 1m probes `:3011/health`, auto-restarts, emails/SMS/Trae using `server/data/ops-contacts.json`. Install via `install-api-health-watchdog.sh` (also from `restart-sync2dine-api.sh`). |

## Failure behaviour

- Dynamic imports use `.catch` / soft fail for WhatsApp init.
- Workers generally log and continue; treat missing disable env as “always on” unless documented above.

## Related

- Routes: [`ROUTE_MAP.md`](./ROUTE_MAP.md)
- AI worker personas: [`AI_REGISTRY.md`](./AI_REGISTRY.md) (`sales_brain`, `sally_product_kb`)
