-- Ops: recruitment, banking, contracts, planning, calls, telephony

create table recruitment_jobs (
  id text not null,
  org_id uuid not null references organizations(id) on delete cascade,
  data jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, id)
);

create table recruitment_candidates (
  id text not null,
  org_id uuid not null references organizations(id) on delete cascade,
  data jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, id)
);

create table recruitment_interviews (
  id text not null,
  org_id uuid not null references organizations(id) on delete cascade,
  data jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, id)
);

create table bank_accounts (
  id text not null,
  org_id uuid not null references organizations(id) on delete cascade,
  data jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, id)
);

create table bank_transactions (
  id text not null,
  org_id uuid not null references organizations(id) on delete cascade,
  data jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, id)
);

create table client_receipts (
  id text not null,
  org_id uuid not null references organizations(id) on delete cascade,
  data jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, id)
);

create table contracts (
  id text not null,
  org_id uuid not null references organizations(id) on delete cascade,
  project_id text,
  signing_token text unique,
  status text not null default 'draft',
  data jsonb not null default '{}',
  signed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, id)
);

create table planning_applications (
  id text not null,
  org_id uuid not null references organizations(id) on delete cascade,
  data jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, id)
);

create table calls (
  id text not null,
  org_id uuid not null references organizations(id) on delete cascade,
  data jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, id)
);

create table outbound_queue (
  id text not null,
  org_id uuid not null references organizations(id) on delete cascade,
  data jsonb not null default '{}',
  created_at timestamptz not null default now(),
  primary key (org_id, id)
);

create table phone_lines (
  id text not null,
  org_id uuid not null references organizations(id) on delete cascade,
  data jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, id)
);

create table agent_settings (
  org_id uuid primary key references organizations(id) on delete cascade,
  is_active boolean not null default true,
  active_voice_id text,
  data jsonb not null default '{}',
  updated_at timestamptz not null default now()
);

create index idx_contracts_token on contracts(signing_token) where signing_token is not null;
create index idx_contracts_org on contracts(org_id);
create index idx_calls_org on calls(org_id);
create index idx_planning_org on planning_applications(org_id);

create trigger recruitment_jobs_updated_at before update on recruitment_jobs for each row execute function public.set_updated_at();
create trigger contracts_updated_at before update on contracts for each row execute function public.set_updated_at();
create trigger calls_updated_at before update on calls for each row execute function public.set_updated_at();
create trigger phone_lines_updated_at before update on phone_lines for each row execute function public.set_updated_at();
create trigger agent_settings_updated_at before update on agent_settings for each row execute function public.set_updated_at();
