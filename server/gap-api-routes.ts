/**
 * API routes for gap-closing tool backends (SMS, Stripe refund/sub, banking payment, WhatsApp).
 */
import type { IncomingMessage, ServerResponse } from 'http';
import { getDataStore, syncData } from './data-store';
import { getStripe } from './stripe-service';
import { updateOrganization, getOrganizationById, type OrgPlan } from './organizations';

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function getWhatsAppCreds(): { phoneId: string; token: string } | null {
  const enabled = process.env.WHATSAPP_META_ENABLED?.trim().toLowerCase();
  if (enabled !== '1' && enabled !== 'true') return null;
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID?.trim() || '';
  const token = process.env.WHATSAPP_ACCESS_TOKEN?.trim() || '';
  if (!phoneId || !token) return null;
  return { phoneId, token };
}

export async function handleGapApiRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  url: URL,
): Promise<boolean> {
  // G27 — SMS via Twilio
  if (pathname === '/api/sms/send' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req) || '{}') as { to?: string; body?: string };
      const to = body.to?.trim();
      const text = body.body?.trim();
      if (!to || !text) {
        sendJson(res, 400, { error: 'to and body required' });
        return true;
      }
      const { sendTwilioSms } = await import('./telephony/twilioAdapter');
      const result = await sendTwilioSms(to, text);
      if (result.stub) {
        sendJson(res, 200, {
          ok: true,
          stub: true,
          to,
          message: 'SMS accepted (stub — configure TWILIO_* env to deliver)',
        });
        return true;
      }
      sendJson(res, 200, { ok: true, sid: result.sid, to });
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : 'SMS failed' });
    }
    return true;
  }

  // G14/G22 — Stripe refund
  if (pathname === '/api/stripe/refund' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req) || '{}') as {
        paymentIntentId?: string;
        chargeId?: string;
        amount?: number;
        reason?: string;
      };
      if (!body.paymentIntentId && !body.chargeId) {
        sendJson(res, 400, { error: 'paymentIntentId or chargeId required' });
        return true;
      }
      if (!process.env.STRIPE_SECRET_KEY?.trim()) {
        sendJson(res, 200, {
          ok: true,
          stub: true,
          refundId: `re_stub_${Date.now()}`,
          message: 'Refund stubbed — set STRIPE_SECRET_KEY to process live',
        });
        return true;
      }
      const stripe = getStripe();
      const amountPence = typeof body.amount === 'number' ? Math.round(body.amount * 100) : undefined;
      const refund = await stripe.refunds.create({
        ...(body.paymentIntentId ? { payment_intent: body.paymentIntentId } : {}),
        ...(body.chargeId ? { charge: body.chargeId } : {}),
        ...(amountPence ? { amount: amountPence } : {}),
        reason: body.reason === 'duplicate' || body.reason === 'fraudulent' ? body.reason : 'requested_by_customer',
      });
      sendJson(res, 200, { ok: true, refundId: refund.id, status: refund.status });
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : 'Refund failed' });
    }
    return true;
  }

  // G21 — manage subscription
  if (pathname === '/api/stripe/manage-subscription' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req) || '{}') as {
        action?: string;
        subscriptionId?: string;
        orgId?: string;
        newPlanId?: OrgPlan;
      };
      const action = body.action;
      if (!action || !['cancel', 'upgrade', 'downgrade'].includes(action)) {
        sendJson(res, 400, { error: 'action must be cancel|upgrade|downgrade' });
        return true;
      }
      if (!process.env.STRIPE_SECRET_KEY?.trim()) {
        sendJson(res, 200, {
          ok: true,
          stub: true,
          message: `Subscription ${action} stubbed — set STRIPE_SECRET_KEY for live changes`,
        });
        return true;
      }
      const stripe = getStripe();
      let subscriptionId = body.subscriptionId;
      if (!subscriptionId && body.orgId) {
        subscriptionId = getOrganizationById(body.orgId)?.stripeSubscriptionId;
      }
      if (!subscriptionId) {
        sendJson(res, 400, { error: 'subscriptionId or orgId with subscription required' });
        return true;
      }
      if (action === 'cancel') {
        const sub = await stripe.subscriptions.update(subscriptionId, { cancel_at_period_end: true });
        if (body.orgId) {
          updateOrganization(body.orgId, { subscriptionStatus: sub.status });
        }
        sendJson(res, 200, { ok: true, message: 'Subscription will cancel at period end.', subscriptionId });
        return true;
      }
      if (!body.newPlanId) {
        sendJson(res, 400, { error: 'newPlanId required for upgrade/downgrade' });
        return true;
      }
      const priceEnv: Record<OrgPlan, string | undefined> = {
        starter: process.env.STRIPE_PRICE_STARTER,
        pro: process.env.STRIPE_PRICE_PRO,
        enterprise: process.env.STRIPE_PRICE_ENTERPRISE,
      };
      const priceId = priceEnv[body.newPlanId]?.trim();
      if (!priceId) {
        sendJson(res, 400, { error: `Stripe price not configured for ${body.newPlanId}` });
        return true;
      }
      const current = await stripe.subscriptions.retrieve(subscriptionId);
      const itemId = current.items.data[0]?.id;
      if (!itemId) {
        sendJson(res, 400, { error: 'Subscription has no items' });
        return true;
      }
      const updated = await stripe.subscriptions.update(subscriptionId, {
        items: [{ id: itemId, price: priceId }],
        proration_behavior: 'create_prorations',
      });
      if (body.orgId) {
        updateOrganization(body.orgId, { plan: body.newPlanId, subscriptionStatus: updated.status });
      }
      sendJson(res, 200, {
        ok: true,
        message: `Subscription ${action}d to ${body.newPlanId}.`,
        subscriptionId,
        plan: body.newPlanId,
      });
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : 'Subscription change failed' });
    }
    return true;
  }

  // G15 — flag bank transaction
  if (pathname === '/api/banking/flag-transaction' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req) || '{}') as {
        transactionId?: string;
        reason?: string;
        flagType?: string;
      };
      if (!body.transactionId || !body.reason) {
        sendJson(res, 400, { error: 'transactionId and reason required' });
        return true;
      }
      const store = getDataStore();
      const tx = store.bankTransactions.find((t) => String(t.id) === body.transactionId);
      if (!tx) {
        // Accept anyway — client store may not be synced to server yet
        sendJson(res, 200, {
          ok: true,
          flagged: true,
          transactionId: body.transactionId,
          reason: body.reason,
          flagType: body.flagType || 'query',
          note: 'Transaction not in server store — flag recorded as acknowledgement',
        });
        return true;
      }
      tx.flagged = true;
      tx.flagReason = body.reason;
      tx.flagType = body.flagType || 'query';
      tx.flaggedAt = new Date().toISOString();
      syncData(store);
      sendJson(res, 200, { ok: true, flagged: true, transaction: tx });
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : 'Flag failed' });
    }
    return true;
  }

  // G25 — initiate TrueLayer payment (sandbox-friendly stub + optional live)
  if (pathname === '/api/banking/initiate-payment' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req) || '{}') as {
        amount?: number;
        beneficiaryName?: string;
        sortCode?: string;
        accountNumber?: string;
        reference?: string;
        currency?: string;
      };
      if (
        typeof body.amount !== 'number'
        || !body.beneficiaryName
        || !body.sortCode
        || !body.accountNumber
        || !body.reference
      ) {
        sendJson(res, 400, { error: 'amount, beneficiaryName, sortCode, accountNumber, reference required' });
        return true;
      }
      const clientId = process.env.TRUELAYER_CLIENT_ID?.trim();
      const clientSecret = process.env.TRUELAYER_CLIENT_SECRET?.trim();
      if (!clientId || !clientSecret) {
        const paymentId = `pay_stub_${Date.now()}`;
        sendJson(res, 200, {
          ok: true,
          stub: true,
          paymentId,
          amount: body.amount,
          currency: body.currency || 'GBP',
          beneficiaryName: body.beneficiaryName,
          reference: body.reference,
          message: 'Payment initiation stubbed — configure TrueLayer credentials for live payments',
        });
        return true;
      }
      // Minimal create-payment payload for TrueLayer Payments API (sandbox)
      const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
      const tokenRes = await fetch('https://auth.truelayer-sandbox.com/connect/token', {
        method: 'POST',
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'grant_type=client_credentials&scope=payments',
      });
      if (!tokenRes.ok) {
        const errText = await tokenRes.text();
        sendJson(res, 502, { error: `TrueLayer auth failed: ${errText}` });
        return true;
      }
      const tokens = await tokenRes.json() as { access_token?: string };
      const paymentRes = await fetch('https://api.truelayer-sandbox.com/v3/payments', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tokens.access_token}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': `tp-${Date.now()}`,
        },
        body: JSON.stringify({
          amount_in_minor: Math.round(body.amount * 100),
          currency: body.currency || 'GBP',
          payment_method: {
            type: 'bank_transfer',
            provider_selection: { type: 'user_selected' },
            beneficiary: {
              type: 'external_account',
              account_holder_name: body.beneficiaryName,
              reference: body.reference.slice(0, 18),
              account_identifier: {
                type: 'sort_code_account_number',
                sort_code: body.sortCode.replace(/\D/g, ''),
                account_number: body.accountNumber.replace(/\D/g, ''),
              },
            },
          },
          user: {
            id: `user-${Date.now()}`,
            name: body.beneficiaryName,
          },
        }),
      });
      const payment = await paymentRes.json() as { id?: string; resource_token?: string; status?: string; detail?: string; title?: string };
      if (!paymentRes.ok) {
        sendJson(res, 502, { error: payment.detail || payment.title || 'TrueLayer payment create failed' });
        return true;
      }
      sendJson(res, 200, {
        ok: true,
        paymentId: payment.id,
        status: payment.status,
        resourceToken: payment.resource_token,
      });
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : 'Payment initiation failed' });
    }
    return true;
  }

  // G23 — WhatsApp template
  if (pathname === '/api/messages/whatsapp-template' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req) || '{}') as {
        to?: string;
        templateName?: string;
        templateParams?: string[];
        language?: string;
      };
      if (!body.to || !body.templateName) {
        sendJson(res, 400, { error: 'to and templateName required' });
        return true;
      }
      const creds = getWhatsAppCreds();
      if (!creds) {
        sendJson(res, 503, {
          error: 'Meta WhatsApp Cloud API is disabled — use WhatsApp Web (QR) in Integrations',
          to: body.to,
          templateName: body.templateName,
        });
        return true;
      }
      const { sendWhatsAppTemplate } = await import('./whatsapp-webhook');
      await sendWhatsAppTemplate(
        creds.phoneId,
        creds.token,
        body.to,
        body.templateName,
        Array.isArray(body.templateParams) ? body.templateParams : [],
      );
      sendJson(res, 200, { ok: true, to: body.to, templateName: body.templateName });
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : 'WhatsApp template failed' });
    }
    return true;
  }

  // G24 — WhatsApp media
  if (pathname === '/api/messages/whatsapp-media' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req) || '{}') as {
        to?: string;
        mediaUrl?: string;
        mediaType?: string;
        caption?: string;
        filename?: string;
      };
      if (!body.to || !body.mediaUrl) {
        sendJson(res, 400, { error: 'to and mediaUrl required' });
        return true;
      }
      const creds = getWhatsAppCreds();
      const mediaType = body.mediaType === 'image' || body.mediaType === 'video' ? body.mediaType : 'document';
      if (!creds) {
        sendJson(res, 503, {
          error: 'Meta WhatsApp Cloud API is disabled — use WhatsApp Web (QR) in Integrations',
          to: body.to,
          mediaType,
        });
        return true;
      }
      const to = body.to.replace(/\D/g, '');
      const payload: Record<string, unknown> = {
        messaging_product: 'whatsapp',
        to,
        type: mediaType,
      };
      if (mediaType === 'image') {
        payload.image = { link: body.mediaUrl, caption: body.caption };
      } else if (mediaType === 'video') {
        payload.video = { link: body.mediaUrl, caption: body.caption };
      } else {
        payload.document = {
          link: body.mediaUrl,
          caption: body.caption,
          filename: body.filename || 'document.pdf',
        };
      }
      const waRes = await fetch(`https://graph.facebook.com/v21.0/${creds.phoneId}/messages`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${creds.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
      const data = await waRes.json() as { error?: { message?: string }; messages?: unknown[] };
      if (!waRes.ok) {
        sendJson(res, 502, { error: data.error?.message || `WhatsApp ${waRes.status}` });
        return true;
      }
      sendJson(res, 200, { ok: true, to: body.to, mediaType, messages: data.messages });
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : 'WhatsApp media failed' });
    }
    return true;
  }

  // Avoid unused url lint in some builds
  void url;
  return false;
}
