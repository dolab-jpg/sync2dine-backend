# ADR 004 — Sally shared BI vs channel adapters

## Decision

Offer facts and shared sales BI live under `server/sally/` (`offer.ts`, prompts, tools). Channel adapters: phone `phone/sally-sales-phone.ts`, web `sally/web-chat.ts`. Dual tool packs exist; Vapi sales uses the **slim** phone pack.

## Consequences

- Do not invent a third price copy in prompts.
- Do not assume web-only tools are on Vapi.
