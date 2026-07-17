-- Sync2Dine: order connector fields, call links, dining tables, reservations, connector config/events.

-- Orders: external sync + call recording links
alter table public.orders add column if not exists external_id text;
alter table public.orders add column if not exists source text not null default 'sync2dine';
alter table public.orders add column if not exists source_status text;
alter table public.orders add column if not exists sync_state text not null default 'local';
alter table public.orders add column if not exists placed_at timestamptz;
alter table public.orders add column if not exists due_at timestamptz;
alter table public.orders add column if not exists provider_meta jsonb not null default '{}'::jsonb;
alter table public.orders add column if not exists customer_allergies text not null default '';
alter table public.orders add column if not exists allergy_confirmed boolean not null default false;
alter table public.orders add column if not exists source_call_id text;
alter table public.orders add column if not exists recording_url text;
alter table public.orders add column if not exists call_ids jsonb not null default '[]'::jsonb;

create unique index if not exists orders_org_source_external_unique
  on public.orders (org_id, source, external_id)
  where external_id is not null and external_id <> '';

create index if not exists idx_orders_source_call_id
  on public.orders (org_id, source_call_id)
  where source_call_id is not null and source_call_id <> '';

-- Dining tables inventory
create table if not exists public.dining_tables (
  id uuid primary key default extensions.uuid_generate_v4(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  label text not null,
  seats integer not null check (seats > 0),
  zone text,
  active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_dining_tables_org_active
  on public.dining_tables (org_id, active, sort_order);

alter table public.dining_tables enable row level security;

drop policy if exists "dining_tables_org_members" on public.dining_tables;
create policy "dining_tables_org_members" on public.dining_tables for all
  using (public.org_access(org_id))
  with check (public.org_access(org_id));

-- Table reservations
create table if not exists public.reservations (
  id uuid primary key default extensions.uuid_generate_v4(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  table_id uuid references public.dining_tables(id) on delete set null,
  party_size integer not null check (party_size > 0),
  customer_name text not null default '',
  customer_phone text not null default '',
  customer_id text,
  starts_at timestamptz not null,
  ends_at timestamptz,
  status text not null default 'confirmed',
  channel text not null default 'phone',
  call_id text,
  recording_url text,
  call_ids jsonb not null default '[]'::jsonb,
  notes text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_reservations_org_starts
  on public.reservations (org_id, starts_at);

create index if not exists idx_reservations_org_phone
  on public.reservations (org_id, customer_phone);

create index if not exists idx_reservations_call_id
  on public.reservations (org_id, call_id)
  where call_id is not null and call_id <> '';

alter table public.reservations enable row level security;

drop policy if exists "reservations_org_members" on public.reservations;
create policy "reservations_org_members" on public.reservations for all
  using (public.org_access(org_id))
  with check (public.org_access(org_id));

-- Connector configuration (secrets server-side; FE reads masked status via API)
create table if not exists public.connector_configs (
  org_id uuid primary key references public.organizations(id) on delete cascade,
  provider text not null default 'mock',
  enabled boolean not null default false,
  direction text not null default 'inbound',
  outbound_url text not null default '',
  webhook_secret text not null default '',
  status_map jsonb not null default '{}'::jsonb,
  deliverect_account_id text not null default '',
  deliverect_location_id text not null default '',
  last_menu_sync_at timestamptz,
  menu_version text not null default '',
  last_inbound_at timestamptz,
  last_outbound_at timestamptz,
  last_error text not null default '',
  updated_at timestamptz not null default now()
);

alter table public.connector_configs enable row level security;

drop policy if exists "connector_configs_org_members" on public.connector_configs;
create policy "connector_configs_org_members" on public.connector_configs for all
  using (public.org_access(org_id))
  with check (public.org_access(org_id));

-- Connector event log + idempotency
create table if not exists public.connector_events (
  id uuid primary key default extensions.uuid_generate_v4(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  provider text not null default 'mock',
  direction text not null default 'inbound',
  event_type text not null,
  idempotency_key text,
  external_id text,
  status text not null default 'ok',
  payload jsonb not null default '{}'::jsonb,
  error text not null default '',
  created_at timestamptz not null default now()
);

create unique index if not exists connector_events_idempotency_unique
  on public.connector_events (org_id, provider, idempotency_key)
  where idempotency_key is not null and idempotency_key <> '';

create index if not exists idx_connector_events_org_created
  on public.connector_events (org_id, created_at desc);

alter table public.connector_events enable row level security;

drop policy if exists "connector_events_org_members" on public.connector_events;
create policy "connector_events_org_members" on public.connector_events for select
  using (public.org_access(org_id));

-- Outbound webhook retry queue
create table if not exists public.connector_outbound_queue (
  id uuid primary key default extensions.uuid_generate_v4(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  provider text not null default 'mock',
  target_url text not null,
  event_type text not null,
  body jsonb not null default '{}'::jsonb,
  signature text not null default '',
  attempts integer not null default 0,
  max_attempts integer not null default 5,
  next_attempt_at timestamptz not null default now(),
  last_error text not null default '',
  delivered_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_connector_outbound_queue_due
  on public.connector_outbound_queue (next_attempt_at)
  where delivered_at is null;

alter table public.connector_outbound_queue enable row level security;

drop policy if exists "connector_outbound_queue_org_members" on public.connector_outbound_queue;
create policy "connector_outbound_queue_org_members" on public.connector_outbound_queue for select
  using (public.org_access(org_id));
