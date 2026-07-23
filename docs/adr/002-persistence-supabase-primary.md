# ADR 002 — Persistence: Supabase primary

## Decision

Supabase cloud is the production source of truth for product data. `server/data/*.json` and FE `localStorage` are cache / offline / UX only.

## Consequences

- Do not “fix production” by editing JSON alone.
- Self-heal jobs: Supabase `code_fix_jobs` primary.
