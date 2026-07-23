# Quarantined server forks

These files are **not** mounted by `server/index.ts`.

| File | Why quarantined |
|------|-----------------|
| `phone-orchestrator.ts` | Zero callers on live Vapi path |
| `*.vps.ts` / `*.local-full.ts` | Stale deploy forks; diverge from canonical modules |

Do **not** edit these for product work. Canonical sources live under `server/phone/`, `server/ai/`, etc.

Restore: move back + wire an explicit import only after proving a caller.
