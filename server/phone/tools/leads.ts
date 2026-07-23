import {
  appendCustomerCallActivity,
  appendProjectMessageRecord,
  enqueueOutboundCall,
  getDataStore,
  getRequestOrgId,
  lookupContactByPhone,
  normalizePhoneExport,
  saveCall,
  saveCustomerRecord,
  saveQuoteRecord,
  saveRecruitmentCandidate,
  saveRecruitmentInterview,
  syncData,
} from '../../data-store';
import type { CallIntent, OutboundCampaignTemplate } from '../../telephony/types';
import type { OrchestratorRequest } from '../../orchestrator-types';
import { sendToStaffCynthiaInternal } from '../../cynthia-routes';
import { actionRequiresConfirmation } from '../../action-registry';
import { formatSpokenGbp } from '../spoken-money';
import { resolvePhoneCallerIdentity } from '../phone-auth';
import { ensureEnglishForCustomerSend } from '../../outbound-english-guard';
import { resolveTransferDestination, resolveTransferNumber } from '../transfer-numbers';
import { listMenuItemsForOrg } from '../../menu-catalog';
import {
  cancelReservation,
  checkTableAvailability,
  createReservation,
  listReservations,
  updateReservation,
} from '../../reservations-store';
import { executeRestaurantTool, RESTAURANT_TOOL_NAMES } from '../../restaurant-ai-tools';
import { resolveCallbackIso } from '../callback-time';
import { firstString } from './util';

export function normalizeDialableE164(raw: unknown): string | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  if (/[a-zA-Z]/.test(s)) return null;
  if (/^c\d+$/i.test(s)) return null;
  const digits = normalizePhoneExport(s.replace(/\s+/g, ''));
  if (!digits || digits.length < 10 || digits.length > 15) return null;
  return digits.startsWith('+') ? digits : `+${digits}`;
}

export function isStaffPartyPhone(phone: string | undefined | null): boolean {
  if (!phone) return false;
  const identity = resolvePhoneCallerIdentity(phone);
  return identity.kind === 'staff' || identity.kind === 'foreman';
}

export interface CaptureLeadFields {
  name?: unknown;
  phone?: unknown;
  email?: unknown;
  address?: unknown;
  postcode?: unknown;
  interestedTrades?: unknown;
  scope?: unknown;
  budget?: unknown;
  notes?: unknown;
}

/**
 * Create-or-update a CRM lead for a phone caller. Shared by the AI `captureLead`
 * tool (automatic, mid-call) and the staff-assisted "Create lead from this call"
 * REST path — both must dedupe against existing customers/contacts by phone so
 * repeat callers don't spawn duplicate lead records.
 */
export function captureOrUpdateLead(
  fields: CaptureLeadFields,
  opts: { callId?: string; fallbackPhone?: string; allowStaffPhoneAsLead?: boolean } = {},
): { customer: Record<string, unknown>; isNewLead: boolean; error?: string; spokenHint?: string } {
  const explicitPhone = firstString(fields.phone);
  const fallback = firstString(opts.fallbackPhone);
  // Staff calling from their own phone must supply an explicit customer phone — never upsert by staff handset.
  if (!opts.allowStaffPhoneAsLead && fallback && isStaffPartyPhone(fallback) && !explicitPhone) {
    return {
      customer: {},
      isNewLead: false,
      error: 'staff_phone_collision',
      spokenHint: 'I need the customer name and their phone number to create that lead — I will not save it against your staff number.',
    };
  }
  const phone = explicitPhone || (fallback && !isStaffPartyPhone(fallback) ? fallback : undefined);
  if (!phone) {
    return {
      customer: {},
      isNewLead: false,
      error: 'phone_required',
      spokenHint: 'I need a customer phone number to create the lead.',
    };
  }
  // Never overwrite a CRM row that matches a registered staff number unless explicit and allowStaffPhoneAsLead
  if (!opts.allowStaffPhoneAsLead && isStaffPartyPhone(phone)) {
    return {
      customer: {},
      isNewLead: false,
      error: 'staff_phone_collision',
      spokenHint: 'That number belongs to a staff handset. Give me the customer phone instead.',
    };
  }

  const existingLookup = lookupContactByPhone(phone);
  const store = getDataStore();
  const existing = existingLookup.found && existingLookup.customerId
    ? store.customers.find((c) => String(c.id) === existingLookup.customerId)
    : undefined;

  const name = firstString(fields.name) ?? (existing?.name as string | undefined) ?? 'Unknown caller';
  const scopeNote = [fields.scope, fields.notes].filter(Boolean).join(' — ');
  const combinedNotes = [existing?.notes, scopeNote].filter(Boolean).join(' | ');
  const newTrades = Array.isArray(fields.interestedTrades) ? fields.interestedTrades : [];
  const existingTrades = Array.isArray(existing?.interestedTrades) ? existing?.interestedTrades as unknown[] : [];
  const mergedTrades = [...new Set([...existingTrades, ...newTrades])];

  const customer = saveCustomerRecord({
    id: existing?.id,
    name,
    phone: phone ?? existing?.phone ?? '',
    email: firstString(fields.email) ?? existing?.email ?? '',
    address: firstString(fields.address, fields.postcode) ?? existing?.address ?? '',
    status: existing?.status ?? 'lead',
    interestedTrades: mergedTrades,
    notes: combinedNotes,
    source: existing?.source ?? 'phone',
    budget: fields.budget ?? existing?.budget,
    sourceCallId: (existing?.sourceCallId as string | undefined) ?? opts.callId,
  });

  if (opts.callId) {
    saveCall({ id: opts.callId, customerId: customer.id, intent: 'new_sales_lead', outcome: 'lead_captured' });
    appendCustomerCallActivity({
      customerId: String(customer.id),
      callId: opts.callId,
      summary: scopeNote || (existing ? 'Lead details updated from phone call' : 'Lead captured from phone call'),
      outcome: 'lead_captured',
    });
  }

  return { customer, isNewLead: !existing };
}
