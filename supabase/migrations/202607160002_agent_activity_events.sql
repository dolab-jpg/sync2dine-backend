-- Live "Cynthia is doing this" activity feed.
-- Org + user scoped events written by the backend (service role) and streamed
-- to logged-in staff devices via Supabase Realtime.

create table if not exists public.agent_activity_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  -- Text (not uuid FK): staff ids may be Supabase auth uuids or legacy platform ids.
  target_user_id text not null,
  seq bigint generated always as identity,
  session_id text,
  channel text,
  capability text,
  action text,
  phase text not null check (phase in ('started', 'working', 'changed', 'saved', 'navigate', 'completed', 'error')),
  summary text not null,
  route text,
  payload jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_agent_activity_events_org_user_seq
  on public.agent_activity_events (org_id, target_user_id, seq desc);
create index if not exists idx_agent_activity_events_created_at
  on public.agent_activity_events (created_at);

alter table public.agent_activity_events enable row level security;

-- Org members may read only their own events (profiles.id = auth.uid()).
-- Rows targeting legacy (non-auth-uuid) staff ids are served through the
-- backend replay API instead, which reads with the service role.
create policy "agent_activity_events_select_own" on public.agent_activity_events
  for select
  using (
    public.org_access(org_id)
    and (target_user_id = (select auth.uid())::text or public.is_platform_owner())
  );

-- No insert/update/delete policies: only the service role writes.

-- Stream inserts to subscribed clients (RLS applies to Realtime as well).
do $$
begin
  alter publication supabase_realtime add table public.agent_activity_events;
exception
  when duplicate_object then null;
end $$;
