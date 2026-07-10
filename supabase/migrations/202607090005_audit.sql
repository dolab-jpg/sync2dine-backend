-- Audit: usage events, conversation logs, AI studio config

create table usage_events (
  id uuid primary key default extensions.uuid_generate_v4(),
  org_id uuid not null references organizations(id) on delete cascade,
  user_id uuid references profiles(id) on delete set null,
  model text,
  prompt_tokens integer not null default 0,
  completion_tokens integer not null default 0,
  total_tokens integer not null default 0,
  route text,
  created_at timestamptz not null default now()
);

create table conversation_logs (
  id uuid primary key default extensions.uuid_generate_v4(),
  org_id uuid not null references organizations(id) on delete cascade,
  thread_id text not null,
  role text not null,
  content text not null default '',
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table ai_studio_config (
  org_id uuid primary key references organizations(id) on delete cascade,
  config jsonb not null default '{}',
  meta jsonb not null default '{}',
  updated_at timestamptz not null default now()
);

create index idx_usage_events_org on usage_events(org_id, created_at desc);
create index idx_conversation_logs_thread on conversation_logs(org_id, thread_id, created_at);
create index idx_conversation_logs_org on conversation_logs(org_id, created_at desc);

create trigger ai_studio_config_updated_at before update on ai_studio_config
  for each row execute function public.set_updated_at();
