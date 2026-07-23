/**
 * Sally — Sync2Dine platform_owner outbound sales agent.
 * Sells Sync2Dine to restaurants; researches profile; confirms; provisions tenant org.
 * Hard-split from Lizzie (restaurant food-order agent).
 */
import { randomBytes } from 'crypto';
import {
  appendCustomerCallActivity,
  enqueueOutboundCall,
  getAgentSettings,
  getCallById,
  getDataStore,
  saveCall,
  saveCustomerRecord,
  syncData,
} from '../data-store';
import { getHomeOrgId } from '../home-org';
import {
  draftToAboutUs,
  researchRestaurantProfile,
  spokenConfirmForField,
  type RestaurantProfileDraft,
  type RestaurantProfileField,
} from '../restaurant-research';
import { END_CALL_FUNCTION_TOOL, SET_CALL_LANGUAGE_TOOL } from '../phone-brain';
import { PHONE_TOOLS } from '../phone-tools';
import { getSallyOfferStored, resolveStoredProductPrices, isLaunchOfferActive, allPackageSnapshots } from '../sally-offer-store';
import {
  SAAS_PRODUCTS,
  formatProductsSummary,
  normalizeSaasProductIds,
  resolveProductLines,
  resolvePackageLine,
  sumMonthly,
  sumQuoteTotal,
  type SaasProductId,
  type SaasProductPrices,
} from '../saas-products';
import {
  FARE_SCHEDULE_VERSION,
  OUTBOUND_OVERAGE,
  SAAS_PACKAGE_IDS,
  SAAS_PACKAGES,
  type OverageAction,
  type SaasPackageId,
  formatFareSummary,
  getPackage,
  isSaasPackageId,
  monthlyEquivalentFromWeekly,
} from '../saas-packages';
import { PLAN_CONFIG } from '../organizations';
import {
  assertContractSignedForCheckout,
  contractEmailBody,
  createSaasContract,
  getSaasContractById,
  markSaasContractSent,
} from '../saas-contracts';
import {
  getSallyOfferTerms,
  resolveSallySessionKey,
  isSallySalesCall,
  getSallyDraftForSession,
  getSallyTermsForSession,
  buildSallyCheckoutHandoff,
  type SallyOfferTerms,
  type SallyTermsRecord,
  SALLY_PERSONA,
} from './offer';
import {
  SALLY_PHONE_TOOLS,
  SALLY_EXTENDED_TOOLS,
  getSallyPhoneSessionChatTools,
  getSallyOrchestratorTools,
  isSallyToolName,
  isSallyExclusiveTool,
} from './tools';
import { buildSallyBrainPrompt, buildSallyChatPrompt, buildSallyWebPrompt } from './prompts';

export type SallyToolContext = {
  callId?: string;
  partyPhone?: string;
  sessionKey?: string;
  staffUserId?: string;
};

export async function sendSallyWhatsApp(
  toRaw: string,
  message: string,
): Promise<{ ok: true; to: string } | { ok: false; error: string }> {
  const { normalizeDialableE164 } = await import('../phone-tools');
  const to = normalizeDialableE164(toRaw);
  if (!to) return { ok: false, error: 'invalid_phone' };
  const { isMetaWhatsAppEnabled, sendWhatsAppText } = await import('../whatsapp-webhook');
  const waToken = process.env.WHATSAPP_ACCESS_TOKEN?.trim();
  const waPhoneId = process.env.WHATSAPP_PHONE_NUMBER_ID?.trim();
  if (!isMetaWhatsAppEnabled() || !waToken || !waPhoneId) {
    return { ok: false, error: 'whatsapp_not_configured' };
  }
  await sendWhatsAppText(waPhoneId, waToken, to.startsWith('+') ? to : `+${to}`, message);
  return { ok: true, to };
}

export async function sendSallyEmail(
  to: string,
  subject: string,
  text: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { sendPlainTextEmail } = await import('../email-service');
  const result = await sendPlainTextEmail({ to, subject, text });
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true };
}

export async function deliverSallyChannels(opts: {
  channel: 'email' | 'whatsapp' | 'both';
  toEmail?: string;
  toPhone?: string;
  emailSubject: string;
  emailBody: string;
  whatsappBody: string;
}): Promise<{ sentVia: string[]; errors: string[] }> {
  const sentVia: string[] = [];
  const errors: string[] = [];
  const wantEmail = opts.channel === 'email' || opts.channel === 'both';
  const wantWa = opts.channel === 'whatsapp' || opts.channel === 'both';

  if (wantEmail) {
    const email = (opts.toEmail || '').trim().toLowerCase();
    if (!email || !email.includes('@')) {
      errors.push('email_required');
    } else {
      const r = await sendSallyEmail(email, opts.emailSubject, opts.emailBody);
      if (r.ok) sentVia.push('email');
      else errors.push(r.error);
    }
  }
  if (wantWa) {
    const phone = (opts.toPhone || '').trim();
    if (!phone) {
      errors.push('phone_required');
    } else {
      const r = await sendSallyWhatsApp(phone, opts.whatsappBody);
      if (r.ok) sentVia.push('whatsapp');
      else errors.push(r.error);
    }
  }
  return { sentVia, errors };
}

