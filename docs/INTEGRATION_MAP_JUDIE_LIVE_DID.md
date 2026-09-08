> **HISTORICAL — do not use as Sync2Dine personality / path SoT.**
> Live phone: [PHONE_ARCHITECTURE.md](./PHONE_ARCHITECTURE.md) · Sally: [SALLY_ARCHITECTURE.md](./SALLY_ARCHITECTURE.md) · Aliases: [LEGACY_ALIASES.md](./LEGACY_ALIASES.md)
> Live app: **https://app.sync2dine.io** · Domain paths live under `server/phone/`, `server/orders/`, `server/brains/`.
> Branch plan with pre-domain flat paths — completed/superseded; edit `server/phone/*` and `server/orders/*`.
# Integration map — Judie live DID routing

Branch: `cursor/judie-live-did-routing` (from latest `master`).  
Source reviewed: `cursor/judie-order-harden-6cb9` (not merged wholesale).

## Goals

1. Real DID ? organisation routing (no hard-coded live-test restaurant).
2. Demo restaurant = full live org config (same path as future clients).
3. OrderService remains the place engine; org-controlled POS/commerce forward.
4. Sally (platform sales) vs Judie (restaurant) credential separation.
5. Cross-org isolation tests before VPS live call.

## File-by-file plan

### NEW (port + adapt)

| File | From PR? | Action |
|---|---|---|
| `server/phone-lines.ts` | Yes | Port: encrypt SIP, DID uniqueness, `resolveOrgIdForInboundDid`, Sally/Judie helpers. Add fail-safe route result type. |
| `server/phone-lines.test.ts` | Yes | Port + extend isolation cases. |
| `server/food-order-guards.ts` | Yes | Port pure address/catalog helpers; wire into OrderService (not inline place). |
| `server/food-order-guards.test.ts` | Yes | Port. |
| `server/connectors/judie-order-forward.ts` | Yes | Adapt: only when `posPush` is `automatic`/`on_place`; never unconditional. |
| `server/connectors/judie-order-forward.test.ts` | Yes | Adapt for policy gate. |
| `server/did-routing.test.ts` | New | Cross-org DID/menu/order/SIP isolation. |

### MODIFY (master)

| File | Change |
|---|---|
| `server/data-store.ts` | `PhoneLinePurpose` += `sally`; optional `connectionType`; encrypt SIP on save; `withOrgContextAsync`. |
| `server/platform-routes.ts` | Add platform phone-line / Sally / Judie APIs (`platform_owner`). |
| `server/vapi-routes.ts` | Resolve org from inbound DID before `setRequestOrgId`; store `resolvedOrgId` + `linePurpose` on call meta; unknown DID fails safe; demo fallback only when DID missing. |
| `server/vapi-assistant.ts` | Use resolved restaurant `orgId` for model/menu; set `agentPersona` from line purpose (`sally` vs Judie). |
| `server/telephony/lineRegistry.ts` | Decrypt SIP before register/test; register `aria` + `sally`. |
| `server/phone-webhook.ts` | Prefer DID?org via phone-lines; keep org.phoneDid; no wrong-org override. |
| `server/delivery-areas.ts` | Add `isValidUkPostcode`, `isPlausibleUkStreetAddress`, `extractUkPostcode`. |
| `server/order-service.ts` | Stricter delivery street helper; menu suggestions; `posPush` aliases `automatic`/`disabled`; forward via policy helper. |
| `server/connectors/types.ts` + `config-store.ts` + `routes.ts` | Accept `automatic`/`disabled` (+ legacy `on_place`/`off`). |
| `server/menu-catalog.ts` | Additive `options` / expand helpers (export findCatalog*). |
| `server/agent-routes.ts` | Allow purpose `sally` only for platform/home patterns; decrypt on softphone GET. |
| `package.json` | Register new test files. |
| `docs/PARTNER_CONNECTOR.md` | Note org-controlled automatic forward. |

### PRESERVE (do not replace)

- `server/order-service.ts` architecture (thin phone-tools wrapper stays).
- `server/sally-offer-store.ts` SaaS/billing model (only sync `demoPhone` from Sally line).
- Sally Knowledge, Sales Brain, weekly billing.
- Existing auth gates.

### Frontend (separate repo, same branch name)

| File | Action |
|---|---|
| `platformApi.ts` | Add Sally/Judie phone-line helpers. |
| `SallyOfferSettings.tsx` | Sally DID + SIP card. |
| `OrgJudiePhoneCredentials.tsx` | NEW — client detail Judie block. |
| `PlatformClientsCRM.tsx` | Mount Judie credentials. |
| `MenuManager.tsx` | Additive upgrade options editor. |
| `App.tsx` / `AppShell.tsx` | Keep Sally knowledge + Sales Brain; no primary Phone-lines nav (APIs still available). |

## Routing rules

1. Extract inbound line DID from Vapi call (`to` / phoneNumber).
2. Lookup: `organizations.phoneDid` then enabled `phoneLines[].did` across orgs.
3. Hit ? `setRequestOrgId(orgId)`; stamp call meta (`resolvedOrgId`, `lineDid`, `linePurpose`).
4. `purpose === 'sally'` ? Sally brain; `aria` ? Judie brain for that org.
5. Unknown DID (present but unmatched) ? safe failure (no demo-kitchen override).
6. Missing DID ? optional explicit demo-kitchen fallback for controlled tests only.
7. Tool/order org always from call-resolved context — never from LLM `orgId` args.

## POS / commerce policy

| Setting | Behaviour |
|---|---|
| `manual_only` (default) | Kitchen board only; staff push. |
| `automatic` (alias `on_place`) | Forward after place for that org. |
| `disabled` (alias `off`) | Never auto-push. |

Live test org may set `automatic`; others stay `manual_only`.

## Rejected from old PR

- Wholesale `phone-tools` inline `placeFoodOrder`.
- Branch `sally-offer-store` stub.
- Unconditional auto-forward.
- Primary `/platform/phone-lines` nav (optional later).
- Hard-coded demo-kitchen as permanent routing.

## Rollback

1. Redeploy previous `master` commit (recorded pre-deploy).
2. Phone-line JSON fields are additive; SIP ciphertext needs decrypt path or re-entry if rolled back without decrypt helper.
3. Set live test org `posPush` back to `manual_only` if forward misbehaves.

