# ADR 003 — Deploy: push-live-local.sh

## Decision

Authoritative live ship is `sync2dine-frontend/scripts/push-live-local.sh` (SPA + API from sibling backend). GitHub master push may update SPA only.

## Consequences

- Never use disabled `deploy-vps.sh` / `deploy-nginx.sh`.
- Live API port is **3011**; local default **3001** is not live SoT.