export async function executeSallyTool(
  name: string,
  args: Record<string, unknown>,
  callIdOrCtx: string | SallyToolContext,
  partyPhoneArg?: string,
): Promise<Record<string, unknown>> {
  const ctx: SallyToolContext = typeof callIdOrCtx === 'string'
    ? { callId: callIdOrCtx, partyPhone: partyPhoneArg || '' }
    : callIdOrCtx;
  const callId = ctx.callId || '';
  const partyPhone = ctx.partyPhone || '';
  const sessionKey = ctx.sessionKey
    || resolveSallySessionKey({ callId, staffUserId: ctx.staffUserId });

  if (name === 'getOfferTerms') {
    const terms = getSallyOfferTerms();
    const phone = terms.products.phone_agent;
    const audio = terms.products.audio_management;
    const plans = {
      starter: PLAN_CONFIG.starter,
      pro: PLAN_CONFIG.pro,
      enterprise: PLAN_CONFIG.enterprise,
    };
    const j = SAAS_PACKAGES.judie_starter;
    const a = SAAS_PACKAGES.atmosphere;
    const c = SAAS_PACKAGES.combined;
    const w = (pkg: typeof j) => (terms.launchActive ? pkg.launchWeeklyGbp : pkg.standardWeeklyGbp);
    return {
      ok: true,
      ...terms,
      plans,
      fareScheduleVersion: terms.fareScheduleVersion,
      spokenHint:
        `Lead with need: Judie from ${w(j)} pounds a week with ${j.weeklyAiMinutes} AI minutes, Atmosphere from ${w(a)} a week, or Complete at ${w(c)} a week best value. ` +
        `Launch is 40 percent off the standard weekly; annual prepay is 50 percent off. ` +
        `Minutes reset weekly — overage is published per package. ` +
        `Comparison monthly for Judie Starter is about ${phone.monthlyPriceGbp} pounds. Atmosphere add path is about ${audio.monthlyPriceGbp} monthly equivalent. ${terms.cancelPolicy}`,
    };
  }

  if (name === 'confirmSaleTerms') {
    if (args.confirmed !== true && args.confirmed !== 'true') {
      return {
        ok: false,
        error: 'confirmation_required',
        spokenHint:
          'Ask them to confirm they understand Judie and/or Atmosphere, the weekly or annual price, fare and overage action, billing, and cancel policy first.',
      };
    }
    const offer = getSallyOfferTerms();
    const packageRaw = String(args.packageId || args.package || '').trim();
    const packageId = isSaasPackageId(packageRaw) ? packageRaw : 'judie_starter';
    const pkg = getPackage(packageId);
    const billingInterval = String(args.billingInterval || args.interval || 'weekly').toLowerCase() === 'annual'
      ? 'annual' as const
      : 'weekly' as const;
    const overageRaw = String(args.overageAction || 'continue_bill').trim() as OverageAction;
    const overageAction: OverageAction =
      overageRaw === 'pause_transfer' || overageRaw === 'approval_required' || overageRaw === 'continue_bill'
        ? overageRaw
        : 'continue_bill';
    const weekly = Number(args.weeklyPriceGbp);
    const monthly = Number(args.monthlyPriceGbp);
    const setup = Number(args.setupFeeGbp);
    const weeklyPrice =
      Number.isFinite(weekly) && weekly > 0
        ? weekly
        : offer.launchActive
          ? pkg.launchWeeklyGbp
          : pkg.standardWeeklyGbp;
    const amountGbp =
      billingInterval === 'annual'
        ? pkg.annualPrepayGbp
        : weeklyPrice;
    const record: SallyTermsRecord = {
      confirmedAt: new Date().toISOString(),
      monthlyPriceGbp:
        Number.isFinite(monthly) && monthly > 0
          ? monthly
          : monthlyEquivalentFromWeekly(weeklyPrice),
      setupFeeGbp: Number.isFinite(setup) && setup >= 0 ? setup : offer.setupFeeGbp,
      weeklyPriceGbp: weeklyPrice,
      packageId,
      billingInterval,
      overageAction,
      amountGbp,
      summary: String(
        args.notes ||
          `Customer confirmed ${pkg.name}, ${billingInterval} £${amountGbp}, overageAction=${overageAction}, fare ${offer.fareScheduleVersion}`,
      ).trim(),
    };
    writeTermsConfirmed(sessionKey, record, callId || undefined);
    return {
      ok: true,
      ...record,
      fareSummary: formatFareSummary(pkg),
      spokenHint: `Noted — they confirmed ${pkg.name} at £${amountGbp}${billingInterval === 'annual' ? ' annual prepay' : '/week'}. Create and send the contract next, then checkout after they sign.`,
    };
  }

  if (name === 'sendSalesAssets') {
    const channel = String(args.channel || '').toLowerCase() as 'email' | 'whatsapp' | 'both';
    if (!['email', 'whatsapp', 'both'].includes(channel)) {
      return { ok: false, error: 'channel_required', spokenHint: 'Should I email, WhatsApp, or both for the demo materials?' };
    }
    const offer = getSallyOfferTerms();
    const parts: string[] = ['Here are your Sync2Dine details:'];
    if (args.includeVideo !== false && offer.demoVideoUrl) parts.push(`Demo video: ${offer.demoVideoUrl}`);
    if (args.includePdf !== false && offer.salesPdfUrl) parts.push(`Overview PDF: ${offer.salesPdfUrl}`);
    if (args.includeDemoPhone !== false && offer.demoPhone) parts.push(`Demo phone: ${offer.demoPhone}`);
    if (parts.length === 1) {
      return {
        ok: false,
        error: 'assets_not_configured',
        spokenHint: 'Demo assets are not configured yet — share the intro price verbally or escalate to set SALLY_DEMO_* env values.',
      };
    }
    const body = parts.join('\n');
    const toEmail = String(args.toEmail || '').trim();
    const toPhone = String(args.toPhone || partyPhone || '').trim();
    const delivered = await deliverSallyChannels({
      channel,
      toEmail,
      toPhone,
      emailSubject: 'Sync2Dine — demo materials',
      emailBody: body,
      whatsappBody: body,
    });
    if (!delivered.sentVia.length) {
      return {
        ok: false,
        error: delivered.errors.join(',') || 'send_failed',
        spokenHint: 'I could not send the materials on that channel — ask for another email or WhatsApp number, or escalate.',
        errors: delivered.errors,
      };
    }
    const customerId = String(args.customerId || '').trim();
    if (customerId) {
      appendCustomerCallActivity({
        customerId,
        callId: callId || undefined,
        summary: `Sales assets sent via ${delivered.sentVia.join(' + ')}`,
        detail: body,
        aim: 'demo_book',
        type: 'note',
        createdBy: 'sally',
      });
    }
    return {
      ok: true,
      sentVia: delivered.sentVia,
      errors: delivered.errors,
      spokenHint: `I've sent the Sync2Dine materials by ${delivered.sentVia.join(' and ')}.`,
    };
  }

  if (name === 'checkPaymentStatus') {
    let organizationId = String(args.organizationId || '').trim();
    const customerId = String(args.customerId || '').trim();
    if (!organizationId && customerId) {
      const store = getDataStore();
      const cust = (store.customers as Array<Record<string, unknown>>).find((c) => String(c.id) === customerId);
      organizationId = String(cust?.saasOrgId || cust?.organizationId || '').trim();
      if (!organizationId && callId) {
        const call = getCallById(callId);
        const meta = (call?.metadata as Record<string, unknown> | undefined) || {};
        organizationId = String(meta.sallyProvisionedOrgId || '').trim();
      }
    }
    if (!organizationId && callId) {
      const call = getCallById(callId);
      const meta = (call?.metadata as Record<string, unknown> | undefined) || {};
      organizationId = String(meta.sallyProvisionedOrgId || '').trim();
    }
    if (!organizationId) {
      return {
        ok: false,
        error: 'organizationId_required',
        spokenHint: 'Which organisation should I check payment for?',
      };
    }
    const { getOrgPaymentStatus } = await import('../stripe-service');
    const status = getOrgPaymentStatus(organizationId);
    if (!status) {
      return { ok: false, error: 'org_not_found', spokenHint: 'I could not find that organisation.' };
    }
    let crmPaid: string | null = null;
    if (customerId) {
      const store = getDataStore();
      const cust = (store.customers as Array<Record<string, unknown>>).find((c) => String(c.id) === customerId);
      crmPaid = cust ? String(cust.saasPaymentStatus || '') || null : null;
    }
    return {
      ok: true,
      ...status,
      crmPaymentStatus: crmPaid,
      spokenHint: status.paid
        ? 'Payment is confirmed — they are live on Sync2Dine.'
        : `Not paid yet — org status ${status.status}${status.subscriptionStatus ? `, subscription ${status.subscriptionStatus}` : ''}.`,
    };
  }

  if (name === 'researchRestaurantProfile') {
    const call = callId ? getCallById(callId) : undefined;
    const meta = (call?.metadata as Record<string, unknown> | undefined) || {};
    const businessName = String(args.businessName || meta.company || call?.contactName || '').trim();
    const phone = String(args.phone || partyPhone || '').trim();
    const website = String(args.website || '').trim();
    const addressHint = String(args.addressHint || '').trim();

    const result = await researchRestaurantProfile({
      businessName,
      phone,
      website: website || undefined,
      addressHint: addressHint || undefined,
      orgId: getHomeOrgId(),
    });

    if (!result.ok) {
      return { ok: false, error: result.error, spokenHint: result.spokenHint };
    }

    const prev = readDraft(sessionKey, callId || undefined);
    const merged: RestaurantProfileDraft = {
      ...prev,
      ...result.draft,
      phone: result.draft.phone || phone || prev.phone,
      businessName: result.draft.businessName || businessName || prev.businessName,
      confirmedFields: prev.confirmedFields || [],
    };
    writeDraft(sessionKey, merged, callId || undefined, { sallyResearchAt: new Date().toISOString() });
    return {
      ok: true,
      draft: merged,
      spokenHint: result.spokenHint,
      nextField: merged.openingHours ? 'openingHours' : 'address',
    };
  }

  if (name === 'getRestaurantSetupDraft') {
    const draft = readDraft(sessionKey, callId || undefined);
    return {
      ok: true,
      draft,
      spokenHint: draft.businessName
        ? `Draft on file for ${draft.businessName}. Confirm remaining fields then provision.`
        : 'No draft yet — research the restaurant first.',
    };
  }

  if (name === 'confirmRestaurantField') {
    const field = String(args.field || '') as RestaurantProfileField;
    if (!field) {
      return { ok: false, error: 'field_required', spokenHint: 'Which field should I confirm?' };
    }
    const draft = { ...readDraft(sessionKey, callId || undefined) };
    const confirmed = args.confirmed !== false && args.confirmed !== 'false';
    if (args.value != null && String(args.value).trim()) {
      const raw = String(args.value).trim();
      if (field === 'deliveryAvailable' || field === 'collectionAvailable' || field === 'reservations') {
        (draft as Record<string, unknown>)[field] = parseBoolish(raw, draft[field] as boolean | null);
      } else {
        (draft as Record<string, unknown>)[field] = raw;
      }
    }
    const confirmedFields = new Set(draft.confirmedFields || []);
    if (confirmed) confirmedFields.add(field);
    else confirmedFields.delete(field);
    draft.confirmedFields = [...confirmedFields];
    writeDraft(sessionKey, draft, callId || undefined);
    const nextHints: RestaurantProfileField[] = [
      'openingHours', 'address', 'deliveryAvailable', 'collectionAvailable',
      'paymentMethods', 'website', 'contactEmail',
    ];
    const next = nextHints.find((f) => !confirmedFields.has(f) && f !== field);
    return {
      ok: true,
      field,
      confirmed: confirmedFields.has(field),
      draft,
      spokenHint: confirmed
        ? (next ? spokenConfirmForField(next, draft) : 'That looks solid. If they are ready, get their email and provision the restaurant account.')
        : spokenConfirmForField(field, draft),
      nextField: next || null,
    };
  }

  if (name === 'provisionRestaurantClient') {
    const termsGate = requireTermsConfirmed(sessionKey, callId || undefined, args);
    if (termsGate) return termsGate;
    if (args.confirmed !== true && args.confirmed !== 'true') {
      return {
        ok: false,
        error: 'confirmation_required',
        spokenHint: 'Ask them to confirm they want the Sync2Dine restaurant account created first.',
      };
    }
    const contactEmail = String(args.contactEmail || '').trim().toLowerCase();
    if (!contactEmail || !contactEmail.includes('@')) {
      return {
        ok: false,
        error: 'email_required',
        spokenHint: 'I need their email address to create the restaurant login.',
      };
    }

    const draft = readDraft(sessionKey, callId || undefined);
    const businessName = String(args.businessName || draft.businessName || 'New Restaurant').trim();
    const contactName = String(args.contactName || businessName).trim();
    const adminPassword = String(args.adminPassword || '').trim() || generateTempPassword();
    const plan = String(args.plan || 'starter').trim() || 'starter';
    const aboutNotes = draftToAboutUs({
      ...draft,
      businessName,
      phone: draft.phone || partyPhone,
      contactEmail,
    });

    try {
      const {
        canProvisionViaSupabase,
        provisionOrganizationInSupabase,
        mapSupabaseOrgToApi,
      } = await import('../provision-org');

      if (canProvisionViaSupabase()) {
        const provisioned = await provisionOrganizationInSupabase({
          name: businessName,
          contactName,
          contactEmail,
          contactPhone: draft.phone || partyPhone,
          address: draft.address,
          plan,
          adminPassword,
          notes: `Provisioned by Sally${callId ? ` on call ${callId}` : ''}.\n${aboutNotes}`,
        });
        const org = mapSupabaseOrgToApi(provisioned.organization);
        await seedTenantProfile(org.id, { ...draft, businessName, contactEmail, phone: draft.phone || partyPhone }, contactEmail);
        writeDraft(sessionKey, {
          ...draft,
          businessName,
          contactEmail,
          phone: draft.phone || partyPhone,
        }, callId || undefined, {
          sallyProvisionedOrgId: org.id,
          sallyProvisionedAt: new Date().toISOString(),
        });
        linkCrmToSallyOrg(org.id, contactEmail, draft.phone || partyPhone);
        return {
          ok: true,
          organizationId: org.id,
          organizationName: org.name,
          contactEmail,
          temporaryPassword: adminPassword,
          plan: org.plan,
          spokenHint: `All set — I've created ${org.name} on Sync2Dine. They can log in with ${contactEmail}. I've set a temporary password; tell them to change it after first login.`,
        };
      }

      const { createOrganization } = await import('../organizations');
      const local = createOrganization({
        name: businessName,
        contactName,
        contactEmail,
        contactPhone: String(draft.phone || partyPhone || ''),
        address: draft.address,
        plan: plan as 'starter' | 'pro' | 'enterprise',
        notes: `Provisioned by Sally${callId ? ` on call ${callId}` : ''}.\n${aboutNotes}`,
      });
      writeDraft(sessionKey, { ...draft, businessName, contactEmail }, callId || undefined, {
        sallyProvisionedOrgId: local.id,
        sallyProvisionedAt: new Date().toISOString(),
      });
      linkCrmToSallyOrg(local.id, contactEmail, draft.phone || partyPhone);
      return {
        ok: true,
        organizationId: local.id,
        organizationName: local.name,
        contactEmail,
        temporaryPassword: adminPassword,
        plan: local.plan,
        localOnly: true,
        spokenHint: `I've created ${local.name} on Sync2Dine (local record). Login email ${contactEmail}.`,
      };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'provision_failed',
        spokenHint: 'Sorry — creating the restaurant account failed. Offer a callback and we will finish setup from the office.',
      };
    }
  }

  if (name === 'bookDemo') {
    const scheduledAt = String(args.scheduledAt || '').trim();
    if (!scheduledAt) {
      return { ok: false, error: 'scheduledAt_required', spokenHint: 'When should we book the demo?' };
    }
    const customerId = String(args.customerId || '').trim();
    const phone = String(args.phone || partyPhone || '').trim();
    const contactName = String(args.contactName || '').trim();
    const notes = String(args.notes || '').trim();
    const detail = `Demo booked for ${scheduledAt}${notes ? ` — ${notes}` : ''}`;
    if (customerId) {
      appendCustomerCallActivity({
        customerId,
        callId: callId || undefined,
        summary: detail,
        detail,
        aim: 'demo_book',
        type: 'note',
        createdBy: 'sally',
      });
      const store = getDataStore();
      const cust = (store.customers as Array<Record<string, unknown>>).find((c) => String(c.id) === customerId);
      if (cust) {
        saveCustomerRecord({ ...cust, nextFollowUp: scheduledAt, status: cust.status || 'lead' });
        syncData({ customers: store.customers });
      }
    }
    if (args.alsoQueueCallback && phone) {
      enqueueOutboundCall({
        to: phone,
        template: 'lead_callback',
        status: 'queued',
        scheduledAt,
        context: {
          customerId: customerId || undefined,
          company: contactName,
          aim: 'demo_book',
          agentPersona: SALLY_PERSONA,
          brief: `Demo callback for ${contactName || 'prospect'} at ${scheduledAt}`,
          source: 'sally_book_demo',
        },
      });
    }
    return {
      ok: true,
      scheduledAt,
      customerId: customerId || null,
      spokenHint: `Demo booked for ${scheduledAt}. I've noted it on the CRM${args.alsoQueueCallback && phone ? ' and queued a reminder call' : ''}.`,
    };
  }

  if (name === 'leaveVoicemail') {
    const left = args.left === true || args.left === 'true';
    const customerId = String(args.customerId || '').trim();
    const summary = String(args.messageSummary || 'Voicemail follow-up').trim();
    const channel = String(args.scheduleFollowUpChannel || (left ? 'none' : 'whatsapp'));
    if (customerId) {
      appendCustomerCallActivity({
        customerId,
        callId: callId || undefined,
        summary: left ? `Voicemail left: ${summary}` : `Voicemail not available — follow up via ${channel}: ${summary}`,
        detail: summary,
        aim: 'sales_outreach',
        outcome: left ? 'voicemail' : 'callback_requested',
        disposition: left ? 'voicemail' : 'callback_requested',
        type: 'note',
        createdBy: 'sally',
        updateCallQueue: true,
      });
    }
    const phone = String(args.phone || partyPhone || '').trim();
    if (!left && channel === 'callback' && phone) {
      const retryMin = getAgentSettings().callQueueRetryMinutes ?? 60;
      enqueueOutboundCall({
        to: phone,
        template: 'lead_callback',
        status: 'queued',
        scheduledAt: new Date(Date.now() + retryMin * 60_000).toISOString(),
        context: {
          customerId: customerId || undefined,
          aim: 'sales_outreach',
          agentPersona: SALLY_PERSONA,
          brief: summary,
          source: 'sally_voicemail_followup',
        },
      });
    }
    return {
      ok: true,
      left,
      followUpChannel: channel,
      spokenHint: left
        ? 'Noted — voicemail left and CRM updated.'
        : `Live voicemail drop isn't available; I've logged it and scheduled a ${channel} follow-up.`,
    };
  }

  if (name === 'createSaasQuote') {
    const plan = String(args.plan || 'starter') as 'starter' | 'pro' | 'enterprise';
    const offer = getSallyOfferTerms();
    const packageRaw = String(args.packageId || '').trim();
    const billingInterval =
      String(args.billingInterval || args.interval || 'weekly').toLowerCase() === 'annual'
        ? ('annual' as const)
        : ('weekly' as const);
    const additionalSites = Math.max(0, Math.floor(Number(args.additionalSites) || 0));
    const customerId = String(args.customerId || '').trim();
    const businessName = String(args.businessName || '').trim() || 'Restaurant';

    let lines: ReturnType<typeof resolvePackageLine>;
    let products: SaasProductId[] = [];
    let packageId: SaasPackageId | undefined;
    let fareSummary: string;

    if (isSaasPackageId(packageRaw)) {
      packageId = packageRaw;
      const pkg = getPackage(packageId);
      lines = resolvePackageLine(packageId, {
        interval: billingInterval,
        useLaunch: offer.launchActive,
        additionalSites,
      });
      fareSummary = formatFareSummary(pkg);
    } else {
      products = normalizeSaasProductIds(args.products);
      if (!products.length) {
        products = ['phone_agent'];
      }
      const quantities = (args.quantities && typeof args.quantities === 'object'
        ? args.quantities
        : {}) as Partial<Record<SaasProductId, number>>;
      const monthlyArg = Number(args.monthlyPriceGbp);
      const weeklyArg = Number(args.weeklyPriceGbp);
      const priceOverrides: Partial<Record<SaasProductId, number>> = {};
      if (Number.isFinite(monthlyArg) && monthlyArg > 0 && products.includes('phone_agent')) {
        priceOverrides.phone_agent = monthlyArg;
      }
      if (Number.isFinite(weeklyArg) && weeklyArg > 0 && products.includes('phone_agent')) {
        priceOverrides.phone_agent = monthlyEquivalentFromWeekly(weeklyArg);
      }
      lines = resolveProductLines(products, offer.products, quantities, priceOverrides);
      const legacyPkg = products.length === 1 ? getPackage(SAAS_PRODUCTS[products[0]!].packageId) : getPackage('judie_starter');
      fareSummary = formatFareSummary(legacyPkg);
    }

    const monthly = sumMonthly(lines);
    const total = sumQuoteTotal(lines);
    const quoteId = `saas-${Date.now().toString(36)}`;
    const summary = formatProductsSummary(lines);
    const { saveQuoteRecord } = await import('../data-store');
    const quote = {
      id: quoteId,
      customerId: customerId || null,
      customerName: businessName,
      tradeId: 'sync2dine_saas',
      tradeName: 'Sync2Dine SaaS',
      status: 'draft',
      total,
      currency: 'GBP',
      billing: billingInterval === 'annual' ? 'annual' : 'weekly',
      billingInterval,
      plan,
      packageId: packageId || null,
      products,
      fareSummary,
      lines: lines.map((l) => ({
        id: l.id,
        description: l.description,
        quantity: l.quantity,
        unit: l.unit,
        rate: l.rate,
        total: l.total,
        category: l.category,
        productId: l.productId,
        packageId: l.packageId,
        billingInterval: l.billingInterval,
      })),
      items: lines
        .filter((l) => l.category === 'product' || l.category === 'site')
        .map((l) => ({
          productId: l.productId,
          name: l.description,
          quantity: l.quantity,
          price: l.rate,
          total: l.total,
        })),
      extras: lines
        .filter((l) => l.category === 'extra')
        .map((l) => ({ description: l.description, price: l.total })),
      labour: [],
      discount: 0,
      notes: String(args.notes || `Sync2Dine ${plan} - ${summary}`),
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      source: 'sally',
    };
    saveQuoteRecord(quote);
    if (customerId) {
      appendCustomerCallActivity({
        customerId,
        summary: `SaaS quote ${quoteId}: ${summary} (total GBP ${total})`,
        detail: quote.notes as string,
        aim: 'quote_requested',
        type: 'note',
        createdBy: 'sally',
      });
    }
    return {
      ok: true,
      quoteId,
      plan,
      packageId,
      products,
      billingInterval,
      fareSummary,
      lines,
      monthlyPriceGbp: monthly,
      total,
      spokenHint: `I've drafted a Sync2Dine quote for ${summary}, totalling ${total} pounds (${quoteId}).`,
    };
  }

  if (name === 'createSaasContract') {
    const termsGate = requireTermsConfirmed(sessionKey, callId || undefined, args);
    if (termsGate) return termsGate;
    const terms = readTermsConfirmed(sessionKey, callId || undefined);
    const packageRaw = String(args.packageId || terms?.packageId || '').trim();
    if (!isSaasPackageId(packageRaw)) {
      return {
        ok: false,
        error: 'packageId_required',
        spokenHint: 'Which Sync2Dine package did they agree to - Judie, Atmosphere, or Complete?',
      };
    }
    const billingInterval =
      String(args.billingInterval || terms?.billingInterval || 'weekly').toLowerCase() === 'annual'
        ? ('annual' as const)
        : ('weekly' as const);
    const overageRaw = String(args.overageAction || terms?.overageAction || 'continue_bill').trim() as OverageAction;
    const overageAction: OverageAction =
      overageRaw === 'pause_transfer' || overageRaw === 'approval_required' || overageRaw === 'continue_bill'
        ? overageRaw
        : 'continue_bill';
    const restaurantName = String(args.restaurantName || '').trim();
    const contactName = String(args.contactName || '').trim();
    const contactEmail = String(args.contactEmail || '').trim().toLowerCase();
    if (!restaurantName || !contactName || !contactEmail || !contactEmail.includes('@')) {
      return {
        ok: false,
        error: 'contact_required',
        spokenHint: 'I need restaurant name, contact name, and email to create the contract.',
      };
    }
    try {
      const contract = createSaasContract({
        packageId: packageRaw,
        billingInterval,
        overageAction,
        additionalSites: Number(args.additionalSites) || 0,
        customerId: String(args.customerId || '').trim() || undefined,
        organizationId: String(args.organizationId || '').trim() || undefined,
        restaurantName,
        contactName,
        contactEmail,
        contactPhone: String(args.contactPhone || partyPhone || '').trim() || undefined,
        address: String(args.address || '').trim() || undefined,
        notes: String(args.notes || terms?.summary || '').trim() || undefined,
        createdBy: 'sally',
      });
      const customerId = String(args.customerId || '').trim();
      if (customerId) {
        appendCustomerCallActivity({
          customerId,
          summary: `SaaS contract ${contract.id} drafted (${contract.packageId})`,
          detail: contract.signingUrl,
          aim: 'quote_requested',
          type: 'note',
          createdBy: 'sally',
        });
      }
      if (callId) {
        const call = getCallById(callId);
        const meta = (call?.metadata as Record<string, unknown> | undefined) || {};
        saveCall({
          id: callId,
          metadata: {
            ...meta,
            sallyLastContractId: contract.id,
            sallyLastContractUrl: contract.signingUrl,
          },
        });
      }
      return {
        ok: true,
        contractId: contract.id,
        signingUrl: contract.signingUrl,
        packageId: contract.packageId,
        billingInterval: contract.billingInterval,
        fareSummary: contract.fareSummary,
        amountGbp: contract.amountGbp,
        spokenHint: `Contract ready for ${restaurantName}. Send it with sendContract, then checkout after they sign.`,
      };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'contract_failed',
        spokenHint: 'Could not create the Sync2Dine contract - check the package and contact details.',
      };
    }
  }

  if (name === 'sendContract') {
    const contractId = String(args.contractId || '').trim();
    if (!contractId) {
      return {
        ok: false,
        error: 'contractId_required',
        spokenHint: 'Which contract should I email - create one with createSaasContract first.',
      };
    }
    const contract = getSaasContractById(contractId);
    if (!contract) {
      return {
        ok: false,
        error: 'contract_not_found',
        spokenHint: 'That contract id was not found - create a new one with createSaasContract.',
      };
    }
    const toEmail = String(args.toEmail || contract.contactEmail || '').trim().toLowerCase();
    if (!toEmail || !toEmail.includes('@')) {
      return {
        ok: false,
        error: 'email_required',
        spokenHint: 'What email should I send the signing link to?',
      };
    }
    const { subject, text } = contractEmailBody(contract);
    const delivered = await deliverSallyChannels({
      channel: 'email',
      toEmail,
      toPhone: String(contract.contactPhone || partyPhone || '').trim(),
      emailSubject: subject,
      emailBody: text,
      whatsappBody: text,
    });
    if (!delivered.sentVia.length) {
      return {
        ok: false,
        error: delivered.errors.join(',') || 'delivery_failed',
        contractId,
        signingUrl: contract.signingUrl,
        spokenHint: 'I could not email the contract - confirm their email or escalate.',
        errors: delivered.errors,
      };
    }
    markSaasContractSent(contractId);
    const customerId = String(args.customerId || contract.customerId || '').trim();
    if (customerId) {
      appendCustomerCallActivity({
        customerId,
        summary: `Sync2Dine contract ${contractId} emailed`,
        detail: contract.signingUrl,
        aim: 'quote_requested',
        type: 'note',
        createdBy: 'sally',
      });
    }
    return {
      ok: true,
      contractId,
      signingUrl: contract.signingUrl,
      sentVia: delivered.sentVia,
      spokenHint: `I've emailed the contract signing link to ${toEmail}. Once they sign, use sendStripeCheckoutLink for payment.`,
    };
  }

  if (name === 'sendStripeCheckoutLink') {
    const termsGate = requireTermsConfirmed(sessionKey, callId || undefined, args);
    if (termsGate) return termsGate;
    const channel = String(args.channel || args.sendVia || '').toLowerCase() as 'email' | 'whatsapp' | 'both';
    if (!['email', 'whatsapp', 'both'].includes(channel)) {
      return {
        ok: false,
        error: 'channel_required',
        spokenHint: 'Should I email, WhatsApp, or both for the payment link?',
      };
    }
    const contractIdArg = String(args.contractId || '').trim();
    let signedContract;
    try {
      signedContract = assertContractSignedForCheckout({
        contractId: contractIdArg || undefined,
        organizationId: String(args.organizationId || '').trim() || undefined,
      });
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'contract_not_signed',
        spokenHint:
          'They need a signed Sync2Dine contract before checkout - create and send the contract, then try again after they sign.',
      };
    }
    const organizationId = String(args.organizationId || signedContract.organizationId || '').trim();
    if (!organizationId) {
      return {
        ok: false,
        error: 'organizationId_required',
        spokenHint: 'Which organisation should get the Stripe checkout link? Provision the restaurant first if needed.',
      };
    }
    try {
      const { createCheckoutSessionForOrg } = await import('../stripe-service');
      const { getOrganizationById } = await import('../organizations');
      const org = getOrganizationById(organizationId);
      const toEmail = String(args.toEmail || signedContract.contactEmail || org?.contactEmail || '').trim();
      const toPhone = String(args.toPhone || partyPhone || signedContract.contactPhone || org?.contactPhone || '').trim();
      const quoteId = String(args.quoteId || '').trim();
      const stripeInterval = signedContract.billingInterval === 'annual' ? ('year' as const) : ('week' as const);
      let lineItems: Array<{
        description: string;
        unitAmountGbp: number;
        quantity?: number;
        recurring?: boolean;
        interval?: 'week' | 'month' | 'year';
      }> = resolvePackageLine(signedContract.packageId, {
        interval: signedContract.billingInterval,
        useLaunch: signedContract.useLaunch,
        additionalSites: signedContract.additionalSites,
      })
        .map((l) => ({
          description: l.description,
          unitAmountGbp: l.rate,
          quantity: l.quantity,
          recurring: l.category !== 'extra',
          interval: l.unit === 'year' ? 'year' : l.unit === 'week' ? 'week' : stripeInterval,
        }))
        .filter((l) => l.unitAmountGbp > 0);

      if (!lineItems.length && quoteId) {
        const { getDataStore } = await import('../data-store');
        const store = getDataStore();
        const quote = (store.quotes as Array<Record<string, unknown>>).find((q) => String(q.id) === quoteId);
        if (quote) {
          const qInterval =
            String(quote.billingInterval || quote.billing || 'weekly').toLowerCase() === 'annual' ? 'annual' : 'weekly';
          const qPackage = String(quote.packageId || '').trim();
          if (isSaasPackageId(qPackage)) {
            lineItems = resolvePackageLine(qPackage, {
              interval: qInterval,
              useLaunch: getSallyOfferTerms().launchActive,
              additionalSites: Number(quote.additionalSites) || 0,
            }).map((l) => ({
              description: l.description,
              unitAmountGbp: l.rate,
              quantity: l.quantity,
              recurring: l.category !== 'extra',
              interval: l.unit === 'year' ? 'year' : 'week',
            }));
          }
        }
      }

      const url = await createCheckoutSessionForOrg(organizationId, {
        metadata: {
          sallySession: sessionKey,
          customerEmail: toEmail || org?.contactEmail || '',
          contractId: signedContract.id,
          ...(quoteId ? { quoteId } : {}),
        },
        lineItems,
      });
      const msg = [
        'Your Sync2Dine payment link is ready.',
        `Pay securely here: ${url}`,
        'Once paid, your restaurant account stays live on the plan we discussed.',
      ].join('\n');
      const delivered = await deliverSallyChannels({
        channel,
        toEmail,
        toPhone,
        emailSubject: 'Sync2Dine - complete your subscription',
        emailBody: msg,
        whatsappBody: msg,
      });
      if (!delivered.sentVia.length) {
        return {
          ok: false,
          error: delivered.errors.join(',') || 'delivery_failed',
          checkoutUrl: url,
          organizationId,
          contractId: signedContract.id,
          spokenHint:
            'I created the payment link but could not send it - ask for another email or WhatsApp number, or escalate.',
          errors: delivered.errors,
        };
      }
      const customerId = String(args.customerId || signedContract.customerId || '').trim();
      if (customerId) {
        appendCustomerCallActivity({
          customerId,
          summary: `Stripe checkout sent via ${delivered.sentVia.join(' + ')}`,
          detail: url,
          aim: 'quote_requested',
          type: 'note',
          createdBy: 'sally',
        });
      }
      if (callId) {
        const call = getCallById(callId);
        const meta = (call?.metadata as Record<string, unknown> | undefined) || {};
        saveCall({
          id: callId,
          metadata: {
            ...meta,
            sallyCheckoutUrl: url,
            sallyCheckoutSentVia: delivered.sentVia,
            sallyCheckoutAt: new Date().toISOString(),
            sallyCheckoutContractId: signedContract.id,
            ...(quoteId ? { sallyCheckoutQuoteId: quoteId } : {}),
          },
        });
      }
      return {
        ok: true,
        checkoutUrl: url,
        organizationId,
        contractId: signedContract.id,
        quoteId: quoteId || undefined,
        sentVia: delivered.sentVia,
        errors: delivered.errors,
        spokenHint: `I've ${delivered.sentVia.includes('email') && delivered.sentVia.includes('whatsapp') ? 'emailed and WhatsAppd' : delivered.sentVia.includes('email') ? 'emailed' : 'WhatsAppd'} the payment link. They can open it now while we stay on the line.`,
      };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'stripe_failed',
        spokenHint: 'Could not create a Stripe checkout link - check Stripe is configured for that organisation.',
      };
    }
  }
  if (name === 'bookOnboarding') {
    const scheduledAt = String(args.scheduledAt || '').trim();
    if (!scheduledAt) {
      return { ok: false, error: 'scheduledAt_required', spokenHint: 'When should onboarding happen?' };
    }
    const customerId = String(args.customerId || '').trim();
    const organizationId = String(args.organizationId || '').trim();
    const phone = String(args.phone || partyPhone || '').trim();
    const detail = `Onboarding booked ${scheduledAt}${organizationId ? ` for org ${organizationId}` : ''}${args.notes ? ` — ${args.notes}` : ''}`;
    if (customerId) {
      appendCustomerCallActivity({
        customerId,
        summary: detail,
        detail,
        aim: 'appointment_booked',
        type: 'note',
        createdBy: 'sally',
      });
    }
    if (phone) {
      enqueueOutboundCall({
        to: phone,
        template: 'lead_callback',
        status: 'queued',
        scheduledAt,
        context: {
          customerId: customerId || undefined,
          aim: 'onboarding',
          agentPersona: SALLY_PERSONA,
          brief: detail,
          source: 'sally_book_onboarding',
          organizationId: organizationId || undefined,
        },
      });
    }
    return {
      ok: true,
      scheduledAt,
      organizationId: organizationId || null,
      spokenHint: `Onboarding booked for ${scheduledAt}.`,
    };
  }

  if (name === 'requestGoogleReview') {
    const customerId = String(args.customerId || '').trim();
    const channel = String(args.channel || 'note_only');
    const url = String(args.googleReviewUrl || process.env.GOOGLE_REVIEW_URL || '').trim()
      || 'https://g.page/r/ — ask staff for the Google review link';
    const message = `We'd love a Google review if you're happy with Sync2Dine: ${url}`;
    if (customerId) {
      appendCustomerCallActivity({
        customerId,
        summary: 'Google review requested',
        detail: message,
        aim: 'satisfaction',
        type: 'note',
        createdBy: 'sally',
      });
    }
    return {
      ok: true,
      googleReviewUrl: url,
      channel,
      message,
      spokenHint: channel === 'note_only'
        ? `Review ask ready: ${url}`
        : `Ask them for a Google review via ${channel}: ${url}`,
    };
  }

  if (name === 'proposePlanUpsell') {
    const organizationId = String(args.organizationId || '').trim();
    const targetPlan = String(args.targetPlan || 'pro') as 'pro' | 'enterprise';
    if (!organizationId) {
      return { ok: false, error: 'organizationId_required', spokenHint: 'Which organisation are we upselling?' };
    }
    const { getOrganizationById, updateOrganization } = await import('../organizations');
    const org = getOrganizationById(organizationId);
    if (!org) {
      return { ok: false, error: 'org_not_found', spokenHint: 'I could not find that organisation.' };
    }
    updateOrganization(organizationId, { plan: targetPlan, notes: `${org.notes || ''}\nSally proposed upsell to ${targetPlan}`.trim() });
    let checkoutUrl: string | undefined;
    if (args.createCheckout === true || args.createCheckout === 'true') {
      try {
        const { createCheckoutSessionForOrg } = await import('../stripe-service');
        checkoutUrl = await createCheckoutSessionForOrg(organizationId);
      } catch {
        /* optional */
      }
    }
    return {
      ok: true,
      organizationId,
      fromPlan: org.plan,
      targetPlan,
      checkoutUrl: checkoutUrl || null,
      spokenHint: checkoutUrl
        ? `Proposed upgrade to ${targetPlan}. Checkout: ${checkoutUrl}`
        : `Proposed upgrade from ${org.plan} to ${targetPlan}.`,
    };
  }

  if (name === 'chaseUnpaidInvoice') {
    const customerId = String(args.customerId || '').trim();
    const organizationId = String(args.organizationId || '').trim();
    const phone = String(args.phone || partyPhone || '').trim();
    const channel = String(args.channel || 'callback');
    const notes = String(args.notes || 'Past-due Sync2Dine invoice chase').trim();
    if (customerId) {
      appendCustomerCallActivity({
        customerId,
        summary: `Invoice chase (${channel})`,
        detail: notes,
        aim: 'past_due',
        type: 'note',
        createdBy: 'sally',
      });
    }
    if (channel === 'callback' && phone) {
      enqueueOutboundCall({
        to: phone,
        template: 'payment_reminder',
        status: 'queued',
        context: {
          customerId: customerId || undefined,
          organizationId: organizationId || undefined,
          aim: 'past_due',
          agentPersona: SALLY_PERSONA,
          brief: notes,
          source: 'sally_chase_unpaid',
        },
      });
    }
    return {
      ok: true,
      channel,
      organizationId: organizationId || null,
      spokenHint: `I've logged the unpaid chase${channel === 'callback' && phone ? ' and queued a payment reminder call' : ''}.`,
    };
  }

  return { ok: false, error: `unknown_sally_tool:${name}` };
}

