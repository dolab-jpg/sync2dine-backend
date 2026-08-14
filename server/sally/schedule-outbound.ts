/**
 * Central Sally outbound scheduling ? venue windows + eligibility + Sally brain routing.
 */
import {
  enqueueOutboundCall,
  getAgentSettings,
  getDataStore,
  normalizePhoneExport,
  saveCustomerRecord,
  syncData,
} from '../data-store';
import { suggestDialWindows, type VenueDialProfile } from './dial-windows';
import {
  assessContactEligibility,
  formatReferralBrief,
  type ConsentSource,
} from './call-eligibility';
import { captureOrUpdateLead, normalizeDialableE164 } from '../phone/tools/leads';
import { rememberPerson, resolveSameVenueCustomer } from './remember-person';
import { isPlausibleUkE164, toUkE164 } from '../phone/vapi-client';

export const SALLY_PERSONA = 'sally';

export type ScheduleSallyDialInput = {
  to: string;
  customerId?: string;
  customerName?: string;
  company?: string;
  template?: string;
  brief?: string;
  aim?: string;
  source?: string;
  /** When set, use this ISO instead of computing from venue profile */
  scheduledAt?: string | null;
  /** Prefer venue-aware scheduling when no explicit scheduledAt */
  venueAware?: boolean;
  venueProfile?: VenueDialProfile;
  bypassQuietHours?: boolean;
  context?: Record<string, unknown>;
  /** Public website if already known (passed into pre-call research). */
  website?: string;
  /** Customer record for eligibility (or look up by customerId) */
  customer?: Record<string, unknown> | null;
  requireExplicitConsent?: boolean;
  dryRun?: boolean;
};

export type ScheduleSallyDialResult = {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  job?: Record<string, unknown>;
  scheduledAt?: string | null;
  dial?: ReturnType<typeof suggestDialWindows>;
  eligibility?: ReturnType<typeof assessContactEligibility>;
};

function customerFromId(customerId?: string): Record<string, unknown> | null {
  if (!customerId) return null;
  const store = getDataStore();
  return (
    (store.customers as Array<Record<string, unknown>>).find((c) => String(c.id) === customerId)
    || null
  );
}

function profileFromCustomer(customer: Record<string, unknown> | null | undefined): VenueDialProfile {
  if (!customer) return {};
  return {
    venueType: customer.venueType,
    openingHours: customer.openingHours,
    weeklyHours: customer.weeklyHours,
    closedDays: customer.closedDays,
    preferredContactTimes: customer.preferredContactTimes,
    hasKitchen:
      customer.hasKitchen === true ? true : customer.hasKitchen === false ? false : null,
    timezone: customer.timezone || customer.timeZone || 'Europe/London',
  };
}

/**
 * Enqueue a Sally sales outbound with correct agentPersona + optional venue schedule.
 * Blocks DNC / consent-declined contacts.
 */
