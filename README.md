# TradePro Backend

Supabase backend for the TradePro / Bathroom Sales Estimation Platform.

## Structure

- `supabase/` — Postgres migrations, seed data, Edge Functions
- `server/` — Slim Node companion (AI, webhooks, telephony)
- `scripts/` — Data migration and type generation
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

## Development

```bash
npm run dev              # Node companion on port 3001
npm run gen:types        # sync DB types to frontend repo
npm run migrate          # import legacy JSON from frontend repo
```

## Environment

See `.env.example` for required variables. **Never commit `.env`** — service role keys belong here only.

## Frontend

The React app lives in the sibling folder `Bathroom Sales Estimation Platform/`. It connects via:

- `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY` (direct to Supabase)
- `VITE_API_BASE_URL` (Node companion for AI/webhooks only)
