-- Projects with JSONB nested payload + project_files metadata

create table projects (
  id text not null,
  org_id uuid not null references organizations(id) on delete cascade,
  customer_id text,
  quote_id text,
  status text,
  portal_token text,
  data jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, id)
);

create unique index idx_projects_portal_token on projects(portal_token) where portal_token is not null;
create index idx_projects_org on projects(org_id);
create index idx_projects_customer on projects(org_id, customer_id);
create index idx_projects_status on projects(org_id, status);

create table project_files (
  id text not null,
  org_id uuid not null references organizations(id) on delete cascade,
  project_id text not null,
  storage_path text not null,
  filename text not null,
  mime_type text not null default 'application/octet-stream',
  source text,
  uploaded_by text,
  caption text,
  taken_at timestamptz,
  message_id text,
  task_id text,
  bucket text not null default 'project-files',
  created_at timestamptz not null default now(),
  primary key (org_id, id),
  foreign key (org_id, project_id) references projects(org_id, id) on delete cascade
);

create index idx_project_files_project on project_files(org_id, project_id);

create table whatsapp_groups (
  project_id text not null,
  org_id uuid not null references organizations(id) on delete cascade,
  data jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, project_id),
  foreign key (org_id, project_id) references projects(org_id, id) on delete cascade
);

create table whatsapp_sessions (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references organizations(id) on delete cascade,
  phone text not null,
  channel text not null default 'individual',
  group_id text,
  last_inbound_at timestamptz not null default now(),
  unique (org_id, phone)
);

create trigger projects_updated_at before update on projects for each row execute function public.set_updated_at();
create trigger whatsapp_groups_updated_at before update on whatsapp_groups for each row execute function public.set_updated_at();