export function scheduleSallyOutboundDial(input: ScheduleSallyDialInput): ScheduleSallyDialResult {
  const phone = normalizePhoneExport(String(input.to || '').trim());
  if (!phone || phone.length < 10) {
    return { ok: false, skipped: true, reason: 'invalid_phone' };
  }

  const customer = input.customer ?? customerFromId(input.customerId);
  const eligibility = assessContactEligibility(customer, {
    requireExplicitConsent: input.requireExplicitConsent,
  });
  if (!eligibility.eligible) {
    return { ok: false, skipped: true, reason: eligibility.reason, eligibility };
  }

  const venueProfile: VenueDialProfile = {
    ...profileFromCustomer(customer),
    ...(input.venueProfile || {}),
  };
  const dial = suggestDialWindows(venueProfile);
  const explicit = input.scheduledAt != null && String(input.scheduledAt).trim()
    ? String(input.scheduledAt).trim()
    : null;
  const venueAware = input.venueAware !== false;

  // Takeaway / venue-aware dials require real hours ? never invent 20:00?22:00 defaults.
  if (venueAware && !explicit && !dial.hoursKnown) {
    return {
      ok: false,
      skipped: true,
      reason: 'needs_hours',
      dial,
      eligibility,
      scheduledAt: null,
    };
  }

  const scheduledAt = explicit || (venueAware ? dial.nextSlotISO : null);
  const bypassQuiet =
    input.bypassQuietHours === true
    || (venueAware && dial.bypassGlobalQuiet);

  const context: Record<string, unknown> = {
    ...(input.context || {}),
    customerId: input.customerId || customer?.id || input.context?.customerId,
    customerName: input.customerName || customer?.name || input.context?.customerName,
    company: input.company || customer?.name || input.context?.company,
    aim: input.aim || 'sales_outreach',
    agentPersona: SALLY_PERSONA,
    brief: input.brief || input.context?.brief,
    source: input.source || input.context?.source || 'sally_schedule',
    venueAwareSchedule: venueAware && !explicit,
    dialReason: dial.reason,
    timezone: dial.timezone,
    hoursKnown: dial.hoursKnown,
  };

  if (input.dryRun) {
    return { ok: true, scheduledAt, dial, eligibility, reason: 'dry_run' };
  }

  const job = enqueueOutboundCall({
    to: toUkE164(phone),
    template: input.template || 'sally_sales',
    status: 'queued',
    customerId: context.customerId != null ? String(context.customerId) : undefined,
    scheduledAt: scheduledAt || undefined,
    bypassQuietHours: bypassQuiet,
    context,
  });

  if (context.customerId) {
    try {
      const store = getDataStore();
      const idx = store.customers.findIndex((c) => String(c.id) === String(context.customerId));
      if (idx >= 0) {
        const prev = store.customers[idx] as Record<string, unknown>;
        store.customers[idx] = {
          ...prev,
          callQueueStatus: 'queued',
          nextFollowUp: scheduledAt || prev.nextFollowUp,
          sallyDialHint: dial.reason,
          updatedAt: new Date().toISOString(),
        };
        syncData(store);
      }
    } catch {
      /* best-effort CRM stamp */
    }
  }

  return { ok: true, job, scheduledAt, dial, eligibility };
}

function draftBriefSnippet(draft: {
  businessName?: string;
  address?: string;
  openingHours?: string;
  website?: string;
  rawSummary?: string;
}): string {
  const bits = [
    draft.businessName ? `Name: ${draft.businessName}` : '',
    draft.address ? `Address: ${draft.address}` : '',
    draft.openingHours ? `Hours: ${draft.openingHours}` : '',
    draft.website ? `Web: ${draft.website}` : '',
    draft.rawSummary ? draft.rawSummary.slice(0, 280) : '',
  ].filter(Boolean);
  return bits.join('. ');
}

/**
 * Pick the number to dial after comparing the sheet phone with a public listing.
 * Both sides go through toUkE164 first so missing-zero / +1296… sheet values
 * can still match a listed 01296 / +441296 number.
 */
export function chooseResearchedDialPhone(
  sheetPhone: string,
  researchedPhone?: string | null,
): {
  dialTo: string;
  usedResearch: boolean;
  sheetE164: string;
  researchE164: string;
} {
  const sheetE164 = toUkE164(String(sheetPhone || '').trim());
  const researchE164 = toUkE164(String(researchedPhone || '').trim());
  const sheetOk = isPlausibleUkE164(sheetE164);
  const researchOk = isPlausibleUkE164(researchE164);

  if (researchOk && (!sheetOk || sheetE164 !== researchE164)) {
    return { dialTo: researchE164, usedResearch: true, sheetE164, researchE164 };
  }
  return {
    dialTo: sheetOk ? sheetE164 : sheetE164 || String(sheetPhone || '').trim(),
    usedResearch: false,
    sheetE164,
    researchE164,
  };
}

/**
 * Research (DeepSeek) for hours + public phone, then schedule — or hold as needs_hours.
 * If the sheet number is undialable or disagrees with the listing, dial the public E.164.
 */
