# Sync2Dine partner connector readiness

Sync2Dine exposes an **integration-ready** connector API for middleware partners (Deliverect/Otter-shaped mocks included). This is **not** a claim of live Deliverect/Otter certification.

## Direction A — Partner → Sync2Dine board

- `POST /api/connectors/:provider/orders` with HMAC (`X-S2D-Signature: sha256=…`)
- Idempotency via `Idempotency-Key` header (provider + org scoped)
- Rich orders: items, allergens, `customerAllergies`, delivery address, external id
- Staff bumps on `/api/orders/:id` emit signed `order.updated` webhooks to configured `outboundUrl`

## Direction B — Sync2Dine → partner hub (skeleton)

- `POST /api/connectors/commerce/forward` posts Commerce/basket-shaped payload to partner URL
- Configure `deliverectAccountId` / `deliverectLocationId` in connector config (server-side only)

## Menu export

- `GET /api/connectors/menu` — full menu with UK 14 allergens
- `GET /api/connectors/menu/version`
- `POST /api/connectors/menu/sync`

## Configuration & ops

- `GET/PUT /api/connectors/config` — masked secret in responses
- `GET /api/connectors/status` — `integrationReady: true`, `certified: false`
- `GET /api/connectors/events` — inbound/outbound event log
- `POST /api/connectors/queue/process` — retry outbound queue

## Local E2E

```bash
# Terminal 1
npm run dev

# Terminal 2
CONNECTOR_WEBHOOK_SECRET=connector-e2e-test-secret npx tsx --env-file=.env scripts/connector-e2e.mts
```

## Partner checklist

1. Exchange webhook secret out-of-band (never in frontend)
2. Confirm status map (`new` → Accepted, `coming` → Preparing, `ready` → Pickup ready, …)
3. Run mock E2E script; verify idempotency + bad signature rejection
4. Validate menu export allergen fields for your menu QA
5. Apply for partner sandbox when ready (Phase 3 — paperwork)

## Database

Apply migration `202607170001_sync2dine_allergens_bookings_connectors.sql` before using Supabase-backed tables/reservations/connector logs in production.
