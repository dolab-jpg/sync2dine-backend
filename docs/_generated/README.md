# Generated discovery evidence

Machine output from `npm run extract:registries` in sync2dine-backend.

| File | Role |
|------|------|
| `tools-discovered.json` | Tool name scan |
| `ai-surfaces-discovered.json` | Brains / env gates |
| `workers-discovered.json` | Boot + discovered starts |
| `routes-discovered.json` | pathname prefixes / handlers |
| `runtime-discovery-summary.json` | Counts + fingerprints |
| `reviewed-baseline.json` | Reviewed fingerprints for `check:agent-maps` |

**Not authoritative architecture** — classify in AI_REGISTRY / TOOL_REGISTRY / WORKERS / ROUTE_MAP (ADR 006).

When fingerprints change after a real runtime change: review registries, then `npm run extract:registries:baseline`.