export async function scheduleSallyOutboundDialWithResearch(
  input: ScheduleSallyDialInput & { addressHint?: string; orgId?: string },
): Promise<ScheduleSallyDialResult & { held?: boolean; researchDraft?: unknown }> {
  const customer = input.customer ?? customerFromId(input.customerId);
  const mergedProfile: VenueDialProfile = {
    ...profileFromCustomer(customer),
    ...(input.venueProfile || {}),
  };
  let openingHours = String(mergedProfile.openingHours || '').trim();
  let researchDraft: unknown;
  let briefExtra = '';
  let chosen = chooseResearchedDialPhone(input.to);

  const company = String(input.company || input.customerName || customer?.name || '').trim();
  const addressHint = String(
    input.addressHint || customer?.address || '',
  ).trim();
  const website = String(
    input.website || customer?.website || customer?.web || '',
  ).trim();
  const skipResearch = process.env.SALLY_SKIP_PRECALL_RESEARCH === '1';
  if (company && !skipResearch) {
    try {
      const { researchRestaurantProfile, draftToAboutUs } = await import('../restaurant-research');
      const result = await researchRestaurantProfile({
        businessName: company,
        phone: input.to,
        addressHint: addressHint || undefined,
        website: website || undefined,
        orgId: input.orgId,
      });
      if (result.ok) {
        researchDraft = result.draft;
        briefExtra = draftBriefSnippet(result.draft);
        if (!openingHours && result.draft.openingHours) {
          openingHours = String(result.draft.openingHours).trim();
        }
        chosen = chooseResearchedDialPhone(input.to, result.draft.phone);
        if (input.customerId) {
          try {
            saveCustomerRecord({
              id: String(input.customerId),
              openingHours: openingHours || undefined,
              address: result.draft.address,
              researchDraft: result.draft,
              aboutUs: draftToAboutUs(result.draft),
              // Only overwrite the venue line when the sheet number is undialable.
              // A disagreeing Google listing still dials for this job, but must not clobber CRM.
              ...(!isPlausibleUkE164(chosen.sheetE164) && chosen.usedResearch
                ? { phone: chosen.dialTo }
                : {}),
            });
          } catch {
            /* best-effort */
          }
        }
      }
    } catch (err) {
      console.warn(
        '[sally-schedule] research failed:',
        err instanceof Error ? err.message : err,
      );
    }
  }

  const dialTo = chosen.dialTo || input.to;

  const venueProfile: VenueDialProfile = {
    ...mergedProfile,
    openingHours: openingHours || mergedProfile.openingHours,
  };
  const brief = [input.brief, briefExtra ? `Research: ${briefExtra}` : '']
    .filter(Boolean)
    .join(' ');

  const result = scheduleSallyOutboundDial({
    ...input,
    to: dialTo,
    brief: brief || input.brief,
    venueProfile,
    context: {
      ...(input.context || {}),
      researchDraft,
      researchBrief: briefExtra || undefined,
      sheetPhone: input.to,
      dialPhone: dialTo,
      usedResearchedPhone: chosen.usedResearch || undefined,
    },
  });

  if (result.reason === 'needs_hours') {
    const held = enqueueOutboundCall({
      to: toUkE164(dialTo),
      template: input.template || 'sally_sales',
      status: 'needs_hours',
      customerId: input.customerId,
      bypassQuietHours: true,
      context: {
        ...(input.context || {}),
        agentPersona: SALLY_PERSONA,
        company: input.company || input.customerName,
        aim: input.aim || 'sales_outreach',
        brief: brief || input.brief,
        source: input.source || 'sally_schedule',
        researchDraft,
        holdReason: 'needs_hours',
        sheetPhone: input.to,
        dialPhone: dialTo,
        usedResearchedPhone: chosen.usedResearch || undefined,
      },
    });
    return {
      ...result,
      ok: true,
      skipped: false,
      held: true,
      job: held,
      researchDraft,
      reason: 'needs_hours',
    };
  }

  return { ...result, researchDraft };
}

export type CaptureReferralInput = {
  name: string;
  phone: string;
  role?: string;
  referredByName?: string;
  referredByPhone?: string;
  referredByVenue?: string;
  referredByCustomerId?: string;
  summary?: string;
  interestHint?: string;
  venueType?: string;
  openingHours?: string;
  preferredContactTimes?: string;
  timezone?: string;
  callId?: string;
  scheduledAt?: string;
  notes?: string;
};

/**
 * Atomic: create/link referred contact + queue Sally follow-up with structured referral brief.
 * Same venue + new mobile stays on THIS restaurant (no second customers row).
 */
