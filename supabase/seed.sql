-- Seed demo organization and note for platform owner setup
-- Platform owner auth user must be created via Supabase Auth (see scripts/migrate-to-supabase.ts)

insert into organizations (
  id,
  legacy_id,
  name,
  contact_name,
  contact_email,
  contact_phone,
  status,
  plan,
  monthly_token_cap
) values (
  '00000000-0000-0000-0000-000000000001',
  'default',
  'TradePro Demo',
  'Demo Admin',
  'admin@tradepro.com',
  '+44 7700 900000',
  'active',
  'pro',
  2000000
) on conflict (legacy_id) do nothing;

insert into agent_settings (org_id, is_active, data)
values (
  '00000000-0000-0000-0000-000000000001',
  true,
  '{"updatedAt": "2026-07-09T00:00:00Z"}'::jsonb
) on conflict (org_id) do nothing;

insert into recruitment_jobs (id, org_id, data) values
  ('J001', '00000000-0000-0000-0000-000000000001', '{"title":"Senior Sales Representative","department":"sales","location":"London, UK","status":"open","description":"Luxury bathroom sales.","salaryRange":"£35k-£45k","employmentType":"full-time","requiredSkills":["Sales"],"qualifications":[],"createdAt":"2026-03-15","positions":2}'::jsonb),
  ('J002', '00000000-0000-0000-0000-000000000001', '{"title":"Microcement Installation Specialist","department":"construction","location":"Manchester, UK","status":"open","description":"Microcement specialist.","salaryRange":"£32k-£42k","employmentType":"full-time","requiredSkills":["Microcement"],"qualifications":[],"createdAt":"2026-03-20","positions":3}'::jsonb),
  ('J003', '00000000-0000-0000-0000-000000000001', '{"title":"Office Administrator","department":"office","location":"Birmingham, UK","status":"open","description":"Office admin.","salaryRange":"£24k-£28k","employmentType":"full-time","requiredSkills":["Admin"],"qualifications":[],"createdAt":"2026-04-01","positions":1}'::jsonb)
on conflict (org_id, id) do nothing;
