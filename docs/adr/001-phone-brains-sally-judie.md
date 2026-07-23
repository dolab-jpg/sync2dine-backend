# ADR 001 — Phone brains: sally | judie | cynthia

## Decision

Runtime phone AI uses three `BrainId` values:

| BrainId | Role |
|---------|------|
| `sally` | Sync2Dine SaaS sales (+ staff PIN mode on the same brain) |
| `judie` | Restaurant diner ordering (line purpose `aria`) |
| `cynthia` | Builder Diddies / construction CRM (line purpose `cynthia` only) |

Cynthia is **not** remapped from Sync2Dine home-org `aria` lines (that remains Judie). Web Cynthia (`server/ai/*`) stays a separate staff chat surface.

## Consequences

- Route Cynthia only when line purpose / `agentPersona` is `cynthia`.
- Do not put Cynthia tools on Judie restaurant DIDs.
- Sally staff PIN remains a **mode** on Sally, not Cynthia.
- Legacy alias `lizzie` still resolves to `judie`.
