# Phone domain

Canonical telephony / Vapi / DID routing / call session tools.

**Architecture SoT:** [`docs/PHONE_ARCHITECTURE.md`](../../docs/PHONE_ARCHITECTURE.md)

## Start here

| File | Role |
|------|------|
| `phone-lines.ts` | DID ? org + purpose (`aria` Judie / `sally` / `staff` softphone) |
| `vapi-routes.ts` | Live webhooks: assistant-request, tool-calls, end-of-call |
| `vapi-assistant.ts` | Builds Vapi assistant from `brains/*` session |
| `phone-brain.ts` | Shared Judie diner + staff PIN tool schemas |
| `phone-tools.ts` | Tool execution (orders, CRM lite, transfer helpers) |
| `sally-sales-phone.ts` | Sally sales prompts + sales tools |
| `phone-webhook.ts` | Non-Vapi / telephony webhook edge |
| `phone-orchestrator.ts` | **LEGACY** — not on live Vapi path |

Brain packages: `../brains/{sally,judie}/`.
