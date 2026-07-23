# ADR 005 — Runtime tool ownership

## Decision

Tool **schemas** live in catalog modules; **executors** live in phone execute / orchestrator / sally web / FE toolRuntime. Docs index names only — code remains schema SoT.

## Consequences

- Adding a tool requires schema + executor + selector + tests + TOOL_REGISTRY update.
- Allowlists without schemas are defects.
