-- Sales Brain: post-call insights + human-approved playbook snippets (org scoped).

create table if not exists public.sales_brain_jobs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  call_id text not null,
  status text not null default 'queued'
    check (status in ('queued', 'running', 'done', 'failed')),
  attempts int not null default 0,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_sales_brain_jobs_status on public.sales_brain_jobs (status, created_at);
create unique index if not exists idx_sales_brain_jobs_call on public.sales_brain_jobs (org_id, call_id);

create table if not exists public.sales_call_insights (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  call_id text not null,
  agent_persona text,
  aim text,
  duration_sec int,
  reached_dm text,
  rapport_score int,
  discovery_score int,
  value_score int,
  close_score int,
  outcome text,
  objections jsonb not null default '[]'::jsonb,
  competitors jsonb not null default '[]'::jsonb,
  what_worked text,
  what_failed text,
  next_step text,
  upsell_potential text,
  cross_sell_potential text,
  raw_json jsonb,
  created_at timestamptz not null default now()
);
create unique index if not exists idx_sales_call_insights_call on public.sales_call_insights (org_id, call_id);
create index if not exists idx_sales_call_insights_created on public.sales_call_insights (org_id, created_at desc);

create table if not exists public.sales_brain_recommendations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  type text not null,
  proposed_text text not null,
  evidence_summary text,
  sample_size int not null default 0,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected', 'rolled_back')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.sales_playbook_snippets (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  slot text not null default 'general',
  body text not null,
  active boolean not null default true,
  variant_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_sales_playbook_active on public.sales_playbook_snippets (org_id, active);

alter table public.sales_brain_jobs enable row level security;
alter table public.sales_call_insights enable row level security;
alter table public.sales_brain_recommendations enable row level security;
alter table public.sales_playbook_snippets enable row level security;

create policy "sales_brain_jobs_select" on public.sales_brain_jobs for select using (public.org_access(org_id));
create policy "sales_call_insights_select" on public.sales_call_insights for select using (public.org_access(org_id));
create policy "sales_brain_recs_select" on public.sales_brain_recommendations for select using (public.org_access(org_id));
create policy "sales_playbook_select" on public.sales_playbook_snippets for select using (public.org_access(org_id));
-- Writes via service role only.
