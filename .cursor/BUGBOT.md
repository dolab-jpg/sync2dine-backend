# TradePro Bugbot rules (backend)

## Setup (one-time — Cursor Dashboard)

1. Open https://cursor.com/dashboard?tab=bugbot
2. Connect the GitHub App for `dolab-jpg`
3. Enable Bugbot on `tradepro-frontend` and `tradepro-backend`
4. Enable **Autofix** → **Create new branch**
5. Confirm **Cursor Bugbot** check on the next PR

## Surgical-fix policy (always)

- Prefer the **smallest diff** that clears the reported error.
- Do **not** redesign flows, rewrite large modules, or recreate full features when a small patch works.
- No secrets (`.env`, deploy tokens). No dependency upgrades unless the error is a broken import and the patch is minimal.
- Migrations only under `supabase/migrations/` — never invent schema changes unless the report explicitly requires them.
- If scope is a multi-area redesign: **stop** and require **Cursor approval**.
