-- Preferred UI / worker language for staff, admins, and builders.
-- Customer-facing documents and communications remain English.

alter table public.profiles
  add column if not exists preferred_language text not null default 'en';

alter table public.profiles
  drop constraint if exists profiles_preferred_language_check;

alter table public.profiles
  add constraint profiles_preferred_language_check
  check (preferred_language in ('en', 'sq', 'uk', 'ru', 'zh', 'es', 'pl', 'fa'));

comment on column public.profiles.preferred_language is
  'Worker/admin UI language. Customer docs and outbound customer communication stay English.';

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, name, role, org_id, username, preferred_language)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)),
    coalesce((new.raw_user_meta_data->>'role')::user_role, 'staff'),
    nullif(new.raw_user_meta_data->>'org_id', '')::uuid,
    nullif(lower(trim(coalesce(new.raw_user_meta_data->>'username', ''))), ''),
    coalesce(
      nullif(lower(trim(coalesce(new.raw_user_meta_data->>'preferred_language', ''))), ''),
      'en'
    )
  )
  on conflict (id) do update set
    email = excluded.email,
    name = coalesce(nullif(excluded.name, ''), profiles.name),
    role = excluded.role,
    org_id = coalesce(excluded.org_id, profiles.org_id),
    username = coalesce(excluded.username, profiles.username),
    preferred_language = coalesce(excluded.preferred_language, profiles.preferred_language, 'en'),
    updated_at = now();
  return new;
end;
$$;
