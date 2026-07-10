/**
 * Supabase data adapter — replaces JSON file persistence for the Node companion.
 * Frontend writes directly via Supabase client; this adapter serves AI/webhooks/telephony.
 */
import { getSupabaseAdmin, resolveOrgUuid, DEFAULT_ORG_UUID } from './supabase-admin.js';
import type { SyncedData, AgentSettings, PhoneLine } from './data-store.js';

const defaultAgentSettings: AgentSettings = {
  isActive: true,
  updatedAt: new Date().toISOString(),
};

function isSupabaseConfigured(): boolean {
  return Boolean(process.env.SUPABASE_URL?.trim() && process.env.SUPABASE_SERVICE_ROLE_KEY?.trim());
}

function rowToRecord<T extends Record<string, unknown>>(rows: Array<{ id: string; data: unknown }>): T[] {
  return rows.map(r => ({ id: r.id, ...(r.data as Record<string, unknown>) })) as T[];
}

export async function loadSyncedDataFromSupabase(orgId?: string | null): Promise<SyncedData> {
  const orgUuid = await resolveOrgUuid(orgId);
  const supabase = getSupabaseAdmin();

  const [
    projectsRes, contactsRes, buildersRes, customersRes, quotesRes,
    callsRes, outboundRes, jobsRes, candidatesRes, interviewsRes,
    bankAccountsRes, bankTxRes, receiptsRes, contractsRes, planningRes,
    phoneLinesRes, agentRes, waGroupsRes, waSessionsRes,
  ] = await Promise.all([
    supabase.from('projects').select('id, data, status, customer_id, quote_id, portal_token').eq('org_id', orgUuid),
    supabase.from('contacts').select('id, data').eq('org_id', orgUuid),
    supabase.from('builders').select('id, data').eq('org_id', orgUuid),
    supabase.from('customers').select('id, data').eq('org_id', orgUuid),
    supabase.from('quotes').select('id, data').eq('org_id', orgUuid),
    supabase.from('calls').select('id, data').eq('org_id', orgUuid),
    supabase.from('outbound_queue').select('id, data').eq('org_id', orgUuid),
    supabase.from('recruitment_jobs').select('id, data').eq('org_id', orgUuid),
    supabase.from('recruitment_candidates').select('id, data').eq('org_id', orgUuid),
    supabase.from('recruitment_interviews').select('id, data').eq('org_id', orgUuid),
    supabase.from('bank_accounts').select('id, data').eq('org_id', orgUuid),
    supabase.from('bank_transactions').select('id, data').eq('org_id', orgUuid),
    supabase.from('client_receipts').select('id, data').eq('org_id', orgUuid),
    supabase.from('contracts').select('id, data').eq('org_id', orgUuid),
    supabase.from('planning_applications').select('id, data').eq('org_id', orgUuid),
    supabase.from('phone_lines').select('id, data').eq('org_id', orgUuid),
    supabase.from('agent_settings').select('*').eq('org_id', orgUuid).maybeSingle(),
    supabase.from('whatsapp_groups').select('project_id, data').eq('org_id', orgUuid),
    supabase.from('whatsapp_sessions').select('*').eq('org_id', orgUuid),
  ]);

  const projects = (projectsRes.data ?? []).map(p => ({
    id: p.id,
    status: p.status,
    customerId: p.customer_id,
    quoteId: p.quote_id,
    portalToken: p.portal_token,
    ...(p.data as Record<string, unknown>),
  }));

  const whatsappGroups: Record<string, Record<string, unknown>> = {};
  for (const g of waGroupsRes.data ?? []) {
    whatsappGroups[g.project_id] = g.data as Record<string, unknown>;
  }

  const sessions = (waSessionsRes.data ?? []).map(s => ({
    phone: s.phone,
    lastInboundAt: s.last_inbound_at,
    channel: s.channel,
    groupId: s.group_id,
  }));

  const agentRow = agentRes.data;
  const agentSettings: AgentSettings = agentRow
    ? { isActive: agentRow.is_active, activeVoiceId: agentRow.active_voice_id ?? undefined, updatedAt: agentRow.updated_at }
    : { ...defaultAgentSettings };

  return {
    projects,
    contacts: rowToRecord(contactsRes.data ?? []),
    builders: rowToRecord(buildersRes.data ?? []),
    sessions,
    whatsappGroups,
    calls: rowToRecord(callsRes.data ?? []),
    outboundQueue: rowToRecord(outboundRes.data ?? []),
    recruitmentJobs: rowToRecord(jobsRes.data ?? []),
    recruitmentCandidates: rowToRecord(candidatesRes.data ?? []),
    recruitmentInterviews: rowToRecord(interviewsRes.data ?? []),
    quotes: rowToRecord(quotesRes.data ?? []),
    customers: rowToRecord(customersRes.data ?? []),
    bankAccounts: rowToRecord(bankAccountsRes.data ?? []),
    bankTransactions: rowToRecord(bankTxRes.data ?? []),
    clientReceipts: rowToRecord(receiptsRes.data ?? []),
    contracts: rowToRecord(contractsRes.data ?? []),
    planningApplications: rowToRecord(planningRes.data ?? []),
    agentSettings,
    phoneLines: rowToRecord<PhoneLine>(phoneLinesRes.data ?? []),
  };
}

