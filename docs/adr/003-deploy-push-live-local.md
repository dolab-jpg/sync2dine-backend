# ADR 003 — Deploy: push-live-local.sh

## Decision

Authoritative **operator** live ship is `sync2dine-frontend/scripts/push-live-local.sh` (SPA + sibling backend sync, excludes `.env` / `server/data`, restarts API).

Additionally, `sync2dine-backend/.github/workflows/deploy-sync2dine-backend.yml` deploys the API on `master` push (SCP + restart after `npm test`). FE GitHub SPA CI behaviour is **Unverified** from this ADR.

## Consequences

- Prefer `push-live-local.sh` when both SPA and API must move together with known excludes.
- Align CI SCP excludes with the local script before treating GitHub-alone as equivalent.
- Never use disabled `deploy-vps.sh` / `deploy-nginx.sh`.
- Never run `scripts/auto-ssl-app.sh` (targets legacy `app.b-diddies.com`).
- Live API port is **3011**; local default **3001** is not live SoT.

## Related

- [`../ARCHITECTURE_DIAGRAMS.md`](../ARCHITECTURE_DIAGRAMS.md)
- FE [`ENGINEERING_AUDIT_REPORT.md`](../../../sync2dine-frontend/docs/ENGINEERING_AUDIT_REPORT.md)
