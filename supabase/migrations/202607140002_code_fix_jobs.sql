-- Self-heal: CRM chat → queued Cursor code-fix jobs

create table if not exists code_fix_jobs (
  id uuid primary key default extensions.uuid_generate_v4(),
  org_id uuid references organizations(id) on delete set null,
  requester_user_id text,
  requester_name text not null default '',
  requester_role text not null default '',
  chat_session_id text,
  error_code text not null default '',
  description text not null default '',
  route text not null default '',
  screenshot_data_url text,
  scope text not null default 'surgical'
    check (scope in ('surgical', 'needs_cursor_approval')),
  status text not null default 'queued'
    check (status in (
      'asking',
      'offered',
      'dismissed',
      'queued',
      'running',
      'awaiting_cursor_approval',
      'pr_open',
      'merged',
      'failed',
      'cancelled'
    )),
  attempt_count integer not null default 0,
  max_attempts integer not null default 3,
  last_error text,
  alerted_at timestamptz,
  cursor_agent_id text,
  cursor_agent_url text,
  pr_url text,
  repo_url text,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_code_fix_jobs_status_created
  on code_fix_jobs (status, created_at asc);
create index if not exists idx_code_fix_jobs_org_created
  on code_fix_jobs (org_id, created_at desc);
create index if not exists idx_code_fix_jobs_error_route
  on code_fix_jobs (error_code, route, created_at desc);

create trigger code_fix_jobs_updated_at
  before update on code_fix_jobs
  for each row execute function public.set_updated_at();

alter table code_fix_jobs enable row level security;

create policy code_fix_jobs_service_all on code_fix_jobs
  for all
  using (true)
  with check (true);