/** Re-queue CRM leads marked needs_retry whose nextFollowUp/retry window has elapsed. */
export function enqueueSallyRetryLeads(): number {
  const settings = getAgentSettings();
  const maxAttempts = settings.callQueueMaxAttempts ?? 3;
  const retryMin = settings.callQueueRetryMinutes ?? 60;
  const store = getDataStore();
  const customers = (store.customers as Array<Record<string, unknown>>) || [];
  let queued = 0;
  const now = Date.now();
  for (const c of customers) {
    if (String(c.callQueueStatus || '') !== 'needs_retry') continue;
    const attempts = Number(c.callAttemptCount ?? 0);
    if (attempts >= maxAttempts) continue;
    const phone = String(c.phone || '').trim();
    if (!phone) continue;
    const lastAt = c.lastCallAt ? Date.parse(String(c.lastCallAt)) : NaN;
    const nextAt = c.nextFollowUp ? Date.parse(String(c.nextFollowUp)) : NaN;
    const readyAt = Number.isFinite(nextAt)
      ? nextAt
      : (Number.isFinite(lastAt) ? lastAt + retryMin * 60_000 : now);
    if (readyAt > now) continue;
    const already = (store.outboundQueue || []).some((j) =>
      String(j.status) === 'queued'
      && String((j.context as Record<string, unknown> | undefined)?.customerId || '') === String(c.id)
    );
    if (already) continue;
    enqueueOutboundCall({
      to: phone,
      template: 'lead_callback',
      status: 'queued',
      context: {
        customerId: String(c.id),
        company: String(c.name || ''),
        aim: 'sales_outreach',
        agentPersona: SALLY_PERSONA,
        brief: `Auto-retry (${attempts + 1}/${maxAttempts}) for ${c.name || phone}`,
        source: 'sally_needs_retry',
      },
    });
    saveCustomerRecord({ ...c, callQueueStatus: 'queued' });
    queued += 1;
  }
  if (queued) syncData({ customers: store.customers });
  return queued;
}

