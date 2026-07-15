import {
  appendCustomerCallActivity,
  enqueueOutboundCall,
  getCallById,
  getDataStore,
  lookupContactByPhone,
  saveCall,
  saveCustomerRecord,
  saveRecruitmentCandidate,
  saveRecruitmentInterview,
} from './data-store';
import type { CallIntent, OutboundCampaignTemplate } from './telephony/types';
import type { OrchestratorRequest } from './orchestrator-types';

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
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
  opts: { callId?: string; fallbackPhone?: string } = {},
): { customer: Record<string, unknown>; isNewLead: boolean } {
  const phone = firstString(fields.phone, opts.fallbackPhone);
  const existingLookup = phone ? lookupContactByPhone(phone) : { found: false as const };
  const store = getDataStore();
  const existing = existingLookup.found && existingLookup.customerId
    ? store.customers.find((c) => String(c.id) === existingLookup.customerId)
    : undefined;

  const name = firstString(fields.name) ?? (existing?.name as string | undefined) ?? 'Unknown caller';
  // Scope/notes text is recorded as a timestamped activity line (below) rather than
  // baked into the `notes` field directly, so repeat calls don't duplicate old text.
  const scopeNote = [fields.scope, fields.notes].filter(Boolean).join(' — ');
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
    notes: existing?.notes ?? (opts.callId ? undefined : scopeNote) ?? '',
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
    // appendCustomerCallActivity mutates notes/activities after saveCustomerRecord
    // returned above — re-read so callers (API responses, AI tool result) see the
    // final record rather than a stale pre-activity-log snapshot.
    const refreshed = getDataStore().customers.find((c) => String(c.id) === customer.id);
    if (refreshed) return { customer: refreshed, isNewLead: !existing };
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
      description: 'Schedule a staff callback for the caller',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          phone: { type: 'string' },
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
      description: 'Transfer the call to a human team member or take a message if unavailable',
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
  'captureMessage',
  'escalateToStaff',
  'saveCustomer',
]);

export function executePhoneTool(
  name: string,
  input: Record<string, unknown>,
  body: OrchestratorRequest,
): Record<string, unknown> {
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
    const { customer, isNewLead } = captureOrUpdateLead(input, { callId, fallbackPhone: callerPhone });
    return {
      customerId: customer.id,
      name: customer.name,
      status: customer.status ?? 'lead',
      saved: true,
      isNewLead,
    };
  }

  if (name === 'bookCallback') {
    const job = enqueueOutboundCall({
      to: callerPhone ?? '',
      template: 'lead_callback',
      status: 'queued',
      context: {
        name: input.name,
        reason: input.reason,
        preferredTime: input.preferredTime,
        urgency: input.urgency ?? 'medium',
        callId,
      },
    });
    return { callbackQueued: true, jobId: job.id, preferredTime: input.preferredTime };
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
      interviewers: ['Aria (AI pre-screen)'],
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
    const transferNumber = process.env.VOICE_TRANSFER_NUMBER ?? '';
    if (callId) {
      saveCall({
        id: callId,
        outcome: input.takeMessage ? 'message_taken' : 'transferred',
        transferredTo: input.department ?? 'general',
      });
    }
    return {
      transferred: Boolean(transferNumber) && !input.takeMessage,
      transferNumber: transferNumber || null,
      department: input.department ?? 'general',
      message: input.message ?? input.reason,
      takeMessage: input.takeMessage ?? !transferNumber,
    };
  }

  if (name === 'enqueueOutboundCall') {
    const job = enqueueOutboundCall({
      to: input.to,
      template: input.template as OutboundCampaignTemplate,
      status: 'queued',
      context: input.context ?? {},
      scheduledAt: input.scheduledAt,
    });
    return { jobId: job.id, to: input.to, template: input.template, queued: true };
  }

  if (name === 'captureMessage') {
    if (callId) {
      // Merge — a metadata replace here used to wipe phoneAuth verified state mid-call
      const existing = getCallById(callId);
      saveCall({
        id: callId,
        outcome: 'message_captured',
        metadata: {
          ...((existing?.metadata as Record<string, unknown> | undefined) || {}),
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

  return { error: `Unknown phone tool: ${name}` };
}

export function getOpenRecruitmentJobs(): Array<Record<string, unknown>> {
  const store = getDataStore();
  return store.recruitmentJobs.filter(j => String(j.status ?? 'open') === 'open').slice(0, 10);
}
