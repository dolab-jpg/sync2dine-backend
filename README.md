# Sync2Dine backend

Supabase + Node API for Sync2Dine (phone AI, orders, billing, staff AI).

**AI / agent navigation:** start at [AGENTS.md](AGENTS.md) and [server/README.md](server/README.md). Phone SoT: [docs/PHONE_ARCHITECTURE.md](docs/PHONE_ARCHITECTURE.md).

Live API: **https://app.sync2dine.io**.

## Structure

- `supabase/` — Postgres migrations, seed data, Edge Functions
- `server/` — Node API; see domain folders in `server/README.md`
- `scripts/` — Migration, smoke, and one-off split helpers
- `shared/` — Generated Supabase TypeScript types

## Setup

```bash
npm install
cp .env.example .env
# Fill in Supabase credentials from your project dashboard
```

### Local Supabase (requires Docker)

```bash
npm run supabase:start
npm run supabase:reset   # applies migrations + seed
```

### Link cloud project

```bash
npx supabase login
npx supabase link --project-ref YOUR_PROJECT_REF
npm run supabase:push
```

## Run API

```bash
npm run dev    # tsx watch
npm start      # production-style
npm test
```

## Deploy

From the sibling frontend repo:

```bash
bash scripts/push-live-local.sh
```

That syncs **this** backend tree to the VPS and restarts the API. Backend GitHub Actions on `master` can also SCP + restart. Never curl frontend `server-legacy/` prompts onto the VPS.
