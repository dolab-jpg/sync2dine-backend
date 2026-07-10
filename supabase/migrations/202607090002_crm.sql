-- CRM: customers, contacts, builders, quotes, products, pricing_rules

create table customers (
  id text not null,
  org_id uuid not null references organizations(id) on delete cascade,
  data jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, id)
);

create table contacts (
  id text not null,
  org_id uuid not null references organizations(id) on delete cascade,
  data jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, id)
);

create table builders (
  id text not null,
  org_id uuid not null references organizations(id) on delete cascade,
  data jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, id)
);

create table quotes (
  id text not null,
  org_id uuid not null references organizations(id) on delete cascade,
  customer_id text,
  status text,
  total numeric,
  data jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, id)
);

create table products (
  id text not null,
  org_id uuid not null references organizations(id) on delete cascade,
  data jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, id)
);

create table pricing_rules (
  id text not null,
  org_id uuid not null references organizations(id) on delete cascade,
  data jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, id)
);

create index idx_customers_org on customers(org_id);
create index idx_contacts_org on contacts(org_id);
create index idx_builders_org on builders(org_id);
create index idx_quotes_org on quotes(org_id);
create index idx_quotes_customer on quotes(org_id, customer_id);
create index idx_products_org on products(org_id);
create index idx_pricing_rules_org on pricing_rules(org_id);

create trigger customers_updated_at before update on customers for each row execute function public.set_updated_at();
create trigger contacts_updated_at before update on contacts for each row execute function public.set_updated_at();
create trigger builders_updated_at before update on builders for each row execute function public.set_updated_at();
create trigger quotes_updated_at before update on quotes for each row execute function public.set_updated_at();
create trigger products_updated_at before update on products for each row execute function public.set_updated_at();
create trigger pricing_rules_updated_at before update on pricing_rules for each row execute function public.set_updated_at();