export function captureReferralAndQueue(input: CaptureReferralInput): {
  ok: boolean;
  error?: string;
  spokenHint?: string;
  customer?: Record<string, unknown>;
  job?: Record<string, unknown>;
  scheduledAt?: string | null;
  brief?: string;
  isNewLead?: boolean;
} {
  const dialTo = normalizeDialableE164(input.phone);
  if (!dialTo) {
    return {
      ok: false,
      error: 'invalid_phone',
      spokenHint: 'I need a valid UK mobile or landline for the person you want me to call.',
    };
  }

  const brief = formatReferralBrief({
    referredByName: input.referredByName,
    referredByPhone: input.referredByPhone,
    referredByVenue: input.referredByVenue,
    summary: input.summary || input.notes,
    interestHint: input.interestHint,
  });

  const sameVenue = resolveSameVenueCustomer({
    referredByCustomerId: input.referredByCustomerId,
    referredByVenue: input.referredByVenue,
    name: input.name,
    phone: dialTo,
  });

  if (sameVenue?.id) {
    const customerId = String(sameVenue.id);
    const venueName = String(sameVenue.name || input.referredByVenue || '').trim();
    if (input.referredByName) {
      rememberPerson({
        customerId,
        name: input.referredByName,
        phone: input.referredByPhone,
        howKnown: 'spoke',
      });
    }
    rememberPerson({
      customerId,
      name: input.name,
      role: input.role,
      phone: dialTo,
      howKnown: 'referred',
      note: input.summary || input.notes,
    });

    const already = (getDataStore().outboundQueue || []).some((j) => {
      if (!['queued', 'dialling'].includes(String(j.status ?? ''))) return false;
      const to = normalizePhoneExport(String(j.to ?? ''));
      return to === normalizePhoneExport(dialTo);
    });
    if (already) {
      return {
        ok: true,
        customer: sameVenue,
        isNewLead: false,
        brief,
        spokenHint: `I've already got a call queued to ${input.name} at ${venueName || 'this restaurant'}. I'll mention ${input.referredByName || 'your colleague'} referred us.`,
      };
    }

    const scheduled = scheduleSallyOutboundDial({
      to: dialTo,
      customerId,
      customerName: venueName || String(sameVenue.name || ''),
      company: venueName,
      template: 'sally_sales',
      aim: 'sales_outreach',
      source: 'gatekeeper_referral',
      brief,
      scheduledAt: input.scheduledAt || undefined,
      venueAware: true,
      venueProfile: {
        venueType: input.venueType || sameVenue.venueType,
        openingHours: input.openingHours || sameVenue.openingHours,
        preferredContactTimes: input.preferredContactTimes,
        timezone: input.timezone || sameVenue.timezone || 'Europe/London',
      },
      customer: getDataStore().customers.find((c) => String(c.id) === customerId) as Record<string, unknown>,
      context: {
        referral: true,
        sameVenue: true,
        referredPersonName: input.name,
        referredByName: input.referredByName,
        referredByPhone: input.referredByPhone,
        referredByVenue: input.referredByVenue || venueName,
        referredByCustomerId: customerId,
        sourceCallId: input.callId,
      },
    });

    if (!scheduled.ok) {
      return {
        ok: false,
        error: scheduled.reason || 'queue_failed',
        customer: sameVenue,
        isNewLead: false,
        spokenHint:
          scheduled.reason === 'do_not_call'
            ? 'That number is marked do-not-call ? I will not dial it.'
            : `Saved ${input.name} on ${venueName || 'this restaurant'} but could not queue the call ? ask staff to follow up.`,
      };
    }

    return {
      ok: true,
      customer: sameVenue,
      isNewLead: false,
      job: scheduled.job,
      scheduledAt: scheduled.scheduledAt,
      brief,
      spokenHint: scheduled.scheduledAt
        ? `Got it ? I'll call ${input.name} at ${venueName || 'this restaurant'} in a sensible window and mention ${input.referredByName || 'your colleague'} referred us.`
        : `Got it ? I'll call ${input.name} at ${venueName || 'this restaurant'} and mention ${input.referredByName || 'your colleague'} referred us.`,
    };
  }

  const notes = [
    input.notes,
    input.summary ? `Referral summary: ${input.summary}` : '',
    input.referredByName ? `Referred by: ${input.referredByName}` : '',
    input.role ? `Role: ${input.role}` : '',
  ]
    .filter(Boolean)
    .join(' | ');

  const lead = captureOrUpdateLead(
    {
      name: input.name,
      phone: dialTo,
      notes,
      venueType: input.venueType,
      openingHours: input.openingHours,
      scope: `Referral from ${input.referredByName || 'main line'}`,
    },
    { callId: input.callId, fallbackPhone: undefined },
  );

  if (lead.error) {
    return {
      ok: false,
      error: lead.error,
      spokenHint: lead.spokenHint || 'Could not save that contact.',
    };
  }

  if (input.referredByCustomerId && input.referredByName) {
    try {
      rememberPerson({
        customerId: String(input.referredByCustomerId),
        name: input.referredByName,
        phone: input.referredByPhone,
        howKnown: 'spoke',
      });
    } catch {
      /* referrer memory is best-effort */
    }
  }

  const customerId = String(lead.customer.id);
  const store = getDataStore();
  const idx = store.customers.findIndex((c) => String(c.id) === customerId);
  if (idx >= 0) {
    const prev = store.customers[idx] as Record<string, unknown>;
    const referral = {
      referredByName: input.referredByName || null,
      referredByPhone: input.referredByPhone || null,
      referredByVenue: input.referredByVenue || null,
      referredByCustomerId: input.referredByCustomerId || null,
      sourceCallId: input.callId || null,
      summary: String(input.summary || input.notes || '').slice(0, 500),
      interestHint: String(input.interestHint || '').slice(0, 200),
      capturedAt: new Date().toISOString(),
    };
    store.customers[idx] = {
      ...prev,
      consentToCall: prev.consentToCall ?? true,
      consentSource: (prev.consentSource as ConsentSource) || 'gatekeeper_referral',
      referral,
      referredByName: input.referredByName || prev.referredByName,
      referredByPhone: input.referredByPhone || prev.referredByPhone,
      preferredContactTimes: input.preferredContactTimes || prev.preferredContactTimes,
      timezone: input.timezone || prev.timezone || 'Europe/London',
      contactRole: input.role || prev.contactRole,
    };
    syncData(store);
  }

  // Dedup: skip if already queued to this number
  const fresh = getDataStore();
  const already = (fresh.outboundQueue || []).some((j) => {
    if (!['queued', 'dialling'].includes(String(j.status ?? ''))) return false;
    const to = normalizePhoneExport(String(j.to ?? ''));
    return to === normalizePhoneExport(dialTo);
  });
  if (already) {
    return {
      ok: true,
      customer: lead.customer,
      isNewLead: lead.isNewLead,
      brief,
      spokenHint: `I've already got a call queued to ${input.name}. I'll mention ${input.referredByName || 'your colleague'} referred us.`,
    };
  }

  const scheduled = scheduleSallyOutboundDial({
    to: dialTo,
    customerId,
    customerName: String(lead.customer.name || input.name),
    company: input.referredByVenue || String(lead.customer.name || ''),
    template: 'sally_sales',
    aim: 'sales_outreach',
    source: 'gatekeeper_referral',
    brief,
    scheduledAt: input.scheduledAt || undefined,
    venueAware: true,
    venueProfile: {
      venueType: input.venueType || lead.customer.venueType,
      openingHours: input.openingHours || lead.customer.openingHours,
      preferredContactTimes: input.preferredContactTimes,
      timezone: input.timezone || 'Europe/London',
    },
    customer: fresh.customers.find((c) => String(c.id) === customerId) as Record<string, unknown>,
    context: {
      referral: true,
      referredByName: input.referredByName,
      referredByPhone: input.referredByPhone,
      referredByVenue: input.referredByVenue,
      referredByCustomerId: input.referredByCustomerId,
      sourceCallId: input.callId,
    },
  });

  if (!scheduled.ok) {
    return {
      ok: false,
      error: scheduled.reason || 'queue_failed',
      customer: lead.customer,
      isNewLead: lead.isNewLead,
      spokenHint:
        scheduled.reason === 'do_not_call'
          ? 'That number is marked do-not-call ? I will not dial it.'
          : 'Saved the contact but could not queue the call ? ask staff to follow up.',
    };
  }

  return {
    ok: true,
    customer: lead.customer,
    isNewLead: lead.isNewLead,
    job: scheduled.job,
    scheduledAt: scheduled.scheduledAt,
    brief,
    spokenHint: scheduled.scheduledAt
      ? `Got it ? I'll call ${input.name} in a sensible window and mention ${input.referredByName || 'your colleague'} referred us.`
      : `Got it ? I'll call ${input.name} and mention ${input.referredByName || 'your colleague'} referred us.`,
  };
}

