---
description: Live-first — test and verify on app.sync2dine.io, not localhost
alwaysApply: true
---

# Live-first production (Sync2Dine)

## Source of truth

| Surface | URL / host |
|---|---|
| App + API | **https://app.sync2dine.io** (same-origin `/api`, `/webhooks`) |
| Data | **Supabase cloud** (not browser `localStorage`, not VPS `server/data/*.json` as primary) |
| Git ship | `origin/master` on `sync2dine-frontend` + `sync2dine-backend` |

Local `localhost:5174` / `:3001` is **dev-only**. Do not use it for product verification, Judie/Sally LIVE cycles, self-heal, or "is it working?" checks unless the user explicitly asks for a local repro.

## Agent behaviour

1. **Browser / E2E:** open `https://app.sync2dine.io` (staff login). Prefer Judie/Sally LIVE gold sparkle on that host.
2. **API probes:** `https://app.sync2dine.io/api/...` and `/health` — not `127.0.0.1:3001`.
3. **Persistence:** CRM/quotes/code-fix jobs → Supabase. Treat local JSON / localStorage as cache or offline fallback only.
4. **Ship path (when user wants live):** commit → push `origin/master` (both repos as needed) → build SPA with `.env.production.local` → `scripts/deploy-spa.sh` via SSH `vps` → sync/restart **sync2dine-backend** / `sync2dine-api` on VPS. Pushing GitHub alone does not refresh the site.
5. **Never** deploy SPA into marketing `httpdocs/`. Docroot is `…/app.sync2dine.io/`.
6. Do not run legacy `deploy-vps.sh` for routine UI deploys.

## Self-heal

- Queue primary store: Supabase `code_fix_jobs`.
- Auto-start surgical fixes should stay **off** on live unless the user turns it on in AI Studio.
- Do not debug self-heal against a local Node `code-fix-jobs.json` as if it were production.
