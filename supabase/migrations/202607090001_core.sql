-- Core: organizations, profiles, integrations

create extension if not exists "uuid-ossp";

create type org_status as enum ('trial', 'active', 'past_due', 'suspended', 'cancelled');
create type org_plan as enum ('starter', 'pro', 'enterprise');
create type user_role as enum (
  'platform_owner', 'super_admin', 'manager', 'staff', 'builder', 'recruitment', 'customer'
);

create table organizations (
  id uuid primary key default uuid_generate_v4(),
  legacy_id text unique,
  name text not null,
  contact_name text not null default '',
  contact_email text not null default '',
  contact_phone text not null default '',
  address text,
  status org_status not null default 'trial',
  plan org_plan not null default 'starter',
  openai_api_key_encrypted text not null default '',
  monthly_token_cap bigint not null default 500000,
  stripe_customer_id text,
  stripe_subscription_id text,
  subscription_status text,
  current_period_end timestamptz,
  trial_ends_at timestamptz,
  whatsapp_phone_number_id text,
  phone_did text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  legacy_id text unique,
  org_id uuid references organizations(id) on delete set null,
  name text not null default '',
  email text not null,
  role user_role not null default 'staff',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table integrations (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references organizations(id) on delete cascade,
  integration_id text not null,
  enabled boolean not null default false,
  mock_mode boolean not null default true,
  values_encrypted jsonb not null default '{}',
  status text not null default 'disconnected',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, integration_id)
);

create index idx_profiles_org_id on profiles(org_id);
create index idx_profiles_email on profiles(email);
create index idx_integrations_org_id on integrations(org_id);

-- Helper: get current user's org_id
create or replace function public.user_org_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select org_id from profiles where id = auth.uid();
$$;

-- Helper: check if current user is platform owner
create or replace function public.is_platform_owner()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from profiles where id = auth.uid() and role = 'platform_owner'
  );
$$;

-- Auto-create profile on signup
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, name, role)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)),
    coalesce((new.raw_user_meta_data->>'role')::user_role, 'staff')
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- updated_at trigger
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger organizations_updated_at before update on organizations
  for each row execute function public.set_updated_at();
create trigger profiles_updated_at before update on profiles
  for each row execute function public.set_updated_at();
create trigger integrations_updated_at before update on integrations
  for each row execute function public.set_updated_at();