/** Hidden retry ceiling — not a staff UI surface. */
const HIDDEN_CALL_QUEUE_MAX_ATTEMPTS = 3;
/** Hidden retry spacing (minutes) — code constant, not a staff setting. */
const HIDDEN_RETRY_MINUTES = 60;

/** Re-queue CRM leads marked needs_retry using venue-aware slots + eligibility. */
export function enqueueSallyRetryLeads(): number {
  const settings = getAgentSettings();
  const maxAttempts = settings.callQueueMaxAttempts ?? HIDDEN_CALL_QUEUE_MAX_ATTEMPTS;
  const retryMin = HIDDEN_RETRY_MINUTES;
  const store = getDataStore();
  const customers = (store.customers as Array<Record<string, unknown>>) || [];
  let queued = 0;
  const now = Date.now();

  for (const c of customers) {
    if (String(c.callQueueStatus || '') !== 'needs_retry') continue;
    const eligibility = assessContactEligibility(c);
    if (!eligibility.eligible) {
      if (eligibility.doNotCall) {
        saveCustomerRecord({ ...c, callQueueStatus: 'do_not_call' });
      }
      continue;
    }
    const attempts = Number(c.callAttemptCount ?? 0);
    if (attempts >= maxAttempts) continue;
    const phone = String(c.phone || '').trim();
    if (!phone) continue;

    const lastAt = c.lastCallAt ? Date.parse(String(c.lastCallAt)) : NaN;
    const retryFloor = Number.isFinite(lastAt) ? lastAt + retryMin * 60_000 : now;
    const dial = suggestDialWindows({
      venueType: c.venueType,
      openingHours: c.openingHours,
      weeklyHours: c.weeklyHours,
      closedDays: c.closedDays,
      preferredContactTimes: c.preferredContactTimes,
      hasKitchen: c.hasKitchen === true ? true : c.hasKitchen === false ? false : null,
      timezone: c.timezone || 'Europe/London',
      from: new Date(Math.max(now, retryFloor)),
    });
    const nextAt = c.nextFollowUp ? Date.parse(String(c.nextFollowUp)) : NaN;
    const scheduledAt = dial.nextSlotISO
      || (Number.isFinite(nextAt) && nextAt > now ? new Date(nextAt).toISOString() : new Date(retryFloor).toISOString());
    const readyAt = Date.parse(scheduledAt);
    if (Number.isFinite(readyAt) && readyAt > now + 60_000) {
      // Stamp nextFollowUp but wait for worker
      if (!Number.isFinite(nextAt) || Math.abs(nextAt - readyAt) > 60_000) {
        saveCustomerRecord({ ...c, nextFollowUp: scheduledAt, sallyDialHint: dial.reason });
      }
    }

    const already = (store.outboundQueue || []).some((j) =>
      String(j.status) === 'queued'
      && (
        String((j.context as Record<string, unknown> | undefined)?.customerId || '') === String(c.id)
        || normalizePhoneExport(String(j.to ?? '')) === normalizePhoneExport(phone)
      ),
    );
    if (already) continue;

    const referral = c.referral && typeof c.referral === 'object'
      ? (c.referral as Record<string, unknown>)
      : null;
    const brief = referral
      ? formatReferralBrief({
          referredByName: String(referral.referredByName || c.referredByName || ''),
          referredByPhone: String(referral.referredByPhone || c.referredByPhone || ''),
          referredByVenue: String(referral.referredByVenue || ''),
          summary: String(referral.summary || ''),
          interestHint: String(referral.interestHint || ''),
        })
      : `Auto-retry (${attempts + 1}/${maxAttempts}) for ${c.name || phone}`;

    const result = scheduleSallyOutboundDial({
      to: phone,
      customerId: String(c.id),
      customerName: String(c.name || ''),
      company: String(c.name || ''),
      template: 'sally_sales',
      aim: 'sales_outreach',
      source: 'sally_needs_retry',
      brief,
      scheduledAt,
      venueAware: true,
      customer: c,
      bypassQuietHours: dial.bypassGlobalQuiet,
    });
    if (result.ok && !result.skipped) {
      saveCustomerRecord({ ...c, callQueueStatus: 'queued', nextFollowUp: scheduledAt });
      queued += 1;
    }
  }
  return queued;
}