export async function syncDataToSupabase(data: Partial<SyncedData>, orgId?: string | null): Promise<void> {
  if (!isSupabaseConfigured()) return;
  const orgUuid = await resolveOrgUuid(orgId);
  const supabase = getSupabaseAdmin();

  const upsertRows = async (
    table: string,
    rows: Array<Record<string, unknown>> | undefined,
    extra?: (row: Record<string, unknown>) => Record<string, unknown>,
  ) => {
    if (!rows?.length) return;
    const payload = rows.map(row => {
      const id = String(row.id);
      const { id: _id, ...rest } = row;
      return {
        id,
        org_id: orgUuid,
        data: rest,
        ...(extra ? extra(row) : {}),
      };
    });
    await supabase.from(table).upsert(payload, { onConflict: 'org_id,id' });
  };

  if (data.projects) {
    const payload = data.projects.map(p => {
      const rec = p as Record<string, unknown>;
      const { id, status, customerId, quoteId, portalToken, ...rest } = rec;
      return {
        id: String(id),
        org_id: orgUuid,
        status: status ? String(status) : null,
        customer_id: customerId ? String(customerId) : null,
        quote_id: quoteId ? String(quoteId) : null,
        portal_token: portalToken ? String(portalToken) : null,
        data: rest,
        updated_at: new Date().toISOString(),
      };
    });
    await supabase.from('projects').upsert(payload, { onConflict: 'org_id,id' });
  }

  await upsertRows('contacts', data.contacts);
  await upsertRows('builders', data.builders);
  await upsertRows('customers', data.customers);
  await upsertRows('quotes', data.quotes);
  await upsertRows('calls', data.calls);
  await upsertRows('outbound_queue', data.outboundQueue);
  await upsertRows('recruitment_jobs', data.recruitmentJobs);
  await upsertRows('recruitment_candidates', data.recruitmentCandidates);
  await upsertRows('recruitment_interviews', data.recruitmentInterviews);
  await upsertRows('bank_accounts', data.bankAccounts);
  await upsertRows('bank_transactions', data.bankTransactions);
  await upsertRows('client_receipts', data.clientReceipts);
  await upsertRows('contracts', data.contracts);
  await upsertRows('planning_applications', data.planningApplications);
  await upsertRows('phone_lines', data.phoneLines);

  if (data.agentSettings) {
    await supabase.from('agent_settings').upsert({
      org_id: orgUuid,
      is_active: data.agentSettings.isActive,
      active_voice_id: data.agentSettings.activeVoiceId ?? null,
      updated_at: new Date().toISOString(),
    });
  }

  if (data.whatsappGroups) {
    const payload = Object.entries(data.whatsappGroups).map(([projectId, group]) => ({
      project_id: projectId,
      org_id: orgUuid,
      data: group,
    }));
    if (payload.length) {
      await supabase.from('whatsapp_groups').upsert(payload, { onConflict: 'org_id,project_id' });
    }
  }

  if (data.sessions) {
    for (const s of data.sessions) {
      await supabase.from('whatsapp_sessions').upsert({
        org_id: orgUuid,
        phone: String(s.phone),
        channel: String(s.channel ?? 'individual'),
        group_id: s.groupId ? String(s.groupId) : null,
        last_inbound_at: String(s.lastInboundAt ?? new Date().toISOString()),
      }, { onConflict: 'org_id,phone' });
    }
  }
}

export { isSupabaseConfigured, DEFAULT_ORG_UUID };
