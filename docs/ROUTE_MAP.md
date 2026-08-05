# Route and handler map (reviewed)

**Evidence:** [`_generated/routes-discovered.json`](./_generated/routes-discovered.json)  
**Mount order SoT:** `server/index.ts` · short table: [`server/README.md`](../server/README.md)

## Classification legend

`public` | `auth` | `org` | `staff` | `admin` | `webhook` | `internal` | `disabled`

Exact auth enforcement varies by handler — prefer reading the route file. Many `/api/*` routes use `requireAuth` / org headers when `AUTH_ENFORCED`.

## Primary mounts (by family)

| Prefix / family | Handler module | Class | Notes |
|-----------------|----------------|-------|-------|
| `/health` | whatsapp-webhook | public | health — must stay 200 for phone; nginx 502 = API process down |
| `/api/ops/alerts` | agent-routes | auth | in-process banner alerts (useless if API dead) |
| `/api/platform/ops-contacts` | platform-routes | platform_owner | GET/PUT alert email/SMS/Trae webhook |
| `/api/platform/ops-contacts/test` | platform-routes | platform_owner | POST test fan-out |
| `/webhooks/whatsapp` | whatsapp-webhook | webhook | Meta cold unless enabled |
| `/webhooks/voice/*`, `/api/calls/*` | phone/phone-webhook | webhook / auth | softphone + call APIs |
| `/webhooks/vapi`, `/api/vapi/*` | phone/vapi-routes | webhook / auth | **live phone AI** |
| `/api/agent/*` | ai/agent-routes | staff | lines, voices, TTS |
| `/api/projects`, `/api/portal`, `/api/data/sync`, files | project-routes | auth/org | |
| `/api/building-control` | building-control-routes | staff | |
| `/api/ai/studio` | ai/ai-studio-routes | staff | config |
| `/api/sales-brain` | sales-brain/routes | staff/admin | |
| `/api/sally-knowledge` | sally-product-kb/routes | staff | |
| `/api/ai/conversation-log` | ai/conversation-audit | staff | |
| `/api/banking` | banking-routes | staff | |
| `/api/mailbox`, `/webhooks/gmail\|outlook` | mailbox-routes | staff / webhook | |
| `/api/calendar` | calendar-routes | staff | |
| `/api/messages` | messages-routes | auth | |
| `/api/ai/price-research` | price-research-routes | staff | |
| `/api/contracts`, `/api/contract` | contract-routes | auth | |
| `/api/stripe` (+ webhook) | billing/stripe-routes | webhook / auth | |
| `/api/auth` | auth + account-auth | public+auth | login, invites |
| `/api/org/openai-key`, `/api/org/ai-brain` | org-openai-key-routes | admin | |
| `/api/org/.../integrations` | org-integrations-routes | admin | |
| org phone billing / weekly billing | billing/* | admin | |
| `/api/platform` | platform-routes | admin | |
| `/api/leads` | leads-routes | staff | |
| `/api/orders` | orders/orders-routes | auth/org | restaurant |
| `/api/menu` | orders/menu-routes | auth/org | |
| `/api/reservations`, `/api/dining-tables` | orders/reservations-routes | auth/org | |
| `/api/connectors` | connectors/routes | admin/org | |
| `/api/cyrus` | ai/cyrus-routes | public+auth | widget CORS |
| `/api/cynthia` | ai/cynthia-routes | auth | |
| `/api/sally/web` | sally-web-routes | public | marketing CORS |
| language-packs / translate / org staff / pin / concierge | channel-routes | mixed | |
| `/api/agent/credentials` | agent-credentials-routes | local/dev | |
| `/api/push` | push-routes | auth | |
| `/api/whatsapp-web` | whatsapp-web-routes | staff | |
| gap SMS/Stripe/banking helpers | ai/gap-api-routes | staff | |
| `/api/agent-activity` | agent-activity-routes | staff | |
| `/api/ai/*` catch-all | ai/ai-proxy | auth | orchestrate, staff, code-fix, … |

## FE ? BE entry points (representative)

| FE | BE |
|----|-----|
| Cynthia overlay / orchestrate | `/api/ai/orchestrate`, `/api/ai/staff` |
| Sally widget / Ask Sync2Dine | `POST /api/sally/web` |
| Restaurant boards | `/api/orders`, `/api/menu`, `/api/reservations` |
| Call Centre | `/api/agent/*`, `/api/vapi/*`, `/api/calls/*` |
| Self-heal | `/api/ai/code-fix*` |

## Not mounted / quarantine

- `server/_quarantine/*` — not in `index.ts`
- `phone/phone-orchestrator.ts` — throw stub; not on Vapi path
- `realtime-routes` — not mounted in index (legacy)

## Related

- Capability rows: `sync2dine-frontend/docs/CAPABILITY_INVENTORY.md`
- Workers: [`WORKERS.md`](./WORKERS.md)
