-- Sally Product Knowledge (separate from Studio/Lizzie/Judie knowledgeChunks).
-- Org-scoped; RLS select via org_access; writes via service role.

create table if not exists public.sally_knowledge_sources (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  kind text not null default 'url'
    check (kind in ('url', 'paste')),
  url text,
  title text,
  raw_text text,
  enabled boolean not null default true,
  last_fetched_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_sally_knowledge_sources_org
  on public.sally_knowledge_sources (org_id, enabled);

create table if not exists public.sally_knowledge_chunks (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  category text not null default 'other'
    check (category in (
      'elevator', 'usp', 'faq', 'objection', 'success',
      'pain', 'profile', 'competitor', 'other'
    )),
  title text not null default '',
  body text not null,
  source_id uuid references public.sally_knowledge_sources(id) on delete set null,
  source_url text,
  evidence_note text,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected')),
  active boolean not null default true,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_sally_knowledge_chunks_org_active
  on public.sally_knowledge_chunks (org_id, active, status);
create index if not exists idx_sally_knowledge_chunks_category
  on public.sally_knowledge_chunks (org_id, category);

create table if not exists public.sally_knowledge_ingest_jobs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  status text not null default 'queued'
    check (status in ('queued', 'running', 'done', 'failed')),
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_sally_knowledge_ingest_status
  on public.sally_knowledge_ingest_jobs (status, created_at);

alter table public.sally_knowledge_sources enable row level security;
alter table public.sally_knowledge_chunks enable row level security;
alter table public.sally_knowledge_ingest_jobs enable row level security;

create policy "sally_knowledge_sources_select"
  on public.sally_knowledge_sources for select using (public.org_access(org_id));
create policy "sally_knowledge_chunks_select"
  on public.sally_knowledge_chunks for select using (public.org_access(org_id));
create policy "sally_knowledge_ingest_select"
  on public.sally_knowledge_ingest_jobs for select using (public.org_access(org_id));
-- Writes via service role only.
