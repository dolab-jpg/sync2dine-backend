-- Username on profiles + org invite tokens for team join flow

alter table public.profiles
  add column if not exists username text;

-- Backfill unique usernames from email local-part (dedupe with suffix if needed)
do $$
declare
  r record;
  base text;
  candidate text;
  n int;
begin
  for r in
    select id, email from public.profiles where username is null or username = ''
  loop
    base := lower(regexp_replace(split_part(coalesce(r.email, 'user'), '@', 1), '[^a-z0-9._-]', '', 'g'));
    if base is null or length(base) < 3 then
      base := 'user';
    end if;
    if length(base) > 30 then
      base := left(base, 30);
    end if;
    candidate := base;
    n := 0;
    while exists (select 1 from public.profiles where username = candidate and id <> r.id) loop
      n := n + 1;
      candidate := left(base, greatest(1, 30 - length(n::text) - 1)) || '_' || n::text;
    end loop;
    update public.profiles set username = candidate where id = r.id;
  end loop;
end $$;

create unique index if not exists profiles_username_unique
  on public.profiles (username)
  where username is not null and username <> '';

create index if not exists idx_profiles_username_lower
  on public.profiles (lower(username));

create table if not exists public.org_invites (
  id uuid primary key default extensions.uuid_generate_v4(),
  token text not null unique,
  org_id uuid not null references public.organizations(id) on delete cascade,
  email text not null,
  role public.user_role not null default 'staff',
  invited_by uuid references public.profiles(id) on delete set null,
  expires_at timestamptz not null default (now() + interval '7 days'),
  accepted_at timestamptz,
  user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists idx_org_invites_token on public.org_invites (token);
create index if not exists idx_org_invites_org_id on public.org_invites (org_id);

alter table public.org_invites enable row level security;

drop policy if exists "org_invites_select_org" on public.org_invites;
create policy "org_invites_select_org" on public.org_invites for select
  using (public.org_access(org_id) or public.is_platform_owner());

drop policy if exists "org_invites_insert_org" on public.org_invites;
create policy "org_invites_insert_org" on public.org_invites for insert
  with check (public.org_access(org_id) or public.is_platform_owner());

drop policy if exists "org_invites_update_org" on public.org_invites;
create policy "org_invites_update_org" on public.org_invites for update
  using (public.org_access(org_id) or public.is_platform_owner());

-- Include username from signup metadata
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, name, role, org_id, username)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)),
    coalesce((new.raw_user_meta_data->>'role')::user_role, 'staff'),
    nullif(new.raw_user_meta_data->>'org_id', '')::uuid,
    nullif(lower(trim(coalesce(new.raw_user_meta_data->>'username', ''))), '')
  )
  on conflict (id) do update set
    email = excluded.email,
    name = coalesce(nullif(excluded.name, ''), profiles.name),
    role = excluded.role,
    org_id = coalesce(excluded.org_id, profiles.org_id),
    username = coalesce(excluded.username, profiles.username),
    updated_at = now();
  return new;
end;
$$;
