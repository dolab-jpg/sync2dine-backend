# ADR 007 — Quarantine boundaries

## Decision

`server/_quarantine/` and throw-stub `phone/phone-orchestrator.ts` are not product runtime. FE `server-legacy/` must not be restored. Root `server/*.ts` re-export stubs are boot compat only — edit domain files.

## Consequences

- check:agent-maps fails if `*.vps.ts` / `*.local-full.ts` appear outside quarantine.
- Do not import quarantine from `index.ts`.
