-- code_fix_jobs is accessed only via /api/ai/code-fix* with the service role.
-- The previous FOR ALL using (true) policy exposed the queue to anon/authenticated.

drop policy if exists code_fix_jobs_service_all on public.code_fix_jobs;

revoke all on public.code_fix_jobs from anon, authenticated;
