-- Provisioned Auth users may pass role + org_id in raw_user_meta_data.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, name, role, org_id)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)),
    coalesce((new.raw_user_meta_data->>'role')::user_role, 'staff'),
    nullif(new.raw_user_meta_data->>'org_id', '')::uuid
  )
  on conflict (id) do update set
    email = excluded.email,
    name = coalesce(nullif(excluded.name, ''), profiles.name),
    role = excluded.role,
    org_id = coalesce(excluded.org_id, profiles.org_id),
    updated_at = now();
  return new;
end;
$$;
