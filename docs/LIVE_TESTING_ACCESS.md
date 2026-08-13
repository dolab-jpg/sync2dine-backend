# Live testing access map (Sync2Dine)

**Status:** Live testing in progress on **https://app.sync2dine.io** (API :3011).  
**Phase policy:** No temporary access gateway, Basic Auth, IP allowlist, blanket `/api` auth, or new login requirement is applied by this document. Classification and recommendations only.

**Mount SoT:** [`server/index.ts`](../server/index.ts)  
**Short route table:** [`ROUTE_MAP.md`](./ROUTE_MAP.md) � [`server/README.md`](../server/README.md)

## Classification legend (current behaviour)

| Class | Meaning |
|-------|---------|
| `intentionally_public` | Designed open for marketing / health / widgets |
| `webhook_signature` | External provider signature or shared secret |
| `auth_when_enforced` | `requireAuth` / similar only when `AUTH_ENFORCED=true` |
| `bearer_or_legacy_jwt` | Supabase bearer and/or legacy JWT checked today |
| `org_header_trusted` | Accepts `X-Org-Id` / body `orgId` when auth not enforced ([`auth.ts` `resolveOrgIdForRequest`](../server/auth.ts)) |
| `mixed` | Subpaths differ (document in Notes) |
| `unmounted` | Present in tree but not mounted from `index.ts` |

`isAuthEnforced()` returns true only when `process.env.AUTH_ENFORCED === 'true'` ([`server/auth.ts`](../server/auth.ts)). Mailbox/calendar also treat `'1'` as enforced � slight inconsistency (recommendation only).

## Mount families (code-verified)

| Prefix / family | Handler | Current class | Live-test callers | Notes |
|-----------------|---------|---------------|-------------------|-------|
| `GET /health` | `whatsapp-webhook.ts` | `intentionally_public` | Deploy probes, ops | Must stay open |
| `/webhooks/whatsapp` | `whatsapp-webhook.ts` | `webhook_signature` (Meta `x-hub-signature-256` when secret set) | Meta | Do not gate |
| `/webhooks/voice/*`, `/api/calls*` | `phone/phone-webhook.ts` | `auth_when_enforced` + telephony | Softphone / telephony | |
| `/webhooks/vapi`, `/api/vapi/webhook` | `phone/vapi-routes.ts` | `webhook_signature` (`verifyVapiRequest`) | Vapi | Unsigned POST ? 401 |
| `GET /api/vapi/health` | `phone/vapi-routes.ts` | `intentionally_public` | Smoke / ops | Config readiness JSON |
| `POST /api/vapi/web-session` | `phone/vapi-routes.ts` | mixed / open for browser voice | Cynthia Vapi voice FE | Do not blanket-auth without FE update |
| `/api/agent/*`, `GET /api/ops/alerts` | `ai/agent-routes.ts` | largely open today; ops used by deploy | FE Call Centre, `push-live-local.sh` | Lockdown deferred |
| `/api/campaigns/*`, `POST /api/customers/upsert` | `ai/agent-routes.ts` | `bearer_or_legacy_jwt` **always** (staff sales roles) | Cynthia + Call Centre | Progress/upload/queue-lapsed/upsert require login even when `AUTH_ENFORCED` is off |
| `/api/projects`, portal, data sync, files | `project-routes.ts` | `auth_when_enforced` + `org_header_trusted` | Construction FE | |
| `/api/building-control*` | `building-control-routes.ts` | staff-oriented; verify per handler | Construction FE | |
| `/api/ai/studio*` | `ai/ai-studio-routes.ts` | staff UI | AI Studio | |
| `/api/sales-brain*` | `sales-brain/routes.ts` | staff | Sales Brain UI | |
| `/api/sally-knowledge*` | `sally-product-kb/routes.ts` | staff | Knowledge admin | |
| `/api/ai/conversation-log*` | `ai/conversation-audit.ts` | staff | Audit UI | |
| `/api/banking*` | `banking-routes.ts` | staff + OAuth tokens | Banking UI | |
| `/api/mailbox*`, mail provider webhooks | `mailbox-routes.ts` | `auth_when_enforced` + provider OAuth/webhooks | Mail UI | |
| `/api/calendar*` | `calendar-routes.ts` | `auth_when_enforced` | Calendar UI | |
| `/api/integrations/package-updates` | `mailbox/package-updates.ts` | internal/status | Deploy/ops | |
| `/api/messages*` | `messages-routes.ts` | mixed | Messaging | |
| `/api/ai/price-research` | `price-research-routes.ts` | staff | Price research | |
| `/api/contracts*`, `/api/contract*` | `contract-routes.ts` | auth-oriented | Contracts UI | |
| `POST /api/stripe/webhook` | `billing/stripe-routes.ts` | `webhook_signature` (`constructEvent`) | Stripe | Unsigned ? 400 |
| `/api/quotes/*/checkout-link`, `/api/public/quotes/*/checkout` | `billing/stripe-routes.ts` | `bearer_or_legacy_jwt` / public checkout patterns | Quote checkout FE | Financial � observe test vs live Stripe keys on VPS |
| `/api/auth/*` | `auth.ts` + `account-auth.ts` | login/me/invites | SPA login | Incomplete final permissions OK during live test |
| `/api/org/openai-key`, `/api/org/ai-brain` | `org-openai-key-routes.ts` | `auth_when_enforced` | Settings | Sensitive when unenforced |
| `/api/org/integrations*` | `org-integrations-routes.ts` | `auth_when_enforced` | Integrations hub | |
| org phone billing / weekly billing | `billing/*` | `auth_when_enforced` (skips when off) | Platform billing | |
| `/api/platform/*` | `platform-routes.ts` | **open when `AUTH_ENFORCED` off** (`if (!isAuthEnforced()) return true`) | Platform owner UI | High risk before public launch; **do not change during live test** |
| `/api/leads*` | `leads-routes.ts` | staff/org header | CRM | |
| `/api/orders*` | `orders/orders-routes.ts` | `bearer_or_legacy_jwt` (401 without) | Kitchen/board FE | Smoke expects 401 unauthenticated |
| `/api/menu*` | `orders/menu-routes.ts` | `auth_when_enforced` | Menu UI | |
| `/api/reservations*`, `/api/dining-tables*` | `orders/reservations-routes.ts` | org/staff | Bookings | |
| `/api/connectors*` admin | `connectors/routes.ts` | `auth_when_enforced` for mutating admin | Square admin UI | |
| `/api/connectors*` inbound HMAC | `connectors/routes.ts` | `webhook_signature` | POS partners | Do not gate |
| `/api/cyrus*` | `ai/cyrus-routes.ts` | widget CORS + chat | Legacy widget | |
| `/api/cynthia*` | `ai/cynthia-routes.ts` | staff thread | Cynthia UI | |
| `POST /api/sally/web` | `sally-web-routes.ts` | `intentionally_public` + CORS allowlist + in-memory rate limit | Marketing widget / Ask Sync2Dine | **Must stay open for live marketing tests** |
| channel / language / pin / concierge | `channel-routes.ts` | mixed | Phone language + staff PIN | |
| `/api/agent/credentials*` | `agent-credentials-routes.ts` | local/dev oriented | Cursor paste / agent | Review before public launch |
| `/api/push*` | `push-routes.ts` | auth-oriented | Push | |
| `/api/whatsapp-web*` | `whatsapp-web-routes.ts` | staff + WS upgrade | WA Web panel | |
| gap SMS/Stripe/banking helpers | `ai/gap-api-routes.ts` | staff tools | Cynthia gap tools | |
| `/api/agent-activity*` | `agent-activity-routes.ts` | staff | Activity | |
| `/api/ai/*` catch-all | `ai/ai-proxy.ts` | `auth_when_enforced` | Cynthia orchestrate, etc. | |

