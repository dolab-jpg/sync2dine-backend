-- Row Level Security policies for multi-tenant isolation

alter table organizations enable row level security;
alter table profiles enable row level security;
alter table integrations enable row level security;
alter table customers enable row level security;
alter table contacts enable row level security;
alter table builders enable row level security;
alter table quotes enable row level security;
alter table products enable row level security;
alter table pricing_rules enable row level security;
alter table projects enable row level security;
alter table project_files enable row level security;
alter table whatsapp_groups enable row level security;
alter table whatsapp_sessions enable row level security;
alter table recruitment_jobs enable row level security;
alter table recruitment_candidates enable row level security;
alter table recruitment_interviews enable row level security;
alter table bank_accounts enable row level security;
alter table bank_transactions enable row level security;
alter table client_receipts enable row level security;
alter table contracts enable row level security;
alter table planning_applications enable row level security;
alter table calls enable row level security;
alter table outbound_queue enable row level security;
alter table phone_lines enable row level security;
alter table agent_settings enable row level security;
alter table usage_events enable row level security;
alter table conversation_logs enable row level security;
alter table ai_studio_config enable row level security;

-- Profiles: users read own profile; platform owner reads all
create policy "profiles_select_own" on profiles for select
  using (id = auth.uid() or public.is_platform_owner());
create policy "profiles_update_own" on profiles for update
  using (id = auth.uid() or public.is_platform_owner());

-- Organizations
create policy "orgs_select_member" on organizations for select
  using (id = public.user_org_id() or public.is_platform_owner());
create policy "orgs_insert_platform_owner" on organizations for insert
  with check (public.is_platform_owner());
create policy "orgs_update_platform_owner" on organizations for update
  using (public.is_platform_owner());
create policy "orgs_delete_platform_owner" on organizations for delete
  using (public.is_platform_owner());

-- Generic org-scoped CRUD macro via helper
create or replace function public.org_access(org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select org_id = public.user_org_id() or public.is_platform_owner();
$$;

-- Integrations
create policy "integrations_org" on integrations for all
  using (public.org_access(org_id))
  with check (public.org_access(org_id));

-- CRM tables
create policy "customers_org" on customers for all using (public.org_access(org_id)) with check (public.org_access(org_id));
create policy "contacts_org" on contacts for all using (public.org_access(org_id)) with check (public.org_access(org_id));
create policy "builders_org" on builders for all using (public.org_access(org_id)) with check (public.org_access(org_id));
create policy "quotes_org" on quotes for all using (public.org_access(org_id)) with check (public.org_access(org_id));
create policy "products_org" on products for all using (public.org_access(org_id)) with check (public.org_access(org_id));
create policy "pricing_rules_org" on pricing_rules for all using (public.org_access(org_id)) with check (public.org_access(org_id));

-- Projects
create policy "projects_org" on projects for all using (public.org_access(org_id)) with check (public.org_access(org_id));
create policy "project_files_org" on project_files for all using (public.org_access(org_id)) with check (public.org_access(org_id));
create policy "whatsapp_groups_org" on whatsapp_groups for all using (public.org_access(org_id)) with check (public.org_access(org_id));
create policy "whatsapp_sessions_org" on whatsapp_sessions for all using (public.org_access(org_id)) with check (public.org_access(org_id));

-- Ops tables
create policy "recruitment_jobs_org" on recruitment_jobs for all using (public.org_access(org_id)) with check (public.org_access(org_id));
create policy "recruitment_candidates_org" on recruitment_candidates for all using (public.org_access(org_id)) with check (public.org_access(org_id));
create policy "recruitment_interviews_org" on recruitment_interviews for all using (public.org_access(org_id)) with check (public.org_access(org_id));
create policy "bank_accounts_org" on bank_accounts for all using (public.org_access(org_id)) with check (public.org_access(org_id));
create policy "bank_transactions_org" on bank_transactions for all using (public.org_access(org_id)) with check (public.org_access(org_id));
create policy "client_receipts_org" on client_receipts for all using (public.org_access(org_id)) with check (public.org_access(org_id));
create policy "contracts_org" on contracts for all using (public.org_access(org_id)) with check (public.org_access(org_id));
create policy "planning_applications_org" on planning_applications for all using (public.org_access(org_id)) with check (public.org_access(org_id));
create policy "calls_org" on calls for all using (public.org_access(org_id)) with check (public.org_access(org_id));
create policy "outbound_queue_org" on outbound_queue for all using (public.org_access(org_id)) with check (public.org_access(org_id));
create policy "phone_lines_org" on phone_lines for all using (public.org_access(org_id)) with check (public.org_access(org_id));
create policy "agent_settings_org" on agent_settings for all using (public.org_access(org_id)) with check (public.org_access(org_id));

-- Audit tables
create policy "usage_events_org" on usage_events for all using (public.org_access(org_id)) with check (public.org_access(org_id));
create policy "conversation_logs_org" on conversation_logs for all using (public.org_access(org_id)) with check (public.org_access(org_id));
create policy "ai_studio_config_org" on ai_studio_config for all using (public.org_access(org_id)) with check (public.org_access(org_id));

-- Public portal access via RPC (token-based, no auth required)
create or replace function public.get_project_by_portal_token(token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  result jsonb;
begin
  select jsonb_build_object(
    'id', p.id,
    'org_id', p.org_id,
    'projectName', p.data->>'projectName',
    'customerName', p.data->>'customerName',
    'status', p.status,
    'startDate', p.data->>'startDate',
    'finishDate', p.data->>'finishDate',
    'description', p.data->>'description',
    'totalCustomerCost', p.data->>'totalCustomerCost',
    'tasks', p.data->'tasks',
    'milestones', p.data->'milestones',
    'paymentStages', p.data->'paymentStages',
    'messages', p.data->'messages',
    'changeOrders', p.data->'changeOrders',
    'files', p.data->'files',
    'photos', p.data->'photos'
  ) into result
  from projects p
  where p.portal_token = token;
  return result;
end;
$$;

grant execute on function public.get_project_by_portal_token(text) to anon, authenticated;

create or replace function public.get_contract_by_token(token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  result jsonb;
begin
  select jsonb_build_object(
    'id', c.id,
    'org_id', c.org_id,
    'status', c.status,
    'data', c.data,
    'signed_at', c.signed_at
  ) into result
  from contracts c
  where c.signing_token = token;
  return result;
end;
$$;

grant execute on function public.get_contract_by_token(text) to anon, authenticated;
