-- Weekly usage/overage billing periods (customer sell breakdown + internal margins)

alter table organizations
  add column if not exists saas_package_id text;

create table if not exists billing_periods (
  id text primary key,
  org_id uuid not null references organizations(id) on delete cascade,
  week_start timestamptz not null,
  week_end timestamptz not null,
  iso_week text not null,
  fare_version text not null,
  type text not null default 'usage_overage',
  status text not null default 'draft',
  customer_subtotal_gbp numeric not null default 0,
  stripe_invoice_id text,
  stripe_hosted_invoice_url text,
  customer_breakdown_json jsonb not null default '{}'::jsonb,
  internal_margin_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, week_start, type)
);

create index if not exists idx_billing_periods_org_week
  on billing_periods (org_id, week_start desc);

create index if not exists idx_billing_periods_stripe_invoice
  on billing_periods (stripe_invoice_id)
  where stripe_invoice_id is not null;

alter table billing_periods enable row level security;

-- Org members can read their own periods but only customer-facing columns via API.
-- Direct select is allowed for org members; platform owner sees all.
-- internal_margin_json is still in the row — org APIs must strip it in application code.
drop policy if exists billing_periods_select_org on billing_periods;
create policy billing_periods_select_org on billing_periods for select
  using (public.org_access(org_id));

drop policy if exists billing_periods_write_platform on billing_periods;
create policy billing_periods_write_platform on billing_periods for all
  using (public.is_platform_owner())
  with check (public.is_platform_owner());