## Unmounted / unreachable

| Path / module | Class |
|---------------|-------|
| `server/_quarantine/*` | `unmounted` (also excluded from `tsc`) |
| `server/phone/phone-orchestrator.ts` | stub throw; not on Vapi path |
| `server/analytics-routes.ts` | not mounted in `index.ts` |

## Callers that would break if gated later

| Caller | Depends on |
|--------|------------|
| `public/sally-widget.js`, `AskSync2DineHero` | `POST /api/sally/web` public |
| Vapi cloud | `/webhooks/vapi` or `/api/vapi/webhook` + secret |
| Stripe | `/api/stripe/webhook` signature |
| POS / connectors | HMAC inbound under `/api/connectors` |
| FE same-origin | relative `/api/*` via nginx ? :3011 |
| Deploy script | `GET /health`, `GET /api/ops/alerts`, orders 401 probe |

## Deferred lockdown (recommendation only � not this phase)

Before **public production** launch (after live testing completes):

1. Roll out consistent final auth (Supabase session + role permissions) � do not use blanket middleware without a caller matrix.
2. Close `/api/platform/*` and org secret routes when `AUTH_ENFORCED` is off.
3. Align `AUTH_ENFORCED` parsing (`true` vs `1`) across mailbox/calendar/auth.
4. Confirm Stripe **test** vs **live** keys match the intended financial stage; isolate test orgs.
5. Rotate `ORG_ENCRYPTION_KEY` off the legacy known-dev material with a controlled re-encrypt.
6. Gate or remove `/api/agent/credentials` from public internet if still present.
7. Neutralize FE `:7756` debug ingest and `scripts/auto-ssl-app.sh` (wrong host) � hygiene, not access gate.
8. Optional edge protections (Cloudflare Access / Basic Auth / IP allowlist) **only** after an affected-route + caller + rollback plan � never mid live-test without proof.

## Smoke harness

```bash
cd sync2dine-backend
npm run smoke:live
# or: node scripts/smoke-live-matrix.mjs https://app.sync2dine.io
```

## Live smoke results

Filled by the stability harness run (see latest entry below).

### Run log

| When (UTC) | Base | Result | Notes |
|------------|------|--------|-------|
| 2026-07-23 ~14:35 | `https://app.sync2dine.io` | **8/8 PASS** | health 200; ops 200; vapi health 200; vapi unsigned 401; stripe unsigned 400; orders 401; Sally Web 200+pricing; connectors HMAC unsigned 401 |

No access-control or runtime gate changes were made. No smoke-proven stability bugs required a code fix in this run.

---

*This file does not change runtime behaviour. Do not treat it as permission to add gates during live testing.*
