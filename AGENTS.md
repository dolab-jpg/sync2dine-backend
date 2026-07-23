# AGENTS.md ù Sync2Dine backend

Start here before API / phone / billing work.

## Always open first (cold path)

1. [`server/index.ts`](server/index.ts) ù mount + boot workers
2. [`server/README.md`](server/README.md)
3. [`docs/AI_REGISTRY.md`](docs/AI_REGISTRY.md)
4. [`docs/TOOL_REGISTRY.md`](docs/TOOL_REGISTRY.md)
5. [`docs/WORKERS.md`](docs/WORKERS.md)
6. [`docs/ROUTE_MAP.md`](docs/ROUTE_MAP.md)
7. [`docs/PHONE_ARCHITECTURE.md`](docs/PHONE_ARCHITECTURE.md) / [`SALLY_ARCHITECTURE.md`](docs/SALLY_ARCHITECTURE.md)
8. [`docs/ARCHITECTURE_DIAGRAMS.md`](docs/ARCHITECTURE_DIAGRAMS.md) (code-verified Mermaid)
9. [`docs/LEGACY_ALIASES.md`](docs/LEGACY_ALIASES.md)
10. FE [`CAPABILITY_INVENTORY.md`](../sync2dine-frontend/docs/CAPABILITY_INVENTORY.md), [`DEPLOYMENT_MAP.md`](../sync2dine-frontend/docs/DEPLOYMENT_MAP.md), [`CHANGE_IMPACT.md`](../sync2dine-frontend/docs/CHANGE_IMPACT.md)
11. Generated evidence: [`docs/_generated/`](docs/_generated/)
12. ADRs: [`docs/adr/`](docs/adr/)
13. Engineering audit: [`../sync2dine-frontend/docs/ENGINEERING_AUDIT_REPORT.md`](../sync2dine-frontend/docs/ENGINEERING_AUDIT_REPORT.md)

## Domain folders

Prefer `server/brains/`, `phone/`, `sally/`, `orders/`, `ai/`, `billing/`, `connectors/`, `sales-brain/`, `sally-product-kb/`. Root `*.ts` with `// RE-EXPORT STUB` ? edit domain target.

## Edit here, not there

| Task | Edit | Avoid |
|------|------|-------|
| Vapi | `phone/vapi-routes.ts`, `vapi-assistant.ts` | stub alone; `_quarantine` |
| Sally offer | `sally/offer.ts` | prompt price copies |
| Sally phone | `phone/sally-sales-phone.ts` | Cynthia web orch |
| Sally Web | `sally/web-chat.ts` | staff orch |
| Cynthia web | `ai/orchestrator-handler.ts` | Sally web |
| Cynthia phone | `brains/cynthia/` (purpose `cynthia`) | remapping `aria` |
| Orders | `orders/*` | JSON as SoT |

## Ports / deploy / verify

Live **https://app.sync2dine.io** (:3011). Local default :3001.

```bash
npm run extract:registries
npm run check:agent-maps
npm run smoke:orders
npm run smoke:sally-web
```

Ship from FE: `bash scripts/push-live-local.sh`.

## When adding a feature

Update ROUTE_MAP / WORKERS / TOOL_REGISTRY / AI_REGISTRY as needed; run extract; if fingerprints change, update `docs/_generated/reviewed-baseline.json` deliberately (`npm run extract:registries:baseline` after review).
