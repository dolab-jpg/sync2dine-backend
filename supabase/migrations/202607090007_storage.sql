-- Storage buckets and policies

insert into storage.buckets (id, name, public, file_size_limit)
values
  ('project-files', 'project-files', false, 52428800),
  ('receipts', 'receipts', false, 10485760),
  ('contracts', 'contracts', false, 20971520),
  ('voice-samples', 'voice-samples', false, 10485760)
on conflict (id) do nothing;

-- Org members can read/write project files under their org folder
create policy "project_files_select" on storage.objects for select
  using (
    bucket_id = 'project-files'
    and (storage.foldername(name))[1] = public.user_org_id()::text
  );

create policy "project_files_insert" on storage.objects for insert
  with check (
    bucket_id = 'project-files'
    and (storage.foldername(name))[1] = public.user_org_id()::text
  );

create policy "project_files_update" on storage.objects for update
  using (
    bucket_id = 'project-files'
    and (storage.foldername(name))[1] = public.user_org_id()::text
  );

create policy "project_files_delete" on storage.objects for delete
  using (
    bucket_id = 'project-files'
    and (storage.foldername(name))[1] = public.user_org_id()::text
  );

-- Receipts
create policy "receipts_select" on storage.objects for select
  using (bucket_id = 'receipts' and (storage.foldername(name))[1] = public.user_org_id()::text);
create policy "receipts_insert" on storage.objects for insert
  with check (bucket_id = 'receipts' and (storage.foldername(name))[1] = public.user_org_id()::text);

-- Contracts
create policy "contracts_select" on storage.objects for select
  using (bucket_id = 'contracts' and (storage.foldername(name))[1] = public.user_org_id()::text);
create policy "contracts_insert" on storage.objects for insert
  with check (bucket_id = 'contracts' and (storage.foldername(name))[1] = public.user_org_id()::text);

-- Voice samples (org admins)
create policy "voice_samples_select" on storage.objects for select
  using (bucket_id = 'voice-samples' and (storage.foldername(name))[1] = public.user_org_id()::text);
create policy "voice_samples_insert" on storage.objects for insert
  with check (bucket_id = 'voice-samples' and (storage.foldername(name))[1] = public.user_org_id()::text);

-- Platform owner full access to all buckets
create policy "platform_owner_storage" on storage.objects for all
  using (public.is_platform_owner())
  with check (public.is_platform_owner());
