-- Durable call recording audio (private bucket; API uses service role + signed URLs)

insert into storage.buckets (id, name, public, file_size_limit)
values
  ('call-recordings', 'call-recordings', false, 104857600)
on conflict (id) do nothing;

-- Org members can read recordings under their org folder
create policy "call_recordings_select" on storage.objects for select
  using (
    bucket_id = 'call-recordings'
    and (storage.foldername(name))[1] = public.user_org_id()::text
  );

-- Inserts/updates go through service role from the API (bypass RLS).
-- Platform owners retain full access via existing platform_owner_storage policy.
