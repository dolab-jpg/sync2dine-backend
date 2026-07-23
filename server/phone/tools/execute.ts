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
import { captureOrUpdateLead, normalizeDialableE164 } from './leads';
import { PHONE_TOOLS, PHONE_AUTO_ACTIONS } from './catalog';

export async function executePhoneTool(
  name: string,
  input: Record<string, unknown>,
  body: OrchestratorRequest,
): Promise<Record<string, unknown>> {
  const { SALLY_RECEPTIONIST_TOOL_NAMES, executeSallyReceptionistTool } = await import('../sally-receptionist');
  if (SALLY_RECEPTIONIST_TOOL_NAMES.has(name)) {
    return executeSallyReceptionistTool(name, input, {
      callId: firstString(body.callContext?.callId),
      staffUserId: firstString(body.staffContext?.userId),
      orgId: body.orgId || getRequestOrgId(),
    });
  }
  if (RESTAURANT_TOOL_NAMES.has(name) && name !== 'getMenu') {
    return executeRestaurantTool(name, input, body);
  }
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
    const preferredRaw = firstString(input.preferredTime, input.scheduledAt) || '';
    const scheduledIso = preferredRaw
      ? (resolveCallbackIso(preferredRaw) || preferredRaw)
      : undefined;
    const job = enqueueOutboundCall({
      to: dialTo,
      template: 'lead_callback',
      status: 'queued',
      context: {
        name: input.name,
        reason: input.reason,
        preferredTime: preferredRaw || scheduledIso,
        urgency: input.urgency ?? 'medium',
        callId,
        customerId: firstString(input.customerId, body.customerContext?.customerId),
        aim: firstString(input.aim) || 'callback',
      },
      scheduledAt: scheduledIso,
    });
    const customerId = firstString(input.customerId, body.customerContext?.customerId);
    if (customerId) {
      appendCustomerCallActivity({
        customerId,
        callId: callId ?? undefined,
        summary: `Callback booked to ${dialTo}${scheduledIso ? ` (${scheduledIso})` : preferredRaw ? ` (${preferredRaw})` : ''}`,
        detail: String(input.reason ?? 'Callback requested'),
        aim: 'callback',
        type: 'callback',
      });
      if (scheduledIso || preferredRaw) {
        const store = getDataStore();
        const idx = store.customers.findIndex((c) => String(c.id) === customerId);
        if (idx >= 0) {
          store.customers[idx] = { ...store.customers[idx], nextFollowUp: scheduledIso || preferredRaw };
          syncData(store);
        }
      }
    }
    return {
      callbackQueued: true,
      jobId: job.id,
      to: dialTo,
      preferredTime: preferredRaw || undefined,
      scheduledAt: scheduledIso,
      spokenHint: `Callback queued to ${dialTo}${scheduledIso ? ` at ${scheduledIso}` : preferredRaw ? ` around ${preferredRaw}` : ''}.`,
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
        customerName = found.name || customerName;
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
      const { isMetaWhatsAppEnabled, sendWhatsAppText } = await import('../whatsapp-webhook');
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
      context: {
        ...((input.context && typeof input.context === 'object') ? input.context as Record<string, unknown> : {}),
        customerId: firstString(
          (input.context as Record<string, unknown> | undefined)?.customerId as string | undefined,
          input.customerId,
          body.customerContext?.customerId,
        ),
        brief: firstString(
          (input.context as Record<string, unknown> | undefined)?.brief as string | undefined,
          input.brief,
          input.aim,
          input.reason,
        ),
        aim: firstString(
          (input.context as Record<string, unknown> | undefined)?.aim as string | undefined,
          input.aim,
          input.reason,
        ) || 'callback',
        source: name === 'placeOutboundCall' ? 'cynthia_place_outbound' : 'cynthia_enqueue_outbound',
      },
      scheduledAt: input.scheduledAt,
    });
    return {
      jobId: job.id,
      to: dialTo,
      template: input.template || 'lead_callback',
      queued: true,
      status: 'queued',
      dialled: false,
      spokenHint: name === 'placeOutboundCall'
        ? `Queued an outbound call to ${dialTo} — the dialler will place it shortly.`
        : `Queued an outbound call to ${dialTo}.`,
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

  if (name === 'getMenu') {
    const store = getDataStore();
    const aboutUs = store.agentSettings?.aboutUs?.trim();
    const sayToday = store.agentSettings?.sayToday?.trim();
    const category = firstString(input.category)?.toLowerCase();
    const menu = await listMenuItemsForOrg(firstString(body.orgId) ?? getRequestOrgId(), category);
    if (!menu.length) {
      return {
        ok: true,
        menu: [],
        aboutUs: aboutUs || undefined,
        sayToday: sayToday || undefined,
        spokenHint: category
          ? `We don't have anything under ${category} on the menu right now.`
          : 'The menu is not set up yet — the team can add dishes from the Menu tab. I can still take a message or a callback.',
      };
    }
    return {
      ok: true,
      menu: menu.map(({
        category: cat,
        name: itemName,
        price,
        description,
        deal,
        allergensContains,
        allergensMayContain,
        dietary,
        allergenNotes,
        allergenDeclared,
      }) => ({
        category: cat,
        name: itemName,
        price,
        ...(description ? { description } : {}),
        allergensContains,
        allergensMayContain,
        ...(dietary?.length ? { dietary } : {}),
        ...(allergenNotes ? { allergenNotes } : {}),
        ...(allergenDeclared ? { allergenDeclared: true } : {}),
        ...(deal
          ? {
              deal: {
                roles: deal.roles.map((r) => ({
                  role: r.role,
                  qtyPerDeal: r.qtyPerDeal,
                  choices: r.choices,
                })),
              },
            }
          : {}),
      })),
      aboutUs: aboutUs || undefined,
      sayToday: sayToday || undefined,
      spokenHint: sayToday
        ? `Today: ${sayToday}. I can read the menu or take your order.`
        : 'I can read the menu or take your order whenever you are ready.',
    };
  }

  if (name === 'getDeliveryAreas') {
    const { normalizeDeliveryPrefixes } = await import('../delivery-areas');
    const { formatSpokenGbp } = await import('../spoken-money');
    const settings = getDataStore().agentSettings;
    const prefixes = normalizeDeliveryPrefixes(settings?.deliveryPostcodePrefixes);
    const notes = settings?.deliveryNotes?.trim() || '';
    const minOrderGbp = Number(settings?.minOrderGbp ?? 0) || 0;
    const deliveryFeeGbp = Number(settings?.deliveryFeeGbp ?? 0) || 0;
    const freeDeliveryOverGbp = Number(settings?.freeDeliveryOverGbp ?? 0) || 0;
    const ruleBits: string[] = [];
    if (minOrderGbp > 0) ruleBits.push(`minimum order ${formatSpokenGbp(minOrderGbp)}`);
    if (deliveryFeeGbp > 0) ruleBits.push(`delivery ${formatSpokenGbp(deliveryFeeGbp)}`);
    if (freeDeliveryOverGbp > 0) ruleBits.push(`free delivery over ${formatSpokenGbp(freeDeliveryOverGbp)}`);
    const rulesSpeak = ruleBits.length ? ruleBits.join(', ') : '';
    if (!prefixes.length) {
      return {
        ok: true,
        prefixes: [],
        deliveryNotes: notes || undefined,
        minOrderGbp,
        deliveryFeeGbp,
        freeDeliveryOverGbp,
        spokenHint: notes || rulesSpeak
          ? `We have not set delivery postcodes in the app yet. ${[rulesSpeak, notes].filter(Boolean).join('. ')}`
          : 'We have not set delivery postcodes in the app yet — I can offer collection, or take a message for the team.',
      };
    }
    const spokenPrefixes = prefixes.join(', ');
    return {
      ok: true,
      prefixes,
      deliveryNotes: notes || undefined,
      minOrderGbp,
      deliveryFeeGbp,
      freeDeliveryOverGbp,
      spokenHint: [
        `We deliver to postcodes starting ${spokenPrefixes}.`,
        rulesSpeak,
        notes,
      ].filter(Boolean).join(' '),
    };
  }

  if (name === 'checkDeliveryArea') {
    const { matchDeliveryPostcode, normalizeDeliveryPrefixes } = await import('../delivery-areas');
    const settings = getDataStore().agentSettings;
    const prefixes = normalizeDeliveryPrefixes(settings?.deliveryPostcodePrefixes);
    const postcode = firstString(input.postcode) ?? '';
    if (!postcode) {
      return {
        ok: false,
        error: 'postcode_required',
        spokenHint: 'I need the postcode to check if we deliver there.',
      };
    }
    if (!prefixes.length) {
      return {
        ok: false,
        error: 'delivery_areas_not_configured',
        postcode,
        spokenHint: 'Delivery areas are not set up in the app yet — shall I put this down for collection instead?',
      };
    }
    const match = matchDeliveryPostcode(postcode, prefixes);
    const notes = settings?.deliveryNotes?.trim() || '';
    if (!match.ok) {
      return {
        ok: false,
        inArea: false,
        postcode: match.normalized || postcode,
        prefixes,
        spokenHint: 'We do not stretch that far for delivery yet — collection is a shout though, or I can take another postcode?',
      };
    }
    return {
      ok: true,
      inArea: true,
      postcode: match.normalized,
      matchedPrefix: match.matchedPrefix,
      deliveryNotes: notes || undefined,
      spokenHint: notes
        ? `Yes, we deliver to ${match.normalized}. ${notes}`
        : `Yes, we deliver to ${match.normalized}.`,
    };
  }

  if (name === 'placeFoodOrder') {
    const { placeFoodOrder } = await import('../order-service');
    return placeFoodOrder({
      items: Array.isArray(input.items) ? input.items : [],
      orderType: firstString(input.orderType),
      postcode: firstString(input.postcode),
      deliveryAddress: firstString(input.deliveryAddress),
      customerAllergies: firstString(input.customerAllergies),
      allergyConfirmed: input.allergyConfirmed === true,
      customerPhone: firstString(input.customerPhone, callerPhone),
      customerName: firstString(input.customerName, body.customerContext?.customerName),
      customerId: firstString(input.customerId, body.customerContext?.customerId),
      specialName: firstString(input.specialName),
      notes: firstString(input.notes),
      paymentStatus: firstString(input.paymentStatus),
      total: input.total != null ? Number(input.total) : undefined,
      channel: 'phone',
      source: 'phone',
      sourceCallId: callId,
      callIds: callId ? [callId] : [],
      orgId: firstString(body.orgId) ?? getRequestOrgId(),
      callerPhone,
    });
  }

  if (name === 'checkTableAvailability') {
    const startsAt = firstString(input.startsAt, input.dateTime) ?? '';
    const partySize = Math.max(1, Number(input.partySize ?? 2) || 2);
    if (!startsAt) {
      return { ok: false, error: 'startsAt_required', spokenHint: 'What day and time were you thinking?' };
    }
    const result = await checkTableAvailability({ startsAt, partySize }, firstString(body.orgId) ?? getRequestOrgId());
    if (!result.ok) return { ok: false, error: result.error, spokenHint: 'I could not check tables just now.' };
    if (!result.availableTables.length) {
      const next = result.nextSlots?.[0];
      return {
        ok: true,
        available: false,
        nextSlots: result.nextSlots,
        spokenHint: next
          ? `Fully booked then — earliest I can do is ${new Date(next).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}.`
          : 'We are fully booked around then — want a different time?',
      };
    }
    return {
      ok: true,
      available: true,
      tables: result.availableTables,
      spokenHint: `Yes — I can fit ${partySize} at that time.`,
    };
  }

  if (name === 'bookTable') {
    const startsAt = firstString(input.startsAt) ?? '';
    const partySize = Math.max(1, Number(input.partySize ?? 2) || 2);
    if (!startsAt) return { ok: false, error: 'startsAt_required' };
    const result = await createReservation({
      startsAt,
      partySize,
      customerName: firstString(input.customerName, body.customerContext?.customerName),
      customerPhone: firstString(input.customerPhone, callerPhone),
      notes: firstString(input.notes),
      callId,
      channel: 'phone',
    }, firstString(body.orgId) ?? getRequestOrgId());
    if (!result.ok || !result.reservation) {
      return { ok: false, error: result.error, spokenHint: 'Could not book that slot — try another time?' };
    }
    const r = result.reservation;
    return {
      ok: true,
      reservationId: r.id,
      startsAt: r.startsAt,
      partySize: r.partySize,
      status: r.status,
      spokenHint: `Table booked for ${partySize} at ${new Date(r.startsAt).toLocaleString('en-GB')}.`,
    };
  }

  if (name === 'updateReservation') {
    const org = firstString(body.orgId) ?? getRequestOrgId();
    let id = firstString(input.reservationId);
    if (!id) {
      const phone = firstString(input.customerPhone, callerPhone);
      const list = await listReservations(org, { phone });
      const upcoming = list
        .filter((r) => !['cancelled', 'completed', 'no_show'].includes(r.status))
        .sort((a, b) => a.startsAt.localeCompare(b.startsAt))[0];
      id = upcoming?.id;
    }
    if (!id) return { ok: false, error: 'reservation_not_found' };
    const patch: Record<string, unknown> = {};
    if (input.startsAt != null) patch.startsAt = String(input.startsAt);
    if (input.partySize != null) patch.partySize = Number(input.partySize);
    if (input.notes != null) patch.notes = String(input.notes);
    if (callId) {
      const existing = (await listReservations(org)).find((r) => r.id === id);
      patch.callIds = [...new Set([...(existing?.callIds ?? []), callId])];
      patch.callId = existing?.callId || callId;
    }
    const result = await updateReservation(id, patch, org);
    return result.ok
      ? { ok: true, reservation: result.reservation, spokenHint: 'Reservation updated.' }
      : { ok: false, error: result.error };
  }

  if (name === 'cancelReservation') {
    const org = firstString(body.orgId) ?? getRequestOrgId();
    let id = firstString(input.reservationId);
    if (!id) {
      const phone = firstString(input.customerPhone, callerPhone);
      const list = await listReservations(org, { phone });
      const upcoming = list
        .filter((r) => !['cancelled', 'completed', 'no_show'].includes(r.status))
        .sort((a, b) => a.startsAt.localeCompare(b.startsAt))[0];
      id = upcoming?.id;
    }
    if (!id) return { ok: false, error: 'reservation_not_found' };
    const result = await cancelReservation(id, firstString(input.reason), org);
    return result.ok
      ? { ok: true, spokenHint: 'Reservation cancelled — see you another time.' }
      : { ok: false, error: result.error };
  }

  if (name === 'listReservations') {
    const org = firstString(body.orgId) ?? getRequestOrgId();
    const rows = await listReservations(org, {
      day: firstString(input.day),
      phone: firstString(input.phone, callerPhone),
    });
    return {
      ok: true,
      count: rows.length,
      reservations: rows.slice(0, 20).map((r) => ({
        id: r.id,
        partySize: r.partySize,
        customerName: r.customerName,
        customerPhone: r.customerPhone,
        startsAt: r.startsAt,
        status: r.status,
        tableId: r.tableId,
      })),
    };
  }

  return { error: `Unknown phone tool: ${name}` };
}

export function getOpenRecruitmentJobs(): Array<Record<string, unknown>> {
  const store = getDataStore();
  return store.recruitmentJobs.filter(j => String(j.status ?? 'open') === 'open').slice(0, 10);
}

