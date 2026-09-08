-- Candidate CV files (private bucket; API uses service role + signed URLs)

insert into storage.buckets (id, name, public, file_size_limit)
values
  ('candidate-cvs', 'candidate-cvs', false, 26214400)
on conflict (id) do nothing;

-- Org members can read CVs under their org folder
create policy "candidate_cvs_select" on storage.objects for select
  using (
    bucket_id = 'candidate-cvs'
    and (storage.foldername(name))[1] = public.user_org_id()::text
  );

-- Inserts/updates go through service role from the API (bypass RLS).
-- Platform owners retain full access via existing platform_owner_storage policy.
