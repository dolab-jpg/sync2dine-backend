# ADR 006 — Generated discovery vs reviewed registries

## Decision

`docs/_generated/*.json` is machine evidence. Reviewed markdown registries are the knowledge layer. `reviewed-baseline.json` fingerprints detection; drift fails `check:agent-maps` until registries/baseline are updated deliberately.

## Consequences

- Agents may read generated JSON; they must not treat it as classified architecture without the registry.
