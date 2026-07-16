-- Sync2Dine restaurant ops: kiosk users and food orders.

alter type public.user_role add value if not exists 'kiosk';
alter type public.org_plan add value if not exists 'sync2dine_platform';
alter type public.org_plan add value if not exists 'sync2dine_kiosk';

create table if not exists public.orders (
  id uuid primary key default extensions.uuid_generate_v4(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  customer_id text,
  customer_name text not null default '',
  customer_phone text not null default '',
  channel text not null default 'phone',
  order_type text not null default 'collection',
  status text not null default 'new',
  payment_status text not null default 'unpaid',
  payment_method text,
  order_number integer not null,
  items jsonb not null default '[]'::jsonb,
  total numeric(10,2) not null default 0,
  delivery_address text,
  notes text not null default '',
  review_score integer,
  review_text text,
  review_called_at timestamptz,
  last_winback_call_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists orders_org_number_unique
  on public.orders (org_id, order_number);

create index if not exists idx_orders_org_created
  on public.orders (org_id, created_at desc);

create index if not exists idx_orders_customer_phone
  on public.orders (org_id, customer_phone);

alter table public.orders enable row level security;

drop policy if exists "orders_org_members_select" on public.orders;
create policy "orders_org_members_select" on public.orders for select
  using (org_id = public.current_org_id());

drop policy if exists "orders_org_members_write" on public.orders;
create policy "orders_org_members_write" on public.orders for all
  using (org_id = public.current_org_id())
  with check (org_id = public.current_org_id());
