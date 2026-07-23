# Legacy aliases ? Sync2Dine meaning

Use this when code, docs, or env still say an old name. **Live product is Sync2Dine** at https://app.sync2dine.io.

| You see | Means today | Action |
|---------|-------------|--------|
| `tradepro-frontend` / `tradepro-backend` | Old GitHub remotes | Use `sync2dine-frontend` / `sync2dine-backend` |
| `tradepro-api` / `/etc/tradepro-api.env` | Old VPS unit / env | Sync2Dine API under sync2dine-backend; port **3011** |
| `app.b-diddies.com` / Builder Diddies (host) | Former production host | Do not verify or deploy unless user asks |
| `Bathroom Sales Estimation Platform` | Old local folder name | `sync2dine-frontend` |
| Cynthia **web** staff AI | Staff chat / overlay | `server/ai/*` — not a phone line by default |
| Cynthia **phone** / BrainId `cynthia` | Builder Diddies construction CRM | Line purpose **`cynthia`** only; package `brains/cynthia/` |
| “Cynthia on phone” without purpose `cynthia` | Historical misnomer | Was Sally staff / Judie; do not remap `aria` ? Cynthia |
| Lizzie | Judie spoken identity / old voice label | BrainId remains `judie` |
| Cyrus | Legacy website widget / API alias | Prefer Cynthia widget + routes |
| Aria / line purpose `aria` | Restaurant DID ? Judie | Correct — not Cynthia |
| Line purpose `sally` | Platform DID ? Sally | Correct |
| Line purpose `cynthia` | Construction DID ? Cynthia phone brain | Correct |
| Line purpose `staff` | Human softphone assignment | **Not** an AI persona |
| `ensureBdiddiesHomeOrg` / `BDIDDIES_*` | Legacy symbol names | Home/platform org helpers — content is Sync2Dine |
| `BUILDER_DIDDIES_COMPANY` (`brains/cynthia/branding.ts`) | Cynthia phone branding only | Do not change Sync2Dine `BDIDDIES_COMPANY` platform branding |
| `server-legacy/` (FE) | Removed FE Node twin | Never restore for product work |
| `*.vps.ts` / `*.local-full.ts` | Old deploy forks | Only under `server/_quarantine/` — do not edit |
| `phone-orchestrator` | Legacy turn loop | Throw stub; live path is Vapi + brains |
| Local port `3001` | Default in `server/index.ts` / `.env.example` | Dev only; **live VPS is 3011** |
| `supabase/config.toml` project_id `tradepro` | Local CLI label | Link uses cloud project **ref**, not that string |
| VOICE_SETUP / VAPI_SIP (unbannered claims) | Historical Cynthia/Builder Diddies ops | SoT = `PHONE_ARCHITECTURE.md` + `SALLY_ARCHITECTURE.md` |
| `docs/archive/BUILDER_DIDDIES_OPS.md` | Archived APPLICATION_MASTER body | Archaeology only |

## Personas (canonical)

| Name | Channel | BrainId / module |
|------|---------|------------------|
| Judie | Phone (diner) | `judie` |
| Sally sales | Phone | `sally` |
| Sally staff | Phone (PIN) | `sally` + staff mode |
| Cynthia (construction) | Phone (CRM) | `cynthia` — purpose `cynthia` |
| Sally Web | Marketing web | `sally/web-chat.ts` — not Cynthia |
| Cynthia (web) | Staff web | `server/ai/*` — not Vapi unless purpose `cynthia` |
