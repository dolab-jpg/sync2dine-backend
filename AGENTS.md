# AGENTS.md — Sync2Dine backend

Start here before API / phone / billing work.

## Always open first

1. **Boot + mount order:** [`server/index.ts`](server/index.ts) — single HTTP process; handlers return boolean when they claim the request.
2. **Route index:** [`server/README.md`](server/README.md) — domain folders + handler map.
3. **Phone personalities:** [`docs/PHONE_ARCHITECTURE.md`](docs/PHONE_ARCHITECTURE.md).
4. **Feature atlas (FE paths + API files):** sibling frontend [`../sync2dine-frontend/docs/APPLICATION_MASTER.md`](../sync2dine-frontend/docs/APPLICATION_MASTER.md) §24–§25.
5. Live API: **https://app.sync2dine.io** / **https://app.b-diddies.com** (not `127.0.0.1:3001`) unless the user asks for local.

## Domain folders (prefer these)

| Folder | Owns |
|--------|------|
| `server/brains/{sally,judie}/` | Brain packages (only two BrainIds) |
| `server/phone/` | Telephony, VAPI, phone brain/tools/session/lines |
| `server/orders/` | Order service, orders/menu/reservations routes, food guards |
| `server/ai/` | Web orchestrator, staff AI, ai-proxy, Cynthia/Cyrus, AI Studio |
| `server/billing/` | Stripe, weekly billing, org phone billing |
| `server/connectors/` | POS / partner connectors |
| `server/sales-brain/` | Sales Brain API + worker |
| `server/sally-product-kb/` | Sally product knowledge |
| `server/mailbox/`, `server/telephony/`, `server/leads/`, … | Other focused packages |

Many root `server/*.ts` files are **thin re-exports** of the domain folders so old import paths keep working. Prefer editing the file under the domain folder, not only the stub.

## Phone brains

- Two BrainIds: `sally` | `judie` via `server/brains/index.ts`.
- Three modes: **Judie** (diner), **Sally sales**, **Sally staff** (PIN / Cynthia-style on phone).
- Live path: `phone/vapi-routes.ts` + `vapi-assistant.ts` — **not** legacy `phone/phone-orchestrator.ts`.
- Web staff chat orchestrator: `server/ai/orchestrator-handler.ts` (separate from Vapi).

## Persistence

- **Primary:** Supabase cloud (migrations in `supabase/migrations/`).
- **`server/data/*.json`:** local cache / offline fallback — **do not treat as production SoT**.
- Gateway: `server/supabase-admin.ts`, `data-store.ts`, feature `supabase-*.ts` modules.

## Deploy variants — ignore unless deploying

- `*.vps.ts`, `*.local-full.ts`

Canonical runtime sources are the non-suffixed modules under `server/phone/`, `server/ai/`, etc.

## Naming drift

Folder may be `sync2dine-backend`; remotes/docs may still say `tradepro-backend` / Builder Diddies — same product.
