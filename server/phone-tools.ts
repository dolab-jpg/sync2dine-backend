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
} from './data-store';
import type { CallIntent, OutboundCampaignTemplate } from './telephony/types';
import type { OrchestratorRequest } from './orchestrator-types';
import { sendToStaffCynthiaInternal } from './cynthia-routes';
import { actionRequiresConfirmation } from './action-registry';
import { formatSpokenGbp } from './spoken-money';
import { resolvePhoneCallerIdentity } from './phone-auth';
import { ensureEnglishForCustomerSend } from './outbound-english-guard';
import { resolveTransferDestination, resolveTransferNumber } from './transfer-numbers';

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

/** Accept UK mobiles/landlines; reject names, CRM ids, free text. */
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

function isStaffPartyPhone(phone: string | undefined | null): boolean {
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

export const PHONE_TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'classifyCallIntent',
      description: 'Classify why the caller is calling: new_sales_lead, existing_customer, recruitment, supplier, complaint, general, after_hours',
      parameters: {
        type: 'object',
        properties: {
          intent: {
            type: 'string',
            enum: ['new_sales_lead', 'existing_customer', 'recruitment', 'supplier', 'complaint', 'general', 'after_hours'],
          },
          confidence: { type: 'number' },
          reason: { type: 'string' },
        },
        required: ['intent'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'captureLead',
      description: 'Capture new sales lead details and create a customer record with status lead',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          phone: { type: 'string' },
          email: { type: 'string' },
          address: { type: 'string' },
          postcode: { type: 'string' },
          interestedTrades: { type: 'array', items: { type: 'string' } },
          scope: { type: 'string' },
          budget: { type: 'number' },
          notes: { type: 'string' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'bookCallback',
      description: 'Schedule a staff callback. For staff callers, callbackTo must be the customer E.164 phone (not a name or CRM id).',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          phone: { type: 'string', description: 'Legacy alias for callbackTo' },
          callbackTo: { type: 'string', description: 'Customer phone in E.164 e.g. +447576442345' },
          reason: { type: 'string' },
          preferredTime: { type: 'string' },
          urgency: { type: 'string', enum: ['low', 'medium', 'high'] },
        },
        required: ['reason'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'saveQuote',
      description: 'Create or update an indicative quote in CRM during a staff phone call',
      parameters: {
        type: 'object',
        properties: {
          customerId: { type: 'string' },
          customerName: { type: 'string' },
          customerPhone: { type: 'string' },
          tradeName: { type: 'string' },
          total: { type: 'number' },
          notes: { type: 'string' },
          status: { type: 'string' },
        },
        required: ['total'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'sendCustomerMessage',
      description: 'Send a WhatsApp (or SMS fallback) message to a customer. Fail closed if messaging is not configured — never invent success.',
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Customer phone E.164' },
          message: { type: 'string' },
          customerId: { type: 'string' },
          customerName: { type: 'string' },
        },
        required: ['to', 'message'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'scheduleAppointment',
      description: 'Book a site survey or appointment for a customer',
      parameters: {
        type: 'object',
        properties: {
          customerId: { type: 'string' },
          customerName: { type: 'string' },
          type: { type: 'string', enum: ['site_survey', 'consultation', 'follow_up'] },
          preferredDate: { type: 'string' },
          preferredTime: { type: 'string' },
          address: { type: 'string' },
          tradeId: { type: 'string' },
          notes: { type: 'string' },
        },
        required: ['type'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'screenCandidate',
      description: 'Pre-screen a recruitment candidate during a phone call',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          phone: { type: 'string' },
          email: { type: 'string' },
          desiredRole: { type: 'string' },
          experience: { type: 'string' },
          availability: { type: 'string' },
          location: { type: 'string' },
          skills: { type: 'array', items: { type: 'string' } },
          jobId: { type: 'string' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'bookInterview',
      description: 'Schedule a recruitment interview for a candidate',
      parameters: {
        type: 'object',
        properties: {
          candidateId: { type: 'string' },
          candidateName: { type: 'string' },
          jobId: { type: 'string' },
          jobTitle: { type: 'string' },
          scheduledDate: { type: 'string' },
          scheduledTime: { type: 'string' },
          type: { type: 'string', enum: ['phone', 'video', 'in-person'] },
          location: { type: 'string' },
          notes: { type: 'string' },
        },
        required: ['scheduledDate', 'scheduledTime', 'type'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'logCandidate',
      description: 'Create or update a recruitment candidate record',
      parameters: {
        type: 'object',
        properties: {
          candidateId: { type: 'string' },
          name: { type: 'string' },
          phone: { type: 'string' },
          email: { type: 'string' },
          desiredRole: { type: 'string' },
          source: { type: 'string' },
          notes: { type: 'string' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'transferToHuman',
      description:
        'Warm-transfer the live call to a human: put the caller on hold, dial staff, brief them, then connect. Use takeMessage if they only want a message.',
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string' },
          department: { type: 'string', enum: ['sales', 'projects', 'recruitment', 'accounts', 'general'] },
          takeMessage: { type: 'boolean' },
          message: { type: 'string' },
        },
        required: ['reason'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'enqueueOutboundCall',
      description: 'Queue an outbound call for later dialling',
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string' },
          template: {
            type: 'string',
            enum: ['quote_chase', 'payment_reminder', 'appointment_reminder', 'recruitment_screening', 'satisfaction_check', 'lead_callback'],
          },
          context: { type: 'object' },
          scheduledAt: { type: 'string' },
        },
        required: ['to', 'template'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'captureMessage',
      description: 'Take a message from caller for a specific department or person',
      parameters: {
        type: 'object',
        properties: {
          callerName: { type: 'string' },
          callerPhone: { type: 'string' },
          department: { type: 'string' },
          message: { type: 'string' },
          urgency: { type: 'string', enum: ['low', 'medium', 'high'] },
        },
        required: ['message'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'sendToStaffCynthia',
      description:
        'When staff say "send it to me", "pop it in the chat", or "send me the details", push a rich card (address, amount, phone, summary) into their Cynthia APK chat so they can open it and call the customer.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Card title e.g. Quote ready — Mrs Smith' },
          customerName: { type: 'string' },
          phone: { type: 'string', description: 'Customer phone for Call button' },
          address: { type: 'string' },
          amount: { type: 'number', description: 'Quote or job amount in GBP' },
          summary: { type: 'string' },
          notes: { type: 'string' },
          quoteId: { type: 'string' },
          projectId: { type: 'string' },
          customerId: { type: 'string' },
          staffUserId: { type: 'string', description: 'Staff user id if known' },
          staffPhone: { type: 'string', description: 'Staff phone to resolve inbox' },
        },
        required: ['title'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'placeOutboundCall',
      description:
        'Place or queue an outbound customer call. Prefer payment_reminder when chasing an outstanding invoice. Require spoken confirmation before calling.',
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string' },
          template: {
            type: 'string',
            enum: ['quote_chase', 'payment_reminder', 'appointment_reminder', 'recruitment_screening', 'satisfaction_check', 'lead_callback'],
          },
          confirmed: { type: 'boolean', description: 'Must be true after the caller confirmed verbally' },
          context: { type: 'object' },
          scheduledAt: { type: 'string' },
        },
        required: ['to', 'template', 'confirmed'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'deliverCallFollowUp',
      description:
        'Fulfil a promised follow-up after the call: always send a staff Cynthia card; if the customer has portal/app access deliver customerMessage there; otherwise schedule a callback. Never claim success without tool success.',
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string' },
          customerMessage: { type: 'string' },
          customerId: { type: 'string' },
          projectId: { type: 'string' },
          assignedStaffUserId: { type: 'string' },
          confirmed: { type: 'boolean' },
          callback: {
            type: 'object',
            properties: {
              reason: { type: 'string' },
              scheduledAt: { type: 'string' },
              template: { type: 'string', enum: ['lead_callback', 'payment_reminder', 'quote_chase'] },
              to: { type: 'string' },
            },
          },
        },
        required: ['summary'],
      },
    },
  },
];

export const PHONE_AUTO_ACTIONS = new Set([
  'classifyCallIntent',
  'captureLead',
  'bookCallback',
  'scheduleAppointment',
  'screenCandidate',
  'bookInterview',
  'logCandidate',
  'transferToHuman',
  'enqueueOutboundCall',
  'placeOutboundCall',
  'captureMessage',
  'sendToStaffCynthia',
  'deliverCallFollowUp',
  'escalateToStaff',
  'saveCustomer',
  'saveQuote',
  'sendCustomerMessage',
]);

export async function executePhoneTool(
  name: string,
  input: Record<string, unknown>,
  body: OrchestratorRequest,
): Promise<Record<string, unknown>> {
  const callId = firstString(body.callContext?.callId);
  const callerPhone = firstString(input.phone, body.callContext?.from, body.customerContext?.phone);

  if (name === 'classifyCallIntent') {
    const intent = String(input.intent ?? 'general') as CallIntent;
    if (callId) {
      saveCall({ id: callId, intent });
    }
    return { intent, confidence: Number(input.confidence ?? 0.8), reason: input.reason ?? '' };
  }

  if (name === 'captureLead') {
    const result = captureOrUpdateLead(input, { callId, fallbackPhone: callerPhone });
    if (result.error) {
      return {
        saved: false,
        error: result.error,
        spokenHint: result.spokenHint,
      };
    }
    return {
      customerId: result.customer.id,
      name: result.customer.name,
      status: result.customer.status ?? 'lead',
      saved: true,
      isNewLead: result.isNewLead,
      spokenHint: result.isNewLead
        ? `Lead saved for ${String(result.customer.name)}.`
        : `Updated the lead for ${String(result.customer.name)}.`,
    };
  }

  if (name === 'bookCallback') {
    const preferred = firstString(input.callbackTo, input.phone);
    const staffOnLine = isStaffPartyPhone(callerPhone);
    const dialTo = normalizeDialableE164(preferred)
      || (!staffOnLine ? normalizeDialableE164(callerPhone) : null);
    if (!dialTo) {
      return {
        callbackQueued: false,
        error: 'invalid_callback_number',
        spokenHint: staffOnLine
          ? 'Tell me the customer phone number to dial back — I cannot queue a callback to a name or CRM id.'
          : 'I need a valid UK phone number to book that callback.',
      };
    }
    const job = enqueueOutboundCall({
      to: dialTo,
      template: 'lead_callback',
      status: 'queued',
      context: {
        name: input.name,
        reason: input.reason,
        preferredTime: input.preferredTime,
        urgency: input.urgency ?? 'medium',
        callId,
        customerId: firstString(input.customerId, body.customerContext?.customerId),
      },
      scheduledAt: firstString(input.preferredTime, input.scheduledAt),
    });
    return {
      callbackQueued: true,
      jobId: job.id,
      to: dialTo,
      preferredTime: input.preferredTime,
      spokenHint: `Callback queued to ${dialTo}${input.preferredTime ? ` around ${String(input.preferredTime)}` : ''}.`,
    };
  }

  if (name === 'saveQuote') {
    const total = Number(input.total ?? 0);
    if (!Number.isFinite(total) || total <= 0) {
      return {
        saved: false,
        error: 'invalid_total',
        spokenHint: 'I need a pound amount to save that quote.',
      };
    }
    const custPhone = normalizeDialableE164(firstString(input.customerPhone, input.phone));
    const customerId = firstString(input.customerId, body.customerContext?.customerId);
    let customerName = firstString(input.customerName, body.customerContext?.customerName) ?? 'Customer';
    let resolvedId = customerId;
    if (!resolvedId && custPhone) {
      const found = lookupContactByPhone(custPhone);
      if (found.found && found.customerId) {
        resolvedId = found.customerId;
        customerName = found.customerName || customerName;
      }
    }
    if (custPhone && !isStaffPartyPhone(custPhone) && !resolvedId) {
      const created = saveCustomerRecord({
        name: customerName,
        phone: custPhone,
        status: 'lead',
        source: 'phone',
      });
      resolvedId = String(created.id);
    }
    const spokenTotal = formatSpokenGbp(total);
    const quote = saveQuoteRecord({
      customerId: resolvedId ?? '',
      customerName,
      tradeName: firstString(input.tradeName, input.tradeId) ?? 'General',
      total,
      status: firstString(input.status) ?? 'draft',
      notes: firstString(input.notes) ?? '',
      source: 'phone',
      sourceCallId: callId,
      expiresAt: new Date(Date.now() + 14 * 86400000).toISOString(),
    });
    if (resolvedId && callId) {
      appendCustomerCallActivity({
        customerId: resolvedId,
        callId,
        summary: `Quote ${quote.id} saved — ${spokenTotal}`,
        outcome: 'quote_saved',
      });
    }
    return {
      saved: true,
      quoteId: quote.id,
      total,
      spokenTotal,
      customerId: resolvedId ?? null,
      customerName,
      spokenHint: `Quote saved for ${customerName} at ${spokenTotal}.`,
    };
  }

  if (name === 'sendCustomerMessage') {
    const to = normalizeDialableE164(firstString(input.to, input.phone));
    const message = firstString(input.message);
    if (!to || !message) {
      return {
        sent: false,
        error: 'missing_to_or_message',
        spokenHint: 'I need a customer phone number and the message text.',
      };
    }
    if (isStaffPartyPhone(to)) {
      return {
        sent: false,
        error: 'staff_phone_collision',
        spokenHint: 'That is a staff number — give me the customer number to message.',
      };
    }
    const englishGuard = await ensureEnglishForCustomerSend(
      message,
      null,
      body.orgId || getRequestOrgId(),
    );
    if (!englishGuard.ok) {
      return {
        sent: false,
        error: 'english_guard_failed',
        spokenHint: 'I could not prepare that customer message in English, so it was not sent.',
      };
    }
    const englishMessage = englishGuard.english;
    try {
      const { isMetaWhatsAppEnabled, sendWhatsAppText } = await import('./whatsapp-webhook');
      const waToken = process.env.WHATSAPP_ACCESS_TOKEN?.trim();
      const waPhoneId = process.env.WHATSAPP_PHONE_NUMBER_ID?.trim();
      if (isMetaWhatsAppEnabled() && waToken && waPhoneId) {
        await sendWhatsAppText(waPhoneId, waToken, to.startsWith('+') ? to : `+${to}`, englishMessage);
        const customerId = firstString(input.customerId);
        if (customerId && callId) {
          appendCustomerCallActivity({
            customerId,
            callId,
            summary: `WhatsApp sent: ${englishMessage.slice(0, 180)}`,
            outcome: 'message_sent',
          });
        }
        return {
          sent: true,
          channel: 'whatsapp',
          to,
          spokenHint: 'Message sent on WhatsApp.',
        };
      }

      // Fail closed — push a Cynthia card so staff can still follow up
      const staffPush = sendToStaffCynthiaInternal({
        orgId: body.orgId || getRequestOrgId(),
        userId: firstString(body.staffContext?.userId),
        staffPhone: firstString(body.callContext?.from, callerPhone),
        title: 'Customer message (WhatsApp not configured)',
        customerName: firstString(input.customerName),
        phone: to,
        summary: englishMessage,
        customerId: firstString(input.customerId),
        source: 'phone',
      });
      return {
        sent: false,
        error: 'messaging_not_configured',
        code: 'whatsapp_not_configured',
        staffCardQueued: Boolean(staffPush.ok),
        spokenHint: staffPush.ok
          ? 'WhatsApp is not connected yet — I logged that message on your Cynthia chat instead.'
          : 'WhatsApp is not configured, so I cannot send that message to the customer.',
      };
    } catch (err) {
      return {
        sent: false,
        error: err instanceof Error ? err.message : 'send_failed',
        spokenHint: 'I could not send that WhatsApp message.',
      };
    }
  }

  if (name === 'scheduleAppointment') {
    const appointment = {
      id: `APT${Date.now()}`,
      customerId: input.customerId ?? body.customerContext?.customerId,
      customerName: input.customerName ?? body.customerContext?.customerName,
      type: input.type ?? 'site_survey',
      preferredDate: input.preferredDate,
      preferredTime: input.preferredTime,
      address: input.address,
      tradeId: input.tradeId,
      notes: input.notes,
      status: 'requested',
      source: 'phone',
      createdAt: new Date().toISOString(),
    };
    const store = getDataStore();
    const appointments = Array.isArray(store.sessions) ? store.sessions : [];
    appointments.push({ ...appointment, phone: callerPhone, kind: 'appointment' });
    return { appointmentId: appointment.id, type: appointment.type, scheduled: true };
  }

  if (name === 'screenCandidate') {
    const candidate = saveRecruitmentCandidate({
      name: input.name,
      phone: callerPhone ?? input.phone,
      email: input.email ?? '',
      desiredRole: input.desiredRole ?? '',
      experience: input.experience ?? '',
      availability: input.availability ?? '',
      location: input.location ?? '',
      skills: input.skills ?? [],
      source: 'phone',
      currentEmploymentStatus: 'unknown',
      createdAt: new Date().toISOString(),
    });
    if (callId) {
      saveCall({ id: callId, candidateId: candidate.id, intent: 'recruitment' });
    }
    return { candidateId: candidate.id, name: candidate.name, screened: true };
  }

  if (name === 'logCandidate') {
    const candidate = saveRecruitmentCandidate({
      id: input.candidateId,
      name: input.name,
      phone: callerPhone ?? input.phone,
      email: input.email ?? '',
      desiredRole: input.desiredRole ?? '',
      source: input.source ?? 'phone',
      notes: input.notes ?? '',
    });
    return { candidateId: candidate.id, name: candidate.name, saved: true };
  }

  if (name === 'bookInterview') {
    const interview = saveRecruitmentInterview({
      candidateId: input.candidateId,
      candidateName: input.candidateName,
      jobId: input.jobId,
      jobTitle: input.jobTitle,
      scheduledDate: input.scheduledDate,
      scheduledTime: input.scheduledTime,
      type: input.type ?? 'phone',
      location: input.location,
      notes: input.notes,
      status: 'scheduled',
      duration: 30,
      interviewers: ['Cynthia (AI pre-screen)'],
    });
    if (callId) {
      saveCall({ id: callId, outcome: 'interview_booked' });
    }
    return {
      interviewId: interview.id,
      scheduledDate: input.scheduledDate,
      scheduledTime: input.scheduledTime,
      type: input.type,
      booked: true,
    };
  }

  if (name === 'transferToHuman') {
    const department = String(input.department || 'general');
    const transferNumber = resolveTransferNumber(department) ?? '';
    const destination = !input.takeMessage
      ? resolveTransferDestination({
          department,
          reason: String(input.reason || input.message || ''),
          message: String(input.message || ''),
        })
      : null;
    const takeMessage = Boolean(input.takeMessage) || !destination;
    const willTransfer = Boolean(destination) && !takeMessage;
    if (callId) {
      saveCall({
        id: callId,
        outcome: willTransfer ? 'transferred' : 'message_taken',
        ...(willTransfer ? { status: 'transferred' } : {}),
        transferredTo: input.department ?? 'general',
      });
    }
    return {
      transferred: willTransfer,
      transferNumber: transferNumber || null,
      department: input.department ?? 'general',
      message: input.message ?? input.reason,
      takeMessage,
      destination: willTransfer ? destination : undefined,
    };
  }

  if (name === 'enqueueOutboundCall' || name === 'placeOutboundCall') {
    if (name === 'placeOutboundCall' && actionRequiresConfirmation(name) && input.confirmed !== true) {
      return {
        queued: false,
        needsConfirmation: true,
        error: 'Ask the caller to confirm before placing the outbound call, then call again with confirmed:true',
        spokenHint: 'Confirm with me and I will place that call.',
      };
    }
    if (name === 'enqueueOutboundCall' && actionRequiresConfirmation(name) && input.confirmed !== true) {
      return {
        queued: false,
        needsConfirmation: true,
        error: 'Confirm before queueing the outbound call, then call again with confirmed:true',
        spokenHint: 'Confirm and I will queue that reminder call.',
      };
    }
    const dialTo = normalizeDialableE164(input.to);
    if (!dialTo) {
      return {
        queued: false,
        error: 'invalid_to_number',
        spokenHint: 'I need a real phone number like plus four four seven… — not a name or customer id.',
      };
    }
    const job = enqueueOutboundCall({
      to: dialTo,
      template: (input.template as OutboundCampaignTemplate) || 'lead_callback',
      status: 'queued',
      context: input.context ?? {},
      scheduledAt: input.scheduledAt,
    });
    return {
      jobId: job.id,
      to: dialTo,
      template: input.template || 'lead_callback',
      queued: true,
      spokenHint: `Queued an outbound call to ${dialTo}.`,
    };
  }

  if (name === 'captureMessage') {
    if (callId) {
      saveCall({
        id: callId,
        outcome: 'message_captured',
        metadata: {
          department: input.department,
          message: input.message,
          callerName: input.callerName,
          urgency: input.urgency ?? 'medium',
        },
      });
    }
    return {
      captured: true,
      department: input.department ?? 'general',
      urgency: input.urgency ?? 'medium',
    };
  }

  if (name === 'sendToStaffCynthia') {
    const amountRaw = input.amount;
    const amount = typeof amountRaw === 'number' ? amountRaw : Number(amountRaw);
    const fromStaffContext = Boolean(body.staffContext?.userId || body.staffContext?.role);
    const result = sendToStaffCynthiaInternal({
      orgId: body.orgId || getRequestOrgId(),
      userId: firstString(input.staffUserId, input.userId, body.staffContext?.userId),
      staffPhone: firstString(
        input.staffPhone,
        fromStaffContext ? callerPhone : undefined,
        body.callContext?.from,
      ),
      title: firstString(input.title) ?? 'Details from call',
      customerName: firstString(input.customerName, body.customerContext?.customerName),
      phone: firstString(
        input.phone,
        fromStaffContext ? undefined : callerPhone,
        body.customerContext?.phone,
      ),
      address: firstString(input.address),
      amount: Number.isFinite(amount) ? amount : undefined,
      summary: firstString(input.summary),
      notes: firstString(input.notes),
      quoteId: firstString(input.quoteId),
      projectId: firstString(input.projectId),
      customerId: firstString(input.customerId, body.customerContext?.customerId),
      source: body.orchestratorMode === 'phone' || body.callContext ? 'phone' : 'cynthia',
    });
    if (!result.ok || !result.card) {
      return {
        sent: false,
        error: result.error || 'Failed to send Cynthia card',
        code: result.code || 'staff_not_resolved',
        spokenConfirm: 'I could not send that to your Cynthia chat — your staff profile is not fully registered.',
      };
    }
    const spokenAmount = Number.isFinite(amount) ? formatSpokenGbp(amount) : null;
    return {
      sent: true,
      cardId: result.card.id,
      route: result.route,
      userId: result.userId,
      spokenTotal: spokenAmount,
      spokenConfirm: spokenAmount
        ? `I've sent it to your Cynthia chat — ${spokenAmount} and the details are there.`
        : "I've sent it to your Cynthia chat — open the app for address, amount, and Call.",
    };
  }

  if (name === 'deliverCallFollowUp') {
    const followUps: Array<Record<string, unknown>> = [];
    const summary = firstString(input.summary) || 'Call follow-up';
    const customerId = firstString(input.customerId, body.customerContext?.customerId);
    const projectId = firstString(input.projectId, body.projectContext?.projectId);
    const staffUserId = firstString(input.assignedStaffUserId, body.staffContext?.userId);
    const fromStaffContext = Boolean(body.staffContext?.userId || body.staffContext?.role);

    let customerMessage = firstString(input.customerMessage);
    if (customerMessage) {
      const msgGuard = await ensureEnglishForCustomerSend(
        customerMessage,
        null,
        body.orgId || getRequestOrgId(),
      );
      if (!msgGuard.ok) {
        return {
          delivered: false,
          error: 'english_guard_failed',
          spokenHint: 'I could not prepare the customer follow-up in English, so it was not sent.',
        };
      }
      customerMessage = msgGuard.english;
    }

    const staffResult = sendToStaffCynthiaInternal({
      orgId: body.orgId || getRequestOrgId(),
      userId: staffUserId,
      staffPhone: firstString(
        fromStaffContext ? callerPhone : undefined,
        body.callContext?.from,
      ),
      title: `Follow-up — ${summary.slice(0, 80)}`,
      customerName: firstString(body.customerContext?.customerName),
      phone: firstString(body.customerContext?.phone, callerPhone),
      summary,
      customerId,
      projectId,
      source: 'phone',
      notes: customerMessage,
    });
    followUps.push({
      type: 'staff_cynthia',
      status: staffResult.ok ? 'completed' : 'failed',
      entityId: staffResult.card?.id,
      error: staffResult.error,
      completedAt: staffResult.ok ? new Date().toISOString() : undefined,
    });

    let portalDelivered = false;
    if (customerMessage && (projectId || customerId)) {
      const store = getDataStore();
      const project = projectId
        ? store.projects.find((p) => String(p.id) === projectId)
        : store.projects.find((p) => String(p.customerId) === customerId && p.portalToken);
      if (project?.portalToken) {
        appendProjectMessageRecord(String(project.id), {
          id: `msg-${Date.now()}`,
          role: 'staff',
          author: 'Cynthia',
          body: customerMessage,
          createdAt: new Date().toISOString(),
          channel: 'portal',
          source: 'deliverCallFollowUp',
        });
        portalDelivered = true;
        followUps.push({
          type: 'customer_portal',
          status: 'completed',
          entityId: String(project.id),
          completedAt: new Date().toISOString(),
        });
      }
    }

    let callbackQueued = false;
    const callback = input.callback && typeof input.callback === 'object'
      ? (input.callback as Record<string, unknown>)
      : undefined;
    if (!portalDelivered && callback) {
      const to = normalizeDialableE164(
        firstString(callback.to, body.customerContext?.phone, !isStaffPartyPhone(callerPhone) ? callerPhone : undefined),
      );
      if (to) {
        const job = enqueueOutboundCall({
          to,
          template: String(callback.template || 'lead_callback') as OutboundCampaignTemplate,
          status: 'queued',
          context: { reason: callback.reason, summary, customerId, projectId },
          scheduledAt: callback.scheduledAt,
        });
        callbackQueued = true;
        followUps.push({
          type: 'scheduled_callback',
          status: 'completed',
          entityId: job.id,
          completedAt: new Date().toISOString(),
        });
      } else {
        followUps.push({
          type: 'scheduled_callback',
          status: 'failed',
          error: 'No valid E.164 customer phone for callback',
        });
      }
    } else if (!portalDelivered && customerMessage) {
      followUps.push({
        type: 'customer_portal',
        status: 'failed',
        error: 'Customer has no portal/app access',
      });
    }

    if (callId) {
      const store = getDataStore();
      const fresh = store.calls.find((c) => String(c.id) === callId);
      saveCall({
        id: callId,
        metadata: {
          ...((fresh?.metadata as Record<string, unknown> | undefined) || {}),
          followUps,
        },
      });
    }

    const staffOk = staffResult.ok;
    const customerOk = portalDelivered || callbackQueued || !customerMessage;
    const ok = staffOk && customerOk;
    return {
      ok,
      followUps,
      portalDelivered,
      callbackQueued,
      staffCardId: staffResult.card?.id,
      spokenConfirm: ok
        ? portalDelivered
          ? 'Done — sent to your Cynthia chat and the customer portal.'
          : callbackQueued
            ? 'Done — sent to your Cynthia chat and scheduled the callback.'
            : "Done — I've put that in your Cynthia chat."
        : 'I could not complete that follow-up fully — check the details in Cynthia.',
      error: ok ? undefined : 'One or more follow-up actions failed',
    };
  }

  return { error: `Unknown phone tool: ${name}` };
}

export function getOpenRecruitmentJobs(): Array<Record<string, unknown>> {
  const store = getDataStore();
  return store.recruitmentJobs.filter(j => String(j.status ?? 'open') === 'open').slice(0, 10);
}
